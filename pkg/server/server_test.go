package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/condatainer/cnt-vnc-viewer/pkg/config"
)

func TestGenerateEphemeralCert(t *testing.T) {
	certPEM, keyPEM, err := GenerateEphemeralCert()
	if err != nil {
		t.Fatalf("GenerateEphemeralCert failed: %v", err)
	}

	if len(certPEM) == 0 || len(keyPEM) == 0 {
		t.Fatalf("empty cert or key PEM generated")
	}
}

func TestSessionHandler(t *testing.T) {
	os.Setenv("SLURM_JOB_ID", "1234567")
	os.Setenv("JOB_WALLTIME_REMAINING", "3600")
	defer os.Unsetenv("SLURM_JOB_ID")
	defer os.Unsetenv("JOB_WALLTIME_REMAINING")

	cfg := &config.Config{
		VNCAddr:     "127.0.0.1:5901",
		EnableAudio: true,
	}

	h := NewSessionHandler(cfg, nil)
	req := httptest.NewRequest(http.MethodGet, "/api/session", nil)
	w := httptest.NewRecorder()

	h.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", w.Code)
	}

	var info SessionInfo
	if err := json.NewDecoder(w.Body).Decode(&info); err != nil {
		t.Fatalf("failed to decode json response: %v", err)
	}

	if info.JobID != "1234567" {
		t.Errorf("expected JobID 1234567, got %s", info.JobID)
	}
	if info.JobScheduler != "Slurm" {
		t.Errorf("expected JobScheduler Slurm, got %s", info.JobScheduler)
	}
	if info.WalltimeRemainingSec != 3600 {
		t.Errorf("expected WalltimeRemainingSec 3600, got %d", info.WalltimeRemainingSec)
	}
	if info.VNCTarget != "127.0.0.1:5901" {
		t.Errorf("expected VNCTarget 127.0.0.1:5901, got %s", info.VNCTarget)
	}
}

