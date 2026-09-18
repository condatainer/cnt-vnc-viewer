import './style.css';
import { loadUrlConfig, ScaleMode } from './url/urlConfig';
import { VncClient, ConnectionState } from './vnc/VncClient';
import type { RenderDebugStats } from './vnc/VncClient';
import { AudioClient } from './audio/AudioClient';
import { ClipboardSync } from './clipboard/ClipboardSync';
import { LeftRail } from './ui/LeftRail';
import { ExtraKeysBar } from './ui/ExtraKeysBar';
import { SettingsModal } from './ui/SettingsModal';
import { PasswordModal } from './ui/PasswordModal';
import { ClipboardDrawer } from './ui/ClipboardDrawer';
import { SoftKeyboard } from './ui/SoftKeyboard';
import { ToastHost } from './ui/Toast';
import { installIconSprite } from './ui/icons';

function initApp(): void {
  installIconSprite();
  const config = loadUrlConfig();

  // Root app structure
  const app = document.getElementById('app')!;
  app.innerHTML = `
    <aside class="left-rail" id="left-rail-container"></aside>
    <div id="extra-keys-container"></div>
    <main class="vnc-viewport" id="vnc-viewport"></main>
    <aside id="clipboard-drawer-container"></aside>
    <div id="settings-modal-container"></div>
    <div id="password-modal-container"></div>
    <div id="soft-keyboard-container"></div>
    <div id="toast-container"></div>
  `;

  const viewportEl = document.getElementById('vnc-viewport')!;
  const railEl = document.getElementById('left-rail-container')!;
  const extraKeysEl = document.getElementById('extra-keys-container')!;
  const drawerEl = document.getElementById('clipboard-drawer-container')!;
  const settingsEl = document.getElementById('settings-modal-container')!;
  const passwordEl = document.getElementById('password-modal-container')!;
  const softKbEl = document.getElementById('soft-keyboard-container')!;
  const toastEl = document.getElementById('toast-container')!;

  const toast = new ToastHost(toastEl);

  let rail: LeftRail;
  let settingsModal: SettingsModal;
  let vncClient: VncClient;
  let clipboardSync: ClipboardSync;
  let clipboardDrawer: ClipboardDrawer;
  let reconnectTimer: number | null = null;

  const cancelReconnect = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  // The speaker button reflects two independent conditions, either of which disables it:
  // not being connected yet (nothing to mute/unmute - a fresh page load has no audio session
  // at all), and the server having no audio backend (only known once /api/session responds).
  // ?audio=0 deliberately does NOT disable it: AudioClient just starts muted in that case, and
  // the button stays functional to unmute once connected.
  let serverAudioEnabled: boolean | null = null;
  let vncConnected = false;
  const updateSpeakerAvailability = () => {
    if (!vncConnected) {
      rail.setSpeakerDisabled(true, 'Connect to enable audio');
    } else if (serverAudioEnabled === false) {
      rail.setSpeakerDisabled(true, 'Audio unavailable (server has no audio backend)');
    } else {
      rail.setSpeakerDisabled(false);
    }
  };

  // 1. Password prompt modal
  const passwordModal = new PasswordModal(passwordEl);

  // Wraps one "label value" pair of a debug overlay line in a span, red-highlighted only when
  // warn is true - so a bad value stands out on its own instead of turning the whole line (and
  // every unrelated field on it) red.
  const statField = (label: string, value: string | number, warn: boolean): string =>
    `${label} <span class="${warn ? 'warn' : ''}">${value}</span>`;

  // Diagnostics overlay (?debug=1) - audio client/server lines from the playback worklet and
  // /api/session (updates ~1/s and every 5s respectively), plus render (noVNC rect/JPEG
  // throughput) and page (JS heap) lines. Shown directly on the page instead of via
  // console.log, since opening DevTools mid-session on this canvas-heavy page can crash the
  // tab. Each line updates independently since they arrive on different schedules from
  // different sources.
  let audioDebugClientLine: HTMLElement | null = null;
  let audioDebugServerLine: HTMLElement | null = null;
  let renderDebugLine: HTMLElement | null = null;
  let pageDebugLine: HTMLElement | null = null;
  let netDebugLine: HTMLElement | null = null;
  // Last-seen bandwidth from each channel, combined into netDebugLine below - video and audio
  // stats arrive on separate schedules/objects, so each side just updates its own half and
  // whichever callback fires re-renders the combined line with the other side's latest value.
  let lastVideoNetKBPerSec = 0;
  let lastAudioNetKBPerSec = 0;
  const updateNetDebugLine = () => {
    if (!netDebugLine) return;
    const total = lastVideoNetKBPerSec + lastAudioNetKBPerSec;
    netDebugLine.textContent =
      `net: ${total}KB/s total (video ${lastVideoNetKBPerSec}KB/s, audio ${lastAudioNetKBPerSec}KB/s)`;
  };
  if (config.debug) {
    const overlay = document.createElement('div');
    overlay.className = 'debug-overlay';
    audioDebugClientLine = document.createElement('div');
    audioDebugClientLine.textContent = 'client: waiting for stats...';
    audioDebugServerLine = document.createElement('div');
    audioDebugServerLine.textContent = 'server: waiting for stats...';
    renderDebugLine = document.createElement('div');
    renderDebugLine.textContent = 'render: waiting for stats...';
    pageDebugLine = document.createElement('div');
    pageDebugLine.textContent = 'page: waiting for stats...';
    netDebugLine = document.createElement('div');
    netDebugLine.textContent = 'net: waiting for stats...';
    overlay.appendChild(audioDebugClientLine);
    overlay.appendChild(audioDebugServerLine);
    overlay.appendChild(renderDebugLine);
    overlay.appendChild(netDebugLine);
    overlay.appendChild(pageDebugLine);
    app.appendChild(overlay);

    // Heap sampling independent of the audio worklet - the client line's heap number only
    // updates via worklet stats messages, which taper off when muted (?audio=0 starts muted;
    // the server stops sending frames to a muted client, so the decode pipeline goes idle even
    // though the worklet/websocket are still technically connected - see AudioClient.speakerMuted).
    // Useful for isolating whether a leak is audio- or video-side. This line always updates as
    // long as the debug overlay itself is on, regardless of the audio pipeline's state.
    setInterval(() => {
      if (!pageDebugLine) return;
      const heap = (performance as any).memory?.usedJSHeapSize;
      const heapMB = heap !== undefined ? Math.round(heap / 1e6) : null;
      pageDebugLine.textContent = `page: heap ${heapMB ?? 'n/a'}MB`;
    }, 1000);
  }

  // 2. Audio Client (PulseAudio bridge)
  const audioClient = new AudioClient(config, {
    onSpeakerState: (active) => {
      if (rail) rail.setSpeakerActive(active);
    },
    onError: (err) => {
      console.warn('[Audio]', err);
      toast.show(err, { level: 'warning' });
    },
    onDebugStats: (stats) => {
      if (audioDebugClientLine) {
        audioDebugClientLine.innerHTML = [
          `client: buffered ${stats.bufferedMs}ms`,
          statField('underrun', `${stats.underrunMs}ms/s`, stats.underrunMs > 0),
          `overflow ${stats.overflowMs}ms/s`,
          statField('lost', `${stats.packetsLostMs}ms/s`, stats.packetsLostMs > 0),
          statField('decodeDrop', `${stats.decodeDropsMs}ms/s`, stats.decodeDropsMs > 0),
          statField('stall', `${stats.maxStallMs}ms`, stats.maxStallMs > 150),
          `reconnects ${stats.reconnectCount}`,
          `heap ${stats.heapMB ?? 'n/a'}MB`,
        ].join(' | ');
      }
      lastAudioNetKBPerSec = stats.netKBPerSec;
      updateNetDebugLine();
    },
  });

  // Unified clipboard sync synchronizer
  const setAppClipboardSync = (enabled: boolean) => {
    config.clipboardSync = enabled;
    if (clipboardSync) clipboardSync.setEnabled(enabled);
    if (rail) rail.setClipboardActive(enabled);
    if (clipboardDrawer) clipboardDrawer.setSyncActive(enabled);
  };

  // 4. Clipboard Synchronization
  clipboardSync = new ClipboardSync(
    (text) => vncClient.sendClientCutText(text),
    {
      onRemoteCut: (text) => {
        clipboardDrawer.setContent(text);
        clipboardDrawer.updateHistory(clipboardSync.getHistory());
      },
      onLocalCut: () => {
        clipboardDrawer.updateHistory(clipboardSync.getHistory());
      },
      onSyncStateChange: (enabled) => {
        setAppClipboardSync(enabled);
      },
    },
    config.clipboardSync
  );

  // 5. Clipboard Slide-out Drawer
  clipboardDrawer = new ClipboardDrawer(drawerEl, {
    onSendText: (text) => clipboardSync.sendLocalText(text, true),
    onToggleSync: (enabled) => setAppClipboardSync(enabled),
    onClearHistory: () => clipboardSync.clearHistory(),
  });
  clipboardSync.bindDrawer(clipboardDrawer.getContainer(), clipboardDrawer.getTextarea());
  clipboardDrawer.setSyncActive(config.clipboardSync);

  // 6. VNC Client Instance
  // Avoids re-showing an identical toast on every retry of a failing reconnect loop (e.g.
  // server unreachable, reconnecting every reconnectDelay forever) - only a genuinely new
  // message re-triggers one.
  let lastErrorToastMessage: string | null = null;

  vncClient = new VncClient(viewportEl, config, {
    onStateChange: (state: ConnectionState, message?: string) => {
      rail.setStatus(state, message);
      vncConnected = state === 'connected';
      updateSpeakerAvailability();
      if (state === 'connecting') {
        cancelReconnect();
      } else if (state === 'connected') {
        cancelReconnect();
        lastErrorToastMessage = null;
        // A successful connect means any outstanding password prompt (if one was open) just
        // got the right password - close it now. See PasswordModal.submit()/close() for why
        // it doesn't close itself on submit anymore.
        passwordModal.close();
        // Reflect the actual configured clipboard-sync state now that there's something to
        // sync with - deliberately not shown at page load (see the clipboard-btn markup),
        // since a fresh page has no connection for it to mean anything yet.
        rail.setClipboardActive(config.clipboardSync);
        audioClient.start().catch((err) => console.warn('[Audio start error]', err));
      } else if (state === 'disconnected' || state === 'error') {
        audioClient.stop();
        // A wrong-password retry never reaches this branch (VncClient retries it directly -
        // see the securityfailure handler), so any 'disconnected'/'error' seen here is a
        // genuine failure unrelated to that flow. Close the dialog rather than leave it stuck
        // in "Verifying..." if it happened to be open for some other reason (e.g. the network
        // died between submit and a response).
        passwordModal.close();
        // 'Disconnected' is only ever the message for a user-initiated stop (the rail's
        // Disconnect button, or canceling the password dialog) - both already show their own
        // visible feedback (the rail status, the dialog closing), so it doesn't also need a
        // toast. Auth-failure retries never reach this branch at all (see the securityfailure
        // handler in VncClient), so anything else here is a genuine, unprompted failure worth
        // surfacing.
        if (message && message !== 'Disconnected' && message !== lastErrorToastMessage) {
          lastErrorToastMessage = message;
          toast.show(message, { level: state === 'error' ? 'error' : 'warning' });
        }
        if (state === 'disconnected') {
          // Explicit disconnect (user or clean server close) - never auto-reconnect.
          cancelReconnect();
        } else if (config.reconnect) {
          cancelReconnect();
          reconnectTimer = window.setTimeout(() => {
            reconnectTimer = null;
            console.log('[cnt-vnc] Reconnecting...');
            vncClient.connect();
          }, config.reconnectDelay);
        }
      }
    },
    onDesktopName: (name: string) => {
      document.title = `${name} - cnt-vnc-viewer`;
    },
    onDesktopResize: (w: number, h: number) => {
      console.log(`[cnt-vnc] Resolution changed: ${w}x${h}`);
      if (rail && vncClient && vncClient.getState() === 'connected') {
        rail.setStatus('connected', `Connected (${w}x${h})`);
      }
      if (settingsModal) settingsModal.setCurrentResolution(w, h);
    },
    onServerCutText: (text: string) => {
      clipboardSync.handleServerCut(text);
    },
    onPasswordRequired: (errorMessage?: string) => {
      return passwordModal.prompt(errorMessage);
    },
    onBell: () => {
      // Audio bell or subtle visual flash
      viewportEl.style.opacity = '0.7';
      setTimeout(() => (viewportEl.style.opacity = '1.0'), 50);
    },
    onRenderStats: (stats: RenderDebugStats) => {
      if (renderDebugLine) {
        renderDebugLine.innerHTML = [
          `render: ${stats.width}x${stats.height}`,
          `rects ${stats.rectsPerSec}/s`,
          `jpeg ${stats.jpegKBPerSec}KB/s`,
          `renderQ ${stats.queueLen}`,
          statField('maxRenderQ', stats.maxQueueLen, stats.maxQueueLen > 10),
        ].join(' | ');
      }
      lastVideoNetKBPerSec = stats.netKBPerSec;
      updateNetDebugLine();
    },
  });

  // 7. Extra Keys Bar
  const extraKeysBar = new ExtraKeysBar(extraKeysEl, {
    onSendKey: (keysym, down) => vncClient.sendKey(keysym, down),
    onSendSequence: (keysyms) => vncClient.sendKeySequence(keysyms),
    onToggleSoftKeyboard: () => softKeyboard.toggle(),
    onVisibilityChange: (visible) => rail.setExtraKeysActive(visible),
  });

  // 8. Soft Virtual Keyboard
  const softKeyboard = new SoftKeyboard(softKbEl, {
    onSendKey: (keysym, down) => vncClient.sendKey(keysym, down),
  });

  // Pan mode (see VncClient.setPanMode / LeftRail.setPanModeActive) only applies in 1:1 scale
  // mode - it's the only mode where the framebuffer can be larger than the visible canvas.
  let panModeActive = false;

  // Unified scale mode synchronizer
  const setAppScaleMode = (mode: ScaleMode) => {
    config.scale = mode;
    if (settingsModal) settingsModal.setScaleMode(mode);
    if (vncClient) vncClient.setScaleMode(mode);
    if (rail) {
      rail.setPanModeAvailable(mode === 'none');
      if (mode !== 'none' && panModeActive) {
        panModeActive = false;
        rail.setPanModeActive(false);
      }
    }
  };

  // 9. Settings Modal
  settingsModal = new SettingsModal(settingsEl, config, {
    onQualityChange: (q) => vncClient.setQuality(q),
    onCompressionChange: (c) => vncClient.setCompression(c),
    onScaleChange: (mode) => setAppScaleMode(mode),
    onDpiChange: (dpi) => vncClient.setDpiScale(dpi),
    onViewOnlyChange: (viewOnly) => vncClient.setViewOnly(viewOnly),
    onAudioQualityChange: (sampleRate, channels) => {
      config.audioSampleRate = sampleRate;
      config.audioChannels = channels;
      audioClient.setAudioQuality(sampleRate, channels);
    },
    onRequestResolution: (w, h) => vncClient.requestExactResolution(w, h),
    onRequestWindowFitResolution: () => vncClient.requestWindowFitResolution(),
  });

  // 10. Left Rail Toolbar
  rail = new LeftRail(railEl, {
    onToggleSpeaker: () => {
      const active = audioClient.toggleSpeaker();
      rail.setSpeakerActive(active);
    },
    onToggleClipboardDrawer: () => clipboardDrawer.toggle(),
    onToggleExtraKeys: () => extraKeysBar.toggle(),
    onTogglePanMode: () => {
      panModeActive = !panModeActive;
      vncClient.setPanMode(panModeActive);
      rail.setPanModeActive(panModeActive);
    },
    onToggleSettings: () => settingsModal.toggle(),
    onToggleFullscreen: () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    },
    onDisconnect: () => vncClient.disconnect(),
    onReconnect: () => vncClient.connect(),
  });

  updateSpeakerAvailability();

  // Set initial scaling mode across components
  setAppScaleMode(config.scale);

  // Poll HPC Session telemetry
  const checkSessionTelemetry = async () => {
    try {
      const res = await fetch('/api/session');
      if (res.ok) {
        const data = await res.json();
        if (data.native_width && data.native_height) {
          vncClient.setServerNativeResolution(data.native_width, data.native_height);
        }
        if (typeof data.audio_enabled === 'boolean' && data.audio_enabled !== serverAudioEnabled) {
          serverAudioEnabled = data.audio_enabled;
          updateSpeakerAvailability();
        }
        if (audioDebugServerLine && data.audio) {
          const a = data.audio;
          audioDebugServerLine.innerHTML = [
            `server: clients ${a.clients}`,
            statField('drops', a.total_drops, a.total_drops > 0),
            statField('encodeFail', a.encode_failures, a.encode_failures > 0),
            `pulseReconnect ${a.pulse_reconnects}`,
            statField('maxCaptureGap', `${a.max_capture_gap_ms}ms`, a.max_capture_gap_ms > 100),
          ].join(' | ');
        }
      }
    } catch (e) {
      // Ignore
    }
  };
  checkSessionTelemetry();
  // Poll more often while the debug overlay is on, for finer-grained correlation with
  // whatever's happening client-side - these are cumulative totals, not per-window, so a
  // tighter interval just gives more data points to line up against client-side spikes.
  setInterval(checkSessionTelemetry, config.debug ? 5000 : 30000);

  // 11. Unlock browser Web Audio API on first user interaction
  const unlockAudio = () => {
    audioClient.resume();
  };
  window.addEventListener('pointerdown', unlockAudio, { passive: true });
  window.addEventListener('keydown', unlockAudio, { passive: true });

  // 12. Autoconnect if configured
  if (config.autoconnect) {
    vncClient.connect();
  }
}

// Start application when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

