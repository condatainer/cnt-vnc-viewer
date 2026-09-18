export type ScaleMode = 'fit' | 'remote-resize' | 'down' | 'none';

export interface VncConfig {
  autoconnect: boolean;
  password: string;
  viewOnly: boolean;
  scale: ScaleMode;
  dpiScale: number;
  quality: number; // 0..9 (JPEG quality)
  compression: number; // 0..9 (zlib compression)
  audio: boolean;
  audioSampleRate: number; // Hz, speaker capture rate (session-wide, server resamples)
  audioChannels: number; // 1 (mono) or 2 (stereo)
  debug: boolean; // Show the on-screen audio/render/heap diagnostics overlay
  clipboardSync: boolean;
  reconnect: boolean;
  reconnectDelay: number;
  token: string;
}

/**
 * Builds a ws:// or wss:// URL for a given app-relative path (e.g. "ws/rfb", no leading slash),
 * resolved against the page's own location rather than the domain root. This matters behind a
 * reverse proxy that serves the app under a per-session subpath - e.g. Open OnDemand's
 * https://ood.example.edu/rnode/<host>/<port>/ - where an absolute path like "/ws/rfb" would
 * resolve to the domain root instead of that subpath and never reach the right backend. Mirrors
 * how the audio worklet script already resolves its own URL via document.baseURI.
 *
 * No host/port override: the frontend is always embedded into and served by the same Go binary
 * that serves /ws/rfb and /ws/audio (see cmd/server, //go:embed dist/*), so there's never a
 * legitimate case where the WebSocket needs a different origin than the page itself. (noVNC and
 * KasmVNC expose host/port because they're generic clients meant to be pointed at an arbitrary
 * backend from a statically-hosted page - this project doesn't have that decoupled model.)
 */
export function buildWsUrl(path: string, config: Pick<VncConfig, 'token'>): string {
  const url = new URL(path, document.baseURI);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (config.token) {
    url.searchParams.set('token', config.token);
  }
  return url.href;
}

/**
 * Parses URL query and hash parameters into a typed VncConfig.
 * Also scrubs sensitive parameters (like password) from the browser address bar.
 */
export function loadUrlConfig(): VncConfig {
  const params = new URLSearchParams(window.location.search);
  const hash = window.location.hash.startsWith('#')
    ? new URLSearchParams(window.location.hash.substring(1))
    : new URLSearchParams();

  // Helper to read from search params then hash params
  const get = (key: string, defaultVal: string = ''): string => {
    return params.get(key) ?? hash.get(key) ?? defaultVal;
  };

  // Accepts the common hand-typed forms in both directions - e.g. without explicit 'on'/'off'
  // handling, "?audio=on" would silently read as false (anything not in the truthy set falls
  // through to defaultVal/false), which is the opposite of what someone editing the URL by hand
  // would expect.
  const getBool = (key: string, defaultVal: boolean): boolean => {
    const val = get(key, '').toLowerCase();
    if (!val) return defaultVal;
    if (val === 'true' || val === '1' || val === 'yes' || val === 'on') return true;
    if (val === 'false' || val === '0' || val === 'no' || val === 'off') return false;
    return defaultVal;
  };

  const getNum = (key: string, defaultVal: number, min?: number, max?: number): number => {
    const val = get(key, '');
    if (!val) return defaultVal;
    const n = parseFloat(val);
    if (isNaN(n)) return defaultVal;
    if (min !== undefined && n < min) return min;
    if (max !== undefined && n > max) return max;
    return n;
  };

  const rawPassword = get('password', '');

  let rawScale = get('scale', 'fit').toLowerCase() as ScaleMode;
  if (!['fit', 'remote-resize', 'down', 'none'].includes(rawScale)) {
    rawScale = 'fit';
  }

  const config: VncConfig = {
    autoconnect: getBool('autoconnect', false),
    password: rawPassword,
    viewOnly: getBool('view_only', false),
    scale: rawScale,
    dpiScale: getNum('dpi_scale', 1, 0.5, 3.0),
    quality: getNum('quality', 7, 0, 9),
    compression: getNum('compression', 2, 0, 9),
    audio: getBool('audio', true),
    // Default mirrors the server's own default (mono, 24kHz Opus) - adjustable in Settings.
    audioSampleRate: getNum('audio_sample_rate', 24000, 8000, 48000),
    audioChannels: Math.round(getNum('audio_channels', 1, 1, 2)),
    debug: getBool('debug', false),
    clipboardSync: getBool('clipboard_sync', getBool('clipboard', true)),
    reconnect: getBool('reconnect', true),
    reconnectDelay: getNum('reconnect_delay', 3000, 500, 30000),
    token: get('token', ''),
  };

  return config;
}

