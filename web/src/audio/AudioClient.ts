import { VncConfig, buildWsUrl } from '../url/urlConfig';

export interface AudioDebugStats {
  bufferedMs: number; // worklet: audio currently queued for playback
  underrunMs: number; // worklet: silence inserted this window because the buffer ran dry
  overflowMs: number; // worklet: buffered audio discarded this window (piled up past the cap)
  packetsLostMs: number; // main thread: network/server-side loss detected via seq gaps this window
  decodeDropsMs: number; // main thread: audio dropped because the Opus decoder's own queue backed up
  maxStallMs: number; // main thread: worst gap this window between expected and actual timer firing
  reconnectCount: number; // cumulative: how many times the audio WebSocket has had to reconnect
  heapMB: number | null; // main thread: JS heap size right now (Chrome-only; null elsewhere)
  // Raw bytes received on the audio WebSocket in roughly the last second (Opus-encoded, over
  // the wire) - for total bandwidth alongside VncClient's netKBPerSec (video/control channel).
  netKBPerSec: number;
}

type WorkletMessage = { type: 'pcm'; left: Float32Array; right: Float32Array } | { type: 'reset' };

export interface AudioCallbacks {
  onSpeakerState?: (active: boolean) => void;
  onError?: (err: string) => void;
  // Fired roughly once a second with combined playback/decode/network diagnostics - see
  // AudioDebugStats for what each field means and what it's useful for distinguishing.
  onDebugStats?: (stats: AudioDebugStats) => void;
}

// If the Opus decoder's own internal queue backs up past this many pending chunks (~300ms
// worth), stop feeding it and drop frames instead. WebCodecs decoders have no built-in backpressure
// - decode() just keeps accepting work - so without this cap, any sustained reason decode can't
// keep up with real time (CPU pressure, main-thread contention) lets that queue grow without
// bound: each queued chunk holds its own copied buffer, so this is a real unbounded memory/CPU
// leak, not just an audio glitch, and left running long enough is consistent with a tab that
// eventually hangs while a fresh tab (empty queue) is fine.
const DECODE_QUEUE_LIMIT = 15;

const STREAM_SPEAKER = 0x01;
const STREAM_CONTROL = 0x03;
const HEADER_SIZE = 8;
// Output rate for the AudioContext itself - independent of the capture sample rate the server
// sends (this.sampleRate below). Decoded PCM is upsampled to this rate (see upsampleLinearInto)
// before reaching the playback worklet, which always operates at the context's native rate.
const AUDIO_CONTEXT_SAMPLE_RATE = 48000;
// Matches the server's FrameDurationMs (pkg/audio/manager.go) - every Opus packet covers
// exactly this much audio, so EncodedAudioChunk timestamps just increment by this uniformly.
const FRAME_DURATION_US = 20000;
// Samples of silence to insert per lost frame when a packet-loss gap is detected, expressed at
// the AudioContext's own rate since that's what reaches the playback worklet. This is also
// exactly one 20ms frame's sample count at 48kHz - the largest a decoded frame's *output* (post-
// upsample) ever is, regardless of capture rate, which is why it doubles as the scratch buffer
// size in pushDecodedAudio below.
const GAP_SILENCE_SAMPLES_PER_FRAME = Math.round((AUDIO_CONTEXT_SAMPLE_RATE * FRAME_DURATION_US) / 1e6);

// Upsamples src (numFrames samples) by an integer ratio via linear interpolation, writing into
// the caller-provided out buffer instead of allocating a new one - see pushDecodedAudio for why
// that matters. Opus's 5 valid rates (8k/12k/16k/24k/48k) all evenly divide the AudioContext's
// fixed 48kHz output rate, so ratio is always a small positive integer (6, 4, 3, 2, or 1) - no
// fractional resampling needed. Done here rather than relying on the Opus decoder to output
// 48kHz directly, since that behavior isn't something WebCodecs guarantees across browsers.
function upsampleLinearInto(src: Float32Array, numFrames: number, ratio: number, out: Float32Array): void {
  if (ratio === 1) {
    out.set(numFrames === src.length ? src : src.subarray(0, numFrames));
    return;
  }
  for (let i = 0; i < numFrames; i++) {
    const a = src[i];
    const b = i + 1 < numFrames ? src[i + 1] : a;
    for (let k = 0; k < ratio; k++) {
      out[i * ratio + k] = a + (b - a) * (k / ratio);
    }
  }
}

