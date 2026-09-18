#!/usr/bin/env bash
# ==============================================================================
# Sets up assets/test/novnc-dev/ - a local noVNC checkout, patched with debug
# instrumentation (a ?debug=1 stats overlay, and a Chromium-memory-regression
# workaround that decodes every rect through both candidate code paths at
# once for side-by-side timing). run-novnc.sh binds this over the container
# image's /opt/noVNC automatically when it's present, for live-editing noVNC
# without rebuilding the image.
#
# novnc-dev/ itself is gitignored (it's a full upstream clone, not project
# source) - this script is what makes it reproducible from git alone. Safe
# to re-run; does nothing if novnc-dev/ already exists.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NOVNC_DEV_DIR="$SCRIPT_DIR/novnc-dev"
PATCH_FILE="$SCRIPT_DIR/novnc-dev-debug.patch"
NOVNC_VERSION="v1.7.0"

if [[ -d "$NOVNC_DEV_DIR" ]]; then
    echo "[*] $NOVNC_DEV_DIR already exists - nothing to do."
    echo "    Delete it first if you want to re-clone and re-patch from scratch."
    exit 0
fi

echo "[*] Cloning noVNC $NOVNC_VERSION into $NOVNC_DEV_DIR..."
git clone --depth 1 --branch "$NOVNC_VERSION" https://github.com/novnc/noVNC.git "$NOVNC_DEV_DIR"

echo "[*] Applying debug instrumentation patch..."
git -C "$NOVNC_DEV_DIR" apply "$PATCH_FILE"

echo "[+] Done. run-novnc.sh will now bind this over /opt/noVNC automatically."
