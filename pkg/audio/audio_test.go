package audio

import (
	"testing"

	"github.com/condatainer/cnt-vnc-viewer/pkg/config"
)

func TestAudioProtocolHeader(t *testing.T) {
	buf := make([]byte, HeaderSize)
	origType := StreamTypeSpeaker
	origFlags := uint8(0x01)
	origSeq := uint16(42)
	origTs := uint32(12345678)

	EncodeHeader(buf, origType, origFlags, origSeq, origTs)

	decType, decFlags, decSeq, decTs := DecodeHeader(buf)

	if decType != origType {
		t.Errorf("type mismatch: expected %d, got %d", origType, decType)
	}
	if decFlags != origFlags {
		t.Errorf("flags mismatch: expected %d, got %d", origFlags, decFlags)
	}
	if decSeq != origSeq {
		t.Errorf("seq mismatch: expected %d, got %d", origSeq, decSeq)
	}
	if decTs != origTs {
		t.Errorf("timestamp mismatch: expected %d, got %d", origTs, decTs)
	}
}

func TestManagerDropOldestRingBuffer(t *testing.T) {
	cfg := &config.Config{EnableAudio: true}
	mgr := NewManager(cfg)

	session := mgr.RegisterClient()
	defer mgr.UnregisterClient(session)

	// Send 10 frames (channel buffer has capacity 6)
	frame := make([]byte, mgr.frameBytes())
	for i := 0; i < 10; i++ {
		frame[0] = byte(i)
		mgr.broadcastSpeakerFrame(frame)
	}

	// Should not block and channel should have at most cap(session.SendChan) packets
	if len(session.SendChan) > cap(session.SendChan) {
		t.Errorf("channel exceeded capacity")
	}

	// Read last received packet and check sequence number
	var lastPacket []byte
	for len(session.SendChan) > 0 {
		lastPacket = <-session.SendChan
	}

	if lastPacket == nil {
		t.Fatalf("expected packet in channel")
	}

	_, _, seq, _ := DecodeHeader(lastPacket)
	if seq != 10 {
		t.Errorf("expected latest sequence 10, got %d", seq)
	}
}

func TestManagerSetQualityValidationAndFormat(t *testing.T) {
	cfg := &config.Config{EnableAudio: true, AudioSampleRate: 16000, AudioChannels: 1}
	mgr := NewManager(cfg)

	if rate, ch := mgr.CurrentFormat(); rate != 16000 || ch != 1 {
		t.Fatalf("expected initial format 16000/1, got %d/%d", rate, ch)
	}

	// Opus only accepts 8000/12000/16000/24000/48000 - anything else should snap to the
	// nearest of those rather than be rejected outright.
	if err := mgr.SetQuality(22000, 1); err != nil {
		t.Fatalf("unexpected error snapping an off-grid rate: %v", err)
	}
	if rate, _ := mgr.CurrentFormat(); rate != 24000 {
		t.Errorf("expected 22000Hz to snap to nearest valid Opus rate 24000, got %d", rate)
	}

	if err := mgr.SetQuality(16000, 3); err == nil {
		t.Errorf("expected error for invalid channel count, got nil")
	}

	// No PulseAudio client connected in this test, so SetQuality can't (and shouldn't need to)
	// touch a record stream - it should still validate and update the stored format.
	if err := mgr.SetQuality(24000, 2); err != nil {
		t.Fatalf("unexpected error from SetQuality: %v", err)
	}
	if rate, ch := mgr.CurrentFormat(); rate != 24000 || ch != 2 {
		t.Errorf("expected format 24000/2 after SetQuality, got %d/%d", rate, ch)
	}
}

func TestSpawnerPaths(t *testing.T) {
	s1 := NewSpawner(":10", "")
	if s1.SocketPath == "" || s1.Dir == "" {
		t.Fatalf("expected non-empty socket and dir")
	}

	custom := "unix:/custom/pulse/native"
	s2 := NewSpawner(":1", custom)
	if s2.SocketPath != "/custom/pulse/native" {
		t.Errorf("expected custom socket path /custom/pulse/native, got %s", s2.SocketPath)
	}
	if s2.Dir != "/custom/pulse" {
		t.Errorf("expected custom dir /custom/pulse, got %s", s2.Dir)
	}

	// Verify Stop on unstarted spawner doesn't panic
	s2.Stop()
}
