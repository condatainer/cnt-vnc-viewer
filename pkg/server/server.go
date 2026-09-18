package server

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/condatainer/cnt-vnc-viewer/pkg/audio"
	"github.com/condatainer/cnt-vnc-viewer/pkg/config"
	"github.com/condatainer/cnt-vnc-viewer/pkg/vncproxy"
)

// Server coordinates HTTP/HTTPS listeners, API routes, WebSocket endpoints, and static UI assets.
type Server struct {
	cfg        *config.Config
	vncHandler *vncproxy.Handler
	audioMgr   *audio.Manager
	audioHdl   *audio.Handler
	staticFS   fs.FS

	httpServer  *http.Server
	httpsServer *http.Server
}

// NewServer constructs a new web VNC server.
func NewServer(cfg *config.Config, vncHdl *vncproxy.Handler, audioMgr *audio.Manager, staticFS fs.FS) *Server {
	var audioHdl *audio.Handler
	if cfg.EnableAudio && audioMgr != nil {
		audioHdl = audio.NewHandler(cfg, audioMgr)
	}

	return &Server{
		cfg:        cfg,
		vncHandler: vncHdl,
		audioMgr:   audioMgr,
		audioHdl:   audioHdl,
		staticFS:   staticFS,
	}
}

// Start launches the configured HTTP and/or HTTPS servers.
func (s *Server) Start() error {
	mux := http.NewServeMux()

	// WebSocket endpoints
	mux.Handle("/ws/rfb", s.vncHandler)
	if s.audioHdl != nil {
		mux.Handle("/ws/audio", s.audioHdl)
	}

	// API endpoints
	mux.Handle("/api/session", NewSessionHandler(s.cfg, s.audioMgr))
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})

	// Static UI assets and SPA fallback
	mux.Handle("/", s.spaFileServer())

	// Security middleware wrapping all routes
	handler := s.withSecurityHeaders(mux)

	errChan := make(chan error, 2)

	// 1. Cleartext HTTP Server (prioritized for SSH port-forwarding to localhost)
	if s.cfg.ListenHTTP != "" {
		s.httpServer = &http.Server{
			Addr:              s.cfg.ListenHTTP,
			Handler:           handler,
			ReadHeaderTimeout: 10 * time.Second,
			IdleTimeout:       120 * time.Second,
		}

		go func() {
			log.Printf("[server] Starting HTTP server on http://%s (optimized for SSH tunnel)", s.cfg.ListenHTTP)
			if err := s.httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				errChan <- fmt.Errorf("http server error: %w", err)
			}
		}()
	}

	// 2. HTTPS Server (for external TLS or auto-generated self-signed certificates)
	if s.cfg.ListenHTTPS != "" || s.cfg.AutoTLS {
		httpsAddr := s.cfg.ListenHTTPS
		if httpsAddr == "" {
			httpsAddr = ":8443"
		}

		var tlsCert tls.Certificate
		var err error

		if s.cfg.TLSCert != "" && s.cfg.TLSKey != "" {
			tlsCert, err = tls.LoadX509KeyPair(s.cfg.TLSCert, s.cfg.TLSKey)
			if err != nil {
				return fmt.Errorf("failed to load TLS keypair: %w", err)
			}
			log.Printf("[server] Loaded TLS certificate from %s", s.cfg.TLSCert)
		} else if s.cfg.AutoTLS {
			log.Printf("[server] Generating ephemeral self-signed ECDSA certificate for HTTPS...")
			certPEM, keyPEM, err := GenerateEphemeralCert()
			if err != nil {
				return fmt.Errorf("failed to generate ephemeral TLS cert: %w", err)
			}
			tlsCert, err = tls.X509KeyPair(certPEM, keyPEM)
			if err != nil {
				return fmt.Errorf("failed to parse ephemeral TLS cert: %w", err)
			}
			log.Printf("[server] Ephemeral self-signed TLS certificate ready")
		}

		tlsConfig := &tls.Config{
			Certificates: []tls.Certificate{tlsCert},
			MinVersion:   tls.VersionTLS12,
		}

		s.httpsServer = &http.Server{
			Addr:              httpsAddr,
			Handler:           handler,
			TLSConfig:         tlsConfig,
			ReadHeaderTimeout: 10 * time.Second,
			IdleTimeout:       120 * time.Second,
		}

		go func() {
			log.Printf("[server] Starting HTTPS server on https://%s", httpsAddr)
			if err := s.httpsServer.ListenAndServeTLS("", ""); err != nil && !errors.Is(err, http.ErrServerClosed) {
				errChan <- fmt.Errorf("https server error: %w", err)
			}
		}()
	}

	select {
	case err := <-errChan:
		return err
	case <-time.After(100 * time.Millisecond):
		return nil
	}
}

// Stop gracefully shuts down active listeners.
func (s *Server) Stop(ctx context.Context) error {
	var firstErr error
	if s.httpServer != nil {
		if err := s.httpServer.Shutdown(ctx); err != nil {
			firstErr = err
		}
	}
	if s.httpsServer != nil {
		if err := s.httpsServer.Shutdown(ctx); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// spaFileServer returns an http.Handler that serves static files and falls back
// to index.html for client-side SPA routing.
func (s *Server) spaFileServer() http.Handler {
	if s.cfg.WebDir != "" {
		// Serve from local filesystem (useful during development)
		fsRoot := http.Dir(s.cfg.WebDir)
		fileServer := http.FileServer(fsRoot)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			path := filepath.Join(s.cfg.WebDir, filepath.Clean(r.URL.Path))
			if info, err := os.Stat(path); err != nil || info.IsDir() {
				// If index.html exists, serve it
				indexPath := filepath.Join(s.cfg.WebDir, "index.html")
				if _, err := os.Stat(indexPath); err == nil {
					http.ServeFile(w, r, indexPath)
					return
				}
			}
			fileServer.ServeHTTP(w, r)
		})
	}

	// Serve from embedded FS if available
	if s.staticFS != nil {
		subFS, err := fs.Sub(s.staticFS, "dist")
		if err != nil {
			subFS = s.staticFS
		}
		fileServer := http.FileServer(http.FS(subFS))
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			cleanPath := strings.TrimPrefix(filepath.Clean(r.URL.Path), "/")
			if cleanPath == "" || cleanPath == "." {
				cleanPath = "index.html"
			}

			// Check if file exists in FS
			if f, err := subFS.Open(cleanPath); err == nil {
				_ = f.Close()
				fileServer.ServeHTTP(w, r)
				return
			}

			// Fallback to index.html for SPA routing
			r.URL.Path = "/"
			fileServer.ServeHTTP(w, r)
		})
	}

	// Fallback placeholder if neither WebDir nor embedded FS is present
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<!DOCTYPE html><html><head><title>cnt-vnc-viewer</title></head><body><h2>cnt-vnc-viewer server running</h2><p>Static UI assets not yet built. Run <code>npm run build</code> in <code>web/</code> directory.</p></body></html>`))
	})
}

// withSecurityHeaders wraps handler with basic security headers.
func (s *Server) withSecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "SAMEORIGIN")
		next.ServeHTTP(w, r)
	})
}
