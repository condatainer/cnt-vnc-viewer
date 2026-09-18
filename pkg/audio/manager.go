package audio

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/condatainer/cnt-vnc-viewer/pkg/config"
	"github.com/jfreymuth/pulse"
	"github.com/jfreymuth/pulse/proto"
)

const (
	BytesPerSample  = 2 // Int16LE
	FrameDurationMs = 20
)

// opusValidRates are the only sample rates libopus's encoder actually accepts. Any other
// rate (e.g. a custom value from a URL config) gets snapped to the nearest of these by
// snapToOpusRate - PulseAudio resamples its capture to match regardless, so this doesn't
// lose anything a non-Opus-native rate would have given us anyway.
var opusValidRates = []int{8000, 12000, 16000, 24000, 48000}

func snapToOpusRate(rate int) int {
	best := opusValidRates[0]
	bestDiff := abs(rate - best)
	for _, r := range opusValidRates[1:] {
		if d := abs(rate - r); d < bestDiff {
			best, bestDiff = r, d
		}
	}
	return best
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// ClientSession represents a connected WebSocket audio client.
type ClientSession struct {
	SendChan chan []byte
	Muted    atomic.Bool
}

// Manager manages the PulseAudio connection and speaker audio capture.
type Manager struct {
	cfg *config.Config

	mu      sync.RWMutex
	clients map[*ClientSession]struct{}

	pulseClient *pulse.Client
	recStream   *pulse.RecordStream
	spawner     *Spawner

	// Current speaker capture format. Session-wide (shared by every connected client, since
	// they all listen to the same PulseAudio record stream and the same Opus encoder) -
	// changed at runtime via SetQuality(), not just at startup.
	sampleRate int
	channels   int
	opusEnc    *opusEncoder

	// seqCounter numbers audio frames only. Clients use it to detect lost speaker packets (see
	// AudioClient.ts's decodeOpusPacket) - it must stay a pure per-frame counter, not shared
	// with control/format packets (see ctrlSeqCounter), since a control packet sent to one
	// client would otherwise appear as a dropped audio packet to every other client.
	seqCounter uint32
	// ctrlSeqCounter numbers control/format packets (broadcastFormat, SendCurrentFormat). Kept
	// separate from seqCounter for the reason above - clients don't actually read a control
	// packet's seq value at all, this just keeps the header field meaningful.
	ctrlSeqCounter uint32

	// Speaker framing accumulator
	spkMu  sync.Mutex
	spkBuf []byte

	// Diagnostics, all read via DebugStats() and exposed through /api/session so they're
	// checkable without opening browser DevTools (which can crash the client tab mid-session -
	// see AudioClient.ts's audio_debug overlay for the client-side counterparts). These narrow
	// down whether a reported audio problem is server-side (drops here, encode failures, a
	// stalled PulseAudio capture) or purely client-side.
	totalDrops      uint64 // enqueue() had to evict a queued packet for being full
	encodeFailures  uint64 // Opus encode returned an error and the frame was dropped
	pulseReconnects uint64 // connectAndRun() exited and the supervisor is retrying
	maxCaptureGapMs int64  // longest gap seen between consecutive PulseAudio Write() calls since
	// the last DebugStats() read (reset on each read, not a lifetime max - see DebugStats) -
	// large values mean PulseAudio itself stalled delivering captured audio, not anything in our
	// own encode/send pipeline

	closed chan struct{}
}

// DebugStats is a snapshot of the counters above, for /api/session.
type DebugStats struct {
	Clients         int    `json:"clients"`
	TotalDrops      uint64 `json:"total_drops"`
	EncodeFailures  uint64 `json:"encode_failures"`
	PulseReconnects uint64 `json:"pulse_reconnects"`
	MaxCaptureGapMs int64  `json:"max_capture_gap_ms"`
}

// DebugStats returns a snapshot of the server-side audio diagnostics counters.
//
// TotalDrops/EncodeFailures/PulseReconnects are lifetime totals (counts of discrete events, so
// "how many have ever happened" is itself the useful number). MaxCaptureGapMs is different - a
// worst-value metric is only useful for seeing current health if it reflects "now", so unlike
// the others it's windowed: reading it here also resets it, giving "worst gap since the last
// read" instead of "worst gap since the server started" (which would otherwise permanently
// latch at whatever the single highest gap ever recorded was - e.g. from startup or one past
// quality-change stream swap - long after things are actually fine again).
func (m *Manager) DebugStats() DebugStats {
	m.mu.RLock()
	n := len(m.clients)
	m.mu.RUnlock()
	return DebugStats{
		Clients:         n,
		TotalDrops:      atomic.LoadUint64(&m.totalDrops),
		EncodeFailures:  atomic.LoadUint64(&m.encodeFailures),
		PulseReconnects: atomic.LoadUint64(&m.pulseReconnects),
		MaxCaptureGapMs: atomic.SwapInt64(&m.maxCaptureGapMs, 0),
	}
}

// NewManager creates a new PulseAudio audio manager.
func NewManager(cfg *config.Config) *Manager {
	configuredRate := cfg.AudioSampleRate
	if configuredRate <= 0 {
		configuredRate = 24000
	}
	rate := snapToOpusRate(configuredRate)
	channels := cfg.AudioChannels
	if channels != 1 && channels != 2 {
		channels = 1
	}
	m := &Manager{
		cfg:        cfg,
		clients:    make(map[*ClientSession]struct{}),
		sampleRate: rate,
		channels:   channels,
		spkBuf:     make([]byte, 0, 8192),
		closed:     make(chan struct{}),
	}
	enc, err := newOpusEncoder(rate, channels, opusBitrateFor(rate, channels))
	if err != nil {
		// Non-fatal: recordHandler.Write skips encoding (and thus broadcasting) entirely
		// while opusEnc is nil, so speaker audio is just unavailable rather than crashing
		// the whole session over it.
		log.Printf("[audio] Failed to create initial Opus encoder: %v", err)
	}
	m.opusEnc = enc
	return m
}

// frameBytes returns the byte size of one FrameDurationMs raw-PCM chunk at the current
// format - i.e. how much PulseAudio capture data accumulates into one Opus frame.
func (m *Manager) frameBytes() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.frameBytesLocked()
}