export class AudioClient {
  private config: VncConfig;
  private callbacks: AudioCallbacks;

  private ws: WebSocket | null = null;
  private audioCtx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private running: boolean = false;
  private reconnectTimer: number | null = null;

  // Speaker playback state. ?audio=0 seeds this true (start muted) rather than preventing the
  // pipeline from starting at all - the client can always unmute via the normal speaker button
  // afterward. The only thing that should ever make the button non-functional is the server
  // having no audio backend at all (see LeftRail.setSpeakerDisabled / main.ts), since that's the
  // one case no client-side action can fix.
  private speakerMuted: boolean;
  private volume: number = 1.0;

  // Playback worklet: a ring-buffer PCM player running on the dedicated real-time audio thread
  // (see public/audio-worklet-processor.js). Decoded PCM is pushed to it via port.postMessage;
  // it pulls from its own buffer on the audio thread's own schedule, so it isn't blocked by main
  // thread jank (DevTools overlay work, GC, another process eating CPU) or background-tab
  // throttling the way scheduling individual AudioBufferSourceNodes from the main thread was.
  private workletNode: AudioWorkletNode | null = null;
  // PCM pushes that arrived before the worklet module finished loading (audioWorklet.addModule
  // is async) - flushed once it's ready.
  private pendingWorkletMessages: WorkletMessage[] = [];

  // Reused every call instead of allocating fresh Float32Arrays per 20ms frame (50/sec) - that
  // churn was a real, measurable chunk of steady-state heap growth (visible in the debug
  // overlay as heapMB climbing between GCs), not just a style preference. Sized to the largest
  // any of these ever needs to be: GAP_SILENCE_SAMPLES_PER_FRAME (960) covers both a 48kHz
  // capture's raw decoded frame and the fixed 960-sample upsampled output at every capture rate.
  // Safe to reuse synchronously like this because postMessage's structured clone (see
  // postToWorklet) copies the data out before the call returns - nothing async holds a
  // reference to these past that point.
  private readonly scratchSrcLeft = new Float32Array(GAP_SILENCE_SAMPLES_PER_FRAME);
  private readonly scratchSrcRight = new Float32Array(GAP_SILENCE_SAMPLES_PER_FRAME);
  private readonly scratchOutLeft = new Float32Array(GAP_SILENCE_SAMPLES_PER_FRAME);
  private readonly scratchOutRight = new Float32Array(GAP_SILENCE_SAMPLES_PER_FRAME);
  private lastSeq: number | null = null;

  // Capture format currently in effect - authoritative value always comes from the server's
  // 'audio_format' control message (sent on connect and whenever quality changes), since this
  // is a session-wide setting another browser tab may have already changed. These defaults are
  // only used for the brief window before that first message arrives.
  private sampleRate: number = 24000;
  private channels: number = 1;

  // Opus decode. Lazily (re)created to match the current sampleRate/channels - WebCodecs
  // requires the config to be fixed at construction, so a format change means a fresh decoder,
  // not reconfiguring the existing one.
  private opusDecoder: AudioDecoder | null = null;
  private opusTimestampUs: number = 0;
  private readonly opusSupported: boolean = typeof AudioDecoder !== 'undefined';
  private warnedUnsupported: boolean = false;

  // Diagnostics (see AudioDebugStats) - the *Ms fields accumulate within the current ~1s
  // window and reset every time they're reported (piggybacked on the worklet's own once-a-
  // second 'stats' message, see setupWorklet); reconnectCount is a running total instead since
  // reconnects are rare enough that a per-window count isn't useful.
  private packetsLostMsWindow: number = 0;
  private decodeDropsMsWindow: number = 0;
  private reconnectCount: number = 0;
  private maxStallMsWindow: number = 0;
  private lastStallTickTime: number = 0;
  private netBytesWindow: number = 0;

  constructor(config: VncConfig, callbacks: AudioCallbacks = {}) {
    this.config = config;
    this.callbacks = callbacks;
    this.speakerMuted = !config.audio;
    this.startStallMonitor();
  }

