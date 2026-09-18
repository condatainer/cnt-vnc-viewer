package vncproxy

import (
	"context"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/condatainer/cnt-vnc-viewer/pkg/config"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  64 * 1024,
	WriteBufferSize: 64 * 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow cross-origin / SSH port-forwarding hosts
	},
	Subprotocols: []string{"binary"},
}

var bufferPool = sync.Pool{
	New: func() interface{} {
		b := make([]byte, 32*1024)
		return &b
	},
}

// Handler handles WebSocket connections to /ws/rfb and bridges them to the target VNC server.
type Handler struct {
	cfg *config.Config
}

// NewHandler creates a new VNC proxy handler.
func NewHandler(cfg *config.Config) *Handler {
	return &Handler{cfg: cfg}
}

// ServeHTTP implements http.Handler for /ws/rfb.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Verify auth token if configured
	if h.cfg.AuthToken != "" {
		token := r.URL.Query().Get("token")
		if token == "" {
			token = r.Header.Get("X-Auth-Token")
		}
		if token != h.cfg.AuthToken {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
	}

	// Connect to VNC server
	vncConn, err := dialVNC(h.cfg.VNCAddr)
	if err != nil {
		log.Printf("[vncproxy] Failed to connect to VNC server at %s: %v", h.cfg.VNCAddr, err)
		http.Error(w, "Failed to connect to target VNC server", http.StatusBadGateway)
		return
	}
	defer vncConn.Close()

	// Upgrade WebSocket
	wsConn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[vncproxy] WebSocket upgrade error: %v", err)
		return
	}
	defer wsConn.Close()

	log.Printf("[vncproxy] Client connected: %s <-> VNC %s", r.RemoteAddr, h.cfg.VNCAddr)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	var wg sync.WaitGroup
	wg.Add(2)

	// WS -> VNC TCP/UNIX
	go func() {
		defer wg.Done()
		defer cancel()
		for {
			msgType, data, err := wsConn.ReadMessage()
			if err != nil {
				if !websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) &&
					!errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) {
					log.Printf("[vncproxy] WS read error: %v", err)
				}
				return
			}
			if msgType == websocket.BinaryMessage {
				if _, err := vncConn.Write(data); err != nil {
					log.Printf("[vncproxy] VNC write error: %v", err)
					return
				}
			}
		}
	}()

	// VNC TCP/UNIX -> WS
	go func() {
		defer wg.Done()
		defer cancel()

		bufPtr := bufferPool.Get().(*[]byte)
		defer bufferPool.Put(bufPtr)
		buf := *bufPtr

		for {
			select {
			case <-ctx.Done():
				return
			default:
			}

			// Set read deadline to periodically check context cancellation
			_ = vncConn.SetReadDeadline(time.Now().Add(5 * time.Second))
			n, err := vncConn.Read(buf)
			if n > 0 {
				if writeErr := wsConn.WriteMessage(websocket.BinaryMessage, buf[:n]); writeErr != nil {
					log.Printf("[vncproxy] WS write error: %v", writeErr)
					return
				}
			}
			if err != nil {
				if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
					continue
				}
				if !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) {
					log.Printf("[vncproxy] VNC read error: %v", err)
				}
				return
			}
		}
	}()

	wg.Wait()
	log.Printf("[vncproxy] Session terminated for %s", r.RemoteAddr)
}

func dialVNC(target string) (net.Conn, error) {
	var network, address string
	if strings.HasPrefix(target, "unix:") {
		network = "unix"
		address = strings.TrimPrefix(target, "unix:")
	} else {
		network = "tcp"
		address = target
		// default port if not provided
		if !strings.Contains(address, ":") {
			address = address + ":5900"
		}
	}

	dialer := net.Dialer{
		Timeout: 5 * time.Second,
	}

	conn, err := dialer.Dial(network, address)
	if err != nil {
		return nil, err
	}

	if tcpConn, ok := conn.(*net.TCPConn); ok {
		_ = tcpConn.SetNoDelay(true)
		_ = tcpConn.SetKeepAlive(true)
		_ = tcpConn.SetKeepAlivePeriod(15 * time.Second)
		_ = tcpConn.SetReadBuffer(64 * 1024)
		_ = tcpConn.SetWriteBuffer(64 * 1024)
	}

	return conn, nil
}

