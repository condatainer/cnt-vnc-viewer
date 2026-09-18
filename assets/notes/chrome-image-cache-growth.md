# Chrome Image Cache / heap growth in noVNC's JPEG decode path

## What we observed

Running stock noVNC (1.7.0, the same version cnt-vnc-viewer vendors) via
the A/B harness (`run-novnc.sh`) at `DEFER_UPDATE_MS=none` (TurboVNC's real
1ms default - see `deferupdate-and-update-rate.md`), during sustained video
playback (800-2000+ JPEG rects/sec):

- JS heap (`performance.memory.usedJSHeapSize`) climbed past **1.6GB** and
  kept climbing, not sawtoothing back down.
- Reproduced identically with zero cnt-vnc-viewer code involved (stock
  noVNC via `websockify`), confirming the growth lives in noVNC's own
  core, not cnt-vnc-viewer's wrapper.
- Traced to `core/display.js`'s `imageRect()`: it builds a base64 `data:`
  URI string per rect and assigns it to `new Image().src`.

## Matches an open upstream report

[novnc/noVNC#2075](https://github.com/novnc/noVNC/issues/2075) (filed
2026-08-05) describes the same thing: unbounded growth of Chrome's own
**Image Cache** (visible in Chrome's Task Manager, distinct from the JS
heap number above) on Chrome v149-151. The reporter notes noVNC's existing 
mitigation (`img.src = ""` after drawing, to let the browser free it) is 
not enough in current Chrome.

The same reporter's own follow-up investigation (their account - the
Chromium tracker requires sign-in, so this hasn't been independently
re-verified here) attributes it to a **Chrome 149 regression**: `MemoryCache`
started holding strong references to `data:` URL resources, and since a
VNC stream continuously generates unique, one-shot `data:` JPEG URLs, this
is a worst case for that behavior. A Chromium bug was filed:
[issues.chromium.org/issues/545977878](https://issues.chromium.org/issues/545977878).

They also tried Blob-based alternatives themselves:

- **Blob URL + `Image`**: Image Cache growth goes away, but overall memory
  growth remains, and it's slower.
- **Blob + `ImageBitmap`**: fixes the memory growth, but they measured
  JPEG decode as ~8x slower, and called it impractical for a VNC client.

## What we tried

Patched `core/display.js`'s `imageRect()` to build a `Blob` from the raw
rect bytes and decode via `createImageBitmap()` instead - no `data:` URI,
no `Image` element - pushing a `'bitmap'` render-queue action that mirrors
the existing WebCodecs `'frame'` action's promise-wait pattern.

Tested two ways:

- In `assets/test/novnc-dev/` - a local noVNC 1.7.0 checkout bind-mounted
  over the container's `/opt/noVNC` (see `run-novnc.sh`), so it can be
  edited live without rebuilding the `.sqf`.
- Ported into cnt-vnc-viewer's own vendored `@novnc/novnc` copy, made
  durable via `patch-package` (`web/patches/@novnc+novnc+1.7.0.patch`,
  reapplied automatically by the `postinstall` script in
  `web/package.json` on every `npm install`).

## What we measured

**Heap, at `DEFER_UPDATE_MS=none` (worst case), same content as above:**

- Stock noVNC: heap growth rate dropped from ~2MB/s to ~150-300KB/s at the
  same 800-2000 rects/sec, and sawtoothed cleanly (grow, then GC reclaims
  back to a ~50MB baseline) rather than climbing unbounded.
- cnt-vnc-viewer itself: heap stayed flat in the 20-80MB range throughout,
  even with `maxRenderQ` (the render queue backlog) spiking to ~100 under
  the same stress - versus 1.6GB+ before the patch at a similar or lower
  backlog.

**Decode latency, measured directly:** to test the reported ~8x figure
ourselves rather than take it on faith, `novnc-dev`'s `imageRect()` was
changed to decode **every rect through both paths at once** on identical
bytes, same session, same system load - one path renders normally through
the ordered `_renderQ`, the other decodes the same bytes purely for timing
and is discarded (never drawn). The `?debug=1` overlay reports both
rolling averages side by side.

Result: `Blob`+`createImageBitmap` averaged **~6ms**, `data:` URI +
`Image` averaged **~3ms** - **~2x slower, not ~8x**. One machine/browser/
session so far; not yet repeated across hardware or under sustained
high-load conditions. The gap with the reported ~8x figure isn't
explained yet (different hardware, rect sizes/content, or methodology are
all possible).

## What we shipped

Rather than pay the decode-latency cost unconditionally, the patch detects
at startup whether the current browser is actually affected and only uses
`createImageBitmap` there:

- `detectChromiumMemoryCacheBug()` in `display.js`: prefers
  `navigator.userAgentData.brands` (User-Agent Client Hints) to identify a
  Chromium-family brand and its major version, falling back to legacy
  `navigator.userAgent` regex parsing where Client Hints aren't available.
  Affected if Chromium-family and version >= 149 (no known fixed version
  yet - the Chromium bug is still open).
- Both `'bitmap'` (new) and `'img'` (original) render-queue action types
  coexist in `_scanRenderQ()`; `imageRect()` picks one per session based
  on the detection result.
- Unaffected browsers (older Chromium, Firefox, Safari) pay no decode-path
  cost at all.
