import RFB from '@novnc/novnc';
import { VncConfig, ScaleMode, buildWsUrl } from '../url/urlConfig';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

// noVNC's own _requestRemoteResize() only rate-limits to once every 100ms (see rfb.js) - during
// an active window drag-resize, its ResizeObserver fires on nearly every layout frame, so that
// still allows up to ~10 real SetDesktopSize requests/sec. Each one triggers a genuine RandR
// resize on the X server (clearing/reallocating the framebuffer), which is what's visible as a
// flash. This debounces on top of that: a request only actually goes out once resize activity
// has been quiet for this long, so intermediate sizes mid-drag are never sent at all - only the
// final settled size is.
const REMOTE_RESIZE_DEBOUNCE_MS = 400;

// Diagnostics for noVNC's own rendering pipeline (Display._renderQ + per-rect JPEG decode via
// `new Image()` + data: URI). Unlike the audio path, noVNC's queue only gets a backpressure
// check *between* whole FramebufferUpdate messages (see rfb.js's _framebufferUpdate: it waits
// for display.pending() to flush before reading the next update's rect count) - not between the
// individual rects inside one update. A single heavy-redraw update can still queue up many
// decoded Image objects before any flush happens. These numbers let us see that directly on
// the page instead of guessing, same reasoning as the audio debug overlay (DevTools mid-session
// can crash the tab on this canvas-heavy page).
export interface RenderDebugStats {
  rectsPerSec: number;
  jpegKBPerSec: number;
  // Total raw bytes/sec received on the RFB WebSocket - actual network bandwidth, covering
  // every rect type (JPEG and non-JPEG/"basic") plus protocol framing, unlike jpegKBPerSec
  // above which only counts JPEG-type rects' own payload.
  netKBPerSec: number;
  maxQueueLen: number;
  queueLen: number;
  // Current framebuffer size - rects/s and jpeg KB/s scale with this (more pixels means more
  // tiles and more bytes for the same amount of on-screen change), so it's included right
  // alongside them rather than needing to cross-reference elsewhere while reading the overlay.
  width: number;
  height: number;
}

export interface VncCallbacks {
  onStateChange: (state: ConnectionState, message?: string) => void;
  onDesktopName: (name: string) => void;
  onDesktopResize: (width: number, height: number) => void;
  onServerCutText: (text: string) => void;
  // errorMessage is set on a re-prompt following a failed previous attempt (e.g. wrong
  // password) - see the securityfailure/credentialsrequired handling in hookRfbInternals.
  onPasswordRequired: (errorMessage?: string) => Promise<string>;
  onBell?: () => void;
  onRenderStats?: (stats: RenderDebugStats) => void;
}

export class VncClient {
  private target: HTMLElement;
  private config: VncConfig;
  private callbacks: VncCallbacks;
  private rfb: RFB | null = null;
  private state: ConnectionState = 'disconnected';
  // Tracks the mode we last actually applied to the rfb object. `config.scale` can't be
  // used for this - main.ts's setAppScaleMode() mutates that shared object to the *new*
  // mode before calling setScaleMode() below, so by the time this class ever reads it,
  // it no longer reflects what mode we were previously in.
  private appliedScaleMode: ScaleMode | null = null;
  // Transient scratch value read by the hooked _screenSize() below during a single
  // sendOneShotResize() call - null the rest of the time, never persists across calls. Note
  // this is itself a legitimate one-shot target (requestWindowFitResolution passes null on
  // purpose, meaning "use the container's current size") - inOneShotResize below tracks
  // "a one-shot call is in flight" independently, since checking this field's truthiness would
  // miss exactly that null case.
  private manualResolution: { w: number; h: number } | null = null;
  // True only for the synchronous duration of a sendOneShotResize() call - see the
  // _requestRemoteResize debounce hook in hookRfbInternals for why this needs to be its own
  // flag rather than reusing manualResolution's truthiness.
  private inOneShotResize: boolean = false;
  // The server's launch-time resolution (from ServerInit), captured before any
  // remote-resize ever runs. RandR-driven resizes permanently mutate the actual
  // remote desktop - nothing restores this automatically, so we do it ourselves
  // when leaving remote-resize mode.
  private nativeResolution: { w: number; h: number } | null = null;
  // True once nativeResolution came from the backend's own launch config (/api/session)
  // rather than being inferred from a live ServerInit report. The backend value is always
  // correct (it's what vncserver was actually started with) and survives page reloads;
  // an inferred one can be wrong if the desktop was already RandR-resized before we ever
  // connected (e.g. reconnecting mid-session after a reload). Once authoritative, an
  // inferred value is never allowed to overwrite it - but a later-arriving authoritative
  // value (the /api/session fetch can resolve after the first ServerInit) still can.
  private nativeResolutionAuthoritative: boolean = false;
  // Bumped on every connect()/disconnect(). Event listeners attached in attachEventListeners()
  // close over the id that was current when they were bound and check it before acting - so a
  // stale async event arriving late from an rfb instance we've already torn down (e.g. its
  // 'disconnect' event, which only fires once the WebSocket finishes closing - can take a
  // moment) can never overwrite the state of a newer connection or bounce the UI after an
  // explicit stop.
  private connectionId: number = 0;

