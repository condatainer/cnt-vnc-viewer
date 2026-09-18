# Configuration reference

## Server flags / environment variables

All flags are also settable via environment variable; CLI flags win over
env vars, which win over defaults. Run `./cnt-vnc-viewer -h` for the
authoritative list.

| Flag | Env var | Default | Purpose |
|---|---|---|---|
| `-listen-http` | `LISTEN_HTTP` | `127.0.0.1:8080` | HTTP listen address |
| `-listen-https` | `LISTEN_HTTPS` | - | Optional HTTPS listen address, e.g. `:8443` |
| `-tls-cert` / `-tls-key` | `TLS_CERT` / `TLS_KEY` | - | TLS certificate/key paths |
| `-auto-tls` | `AUTO_TLS` | `false` | Generate a self-signed certificate if none is provided |
| `-vnc-addr` | `VNC_ADDR` | `127.0.0.1:5901` | Target VNC server address |
| `-native-geometry` | `NATIVE_GEOMETRY` | - | Resolution the desktop was launched at, e.g. `1280x720` |
| `-enable-audio` | `ENABLE_AUDIO` | `true` | Enable the audio bridge |
| `-pulse-spawn` | `PULSE_SPAWN` | `false` | Run an isolated audio daemon instead of using an existing one |
| `-pulse-server` / `-pulse-cookie` | `PULSE_SERVER` / `PULSE_COOKIE` | autodetected | Explicit PulseAudio socket/cookie |
| `-audio-sample-rate` / `-audio-channels` | `AUDIO_SAMPLE_RATE` / `AUDIO_CHANNELS` | `24000` / `1` | Initial audio format (Hz / channels) |
| `-auth-token` | `AUTH_TOKEN` | - | Shared secret required to connect |
| `-web-dir` | `WEB_DIR` | - | Serve frontend files from a local directory instead of the built-in copy |
| `-log-file` / `-log-level` / `-debug` | `LOG_FILE` / `LOG_LEVEL` / `DEBUG` | stdout / `info` / `false` | Logging |
| `-version` / `-v` | - | - | Print the version and exit |

`-listen-http` defaults to localhost because the typical deployment is
behind an SSH tunnel or a reverse proxy on the same host - see
`ood-integration.md`.

`-auth-token`, when set, is required to actually start the video/audio
streams; the page itself still loads without it.

When `-pulse-server` isn't set, autodetection checks (in order): the
`PULSE_SERVER` env var, `/tmp/pulse-vnc-*/native` (this app's own
`-pulse-spawn` sockets), `$XDG_RUNTIME_DIR/pulse/native`,
`/run/user/<uid>/pulse/native`, then `/tmp/pulse-*/native`.

## Client URL parameters

Configured via query string, e.g.
`https://host:8080/?autoconnect=true&scale=remote-resize&quality=7`.

| Param | Default | Meaning |
|---|---|---|
| `autoconnect` | `false` | Connect immediately on page load |
| `password` | - | VNC password |
| `token` | - | Matches `-auth-token`, if the server requires one |
| `view_only` | `false` | Disable keyboard/mouse/clipboard input |
| `scale` | `fit` | `fit` \| `remote-resize` \| `down` \| `none` |
| `dpi_scale` | `1` | Render sharpness multiplier in `remote-resize` mode, `0.5`-`3.0` |
| `quality` | `7` | Image quality, `0`-`9` |
| `compression` | `2` | Compression level, `0`-`9` |
| `audio` | `true` | Start with the speaker unmuted |
| `audio_sample_rate` / `audio_channels` | `24000` / `1` | Initial audio format |
| `clipboard_sync` (or `clipboard`) | `true` | Bidirectional clipboard sync |
| `reconnect` / `reconnect_delay` | `true` / `3000` | Auto-reconnect on drop, and delay in ms |
| `debug` | `false` | On-page diagnostics overlay - see below |

`scale` modes: `fit` scales the desktop to the browser window; `remote-resize`
asks the server to resize the desktop to match the window instead;
`down` scales down only, never enlarging; `none` shows the desktop at its
actual size, with panning.

`quality` and `compression` are two separate settings for two different
kinds of screen content: `quality` affects photographic/video-like areas,
`compression` affects everything else (flat colors, text, window chrome).
Raising `compression` doesn't improve photographic content.

## Notifications

Connection and audio errors (lost connection, authentication failure,
playback errors, etc.) appear as dismissible notifications in the
bottom-right corner, rather than only being logged to the browser console.

## Checking the version

`./cnt-vnc-viewer -version` (or `-v`) prints the version and exits. While
connected, the same version is also shown in the web client's Settings
panel, under "Session Info".

## Debug overlay

`?debug=1` adds an on-page overlay showing live connection stats (not
`console.log`, since opening browser DevTools mid-session can crash the
page):

- **client / server** - audio buffering, underrun, packet loss, and
  reconnect counts.
- **render** - resolution and screen-update rate.
- **net** - actual bandwidth in use (video and audio combined).
- **page** - browser memory usage (Chrome/Edge only).
