package audio

/*
#cgo LDFLAGS: -lopus
#include <opus/opus.h>
#include <stdlib.h>

// opus_encoder_ctl is a C variadic function, which cgo cannot call directly - this small
// non-variadic shim is the standard way around that for the one control value we need.
static int shim_opus_set_bitrate(OpusEncoder *st, opus_int32 bitrate) {
    return opus_encoder_ctl(st, OPUS_SET_BITRATE(bitrate));
}
*/
import "C"

import (
	"fmt"
	"unsafe"
)

// opusMaxPacketBytes is the output buffer size libopus recommends for opus_encode to
// guarantee it never runs out of room, regardless of input/bitrate.
const opusMaxPacketBytes = 4000

// opusEncoder wraps a single libopus encoder instance for one fixed sample rate/channel
// count/bitrate. Not safe for concurrent use - the caller (Manager) already serializes all
// encode calls through spkMu, since they all originate from the single PulseAudio record
// callback goroutine.
type opusEncoder struct {
	enc      *C.OpusEncoder
	channels int
}

// newOpusEncoder creates an encoder for the given sample rate (must be one of Opus's native
// rates: 8000, 12000, 16000, 24000, 48000 - all of ours are), channel count (1 or 2), and
// target bitrate in bits/second.
func newOpusEncoder(sampleRate, channels, bitrateBps int) (*opusEncoder, error) {
	var cErr C.int
	enc := C.opus_encoder_create(C.opus_int32(sampleRate), C.int(channels), C.OPUS_APPLICATION_AUDIO, &cErr)
	if cErr != C.OPUS_OK || enc == nil {
		return nil, fmt.Errorf("opus_encoder_create(%d, %d) failed: %s", sampleRate, channels, C.GoString(C.opus_strerror(cErr)))
	}
	if ret := C.shim_opus_set_bitrate(enc, C.opus_int32(bitrateBps)); ret != C.OPUS_OK {
		C.opus_encoder_destroy(enc)
		return nil, fmt.Errorf("opus_encoder_ctl(SET_BITRATE=%d) failed: %s", bitrateBps, C.GoString(C.opus_strerror(ret)))
	}
	return &opusEncoder{enc: enc, channels: channels}, nil
}

// Encode encodes one frame of interleaved 16-bit PCM samples (frameSamples samples PER
// CHANNEL - e.g. 320 for a 20ms frame at 16kHz) into a single Opus packet.
func (e *opusEncoder) Encode(pcm []int16, frameSamples int) ([]byte, error) {
	if len(pcm) != frameSamples*e.channels {
		return nil, fmt.Errorf("opus encode: pcm has %d samples, want exactly %d (%d frame samples * %d channels)",
			len(pcm), frameSamples*e.channels, frameSamples, e.channels)
	}
	out := make([]byte, opusMaxPacketBytes)
	n := C.opus_encode(
		e.enc,
		(*C.opus_int16)(unsafe.Pointer(&pcm[0])),
		C.int(frameSamples),
		(*C.uchar)(unsafe.Pointer(&out[0])),
		C.opus_int32(len(out)),
	)
	if n < 0 {
		return nil, fmt.Errorf("opus_encode failed: %s", C.GoString(C.opus_strerror(C.int(n))))
	}
	return out[:n], nil
}

// Close releases the underlying libopus encoder. Safe to call more than once.
func (e *opusEncoder) Close() {
	if e.enc != nil {
		C.opus_encoder_destroy(e.enc)
		e.enc = nil
	}
}

// opusDecoder decodes Opus packets back to PCM. The running server never actually decodes -
// every real client is a browser decoding via WebCodecs - this exists so opus_test.go (a pure
// Go file; this Go toolchain doesn't support cgo directly in _test.go files) can verify
// newOpusEncoder's output round-trips correctly instead of only checking that it compiles.
type opusDecoder struct {
	dec      *C.OpusDecoder
	channels int
}

func newOpusDecoder(sampleRate, channels int) (*opusDecoder, error) {
	var cErr C.int
	dec := C.opus_decoder_create(C.opus_int32(sampleRate), C.int(channels), &cErr)
	if cErr != C.OPUS_OK || dec == nil {
		return nil, fmt.Errorf("opus_decoder_create(%d, %d) failed: %s", sampleRate, channels, C.GoString(C.opus_strerror(cErr)))
	}
	return &opusDecoder{dec: dec, channels: channels}, nil
}

// Decode decodes one Opus packet, returning frameSamples samples per channel, interleaved.
func (d *opusDecoder) Decode(packet []byte, frameSamples int) ([]int16, error) {
	out := make([]int16, frameSamples*d.channels)
	n := C.opus_decode(
		d.dec,
		(*C.uchar)(unsafe.Pointer(&packet[0])),
		C.opus_int32(len(packet)),
		(*C.opus_int16)(unsafe.Pointer(&out[0])),
		C.int(frameSamples),
		0,
	)
	if n < 0 {
		return nil, fmt.Errorf("opus_decode failed: %s", C.GoString(C.opus_strerror(C.int(n))))
	}
	return out[:int(n)*d.channels], nil
}

func (d *opusDecoder) Close() {
	if d.dec != nil {
		C.opus_decoder_destroy(d.dec)
		d.dec = nil
	}
}

// int16FromPCMBytes converts a little-endian interleaved Int16LE byte buffer (PulseAudio's
// wire format, see proto.FormatInt16LE in manager.go) into a []int16 the opus C API can read
// directly. Decoded byte-by-byte via encoding/binary rather than an unsafe reinterpret cast,
// so this doesn't depend on the host also being little-endian.
func int16FromPCMBytes(b []byte) []int16 {
	out := make([]int16, len(b)/2)
	for i := range out {
		out[i] = int16(uint16(b[i*2]) | uint16(b[i*2+1])<<8)
	}
	return out
}

// opusBitrateFor picks a sensible target bitrate for a given capture format. There's no need
// for this to be user-configurable directly - it's derived from the sample rate/channel count
// the user already picks (via the Settings quality presets or a custom URL config value), on
// the same "higher rate implies wanting higher fidelity" assumption that choice already
// implies. Opus is comfortable anywhere from ~6kbps (barely intelligible speech) up into the
// hundreds of kbps; 1.5x the sample rate per channel lands solidly in "very good quality"
// territory across our whole supported range without needing a lookup table.
func opusBitrateFor(sampleRate, channels int) int {
	bps := int(float64(sampleRate)*1.5) * channels
	const minBps = 8000
	const maxBps = 256000
	if bps < minBps {
		return minBps
	}
	if bps > maxBps {
		return maxBps
	}
	return bps
}
