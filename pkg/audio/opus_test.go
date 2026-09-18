package audio

import "testing"

func TestOpusEncoderRoundTrip(t *testing.T) {
	for _, tc := range []struct {
		name     string
		rate     int
		channels int
	}{
		{"16kHz mono (Low preset)", 16000, 1},
		{"24kHz mono (Medium preset)", 24000, 1},
		{"48kHz stereo (High preset)", 48000, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			enc, err := newOpusEncoder(tc.rate, tc.channels, opusBitrateFor(tc.rate, tc.channels))
			if err != nil {
				t.Fatalf("newOpusEncoder: %v", err)
			}
			defer enc.Close()

			dec, err := newOpusDecoder(tc.rate, tc.channels)
			if err != nil {
				t.Fatalf("newOpusDecoder: %v", err)
			}
			defer dec.Close()

			frameSamples := (tc.rate * FrameDurationMs) / 1000

			// A synthetic waveform, not silence - silence compresses trivially and wouldn't
			// catch a broken encoder producing garbage-but-tiny output.
			pcm := make([]int16, frameSamples*tc.channels)
			for i := range pcm {
				pcm[i] = int16(10000 * sawtooth(i))
			}

			packet, err := enc.Encode(pcm, frameSamples)
			if err != nil {
				t.Fatalf("Encode: %v", err)
			}
			if len(packet) == 0 {
				t.Fatalf("Encode returned an empty packet")
			}

			rawBytes := len(pcm) * 2
			if len(packet) >= rawBytes {
				t.Errorf("Opus packet (%d bytes) is not smaller than raw PCM (%d bytes) - compression isn't working", len(packet), rawBytes)
			}

			decoded, err := dec.Decode(packet, frameSamples)
			if err != nil {
				t.Fatalf("Decode: %v", err)
			}
			if len(decoded) != len(pcm) {
				t.Fatalf("decoded %d samples, want %d", len(decoded), len(pcm))
			}
			// Lossy codec - don't expect exact equality, just that it's a recognizable,
			// non-silent, non-garbage reconstruction of the input.
			var sumAbs int64
			for _, s := range decoded {
				if s < 0 {
					sumAbs -= int64(s)
				} else {
					sumAbs += int64(s)
				}
			}
			meanAbs := sumAbs / int64(len(decoded))
			if meanAbs < 1000 {
				t.Errorf("decoded audio looks silent/garbage (mean abs amplitude %d, expected a few thousand)", meanAbs)
			}
		})
	}
}

func TestOpusEncoderRejectsWrongFrameSize(t *testing.T) {
	enc, err := newOpusEncoder(16000, 1, opusBitrateFor(16000, 1))
	if err != nil {
		t.Fatalf("newOpusEncoder: %v", err)
	}
	defer enc.Close()

	// 320 samples is the correct 20ms frame size at 16kHz; deliberately pass the wrong count.
	pcm := make([]int16, 100)
	if _, err := enc.Encode(pcm, 320); err == nil {
		t.Errorf("expected an error encoding a PCM slice that doesn't match frameSamples*channels")
	}
}

func TestInt16FromPCMBytesLittleEndian(t *testing.T) {
	// -1 as int16 LE is 0xFF 0xFF; 256 as int16 LE is 0x00 0x01.
	b := []byte{0xFF, 0xFF, 0x00, 0x01}
	got := int16FromPCMBytes(b)
	want := []int16{-1, 256}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("int16FromPCMBytes(%v) = %v, want %v", b, got, want)
	}
}

func TestSnapToOpusRate(t *testing.T) {
	cases := map[int]int{
		8000:  8000,
		11000: 12000,
		16000: 16000,
		20000: 16000, // exact tie between 16000 and 24000 - snapToOpusRate favors the lower one
		22000: 24000,
		44100: 48000,
		96000: 48000,
	}
	for in, want := range cases {
		if got := snapToOpusRate(in); got != want {
			t.Errorf("snapToOpusRate(%d) = %d, want %d", in, got, want)
		}
	}
}

// sawtooth is a cheap deterministic waveform generator (no math.Sin needed) - just enough
// variation to look like real audio rather than silence or a DC offset.
func sawtooth(i int) float64 {
	x := float64(i % 100)
	return (x - 50) / 50
}