  // A lightweight self-rescheduling timer expected to fire every 50ms. The *actual* gap between
  // ticks reveals how long the main thread was blocked (GC pause, a long synchronous task,
  // another process starving this one) - directly answers "is this a GC/main-thread issue"
  // instead of guessing from indirect symptoms like underrun alone.
  private startStallMonitor(): void {
    this.lastStallTickTime = performance.now();
    const tick = () => {
      const now = performance.now();
      const delta = now - this.lastStallTickTime;
      if (delta > this.maxStallMsWindow) this.maxStallMsWindow = delta;
      this.lastStallTickTime = now;
      setTimeout(tick, 50);
    };
    setTimeout(tick, 50);
  }

  public async start(): Promise<void> {
    if (this.running && this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.running = true;

    this.connectWs();
  }

  public stop(): void {
    this.running = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      try {
        this.ws.close(1000, 'Client stopped');
      } catch {}
      this.ws = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
    this.gainNode = null;
    this.workletNode = null;
    this.resetPlayback();
    this.closeOpusDecoder();
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'none';
    }
    if (this.callbacks.onSpeakerState) {
      this.callbacks.onSpeakerState(false);
    }
  }

  public setVolume(val: number): void {
    this.volume = Math.max(0, Math.min(1, val));
    if (this.gainNode && !this.speakerMuted) {
      this.gainNode.gain.value = this.volume;
    }
  }

  public toggleSpeaker(): boolean {
    this.speakerMuted = !this.speakerMuted;

    if (this.speakerMuted) {
      // Muting: cancel pending Web Audio schedules, set gain to 0, suspend AudioContext, notify backend
      if (this.gainNode && this.audioCtx) {
        try {
          this.gainNode.gain.cancelScheduledValues(this.audioCtx.currentTime);
          this.gainNode.gain.setValueAtTime(0, this.audioCtx.currentTime);
        } catch {}
      }
      if (this.audioCtx && this.audioCtx.state === 'running') {
        this.audioCtx.suspend().catch(() => {});
      }
      this.sendControl('mute_speaker');
    } else {
      // Unmuting: resume AudioContext, restore gain, notify backend
      const ctx = this.initAudioContext();
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
      if (this.gainNode) {
        try {
          this.gainNode.gain.cancelScheduledValues(ctx.currentTime);
          this.gainNode.gain.setValueAtTime(this.volume, ctx.currentTime);
        } catch {}
      }
      this.resetPlayback();
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
        this.connectWs();
      } else if (this.ws.readyState === WebSocket.OPEN) {
        this.sendControl('unmute_speaker');
      }
    }

    this.updateMediaSession();

