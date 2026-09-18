// Ring-buffer PCM player. Runs on the browser's dedicated real-time audio rendering thread,
// which the browser gives higher scheduling priority than the main thread and does not throttle
// when the tab is backgrounded. AudioClient.ts pushes decoded PCM here via port.postMessage as
// soon as it's ready; process() below pulls from the buffer on its own fixed schedule
// (~every 128 samples) regardless of what the main thread is doing at that moment. That's the
// property the previous approach (scheduling individual AudioBufferSourceNodes from the main
// thread via source.start()) didn't have - a busy or throttled main thread could delay decode
// output delivery past a buffer's intended start time, forcing an audible resync.
//
// Protocol (messages via the node's port):
//   { type: 'pcm', left: Float32Array, right: Float32Array }  - append PCM (equal length)
//   { type: 'reset' }                                          - drop all buffered audio
// Outgoing (worklet -> main thread), once a second:
//   { type: 'stats', bufferedMs, underrunMs, overflowMs } - underrunMs/overflowMs are the
//   totals accumulated *in that second*, not running totals - see comments below on why.
//
// Always stereo: the main thread duplicates mono content to both channels before sending, so
// this processor never needs to know or care about the capture format's channel count.

const SAMPLE_RATE = 48000;
const CAPACITY_SAMPLES = Math.round(SAMPLE_RATE * 0.4); // 400ms at 48kHz - bounds buffered latency
const STATS_INTERVAL_SAMPLES = SAMPLE_RATE; // report roughly once a second

class PcmPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left = new Float32Array(CAPACITY_SAMPLES);
    this.right = new Float32Array(CAPACITY_SAMPLES);
    this.readIdx = 0;
    this.writeIdx = 0;
    this.buffered = 0;

    // Diagnostics for the "audio drifts behind video over a long session" investigation -
    // underrunSamples is how much silence process() had to fill in because the ring buffer ran
    // dry (the server producing frames slightly slower than real time would show up as this
    // trending upward continuously, not just spiking once); overflowSamples is old audio
    // dropped because too much piled up (the opposite direction). Reset every report so each
    // number reflects that one-second window, not a lifetime total that would hide whether it's
    // still ongoing right now.
    this.underrunSamples = 0;
    this.overflowSamples = 0;
    this.samplesSinceReport = 0;

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === 'reset') {
        this.readIdx = 0;
        this.writeIdx = 0;
        this.buffered = 0;
      } else if (msg.type === 'pcm') {
        this.push(msg.left, msg.right);
      }
    };
  }

  push(left, right) {
    const n = left.length;
    // Would overflow capacity - drop the oldest buffered samples to make room. Keeps latency
    // bounded under sustained overload instead of letting the buffer (and delay) grow forever;
    // this is the ring-buffer equivalent of the old "too far ahead, resync" logic, just without
    // needing any wall-clock math since it's just "don't let more than N ms queue up."
    if (this.buffered + n > CAPACITY_SAMPLES) {
      const drop = this.buffered + n - CAPACITY_SAMPLES;
      this.readIdx = (this.readIdx + drop) % CAPACITY_SAMPLES;
      this.buffered -= drop;
      this.overflowSamples += drop;
    }
    for (let i = 0; i < n; i++) {
      this.left[this.writeIdx] = left[i];
      this.right[this.writeIdx] = right[i];
      this.writeIdx = (this.writeIdx + 1) % CAPACITY_SAMPLES;
    }
    this.buffered += n;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const outL = output[0];
    const outR = output[1] || output[0];
    const n = outL.length;

    const avail = Math.min(n, this.buffered);
    for (let i = 0; i < avail; i++) {
      outL[i] = this.left[this.readIdx];
      outR[i] = this.right[this.readIdx];
      this.readIdx = (this.readIdx + 1) % CAPACITY_SAMPLES;
    }
    this.buffered -= avail;
    // Ran out of buffered audio (network/decode fell behind) - fill the rest with silence
    // rather than stale/garbage samples. Self-heals as soon as more PCM arrives.
    const underrun = n - avail;
    for (let i = avail; i < n; i++) {
      outL[i] = 0;
      outR[i] = 0;
    }
    this.underrunSamples += underrun;

    this.samplesSinceReport += n;
    if (this.samplesSinceReport >= STATS_INTERVAL_SAMPLES) {
      this.port.postMessage({
        type: 'stats',
        bufferedMs: Math.round((this.buffered / SAMPLE_RATE) * 1000),
        underrunMs: Math.round((this.underrunSamples / SAMPLE_RATE) * 1000),
        overflowMs: Math.round((this.overflowSamples / SAMPLE_RATE) * 1000),
      });
      this.underrunSamples = 0;
      this.overflowSamples = 0;
      this.samplesSinceReport = 0;
    }

    return true; // keep this processor alive across render quanta
  }
}

registerProcessor('pcm-player', PcmPlayerProcessor);