  // Set by the securityfailure handler, read (and cleared) by the next credentialsrequired -
  // VNC auth failure closes the connection outright (no "try again on the same socket"), so
  // surfacing the reason to a re-prompt means carrying it across that reconnect cycle.
  private lastAuthError: string | null = null;

  // Render-queue diagnostics window counters (see RenderDebugStats above), reset every report.
  private renderRectCountWindow: number = 0;
  private renderBytesWindow: number = 0;
  private netBytesWindow: number = 0;
  private maxRenderQLenWindow: number = 0;
  private renderStatsTimer: number | null = null;

  // Debounces remote-resize requests - see the _requestRemoteResize hook in hookRfbInternals.
  private remoteResizeDebounceTimer: number | null = null;

  constructor(target: HTMLElement, config: VncConfig, callbacks: VncCallbacks) {
    this.target = target;
    this.config = config;
    this.callbacks = callbacks;
  }

  public connect(): void {
    if (this.rfb) {
      this.teardownRfb();
    }
    const myId = ++this.connectionId;

    if (!this.nativeResolutionAuthoritative) {
      this.nativeResolution = null;
    }
    this.setState('connecting', 'Connecting to VNC proxy...');

    const url = buildWsUrl('ws/rfb', this.config);

    console.log(`[cnt-vnc] Connecting noVNC RFB to: ${url}`);

    try {
      this.rfb = new RFB(this.target, url, {
        wsProtocols: ['binary'],
        credentials: {
          password: this.config.password || undefined,
        },
      });

      this.hookRfbInternals();
      this.applyConfig();
      this.attachEventListeners(myId);
      this.startRenderStats();
    } catch (err: any) {
      console.error('[cnt-vnc] Failed to initialize noVNC RFB:', err);
      this.setState('error', `Failed to initialize VNC client: ${err?.message || err}`);
    }
  }

  public disconnect(): void {
    this.teardownRfb();
    this.setState('disconnected', 'Disconnected');
  }

  // Tears down the current rfb instance without announcing a 'disconnected' state - shared by
  // the public disconnect() above (which does announce one) and connect()'s own pre-teardown of
  // a stale rfb instance, and by the immediate reconnect-on-auth-failure path in
  // attachEventListeners (which deliberately avoids the generic error/toast/reconnect-delay
  // path - see the securityfailure handler).
  private teardownRfb(): void {
    // Invalidate any listeners still bound to the rfb instance being torn down below, before
    // anything else - so its late-arriving 'disconnect' event (the close handshake is async
    // and can take up to a few seconds) can never fire setState() after this point.
    this.connectionId++;
    this.stopRenderStats();
    if (this.remoteResizeDebounceTimer !== null) {
      window.clearTimeout(this.remoteResizeDebounceTimer);
      this.remoteResizeDebounceTimer = null;
    }
    if (this.rfb) {
      try {
        this.rfb.disconnect();
      } catch {
        // ignore
      }
      this.rfb = null;
    }
  }