func (m *Manager) frameBytesLocked() int {
	return (m.sampleRate * m.channels * BytesPerSample * FrameDurationMs) / 1000
}

// frameSamplesLocked returns the per-channel sample count of one FrameDurationMs frame -
// the "frame_size" opus_encode expects, independent of channel count.
func (m *Manager) frameSamplesLocked() int {
	return (m.sampleRate * FrameDurationMs) / 1000
}

// CurrentFormat returns the speaker capture format currently in effect.
func (m *Manager) CurrentFormat() (sampleRate, channels int) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.sampleRate, m.channels
}

// currentEncodeParams returns a mutually-consistent snapshot of everything one call to
// recordHandler.Write needs: frameBytes/frameSamples always describe whichever format opusEnc
// was actually built for, even if SetQuality races with a Write() in progress - they're all
// read under a single lock acquisition rather than three separate ones.
func (m *Manager) currentEncodeParams() (frameBytes, frameSamples int, enc *opusEncoder) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.frameBytesLocked(), m.frameSamplesLocked(), m.opusEnc
}

// SetQuality changes the speaker capture sample rate/channel count at runtime. It tears down
// and recreates only the PulseAudio record stream (a fast, sub-second protocol round trip)
// and the Opus encoder - the PulseAudio daemon connection itself is untouched, since
// PulseAudio resamples record streams to whatever rate/channels they ask for regardless of
// the sink's native format. The new format is broadcast to every connected client so they can
// reconfigure their Opus decoder for subsequent speaker frames.
func (m *Manager) SetQuality(sampleRate, channels int) error {
	sampleRate = snapToOpusRate(sampleRate)
	if channels != 1 && channels != 2 {
		return fmt.Errorf("channels must be 1 or 2, got %d", channels)
	}

	m.mu.Lock()
	if m.sampleRate == sampleRate && m.channels == channels {
		m.mu.Unlock()
		return nil
	}
	m.mu.Unlock()

	newEnc, err := newOpusEncoder(sampleRate, channels, opusBitrateFor(sampleRate, channels))
	if err != nil {
		return fmt.Errorf("failed to create opus encoder for %dHz/%dch: %w", sampleRate, channels, err)
	}

	m.mu.Lock()
	m.sampleRate = sampleRate
	m.channels = channels
	oldEnc := m.opusEnc
	m.opusEnc = newEnc
	client := m.pulseClient
	oldStream := m.recStream
	m.recStream = nil
	m.mu.Unlock()

	// Reset the framing accumulator - bytes buffered under the old format are not valid audio
	// in the new one (different bytes-per-sample-frame), so splicing them together would
	// produce noise. Done under spkMu so it can't land in the middle of an in-flight Write()
	// call (which holds spkMu for its whole duration).
	//
	// oldEnc.Close() (opus_encoder_destroy) is closed here too, under the same lock, and not
	// right after the swap above - Write() takes its enc snapshot via currentEncodeParams()
	// and then calls Encode() on it while holding spkMu for the whole batch. Closing oldEnc
	// outside spkMu let a Write() already in flight (still holding a pre-swap encoder
	// snapshot) race opus_encoder_destroy freeing that same C struct out from under it - a
	// use-after-free in libopus, seen as a native SIGSEGV crash rather than a Go panic,
	// reliably reproducible by switching audio quality while audio is actively capturing.
	m.spkMu.Lock()
	m.spkBuf = m.spkBuf[:0]
	if oldEnc != nil {
		oldEnc.Close()
	}
	m.spkMu.Unlock()

	if client != nil {
		newStream, err := m.startRecordStream(client)
		if err != nil {
			log.Printf("[audio] Failed to apply new audio quality (%dHz/%dch): %v", sampleRate, channels, err)
			return err
		}
		m.mu.Lock()
		m.recStream = newStream
		m.mu.Unlock()
		safeCloseRecord(oldStream)
	}

	log.Printf("[audio] Audio quality changed to %dHz, %d channel(s), Opus @ %dbps", sampleRate, channels, opusBitrateFor(sampleRate, channels))

	// Announce the new format under spkMu too - the same lock recordHandler.Write() holds for
	// its entire call, including every broadcastSpeakerFrame() in that batch. Without sharing
	// spkMu here, a Write() call already in flight (still encoding with the *old* opusEnc
	// snapshot it captured before this swap) could enqueue a straggler old-format packet on a
	// client's channel *after* broadcastFormat below already told that client to switch its
	// decoder to the new format - a real bitstream mismatch, audible as a garbled/echoing burst
	// right when quality changes. Holding spkMu here forces this call to wait for any in-flight
	// Write() to fully finish (draining all of its old-format packets first) before the
	// format-change announcement can be enqueued for anyone.
	m.spkMu.Lock()
	m.broadcastFormat()
	m.spkMu.Unlock()
	return nil
}

