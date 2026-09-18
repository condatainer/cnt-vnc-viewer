package audio

import (
	"encoding/binary"
	"time"
)

// Stream Types
const (
	StreamTypeSpeaker uint8 = 0x01 // Server -> Browser Speaker
	StreamTypeControl uint8 = 0x03 // Bidirectional Control (JSON/config)
)

// Control Message Types (JSON payload)
const (
	CtrlMuteSpeaker     = "mute_speaker"
	CtrlUnmuteSpeaker   = "unmute_speaker"
	CtrlAudioStats      = "audio_stats"
	CtrlSetAudioQuality = "set_audio_quality" // browser -> server: request a new capture sample_rate/channels
	CtrlAudioFormat     = "audio_format"      // server -> browser: the sample_rate/channels currently in effect
)

// HeaderSize is the 8-byte binary framing header:
// [0] Stream Type (0x01=Speaker, 0x03=Control)
// [1] Flags (bit 0: compressed, bit 1: discontinuity)
// [2..3] Sequence Number (uint16 big-endian)
// [4..7] Timestamp (uint32 big-endian, millisecond or sample timestamp)
const HeaderSize = 8

// FlagCompressed marks a StreamTypeSpeaker packet's payload as Opus-encoded (as opposed to
// raw PCM). Every speaker frame carries this today - the reserved bit exists so a future raw
// fallback (e.g. for a browser without WebCodecs support) could be added without a wire
// format change.
const FlagCompressed uint8 = 1 << 0

// AudioPacket represents an audio packet with parsed header and payload.
type AudioPacket struct {
	StreamType uint8
	Flags      uint8
	Seq        uint16
	Timestamp  uint32
	Payload    []byte
}

// EncodeHeader encodes the 8-byte header into dst. dst must have len >= 8.
func EncodeHeader(dst []byte, streamType, flags uint8, seq uint16, timestamp uint32) {
	dst[0] = streamType
	dst[1] = flags
	binary.BigEndian.PutUint16(dst[2:4], seq)
	binary.BigEndian.PutUint32(dst[4:8], timestamp)
}

// DecodeHeader parses the 8-byte header from src.
func DecodeHeader(src []byte) (streamType, flags uint8, seq uint16, timestamp uint32) {
	if len(src) < HeaderSize {
		return 0, 0, 0, 0
	}
	streamType = src[0]
	flags = src[1]
	seq = binary.BigEndian.Uint16(src[2:4])
	timestamp = binary.BigEndian.Uint32(src[4:8])
	return
}

// NowTimestampMs returns milliseconds since a base reference for timestamps.
var startTime = time.Now()

func NowTimestampMs() uint32 {
	return uint32(time.Since(startTime).Milliseconds())
}