  public getState(): ConnectionState {
    return this.state;
  }

  public setQuality(quality: number): void {
    this.config.quality = quality;
    if (this.rfb) {
      this.rfb.qualityLevel = quality;
    }
  }

  public setCompression(compression: number): void {
    this.config.compression = compression;
    if (this.rfb) {
      this.rfb.compressionLevel = compression;
    }
  }

  public setViewOnly(viewOnly: boolean): void {
    this.config.viewOnly = viewOnly;
    if (this.rfb) {
      this.rfb.viewOnly = viewOnly;
    }
  }

  // Mirrors what noVNC's own reference UI does: just set the three public
  // properties below and let noVNC's setters (and the _updateScale hook
  // above) handle _updateClip/_updateScale/_requestRemoteResize themselves.
  // Poking those private methods directly here caused two bugs: redundant/
  // racy calls left remote-resize stuck, and a trailing _updateScale() call
  // was resetting the DPI scale back to 1.0 right after setting it.
  public setScaleMode(mode: ScaleMode): void {
    const leavingRemoteResize = this.appliedScaleMode === 'remote-resize' && mode !== 'remote-resize';
    this.appliedScaleMode = mode;
    this.config.scale = mode;
    if (!this.rfb) return;

    if (mode === 'remote-resize') {
      this.rfb.scaleViewport = false;
      this.rfb.clipViewport = false;
      this.rfb.resizeSession = true;
    } else if (mode === 'fit' || mode === 'down') {
      if (leavingRemoteResize) this.restoreNativeResolution();
      this.rfb.resizeSession = false;
      this.rfb.clipViewport = false;
      this.rfb.scaleViewport = true;
    } else if (mode === 'none') {
      if (leavingRemoteResize) this.restoreNativeResolution();
      this.rfb.resizeSession = false;
      this.rfb.scaleViewport = false;
      this.rfb.clipViewport = true;
    }

    // Pan mode (see setPanMode) only makes sense in 'none' - clipViewport is the only mode
    // where the framebuffer can be larger than the visible canvas at all. Defensively reset it
    // when leaving 'none' so it can never get stuck on and silently steal drag input in a mode
    // where it does nothing useful.
    if (mode !== 'none') {
      this.setPanMode(false);
    }
  }

  // Toggles noVNC's own dragViewport behavior: while enabled, click-and-drag pans the clipped
  // viewport around the (possibly larger) framebuffer instead of being forwarded to the remote
  // desktop as a normal mouse drag. Only meaningful in 'none' (1:1) scale mode, where clipViewport
  // keeps the visible canvas element clamped to the container size - there's no browser-native
  // scrollbar for this (see assets/test/NOTES.md-adjacent discussion: the canvas never actually
  // overflows its container in the DOM, so overflow:auto has nothing to trigger on). An explicit
  // toggle (rather than always-on) is deliberate: dragViewport intercepts ALL mouse-button drags
  // uniformly, so leaving it on all the time would mean losing normal click-drag interaction with
  // the remote desktop (text selection, dragging windows, etc.) in 1:1 mode.
  public setPanMode(enabled: boolean): void {
    if (this.rfb) {
      this.rfb.dragViewport = enabled;
    }
    this.target.classList.toggle('pan-mode', enabled);
  }

  // DPI only applies to 'remote-resize' mode: it's the multiplier RandR is asked to render
  // at on every auto-fit request, not a general client-side zoom (that's what scaleViewport/
  // 'fit' already does). It has no effect in any other mode.
  public setDpiScale(dpi: number): void {
    this.config.dpiScale = dpi;
    if (!this.rfb || this.config.scale !== 'remote-resize') return;
    const rfbAny = this.rfb as any;
    // Compensating client-side scale first (instant visual feedback), then request the
    // server actually render at the new resolution.
    rfbAny._updateScale();
    rfbAny._requestRemoteResize();
  }

