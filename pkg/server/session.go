package server

import (
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/condatainer/cnt-vnc-viewer/pkg/audio"
	"github.com/condatainer/cnt-vnc-viewer/pkg/config"
	"github.com/condatainer/cnt-vnc-viewer/pkg/version"
)

// SessionInfo provides metadata about the current VNC session and HPC job environment.
type SessionInfo struct {
	Version              string            `json:"version"`
	VNCTarget            string            `json:"vnc_target"`
	AudioEnabled         bool              `json:"audio_enabled"`
	AuthRequired         bool              `json:"auth_required"`
	JobID                string            `json:"job_id,omitempty"`
	JobScheduler         string            `json:"job_scheduler,omitempty"`
	WalltimeRemainingSec int64             `json:"walltime_remaining_sec,omitempty"`
	NativeWidth          int               `json:"native_width,omitempty"`
	NativeHeight         int               `json:"native_height,omitempty"`
	ServerTime           int64             `json:"server_time"`
	Audio                *audio.DebugStats `json:"audio,omitempty"`
}

// SessionHandler handles the /api/session endpoint.
type SessionHandler struct {
	cfg      *config.Config
	audioMgr *audio.Manager
}

// NewSessionHandler creates a new SessionHandler.
func NewSessionHandler(cfg *config.Config, audioMgr *audio.Manager) *SessionHandler {
	return &SessionHandler{cfg: cfg, audioMgr: audioMgr}
}

func (h *SessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")

	info := SessionInfo{
		Version:      version.Version,
		VNCTarget:    h.cfg.VNCAddr,
		AudioEnabled: h.cfg.EnableAudio,
		AuthRequired: h.cfg.AuthToken != "",
		ServerTime:   time.Now().Unix(),
	}

	if h.audioMgr != nil {
		stats := h.audioMgr.DebugStats()
		info.Audio = &stats
	}

	if w, ht, ok := parseGeometry(h.cfg.NativeGeometry); ok {
		info.NativeWidth = w
		info.NativeHeight = ht
	}

	// Detect HPC Job Scheduler (Slurm, PBS, LSF)
	if slurmID := os.Getenv("SLURM_JOB_ID"); slurmID != "" {
		info.JobID = slurmID
		info.JobScheduler = "Slurm"
		if endTimeStr := os.Getenv("SLURM_JOB_END_TIME"); endTimeStr != "" {
			if endTime, err := strconv.ParseInt(endTimeStr, 10, 64); err == nil {
				rem := endTime - time.Now().Unix()
				if rem < 0 {
					rem = 0
				}
				info.WalltimeRemainingSec = rem
			}
		}
	} else if pbsID := os.Getenv("PBS_JOBID"); pbsID != "" {
		info.JobID = pbsID
		info.JobScheduler = "PBS"
	} else if lsfID := os.Getenv("LSB_JOBID"); lsfID != "" {
		info.JobID = lsfID
		info.JobScheduler = "LSF"
	}

	// Custom walltime override support
	if walltimeSecStr := os.Getenv("JOB_WALLTIME_REMAINING"); walltimeSecStr != "" {
		if rem, err := strconv.ParseInt(walltimeSecStr, 10, 64); err == nil {
			info.WalltimeRemainingSec = rem
		}
	}

	_ = json.NewEncoder(w).Encode(info)
}

// parseGeometry parses a "WIDTHxHEIGHT" string (as passed to `vncserver -geometry`).
func parseGeometry(geometry string) (width, height int, ok bool) {
	parts := strings.SplitN(geometry, "x", 2)
	if len(parts) != 2 {
		return 0, 0, false
	}
	w, err := strconv.Atoi(strings.TrimSpace(parts[0]))
	if err != nil || w <= 0 {
		return 0, 0, false
	}
	h, err := strconv.Atoi(strings.TrimSpace(parts[1]))
	if err != nil || h <= 0 {
		return 0, 0, false
	}
	return w, h, true
}