// Start launches the supervisor loop that manages PulseAudio connection and streams.
func (m *Manager) Start() {
	if !m.cfg.EnableAudio {
		log.Println("[audio] Audio is disabled by configuration")
		return
	}

	if m.cfg.PulseSpawn {
		m.spawner = NewSpawner(m.cfg.VNCAddr, m.cfg.PulseServer)
		serverAddr, err := m.spawner.Start()
		if err != nil {
			log.Printf("[audio] Error spawning headless virtual PulseAudio: %v", err)
		} else {
			m.cfg.PulseServer = serverAddr
		}
	}

	go m.supervisor()
}

// Stop shuts down the manager and closes audio streams.
func (m *Manager) Stop() {
	select {
	case <-m.closed:
		return
	default:
		close(m.closed)
	}

	m.mu.Lock()
	rec := m.recStream
	client := m.pulseClient
	spawner := m.spawner
	enc := m.opusEnc
	m.recStream = nil
	m.pulseClient = nil
	m.spawner = nil
	m.opusEnc = nil
	m.mu.Unlock()

	safeCloseRecord(rec)
	safeCloseClient(client)
	if enc != nil {
		enc.Close()
	}

	if spawner != nil {
		spawner.Stop()
	}
}

func safeCloseRecord(s *pulse.RecordStream) {
	if s == nil {
		return
	}
	defer func() {
		_ = recover()
	}()
	s.Close()
}

func safeCloseClient(c *pulse.Client) {
	if c == nil {
		return
	}
	defer func() {
		_ = recover()
	}()
	c.Close()
}

// RegisterClient registers a new WebSocket client session.
func (m *Manager) RegisterClient() *ClientSession {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Channel buffer holds up to 6 packets (120ms)
	s := &ClientSession{
		SendChan: make(chan []byte, 6),
	}
	m.clients[s] = struct{}{}
	log.Printf("[audio] Client session registered (total: %d)", len(m.clients))
	return s
}

// UnregisterClient removes a client session and cleans up its channel.
func (m *Manager) UnregisterClient(s *ClientSession) {
	m.mu.Lock()
	defer m.mu.Unlock()

	delete(m.clients, s)
	close(s.SendChan)
	log.Printf("[audio] Client session unregistered (total: %d)", len(m.clients))
}