    if (this.callbacks.onSpeakerState) {
      this.callbacks.onSpeakerState(!this.speakerMuted);
    }
    return !this.speakerMuted;
  }

  public isSpeakerActive(): boolean {
    return !this.speakerMuted && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  public resume(): void {
    if (!this.audioCtx) {
      this.initAudioContext();
    } else if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }
  }

  // --------------------------------------------------------------------------
  // Speaker Playback Engine
  // --------------------------------------------------------------------------

  private connectWs(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const url = buildWsUrl('ws/audio', this.config);

    try {
      this.ws = new WebSocket(url);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onmessage = this.handleWsMessage.bind(this);
      this.ws.onerror = () => {
        if (this.callbacks.onError) this.callbacks.onError('Audio WebSocket error');
      };
      this.ws.onclose = () => {
        console.log('[Audio] WebSocket closed');
        if (this.callbacks.onSpeakerState) this.callbacks.onSpeakerState(false);

        // Auto-reconnect in 2s if still running
        if (this.running && this.reconnectTimer === null) {
          this.reconnectTimer = window.setTimeout(() => {
            this.reconnectTimer = null;
            if (this.running) {
              console.log('[Audio] Reconnecting audio stream...');
              this.reconnectCount++;
              this.connectWs();
            }
          }, 2000);
        }
      };
      this.ws.onopen = () => {
        console.log('[Audio] WebSocket connected successfully');
        // Synchronize mute state with backend
        this.sendControl(this.speakerMuted ? 'mute_speaker' : 'unmute_speaker');
        // Apply this browser's configured quality. Harmless no-op if it's already the format
        // in effect (e.g. another tab, or a previous connection from this same tab, already
        // set it) - the server only actually swaps the capture stream when it differs.
        this.setAudioQuality(this.config.audioSampleRate, this.config.audioChannels);
        if (this.callbacks.onSpeakerState) {
          this.callbacks.onSpeakerState(!this.speakerMuted);
        }
      };
    } catch (e: any) {
      if (this.callbacks.onError) this.callbacks.onError(`Audio error: ${e?.message || e}`);
    }
  }

  private initAudioContext(): AudioContext {
    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
      this.audioCtx = new AudioCtxClass({ sampleRate: AUDIO_CONTEXT_SAMPLE_RATE, latencyHint: 'interactive' });
      this.gainNode = this.audioCtx.createGain();
      this.gainNode.gain.value = this.speakerMuted ? 0 : this.volume;
      this.gainNode.connect(this.audioCtx.destination);

      this.initMediaSession();
      this.resetPlayback();
      this.setupWorklet(this.audioCtx);
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }
    return this.audioCtx;
  }

  // Loads the playback worklet module (public/audio-worklet-processor.js, served as a static
  // asset - see vite.config.ts's public dir handling) and wires it to the gain node. Resolved
  // relative to the current page via document.baseURI so this keeps working if the app is ever
  // served from a subpath (the build's own base: './' setting implies that's a real scenario).
  private setupWorklet(ctx: AudioContext): void {
    this.workletNode = null;
    const workletUrl = new URL('audio-worklet-processor.js', document.baseURI).href;
    ctx.audioWorklet
      .addModule(workletUrl)
      .then(() => {
        // The context may have been replaced or closed while this load was in flight.
        if (this.audioCtx !== ctx) return;
        const node = new AudioWorkletNode(ctx, 'pcm-player', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        node.connect(this.gainNode!);
        node.port.onmessage = (event) => {
          if (event.data?.type !== 'stats') return;
          if (this.callbacks.onDebugStats) {
            const heap = (performance as any).memory?.usedJSHeapSize;
            this.callbacks.onDebugStats({
              bufferedMs: event.data.bufferedMs,
              underrunMs: event.data.underrunMs,
              overflowMs: event.data.overflowMs,
              packetsLostMs: this.packetsLostMsWindow,
              decodeDropsMs: this.decodeDropsMsWindow,
              maxStallMs: Math.round(this.maxStallMsWindow),
              reconnectCount: this.reconnectCount,
              heapMB: heap !== undefined ? Math.round(heap / 1e6) : null,
              netKBPerSec: Math.round(this.netBytesWindow / 1024),
            });
          }
          // Reset windowed counters now that they've been reported - reconnectCount is
          // deliberately excluded, it's a running total.
          this.packetsLostMsWindow = 0;
          this.decodeDropsMsWindow = 0;
          this.maxStallMsWindow = 0;
          this.netBytesWindow = 0;
        };
        this.workletNode = node;
        for (const msg of this.pendingWorkletMessages) {
          node.port.postMessage(msg);
        }
        this.pendingWorkletMessages = [];
      })
      .catch((e) => {
        console.error('[Audio] Failed to load playback worklet:', e);
        if (this.callbacks.onError) {
          this.callbacks.onError('Failed to initialize audio playback worklet.');
        }
      });
  }

  // Sends a message to the playback worklet, or queues it if the worklet module hasn't finished
  // loading yet (addModule is async, but decode output can start arriving before it resolves).
  private postToWorklet(data: WorkletMessage): void {
    if (this.workletNode) {
      // postMessage's structured clone copies left/right out synchronously before this call
      // returns, so it's safe for the caller to reuse those buffers (scratchOutLeft/Right)
      // immediately afterward - see their declaration for why that matters.
      this.workletNode.port.postMessage(data);
    } else {
      // Not ready yet, so no synchronous clone is about to happen for us - if data.left/right
      // are the reusable scratch buffers, they'd otherwise get overwritten by the next frame
      // before this queue is ever flushed. Snapshot now instead (slice() allocates, but this
      // only happens during the brief one-time window before the worklet loads, not steady
      // state).
      if (data.type === 'pcm') {
        const left = data.left.slice();
        this.pendingWorkletMessages.push({ type: 'pcm', left, right: data.right === data.left ? left : data.right.slice() });
      } else {
        this.pendingWorkletMessages.push(data);
      }
    }
  }

  private initMediaSession(): void {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: 'Remote Desktop Audio',
        artist: 'cnt-vnc-viewer',
        album: 'TurboVNC / XFCE4 Session',
      });
      this.updateMediaSession();

      try {
        navigator.mediaSession.setActionHandler('play', () => {
          if (this.speakerMuted) this.toggleSpeaker();
        });
        navigator.mediaSession.setActionHandler('pause', () => {
          if (!this.speakerMuted) this.toggleSpeaker();
        });
        navigator.mediaSession.setActionHandler('stop', () => {
          this.stop();
        });
      } catch (e) {
        // Some browser engines don't implement all actions
      }
    }
  }

  private updateMediaSession(): void {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = this.speakerMuted ? 'paused' : 'playing';
    }
  }

  private handleWsMessage(event: MessageEvent): void {
    if (!this.running) return;
    if (!(event.data instanceof ArrayBuffer)) return;
    this.netBytesWindow += event.data.byteLength;
    const buf = new Uint8Array(event.data);
    if (buf.length < HEADER_SIZE) return;

    const streamType = buf[0];
    if (streamType === STREAM_CONTROL) {
      this.handleControlMessage(buf.subarray(HEADER_SIZE));
      return;
    }
    if (streamType !== STREAM_SPEAKER) return;
    if (this.speakerMuted) return;

    // Header: [0] stream type, [1] flags, [2..3] seq (big-endian uint16), [4..7] timestamp.
    const seq = (buf[2] << 8) | buf[3];
    const opusPacket = buf.subarray(HEADER_SIZE);
    this.decodeOpusPacket(opusPacket, seq);
  }

  private handleControlMessage(payload: Uint8Array): void {
    try {
      const msg = JSON.parse(new TextDecoder().decode(payload));
      if (msg.action === 'audio_format' && msg.sample_rate && msg.channels) {
        if (msg.sample_rate === this.sampleRate && msg.channels === this.channels && this.opusDecoder) {
          return; // already configured for this format - nothing to do
        }
        console.log(`[Audio] Format now ${msg.sample_rate}Hz, ${msg.channels}ch`);
        this.sampleRate = msg.sample_rate;
        this.channels = msg.channels;
        // WebCodecs config is fixed at construction time - a format change means a fresh
        // decoder, not reconfiguring the existing one. Lazily recreated on the next packet.
        this.closeOpusDecoder();
        this.opusTimestampUs = 0;
        // Anything already buffered in the worklet was decoded for the old format's channel
        // layout - drop it rather than let a stale/mismatched frame play.
        this.resetPlayback();
      }
    } catch {
      // Ignore malformed control payloads
    }
  }

  // Decodes one Opus packet via WebCodecs and schedules the result for playback. Silently
  // drops packets (after one console warning) if this browser has no AudioDecoder - Opus
  // decode isn't available anywhere else client-side.
  private decodeOpusPacket(opusPacket: Uint8Array, seq: number): void {
    if (!this.opusSupported) {
      if (!this.warnedUnsupported) {
        this.warnedUnsupported = true;
        console.warn('[Audio] This browser has no WebCodecs AudioDecoder - speaker audio is unavailable.');
        if (this.callbacks.onError) {
          this.callbacks.onError('This browser does not support Opus audio decoding - speaker audio is unavailable.');
        }
      }
      return;
    }

    // The server's send queue drops the *oldest* packet under congestion (see enqueue() in
    // pkg/audio/manager.go), so a jump in seq means real audio content is missing, not just
    // arriving late. Push explicit silence for the missing span instead of just letting the
    // next packet play immediately - without this the ring buffer would simply have that much
    // less audio in it, quietly shortening the stream relative to real elapsed time (the
    // timeline "catching up" is what a drop sounds like as a brief speed-up).
    if (this.lastSeq !== null) {
      const expected = (this.lastSeq + 1) & 0xffff;
      if (seq !== expected) {
        const gap = (seq - expected) & 0xffff;
        if (gap > 0 && gap < 1000) {
          console.warn(`[Audio] Lost ${gap} packet(s) (~${gap * (FRAME_DURATION_US / 1000)}ms) - inserting silence instead of skipping ahead`);
          this.packetsLostMsWindow += gap * (FRAME_DURATION_US / 1000);
          this.pushSilence(gap);
        }
        // else: huge or negative gap (e.g. a fresh connection, or seq wrapped unexpectedly) -
        // don't try to bridge it, just carry on from here.
      }
    }
    this.lastSeq = seq;

    if (!this.opusDecoder) {
      this.opusDecoder = new AudioDecoder({
        output: (audioData) => {
          this.pushDecodedAudio(audioData);
          audioData.close();
        },
        error: (e) => {
          console.warn('[Audio] Opus decode error:', e);
        },
      });
      this.opusDecoder.configure({
        codec: 'opus',
        sampleRate: this.sampleRate,
        numberOfChannels: this.channels,
      });
    }

    if (this.opusDecoder.state !== 'configured') return;

    // Backpressure guard - see DECODE_QUEUE_LIMIT. Drop this frame as silence rather than let
    // decode() keep accepting work the decoder can't keep up with.
    if (this.opusDecoder.decodeQueueSize > DECODE_QUEUE_LIMIT) {
      this.decodeDropsMsWindow += FRAME_DURATION_US / 1000;
      this.pushSilence(1);
      this.opusTimestampUs += FRAME_DURATION_US;
      return;
    }

    try {
      // Opus frames are all independently decodable (no inter-frame prediction across
      // packets), so every chunk is a 'key' frame.
      const chunk = new EncodedAudioChunk({
        type: 'key',
        timestamp: this.opusTimestampUs,
        data: opusPacket,
      });
      this.opusDecoder.decode(chunk);
      this.opusTimestampUs += FRAME_DURATION_US;
    } catch (e) {
      console.warn('[Audio] Failed to decode Opus packet:', e);
    }
  }

  private closeOpusDecoder(): void {
    if (this.opusDecoder) {
      try {
        if (this.opusDecoder.state !== 'closed') this.opusDecoder.close();
      } catch {}
      this.opusDecoder = null;
    }
  }

  // Drops everything buffered in the playback worklet and any not-yet-sent pushes. Called
  // whenever the audio timeline is being discarded outright - a format change, mute/unmute, or
  // stop - so stale audio can't keep sounding underneath whatever plays next.
  private resetPlayback(): void {
    this.lastSeq = null;
    this.pendingWorkletMessages = [];
    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'reset' });
    }
  }

  // Converts one decoded Opus frame's PCM to stereo Float32 at the AudioContext's sample rate
  // and pushes it to the playback worklet's ring buffer. No scheduling/timing decisions happen
  // here - the worklet just plays back whatever arrives, in order, on its own clock; that's what
  // keeps this immune to main-thread jank instead of needing explicit resync logic.
  private pushDecodedAudio(audioData: AudioData): void {
    this.initAudioContext();

    const numFrames = audioData.numberOfFrames;
    const numChannels = audioData.numberOfChannels;
    if (numFrames === 0) return;

    const srcLeft = this.scratchSrcLeft.subarray(0, numFrames);
    audioData.copyTo(srcLeft, { planeIndex: 0, format: 'f32-planar' });
    const hasRight = numChannels >= 2;
    const srcRight = hasRight ? this.scratchSrcRight.subarray(0, numFrames) : srcLeft;
    if (hasRight) {
      audioData.copyTo(srcRight, { planeIndex: 1, format: 'f32-planar' });
    }

    const ratio = AUDIO_CONTEXT_SAMPLE_RATE / audioData.sampleRate;
    upsampleLinearInto(srcLeft, numFrames, ratio, this.scratchOutLeft);
    if (hasRight) {
      upsampleLinearInto(srcRight, numFrames, ratio, this.scratchOutRight);
    }

    this.postToWorklet({
      type: 'pcm',
      left: this.scratchOutLeft,
      right: hasRight ? this.scratchOutRight : this.scratchOutLeft,
    });
  }

  // Inserts silence for a detected run of lost packets, at the AudioContext's sample rate (the
  // worklet never sees the capture rate). A gap can span many frames (up to 999 per the caller's
  // own cap) so this can't reuse the fixed one-frame scratch buffers above - it's also a rare,
  // not every-20ms path, so allocating here doesn't meaningfully contribute to steady-state
  // churn the way pushDecodedAudio's per-frame path did.
  private pushSilence(gapFrames: number): void {
    this.initAudioContext();
    const samples = gapFrames * GAP_SILENCE_SAMPLES_PER_FRAME;
    const left = new Float32Array(samples);
    const right = new Float32Array(samples);
    this.postToWorklet({ type: 'pcm', left, right });
  }

  // Requests the server change the shared speaker capture format. This is session-wide (every
  // connected tab hears the result), applied by the server via a fast record-stream hot-swap -
  // no restart of PulseAudio or the video connection involved.
  public setAudioQuality(sampleRate: number, channels: number): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ action: 'set_audio_quality', sample_rate: sampleRate, channels }));
    }
  }

  private sendControl(action: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ action }));
    }
  }
}

