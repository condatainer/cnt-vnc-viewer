package audio

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/condatainer/cnt-vnc-viewer/pkg/config"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  16 * 1024,
	WriteBufferSize: 16 * 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

// ControlMessage defines a control payload for audio state.
type ControlMessage struct {
	Action     string `json:"action"`
	SampleRate int    `json:"sample_rate,omitempty"`
	Channels   int    `json:"channels,omitempty"`
}

// Handler handles WebSocket audio streaming for /ws/audio.
type Handler struct {
	cfg *config.Config
	mgr *Manager
}

// NewHandler creates a new audio WebSocket handler.
func NewHandler(cfg *config.Config, mgr *Manager) *Handler {
	return &Handler{
		cfg: cfg,
		mgr: mgr,
	}
}

// ServeHTTP handles /ws/audio requests.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !h.cfg.EnableAudio {
		http.Error(w, "Audio disabled", http.StatusServiceUnavailable)
		return
	}

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

	wsConn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[audio] Upgrade error: %v", err)
		return
	}
	defer wsConn.Close()

	session := h.mgr.RegisterClient()
	defer h.mgr.UnregisterClient(session)
	// Tell this client the capture format currently in effect before any speaker frames
	// arrive - it can't assume a fixed default since another client may have already
	// changed it via SetQuality for this (shared) session.
	h.mgr.SendCurrentFormat(session)

	log.Printf("[audio] Audio WebSocket client connected from %s", r.RemoteAddr)

	stopChan := make(chan struct{})
	var once sync.Once
	stop := func() {
		once.Do(func() {
			close(stopChan)
		})
	}

	// WS Write loop (Speaker audio -> browser)
	go func() {
		ticker := time.NewTicker(20 * time.Second)
		defer ticker.Stop()
		defer stop()

		for {
			select {
			case <-stopChan:
				return
			case <-ticker.C:
				_ = wsConn.SetWriteDeadline(time.Now().Add(5 * time.Second))
				if err := wsConn.WriteMessage(websocket.PingMessage, nil); err != nil {
					return
				}
			case packet, ok := <-session.SendChan:
				if !ok {
					return
				}
				_ = wsConn.SetWriteDeadline(time.Now().Add(2 * time.Second))
				if err := wsConn.WriteMessage(websocket.BinaryMessage, packet); err != nil {
					return
				}
			}
		}
	}()

	// WS Read loop (control signals from browser)
	wsConn.SetPongHandler(func(string) error {
		_ = wsConn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	for {
		_ = wsConn.SetReadDeadline(time.Now().Add(60 * time.Second))
		msgType, data, err := wsConn.ReadMessage()
		if err != nil {
			if !websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) &&
				!errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) {
				log.Printf("[audio] WS read error: %v", err)
			}
			break
		}

		if msgType == websocket.BinaryMessage && len(data) >= HeaderSize {
			streamType, _, _, _ := DecodeHeader(data)
			switch streamType {
			case StreamTypeControl:
				var ctrl ControlMessage
				if err := json.Unmarshal(data[HeaderSize:], &ctrl); err == nil {
					h.handleControl(session, &ctrl)
				}
			}
		} else if msgType == websocket.TextMessage {
			var ctrl ControlMessage
			if err := json.Unmarshal(data, &ctrl); err == nil {
				h.handleControl(session, &ctrl)
			}
		}
	}

	stop()
	log.Printf("[audio] Audio WebSocket client disconnected: %s", r.RemoteAddr)
}

func (h *Handler) handleControl(session *ClientSession, ctrl *ControlMessage) {
	log.Printf("[audio] Client audio control request: %s", ctrl.Action)
	switch ctrl.Action {
	case CtrlMuteSpeaker:
		session.Muted.Store(true)
		// Drain any buffered frames so unmuting later does not burst stale audio
		for len(session.SendChan) > 0 {
			select {
			case <-session.SendChan:
			default:
			}
		}
	case CtrlUnmuteSpeaker:
		session.Muted.Store(false)
	case CtrlSetAudioQuality:
		if err := h.mgr.SetQuality(ctrl.SampleRate, ctrl.Channels); err != nil {
			log.Printf("[audio] Rejected audio quality change (%dHz/%dch): %v", ctrl.SampleRate, ctrl.Channels, err)
		}
	}
}
