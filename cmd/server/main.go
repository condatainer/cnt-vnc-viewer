package main

import (
	"context"
	"embed"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/condatainer/cnt-vnc-viewer/pkg/audio"
	"github.com/condatainer/cnt-vnc-viewer/pkg/config"
	"github.com/condatainer/cnt-vnc-viewer/pkg/logger"
	"github.com/condatainer/cnt-vnc-viewer/pkg/server"
	"github.com/condatainer/cnt-vnc-viewer/pkg/version"
	"github.com/condatainer/cnt-vnc-viewer/pkg/vncproxy"
)

//go:embed dist/*
var staticFS embed.FS

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("[main] Configuration error: %v", err)
	}

	cleanupLog, _ := logger.Setup(cfg.LogFile, cfg.LogLevel, cfg.Debug)
	if cleanupLog != nil {
		defer cleanupLog()
	}

	log.Printf("[main] Starting cnt-vnc-viewer %s (log-level: %s)...", version.Version, cfg.LogLevel)
	if cfg.LogFile != "" {
		log.Printf("[main] Logging to file: %s", cfg.LogFile)
	} else {
		log.Printf("[main] Logging to console (stdout)")
	}

	// Initialize Audio Subsystem
	audioMgr := audio.NewManager(cfg)
	if cfg.EnableAudio {
		audioMgr.Start()
		defer audioMgr.Stop()
	}

	// Initialize VNC Proxy
	vncHandler := vncproxy.NewHandler(cfg)

	// Initialize Web Server
	srv := server.NewServer(cfg, vncHandler, audioMgr, staticFS)
	if err := srv.Start(); err != nil {
		log.Fatalf("[main] Failed to start server: %v", err)
	}

	// Graceful shutdown handling
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	sig := <-sigChan
	log.Printf("[main] Received signal %v, initiating shutdown...", sig)

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := srv.Stop(shutdownCtx); err != nil {
		log.Printf("[main] Server shutdown error: %v", err)
	}
	audioMgr.Stop()

	log.Println("[main] Server gracefully stopped.")
}

