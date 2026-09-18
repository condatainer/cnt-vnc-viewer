package logger

import (
	"bytes"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseLevel(t *testing.T) {
	tests := []struct {
		input string
		want  Level
	}{
		{"debug", LevelDebug},
		{"DEBUG", LevelDebug},
		{"info", LevelInfo},
		{"INFO", LevelInfo},
		{"warn", LevelWarn},
		{"warning", LevelWarn},
		{"error", LevelError},
		{"unknown", LevelInfo},
	}

	for _, tt := range tests {
		got := ParseLevel(tt.input)
		if got != tt.want {
			t.Errorf("ParseLevel(%q) = %v, want %v", tt.input, got, tt.want)
		}
	}
}

func TestLevelFiltering(t *testing.T) {
	var buf bytes.Buffer
	log.SetOutput(&buf)
	log.SetFlags(0) // omit timestamps for testing

	SetLevel(LevelInfo)
	Debugf("this should be hidden")
	Infof("this should be visible")

	output := buf.String()
	if strings.Contains(output, "this should be hidden") {
		t.Errorf("expected debug message to be filtered, got: %s", output)
	}
	if !strings.Contains(output, "this should be visible") {
		t.Errorf("expected info message to be present, got: %s", output)
	}

	buf.Reset()
	SetLevel(LevelDebug)
	Debugf("now debug is visible")
	if !strings.Contains(buf.String(), "now debug is visible") {
		t.Errorf("expected debug message when level is debug, got: %s", buf.String())
	}
}

func TestSetupRouting(t *testing.T) {
	tempDir := t.TempDir()
	logFile := filepath.Join(tempDir, "test.log")

	// Test 1: File only (debug=false)
	cleanup, _ := Setup(logFile, "info", false)
	log.Println("message for file only")
	if cleanup != nil {
		cleanup()
	}

	content, err := os.ReadFile(logFile)
	if err != nil {
		t.Fatalf("failed to read log file: %v", err)
	}
	if !strings.Contains(string(content), "message for file only") {
		t.Errorf("expected log file to contain message, got: %s", string(content))
	}

	// Test 2: Debug enabled with file (destination is still file, but level is debug)
	logFile2 := filepath.Join(tempDir, "test2.log")
	cleanup2, _ := Setup(logFile2, "info", true) // debug=true overrides level to LevelDebug
	if !IsDebug() {
		t.Errorf("expected IsDebug to be true when debug=true")
	}
	Debugf("debug message in file")
	if cleanup2 != nil {
		cleanup2()
	}

	content2, err := os.ReadFile(logFile2)
	if err != nil {
		t.Fatalf("failed to read log file 2: %v", err)
	}
	if !strings.Contains(string(content2), "debug message in file") {
		t.Errorf("expected log file 2 to contain debug message, got: %s", string(content2))
	}

	// Test 3: No file specified (destination is os.Stdout)
	cleanup3, writer3 := Setup("", "warn", false)
	if writer3 != os.Stdout {
		t.Errorf("expected writer to be os.Stdout when logFile is empty")
	}
	if GetLevel() != LevelWarn {
		t.Errorf("expected level to be LevelWarn, got %v", GetLevel())
	}
	if cleanup3 != nil {
		cleanup3()
	}
}