  // One-shot: requests the server resize to an exact resolution, right now - regardless of
  // the current scale mode. This is independent of remote-resize's continuous auto-match-
  // to-window-size behavior (which stays exactly as it is): it doesn't persist, doesn't
  // require being in remote-resize mode, and if you are in remote-resize mode, the next
  // browser window resize will simply auto-fit again afterward as normal.
  public requestExactResolution(width: number, height: number): void {
    this.sendOneShotResize({ w: width, h: height });
  }

  // One-shot: requests the server resize to match the browser viewport's current size,
  // right now, without switching into (or needing to already be in) remote-resize mode.
  public requestWindowFitResolution(): void {
    this.sendOneShotResize(null);
  }

  // Sends a single setDesktopSize request for the given size (or, if null, whatever the
  // live browser viewport size currently is). resizeSession has to be true for noVNC's
  // _requestRemoteResize() to act at all, so this flips it on just long enough to send the
  // request (synchronous - the RFB message goes out inline in the setter) and restores
  // whatever it was before, without disturbing the caller's own scale-mode state.
  private sendOneShotResize(target: { w: number; h: number } | null): void {
    if (!this.rfb) return;
    const previousResizeSession = this.rfb.resizeSession;
    this.manualResolution = target;
    this.inOneShotResize = true;
    this.rfb.resizeSession = true;
    this.rfb.resizeSession = previousResizeSession;
    this.inOneShotResize = false;
    this.manualResolution = null;
  }

  // Sets the authoritative native resolution, sourced from the backend's own launch config
  // (GET /api/session, populated from the -geometry TurboVNC/vncserver was started with).
  // Unlike the value opportunistically inferred from the first ServerInit, this is always
  // correct and survives a page reload - so it takes priority and can't be overwritten by
  // a later inferred guess. Call this whenever /api/session reports a resolution; safe to
  // call repeatedly (e.g. on every poll) or before the first connect.
  public setServerNativeResolution(width: number, height: number): void {
    this.nativeResolution = { w: width, h: height };
    this.nativeResolutionAuthoritative = true;
  }

  // Explicitly requests the server's original ServerInit resolution back.
  private restoreNativeResolution(): void {
    if (!this.nativeResolution) return;
    this.sendOneShotResize(this.nativeResolution);
  }

  public sendKey(keysym: number, down: boolean): void {
    if (this.rfb && this.state === 'connected') {
      this.rfb.sendKey(keysym, undefined, down);
    }
  }

  public sendKeySequence(keysyms: number[]): void {
    if (!this.rfb || this.state !== 'connected') return;
    for (const k of keysyms) {
      this.rfb.sendKey(k, undefined, true);
    }
    for (let i = keysyms.length - 1; i >= 0; i--) {
      this.rfb.sendKey(keysyms[i], undefined, false);
    }
  }

  public sendCtrlAltDel(): void {
    if (this.rfb && this.state === 'connected') {
      this.rfb.sendCtrlAltDel();
    }
  }

  public sendClientCutText(text: string): void {
    if (this.rfb && this.state === 'connected') {
      this.rfb.clipboardPasteFrom(text);
    }
  }

  public getFramebufferSize(): { width: number; height: number } {
    if (!this.rfb) return { width: 0, height: 0 };
    return { width: this.rfb._fbWidth || 0, height: this.rfb._fbHeight || 0 };
  }

  public focus(): void {
    if (this.rfb) {
      this.rfb.focus();
    }
  }

  private applyConfig(): void {
    if (!this.rfb) return;

    this.appliedScaleMode = this.config.scale;
    this.rfb.viewOnly = this.config.viewOnly;
    this.rfb.scaleViewport = this.config.scale === 'fit' || this.config.scale === 'down';
    this.rfb.resizeSession = this.config.scale === 'remote-resize';
    this.rfb.clipViewport = this.config.scale === 'none';
    this.rfb.qualityLevel = this.config.quality;
    this.rfb.compressionLevel = this.config.compression;
    this.rfb.showDotCursor = true;
    this.rfb.background = '#0a0c10';
  }