// broadcastSpeakerFrame packages one Opus-encoded 20ms frame with an 8-byte framing header
// and dispatches it to all registered clients using a drop-oldest policy.
func (m *Manager) broadcastSpeakerFrame(opusPacket []byte) {
	seq := uint16(atomic.AddUint32(&m.seqCounter, 1))
	timestamp := NowTimestampMs()

	packet := make([]byte, HeaderSize+len(opusPacket))
	EncodeHeader(packet, StreamTypeSpeaker, FlagCompressed, seq, timestamp)
	copy(packet[HeaderSize:], opusPacket)

	m.mu.RLock()
	defer m.mu.RUnlock()

	for client := range m.clients {
		if client.Muted.Load() {
			continue
		}
		m.enqueue(client, packet)
	}
}

// enqueue sends packet to a client's channel, dropping the oldest queued packet to make room
// if it's full - keeps latency bounded instead of blocking or growing an unbounded backlog.
func (m *Manager) enqueue(client *ClientSession, packet []byte) {
	select {
	case client.SendChan <- packet:
	default:
		atomic.AddUint64(&m.totalDrops, 1)
		select {
		case <-client.SendChan:
		default:
		}
		select {
		case client.SendChan <- packet:
		default:
		}
	}
}

// formatPacket builds a StreamTypeControl-framed JSON message announcing the given format,
// so the browser can decode subsequent speaker frames with the right sample rate/channel count.
func formatPacket(seq uint16, sampleRate, channels int) []byte {
	payload, _ := json.Marshal(struct {
		Action     string `json:"action"`
		SampleRate int    `json:"sample_rate"`
		Channels   int    `json:"channels"`
	}{CtrlAudioFormat, sampleRate, channels})

	packet := make([]byte, HeaderSize+len(payload))
	EncodeHeader(packet, StreamTypeControl, 0, seq, NowTimestampMs())
	copy(packet[HeaderSize:], payload)
	return packet
}

// broadcastFormat announces the current speaker capture format to every connected client.
func (m *Manager) broadcastFormat() {
	rate, channels := m.CurrentFormat()
	seq := uint16(atomic.AddUint32(&m.ctrlSeqCounter, 1))
	packet := formatPacket(seq, rate, channels)

	m.mu.RLock()
	defer m.mu.RUnlock()
	for client := range m.clients {
		m.enqueue(client, packet)
	}
}

// SendCurrentFormat announces the current speaker capture format to a single client - used
// right after a new client registers, so it knows the format before any speaker frames arrive
// instead of assuming a default that may not match.
func (m *Manager) SendCurrentFormat(session *ClientSession) {
	rate, channels := m.CurrentFormat()
	seq := uint16(atomic.AddUint32(&m.ctrlSeqCounter, 1))
	m.enqueue(session, formatPacket(seq, rate, channels))
}

// supervisor maintains connection to PulseAudio daemon.
func (m *Manager) supervisor() {
	backoff := 1 * time.Second
	for {
		select {
		case <-m.closed:
			return
		default:
		}

		err := m.connectAndRun()
		if err != nil {
			atomic.AddUint64(&m.pulseReconnects, 1)
			log.Printf("[audio] PulseAudio connection error: %v. Retrying in %v...", err, backoff)
		}

		select {
		case <-m.closed:
			return
		case <-time.After(backoff):
			if backoff < 10*time.Second {
				backoff *= 2
			}
		}
	}
}

func (m *Manager) connectAndRun() error {
	var opts []pulse.ClientOption
	if m.cfg.PulseServer != "" {
		opts = append(opts, pulse.ClientServerString(m.cfg.PulseServer))
	}
	opts = append(opts, pulse.ClientApplicationName("cnt-vnc-viewer"))

	if m.cfg.PulseCookie != "" {
		_ = os.Setenv("PULSE_COOKIE", m.cfg.PulseCookie)
	}

	client, err := pulse.NewClient(opts...)
	if err != nil {
		return err
	}
	defer safeCloseClient(client)

	log.Printf("[audio] Successfully connected to PulseAudio server (%s)", m.cfg.PulseServer)

	// List available sinks for diagnostic visibility
	if sinks, err := client.ListSinks(); err == nil && len(sinks) > 0 {
		for _, s := range sinks {
			log.Printf("[audio] Found sink: %s (rate: %d)", s.Name(), s.SampleRate())
		}
	}

	m.mu.Lock()
	m.pulseClient = client
	m.mu.Unlock()

	recStream, err := m.startRecordStream(client)
	if err != nil {
		m.mu.Lock()
		m.pulseClient = nil
		m.mu.Unlock()
		return err
	}

	m.mu.Lock()
	m.recStream = recStream
	m.mu.Unlock()

	defer func() {
		// Always close whatever is *currently* the active stream - SetQuality() may have
		// swapped it out for a different one since we created recStream above.
		m.mu.Lock()
		rec := m.recStream
		m.recStream = nil
		m.pulseClient = nil
		m.mu.Unlock()
		safeCloseRecord(rec)
	}()

	// Keep alive until an error occurs or manager is stopped
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-m.closed:
			return nil
		case <-ticker.C:
			m.mu.RLock()
			rec := m.recStream
			m.mu.RUnlock()
			if rec == nil {
				continue
			}
			if rec.Closed() {
				return io.EOF
			}
			if err := rec.Error(); err != nil {
				return err
			}
		}
	}
}

