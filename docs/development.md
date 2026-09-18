# Development / testing harness

`assets/test/` contains an Apptainer-based TurboVNC+XFCE image and launcher
scripts, used for local development and for checking whether a given
behavior comes from noVNC itself or from this project's own code.

## Building the image

```bash
./assets/test/build-sqf.sh
```

Builds a container image from `turbovnc-xfce.def` (Ubuntu 22.04 + XFCE4 +
TurboVNC + VirtualGL + PulseAudio + stock noVNC/websockify) and packs it to
`assets/test/turbovnc-xfce.sqf`. Network- and package-download-heavy; not
fast.

## Running cnt-vnc-viewer against it

```bash
./assets/test/run.sh
```

Launches TurboVNC (`:10` by default) plus this project's own built
`cnt-vnc-viewer` binary. Env vars:

- `GEOMETRY` (default `1280x720`) - the desktop's launch resolution.
- `DEFER_UPDATE_MS` (default `40`) - the server's screen-update batching
  window in milliseconds. Set to `none` to disable batching entirely.
- `VNC_PASSWORD` - if set, configures a VNC password.

## A/B testing against stock noVNC

```bash
./assets/test/run-novnc.sh
```

Launches the same TurboVNC setup but serves the stock noVNC reference
client instead of cnt-vnc-viewer, on a separate display/port
(`DISPLAY_NUM=11` / `WEB_PORT=8081` by default) so it can run alongside
`run.sh` for a side-by-side comparison. noVNC is pinned to the exact
version this project vendors, so any difference in behavior is
attributable to this project's own code, not a version mismatch.
Video/render only - no audio bridging in this mode.

This harness also auto-binds `assets/test/novnc-dev/` - a local, debug-
instrumented noVNC checkout - over the image's noVNC install whenever that
directory exists, so noVNC's own source can be edited and the effect seen
immediately without rebuilding the image. It carries its own `?debug=1`
overlay (see `configuration.md`), since stock noVNC has none of its own.

`novnc-dev/` isn't committed (it's a full upstream clone, not project
source) - set it up with:

```bash
./assets/test/setup-novnc-dev.sh
```

This clones noVNC and applies `assets/test/novnc-dev-debug.patch` (the
diff for the debug overlay, committed to git). Without it, `run-novnc.sh`
still works - it just falls back to the image's plain stock noVNC, with
no overlay, which is a legitimate mode too (the real A/B baseline).

## Making a noVNC fix durable

cnt-vnc-viewer vendors `@novnc/novnc` as a normal npm dependency and patches
it via [`patch-package`](https://www.npmjs.com/package/patch-package) rather
than maintaining a fork:

- `web/patches/@novnc+novnc+1.7.0.patch` is the diff, committed to git.
- `web/package.json`'s `postinstall` script reapplies it automatically on
  every `npm install`.

To change the patch: edit the file directly under
`web/node_modules/@novnc/novnc/`, then regenerate it:

```bash
cd web && node_modules/.bin/patch-package @novnc/novnc
```

Then `make all` to rebuild.