  private hookRfbInternals(): void {
    if (!this.rfb) return;
    const rfbAny = this.rfb as any;

    // 1. Ensure screenSize always produces even dimensions and minimum bounds for TurboVNC.
    //    While a one-shot resize is in flight (see sendOneShotResize), report its target
    //    size instead of the container's measured size - this is what lets a single
    //    _requestRemoteResize() call request an exact, arbitrary size on demand.
    //    In 'remote-resize' mode, multiply by dpiScale so the server renders at a sharper
    //    resolution than the raw CSS pixel viewport (compensated back down in _updateScale).
    const origScreenSize = rfbAny._screenSize.bind(this.rfb);
    rfbAny._screenSize = () => {
      let w: number, h: number;
      if (this.manualResolution) {
        w = this.manualResolution.w;
        h = this.manualResolution.h;
      } else {
        const orig = origScreenSize();
        const dpi = this.config.scale === 'remote-resize' ? (this.config.dpiScale || 1.0) : 1.0;
        w = orig.w * dpi;
        h = orig.h * dpi;
      }
      w = Math.floor(w);
      h = Math.floor(h);
      // TurboVNC requires even dimensions; clamp to at least 64x64
      w = Math.max(64, w - (w % 2));
      h = Math.max(64, h - (h % 2));
      return { w, h };
    };

    // 2. Hook _resize so that every server resize (initial ServerInit, ExtendedDesktopSize,
    // RandR resize, or XFCE desktop setting change) updates the connected status text
    // and dispatches onDesktopResize callback. The very first call per connection carries
    // the server's ServerInit (launch-time) resolution, before any auto-resize-to-container
    // has had a chance to run - capture that as the "native" size to restore later.
    const origResize = rfbAny._resize.bind(this.rfb);
    rfbAny._resize = (width: number, height: number) => {
      if (!this.nativeResolutionAuthoritative && !this.nativeResolution) {
        this.nativeResolution = { w: width, h: height };
      }
      origResize(width, height);
      console.log(`[cnt-vnc] Remote desktop resized: ${width}x${height}`);
      if (this.state === 'connected') {
        this.setState('connected', `Connected (${width}x${height})`);
      }
      this.callbacks.onDesktopResize(width, height);
    };

    // 3. Hook _updateScale so it stays in charge of _display.scale in every mode:
    //    - 'down': scale down only, never upscale past 1.0
    //    - 'remote-resize' with dpiScale != 1: the server is rendering at dpiScale x the
    //      CSS viewport (see _screenSize above), so compensate by displaying it back down
    //      at 1/dpiScale - same visual size on screen, sharper actual pixels.
    //    - everything else ('fit', 'none'): noVNC's own default behavior.
    //    noVNC calls _updateScale() internally from several places (its own setters,
    //    window resize, framebuffer resize) - owning it here means those calls can
    //    never silently reset the DPI scale back to 1.0 while a resize is in flight.
    const origUpdateScale = rfbAny._updateScale.bind(this.rfb);
    rfbAny._updateScale = () => {
      if (this.config.scale === 'down') {
        const size = rfbAny._screenSize();
        const fbW = rfbAny._fbWidth || 0;
        const fbH = rfbAny._fbHeight || 0;
        if (fbW > 0 && fbH > 0 && size.w > 0 && size.h > 0) {
          const scaleRatio = Math.min(size.w / fbW, size.h / fbH);
          rfbAny._display.scale = Math.min(1.0, scaleRatio);
        } else {
          rfbAny._display.scale = 1.0;
        }
        rfbAny._fixScrollbars();
      } else if (this.config.scale === 'remote-resize') {
        rfbAny._display.scale = 1.0 / (this.config.dpiScale || 1.0);
        rfbAny._fixScrollbars();
      } else {
        origUpdateScale();
      }
    };

    // 4. Count JPEG rects/bytes flowing into the render queue, for the diagnostics reported by
    // startRenderStats() below. imageRect() is where noVNC allocates the `new Image()` + base64
    // data: URI per rect and pushes it onto _renderQ - this is the piece under suspicion for
    // the still-growing heap (see RenderDebugStats comment), so we count right at the source
    // rather than guessing from the outside.
    const display = rfbAny._display;
    if (display && typeof display.imageRect === 'function') {
      const origImageRect = display.imageRect.bind(display);
      display.imageRect = (x: number, y: number, width: number, height: number, mime: string, arr: Uint8Array) => {
        this.renderRectCountWindow++;
        this.renderBytesWindow += arr.byteLength;
        origImageRect(x, y, width, height, mime, arr);
      };
    }

    // 5. Debounce remote-resize requests (see REMOTE_RESIZE_DEBOUNCE_MS) - noVNC's own 100ms
    // rate limit inside _requestRemoteResize is too short to avoid visible flashing from a real
    // RandR resize on every step of an active window drag-resize.
    const origRequestRemoteResize = rfbAny._requestRemoteResize.bind(this.rfb);
    rfbAny._requestRemoteResize = () => {
      // One-shot resizes (sendOneShotResize, used by Settings' Apply/Fit-to-Window and
      // restoreNativeResolution) rely on this firing synchronously within their brief
      // resizeSession toggle. noVNC's own _requestRemoteResize() bails out immediately if
      // _resizeSession is false at call time - and sendOneShotResize restores it to whatever
      // it was before (often false, outside 'remote-resize' mode) right after flipping it true,
      // all synchronously. Debouncing here would mean the deferred call runs after that restore
      // has already happened, so it would silently no-op instead of sending anything.
      if (this.inOneShotResize) {
        origRequestRemoteResize();
        return;
      }
      if (this.remoteResizeDebounceTimer !== null) {
        window.clearTimeout(this.remoteResizeDebounceTimer);
      }
      this.remoteResizeDebounceTimer = window.setTimeout(() => {
        this.remoteResizeDebounceTimer = null;
        origRequestRemoteResize();
      }, REMOTE_RESIZE_DEBOUNCE_MS);
    };

    // 6. Count total raw bytes received on the RFB WebSocket, for actual network bandwidth -
    // unlike jpegKBPerSec above (which only counts JPEG-type rects' payload), this covers every
    // byte of the protocol: JPEG rects, non-JPEG ("basic"/zlib) rects, fills, and framing
    // overhead. RFB's constructor calls _updateConnectionState('connecting') synchronously,
    // which drives _connect() -> Websock.open() -> `_websocket.onmessage = this._recvMessage
    // .bind(this)` to completion before `new RFB(...)` even returns - by the time this hook
    // runs, _websocket.onmessage is already bound to the *original* _recvMessage, so wrapping
    // the _recvMessage method reference here (as done originally) is a no-op: the already-bound
    // onmessage never sees it. Wrapping the already-installed onmessage handler itself instead
    // works regardless of that ordering.
    const sock = rfbAny._sock;
    if (sock && sock._websocket) {
      const origOnMessage = sock._websocket.onmessage;
      sock._websocket.onmessage = (e: MessageEvent) => {
        this.netBytesWindow += (e.data as ArrayBuffer).byteLength;
        if (origOnMessage) origOnMessage.call(sock._websocket, e);
      };
    }
  }

