# TurboVNC update-rate (`-deferupdate`) behavior

## The TurboVNC behavior

Xvnc has a `-deferupdate <ms>` option: it batches all screen damage within
that window into a single framebuffer update instead of flushing on every
individual change. `Xvnc -help` documents its own default as 40ms - but
that's misleading for anyone launching via `vncserver`. TurboVNC's
`vncserver` Perl wrapper (`/opt/TurboVNC/bin/vncserver`) hardcodes its own
default:

```perl
$deferUpdate = 1;
```

and only overrides it if `-deferupdate` is explicitly passed on the
`vncserver` command line. So unless a caller passes it explicitly, every
TurboVNC session actually runs at **1ms** defer - essentially real-time, no
batching at all - regardless of what the Xvnc help text claims. Confirmed
directly against this image's binaries (`Xvnc -help`, and reading the
wrapper script itself), not assumed.

## What we observed at 1ms defer

A busy remote screen (video playback, hover-heavy UI) drives the update
rate as fast as the content itself changes - observed **800-2000+ JPEG
rects/sec** at **~10MB/sec** of JPEG payload during video playback,
sustained for the whole time it plays.

That rate is costly in two separate ways:

1. **Chrome-side heap/Image Cache growth** in noVNC's JPEG decode path,
   severe enough at sustained high rates to cause audio crackle, page
   stalls, and even hung page refreshes. Root-caused and fixed separately
   - see `chrome-image-cache-growth.md`, not repeated here.
2. **Render-queue backlog starving the main thread.** At 40ms defer,
   `Display._renderQ` / `maxRenderQ` was observed reaching 50+ under
   video, which starved the main thread badly enough to cause audio
   underrun even with decode itself healthy - the backlog eating the
   thread, not GC, being the mechanism for this particular symptom.

(Two related but separate resize-flashing issues from the same general
area were also fixed on the client side: `VncClient.ts`'s
`_requestRemoteResize` debounce, and a `.vnc-viewport` `overflow: hidden`
fix - neither is the subject of this document.)

## Mitigation (current default: 40ms) - and how it got there

`run-turbovnc.sh` explicitly passes `-deferupdate $DEFER_UPDATE_MS`
(default **40**, overridable via env var: `DEFER_UPDATE_MS=<ms>
./assets/test/run.sh`). 40ms brings a test video down from 1000-2000
rects/sec to 400-500 with a flat, stable heap - a big improvement over the
wrapper's real 1ms default.

This wasn't the first landing point, though. Measured against noVNC's
*original* base64 `Image()` decode path, 40ms could still spike past 500
rects/sec during video, backing up the render queue (`maxRenderQ` 50+)
enough to starve the main thread and cause audio underrun - which briefly
pushed the default up to 70ms, trading some smoothness for headroom. Once
the decode path changed (the `createImageBitmap` fix in
`chrome-image-cache-growth.md`, which also removes a real chunk of
per-rect main-thread cost - no more base64 string parsing as part of
`Image` resource loading), 70ms felt noticeably laggier in practice than
it needed to be, so the default moved back down to 40ms.

This is still a real quality/responsiveness tradeoff, not a free fix: a
lower `deferupdate` means smoother/faster-feeling screen updates but
higher risk of the render-queue-backlog problem above; a higher value
trades some smoothness (fewer effective FPS on fast-moving content) for
headroom. Tune per workload - watch `rects/s` and `maxRenderQ` in the
debug overlay (below); if `maxRenderQ` climbs and audio underrun shows up
again, that's the signal to raise `DEFER_UPDATE_MS` back up, not a fixed
rects/s number to target blindly.

## Script

`run.sh` / `run-turbovnc.sh` - normal launcher, explicit `-deferupdate`
(default 40ms, override with `DEFER_UPDATE_MS=<ms> ./assets/test/run.sh`).

Set `DEFER_UPDATE_MS=none` to omit the `-deferupdate` flag entirely,
reproducing the wrapper's real (1ms) default. Useful for re-confirming this
finding (e.g. after a TurboVNC upgrade), not for normal use - it reproduces
the original problem: `DEFER_UPDATE_MS=none ./assets/test/run.sh`

## Is it noVNC or cnt-vnc-viewer? (A/B harness)

`run-novnc.sh` / `run-turbovnc-novnc.sh` launch the same TurboVNC setup (same
`DEFER_UPDATE_MS` handling) but serve the *stock* noVNC reference client
(`vnc.html`) via `websockify` instead of cnt-vnc-viewer. noVNC is pinned to
the exact version cnt-vnc-viewer's `web/package.json` vendors
(`turbovnc-xfce.def`'s `NOVNC_VERSION`), so this isolates whether a
rendering/flashing/underrun issue is in noVNC's own core (`core/rfb.js`,
`core/display.js`) versus something in cnt-vnc-viewer's own wrapper code
(`VncClient.ts`'s hooks/debounce, the render-stats instrumentation, etc.).
This is the harness `chrome-image-cache-growth.md`'s findings were
isolated and validated with.

Defaults to `DISPLAY_NUM=11` / `WEB_PORT=8081` so it can run alongside
`run.sh` for a direct side-by-side comparison. Video/render only - websockify
has no audio-bridging capability at all, so this can't compare the audio
path. Requires the `.sqf` to be rebuilt with `websockify` + noVNC installed
(added to `turbovnc-xfce.def`; not present in an older-built image).

`run-novnc.sh` also auto-binds `assets/test/novnc-dev/` (a local noVNC
checkout - `git clone --branch v1.7.0 https://github.com/novnc/noVNC.git
novnc-dev`) over the image's `/opt/noVNC` whenever that directory exists,
letting you patch noVNC's core and see the effect live (bind mounts are
live - no `.sqf` rebuild needed) instead of rebuilding the image for every
iteration. It also carries its own `?debug=1` stats overlay (`vnc.html`),
mirroring cnt-vnc-viewer's own overlay (rects/s, jpeg KB/s, render queue
depth, JS heap), since stock noVNC has no such instrumentation itself.

## How to observe it directly

Launch with `?debug=1` on the client URL for an on-page diagnostics
overlay (deliberately not console.log - opening DevTools mid-session on
this canvas-heavy page can crash the tab; if you need finer-grained memory
inspection, Chrome/Edge's Task Manager - `Shift+Esc` - is lighter-weight
than the full DevTools inspector). The `render:` line shows live
`rects/s` / `jpeg KB/s` / render-queue depth (`VncClient.ts`'s
`RenderDebugStats`), and `page:` shows JS heap size
(`performance.memory.usedJSHeapSize`, Chrome/Edge only). Compare the default
`DEFER_UPDATE_MS=40` run against `DEFER_UPDATE_MS=none` (or a higher value
like `=70`) on the same content to see the difference directly.
