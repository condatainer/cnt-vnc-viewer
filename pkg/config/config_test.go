package config

import (
	"os"
	"testing"
)

func TestConfigDefaults(t *testing.T) {
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() unexpected error: %v", err)
	}

	if cfg.ListenHTTP != "127.0.0.1:8080" {
		t.Errorf("expected ListenHTTP 127.0.0.1:8080, got %s", cfg.ListenHTTP)
	}

	if cfg.VNCAddr != "127.0.0.1:5901" {
		t.Errorf("expected VNCAddr 127.0.0.1:5901, got %s", cfg.VNCAddr)
	}

	if !cfg.EnableAudio {
		t.Errorf("expected EnableAudio true by default, got false")
	}
}

func TestAutodetectPulseServer(t *testing.T) {
	// Test environment override
	os.Setenv("PULSE_SERVER", "tcp:192.168.1.50:4713")
	defer os.Unsetenv("PULSE_SERVER")

	srv := AutodetectPulseServer()
	if srv != "tcp:192.168.1.50:4713" {
		t.Errorf("expected PULSE_SERVER override, got %s", srv)
	}
}

func TestParseDisplayFromVNCAddr(t *testing.T) {
	tests := []struct {
		addr     string
		expected int
	}{
		{":1", 1},
		{":10", 10},
		{"127.0.0.1:5901", 1},
		{"127.0.0.1:5910", 10},
		{"localhost:5905", 5},
		{"invalid", 10},
	}

	for _, tc := range tests {
		got := ParseDisplayFromVNCAddr(tc.addr)
		if got != tc.expected {
			t.Errorf("ParseDisplayFromVNCAddr(%q) = %d, expected %d", tc.addr, got, tc.expected)
		}
	}
}