  private startRenderStats(): void {
    this.stopRenderStats();
    if (!this.callbacks.onRenderStats) return;
    let lastReport = performance.now();
    this.renderStatsTimer = window.setInterval(() => {
      const rfbAny = this.rfb as any;
      const queueLen: number = rfbAny?._display?._renderQ?.length ?? 0;
      if (queueLen > this.maxRenderQLenWindow) {
        this.maxRenderQLenWindow = queueLen;
      }
      const now = performance.now();
      const elapsedSec = (now - lastReport) / 1000;
      if (elapsedSec >= 1) {
        this.callbacks.onRenderStats!({
          rectsPerSec: Math.round(this.renderRectCountWindow / elapsedSec),
          jpegKBPerSec: Math.round(this.renderBytesWindow / 1024 / elapsedSec),
          netKBPerSec: Math.round(this.netBytesWindow / 1024 / elapsedSec),
          maxQueueLen: this.maxRenderQLenWindow,
          queueLen,
          width: rfbAny?._fbWidth ?? 0,
          height: rfbAny?._fbHeight ?? 0,
        });
        this.renderRectCountWindow = 0;
        this.renderBytesWindow = 0;
        this.netBytesWindow = 0;
        this.maxRenderQLenWindow = 0;
        lastReport = now;
      }
    }, 200);
  }

