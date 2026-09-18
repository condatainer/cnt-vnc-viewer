package vncproxy

import (
	"net"
	"testing"
)

func TestDialVNCLocalListener(t *testing.T) {
	// Create a mock local TCP listener
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to create test listener: %v", err)
	}
	defer l.Close()

	// Dial via dialVNC
	conn, err := dialVNC(l.Addr().String())
	if err != nil {
		t.Fatalf("dialVNC failed: %v", err)
	}
	defer conn.Close()

	if conn.RemoteAddr().String() != l.Addr().String() {
		t.Errorf("remote address mismatch: expected %s, got %s", l.Addr().String(), conn.RemoteAddr().String())
	}
}