// startRecordStream creates and starts a new PulseAudio record stream using the manager's
// current sampleRate/channels, monitoring the default sink. Does not touch
// m.recStream/m.pulseClient itself - callers decide when to swap those in, so both the
// initial connect and a runtime SetQuality() hot-swap can share this.
func (m *Manager) startRecordStream(client *pulse.Client) (*pulse.RecordStream, error) {
	m.mu.RLock()
	rate := m.sampleRate
	channels := m.channels
	fb := m.frameBytesLocked()
	m.mu.RUnlock()

	recWriter := pulse.NewWriter(&recordHandler{mgr: m}, proto.FormatInt16LE)
	recOpts := []pulse.RecordOption{
		pulse.RecordSampleRate(rate),
		pulse.RecordBufferFragmentSize(uint32(fb)),
		pulse.RecordMediaName("Speaker Monitor"),
	}
	if channels == 2 {
		recOpts = append(recOpts, pulse.RecordStereo)
	} else {
		recOpts = append(recOpts, pulse.RecordMono)
	}

	if defaultSink, err := client.DefaultSink(); err == nil && defaultSink != nil {
		recOpts = append(recOpts, pulse.RecordMonitor(defaultSink))
		log.Printf("[audio] Monitoring default sink: %s", defaultSink.Name())
	} else {
		log.Printf("[audio] Default sink monitor not found (%v), using default record source", err)
	}

	recStream, err := client.NewRecord(recWriter, recOpts...)
	if err != nil {
		return nil, err
	}
	recStream.Start()
	log.Printf("[audio] Audio stream started (%dHz S16LE, %d channel(s), 20ms frames)", rate, channels)
	return recStream, nil
}

// recordHandler receives PCM chunks from PulseAudio monitor and packages into 20ms frames.
type recordHandler struct {
	mgr           *Manager
	lastAudio     time.Time
	lastWriteCall time.Time
}

func (r *recordHandler) Write(p []byte) (int, error) {
	// Track the gap since the previous call - PulseAudio itself stalling (as opposed to
	// anything in our own encode/send pipeline) would show up here as a large gap, since this
	// callback simply wouldn't fire while that's happening. Only one goroutine ever calls
	// Write() (PulseAudio's own delivery), so no locking needed for this field.
	now := time.Now()
	if !r.lastWriteCall.IsZero() {
		gapMs := now.Sub(r.lastWriteCall).Milliseconds()
		for {
			cur := atomic.LoadInt64(&r.mgr.maxCaptureGapMs)
			if gapMs <= cur || atomic.CompareAndSwapInt64(&r.mgr.maxCaptureGapMs, cur, gapMs) {
				break
			}
		}
	}
	r.lastWriteCall = now

	r.mgr.spkMu.Lock()
	defer r.mgr.spkMu.Unlock()

	// Detect non-silent audio signal
	var peak int16
	for i := 0; i < len(p)-1; i += 2 {
		s := int16(binary.LittleEndian.Uint16(p[i : i+2]))
		if s < 0 {
			s = -s
		}
		if s > peak {
			peak = s
		}
	}

	if peak > 250 && time.Since(r.lastAudio) > 5*time.Second {
		r.lastAudio = time.Now()
		log.Printf("[audio] Audio signal active (peak: %d/32767), streaming to clients", peak)
	}

	fb, frameSamples, enc := r.mgr.currentEncodeParams()
	r.mgr.spkBuf = append(r.mgr.spkBuf, p...)
	for len(r.mgr.spkBuf) >= fb {
		rawFrame := r.mgr.spkBuf[:fb]
		r.mgr.spkBuf = r.mgr.spkBuf[fb:]

		if enc == nil {
			continue // no encoder available (e.g. failed to create) - drop rather than crash
		}
		pcm := int16FromPCMBytes(rawFrame)
		opusPacket, err := enc.Encode(pcm, frameSamples)
		if err != nil {
			atomic.AddUint64(&r.mgr.encodeFailures, 1)
			log.Printf("[audio] Opus encode failed, dropping frame: %v", err)
			continue
		}
		r.mgr.broadcastSpeakerFrame(opusPacket)
	}

	return len(p), nil
}