  private stopRenderStats(): void {
    if (this.renderStatsTimer !== null) {
      window.clearInterval(this.renderStatsTimer);
      this.renderStatsTimer = null;
    }
    this.renderRectCountWindow = 0;
    this.renderBytesWindow = 0;
    this.netBytesWindow = 0;
    this.maxRenderQLenWindow = 0;
  }

  private attachEventListeners(myId: number): void {
    if (!this.rfb) return;
    // Every handler below bails out if a newer connect()/disconnect() has since superseded
    // this rfb instance - see the `connectionId` field for why.
    const stale = () => myId !== this.connectionId;

    // Deliberately not forcing _supportsSetDesktopSize/_screenID/_screenFlags or calling
    // _requestRemoteResize() here: resizeSession was already set to true in applyConfig()
    // before connecting, so noVNC's own firstUpdate logic in _handleExtendedDesktopSize()
    // fires the very first resize request automatically, once it actually learns the
    // server supports it and what its real screen id is. Forcing those early defeats that
    // gate and was the root cause of remote-resize getting stuck.
    this.rfb.addEventListener('connect', () => {
      if (stale()) return;
      console.log('[cnt-vnc] RFB Connected successfully');

      const w = this.rfb?._fbWidth || 0;
      const h = this.rfb?._fbHeight || 0;
      this.setState('connected', `Connected (${w}x${h})`);
      if (w > 0 && h > 0) {
        this.callbacks.onDesktopResize(w, h);
      }
    });

    this.rfb.addEventListener('disconnect', (e: any) => {
      if (stale()) return;
      const clean = e.detail?.clean;
      console.warn(`[cnt-vnc] RFB Disconnected (clean=${clean})`);
      this.setState('disconnected', clean ? 'Session closed' : 'Connection lost');
    });

    this.rfb.addEventListener('credentialsrequired', async () => {
      if (stale()) return;
      console.log('[cnt-vnc] VNC server requires credentials');
      const errorMessage = this.lastAuthError ?? undefined;
      this.lastAuthError = null;
      try {
        const password = await this.callbacks.onPasswordRequired(errorMessage);
        if (stale()) return;
        if (this.rfb) {
          this.rfb.sendCredentials({ password });
        }
      } catch {
        if (!stale()) this.disconnect();
      }
    });

    this.rfb.addEventListener('securityfailure', (e: any) => {
      if (stale()) return;
      const reason = e.detail?.reason || 'Authentication failed';
      console.error('[cnt-vnc] Security failure:', reason);
      this.lastAuthError = reason;
      // Recoverable by simply re-prompting on a fresh connection, so retry immediately instead
      // of surfacing this through the generic 'error' state - that path shows a toast and waits
      // out config.reconnectDelay before trying again, which made the password dialog (kept
      // open across this by the caller - see PasswordModal.submit()) sit idle for no reason.
      // The next credentialsrequired below carries lastAuthError back to the dialog.
      this.connect();
    });

    this.rfb.addEventListener('desktopname', (e: any) => {
      if (stale()) return;
      const name = e.detail?.name || 'TurboVNC';
      console.log(`[cnt-vnc] Desktop name: ${name}`);
      this.callbacks.onDesktopName(name);
    });

    this.rfb.addEventListener('clipboard', (e: any) => {
      if (stale()) return;
      const text = e.detail?.text;
      if (text) {
        this.callbacks.onServerCutText(text);
      }
    });

    this.rfb.addEventListener('bell', () => {
      if (stale()) return;
      if (this.callbacks.onBell) {
        this.callbacks.onBell();
      }
    });
  }

  private setState(state: ConnectionState, message?: string): void {
    this.state = state;
    console.log(`[cnt-vnc] State -> ${state}${message ? ' (' + message + ')' : ''}`);
    this.callbacks.onStateChange(state, message);
  }
}
