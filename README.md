# cnt-vnc-viewer

A web-based VNC client purpose-built for HPC remote-desktop sessions: a
single Go binary that serves a noVNC-based frontend, proxies the RFB (VNC)
protocol over WebSocket, bridges PulseAudio so remote-desktop audio
plays in the browser, and syncs the clipboard both ways with the remote
desktop. Designed to sit behind an SSH tunnel or a reverse proxy such as
Open OnDemand, with everything (frontend, video, audio, clipboard)
served from one process and one port.

```
Browser  <--WebSocket-->  cnt-vnc-viewer (Go)  <--TCP-->  TurboVNC/Xvnc
                                |
                                +--unix/tcp-->  PulseAudio
```

- **`cmd/server`** - entrypoint; embeds the built frontend.
- **`pkg/server`** - HTTP(S) server, routes, TLS.
- **`pkg/vncproxy`** - proxies `/ws/rfb` to the target RFB TCP server.
- **`pkg/audio`** - PulseAudio bridge, Opus over `/ws/audio`.
- **`web/`** - frontend (Vite + TypeScript) on top of noVNC.

## Build

Requires Go and Node/npm.

```bash
make frontend   # tsc + vite build -> cmd/server/dist/
make server     # go build -> ./cnt-vnc-viewer
make all        # both
make test       # go test ./pkg/...
```

## Run

```bash
./cnt-vnc-viewer -vnc-addr 127.0.0.1:5901
```

## Documentation

- [`docs/configuration.md`](docs/configuration.md) - server flags/env vars,
  client URL parameters, the debug overlay.
- [`docs/ood-integration.md`](docs/ood-integration.md) - deploying behind
  Open OnDemand.
- [`docs/development.md`](docs/development.md) - the local TurboVNC/XFCE
  test harness, and the A/B setup against stock noVNC.
- [`assets/notes/`](assets/notes/) - deeper write-ups on specific findings
  (TurboVNC's update-rate behavior, a Chromium memory regression in noVNC's
  JPEG decode path, and the reasoning behind the current defaults).
