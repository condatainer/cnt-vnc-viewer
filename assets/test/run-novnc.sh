#!/usr/bin/env bash
# ==============================================================================
# Same as run.sh, but launches run-turbovnc-novnc.sh inside the container - stock
# noVNC reference client via websockify, instead of cnt-vnc-viewer. See
# run-turbovnc-novnc.sh's own header comment for why this exists (A/B isolating
# whether a rendering issue is in noVNC's own core vs. cnt-vnc-viewer's wrapper).
#
# Defaults to a different display/port than run.sh (DISPLAY_NUM=11, WEB_PORT=8081)
# so both can be run at the same time for a direct side-by-side comparison.
#
# When Ctrl+C is pressed, all container and host processes terminate cleanly.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ------------------------------------------------------------------------------
# 1. Locate Container Runtime (Apptainer or Singularity)
# ------------------------------------------------------------------------------
if command -v apptainer &>/dev/null; then
    CONTAINER_CMD="apptainer"
elif command -v singularity &>/dev/null; then
    CONTAINER_CMD="singularity"
else
    echo "[-] Error: Neither 'apptainer' nor 'singularity' was found in PATH." >&2
    exit 1
fi

# ------------------------------------------------------------------------------
# 2. Locate Container Image (SquashFS .sqf)
# ------------------------------------------------------------------------------
IMAGE_FILE="${SQF_PATH:-${IMAGE_PATH:-}}"

if [[ -z "$IMAGE_FILE" ]]; then
    SEARCH_PATHS=(
        "$SCRIPT_DIR/turbovnc-xfce.sqf"
        "$PROJECT_ROOT/turbovnc-xfce.sqf"
        "$(pwd)/turbovnc-xfce.sqf"
    )
    for p in "${SEARCH_PATHS[@]}"; do
        if [[ -f "$p" ]]; then
            IMAGE_FILE="$p"
            break
        fi
    done
fi

if [[ -z "$IMAGE_FILE" || ! -f "$IMAGE_FILE" ]]; then
    echo "[-] Error: SquashFS container image (.sqf) not found." >&2
    echo "    Please build it first using:" >&2
    echo "      ./assets/test/build-sqf.sh" >&2
    echo "    Or specify its path via SQF_PATH environment variable:" >&2
    echo "      SQF_PATH=/path/to/image.sqf ./run-novnc.sh" >&2
    exit 1
fi

# ------------------------------------------------------------------------------
# 3. Configure Bind Mounts & Environment
# ------------------------------------------------------------------------------
BINDS=(
    # Bind the project root so helper scripts are accessible inside container
    "-B" "$PROJECT_ROOT:$PROJECT_ROOT"
)

# Crucial for Apptainer: host /tmp/.X11-unix is owned by host root, which maps to
# 'nobody' in unprivileged containers. libXtrans refuses to bind sockets in 'nobody' dirs.
# Providing a user-owned directory allows Xvnc to create /tmp/.X11-unix/X<N> without error.
USER_X11_DIR="/tmp/x11-unix-${USER:-user}"
mkdir -p "$USER_X11_DIR"
chmod 1777 "$USER_X11_DIR"
BINDS+=("-B" "$USER_X11_DIR:/tmp/.X11-unix")

# If a local noVNC dev checkout exists (see assets/test/setup-novnc-dev.sh),
# bind it over the image's baked-in /opt/noVNC. This lets you patch noVNC's
# core (e.g. core/display.js) and see the effect on refresh, with no .sqf
# rebuild needed - only bake a change into the image once it's proven out.
# It's also the only way to get the ?debug=1 stats overlay here, since the
# image's own stock /opt/noVNC has none. Override the path with
# NOVNC_DEV_DIR, or unset/point it elsewhere to fall back to the image's
# stock (unpatched, no overlay) copy - a legitimate mode too, since that's
# the real A/B baseline.
NOVNC_DEV_DIR="${NOVNC_DEV_DIR:-$SCRIPT_DIR/novnc-dev}"
if [[ -d "$NOVNC_DEV_DIR" ]]; then
    echo "[*] Binding local noVNC dev checkout: $NOVNC_DEV_DIR -> /opt/noVNC"
    BINDS+=("-B" "$NOVNC_DEV_DIR:/opt/noVNC")
else
    echo "[*] $NOVNC_DEV_DIR not found - serving the image's stock noVNC"
    echo "    (no ?debug=1 overlay there). Run ./assets/test/setup-novnc-dev.sh"
    echo "    first for the debug-instrumented dev copy."
fi

# ------------------------------------------------------------------------------
# 4. Check GPU Acceleration
# ------------------------------------------------------------------------------
EXTRA_OPTS=()
if command -v nvidia-smi &>/dev/null || [[ -e /dev/nvidia0 ]]; then
    echo "[*] NVIDIA GPU detected. Enabling --nv flag for VirtualGL acceleration."
    EXTRA_OPTS+=("--nv")
fi

# ------------------------------------------------------------------------------
# 5. Cleanup Trap for Clean Teardown
# ------------------------------------------------------------------------------
DISPLAY_NUM="${DISPLAY_NUM:-11}"

cleanup_host() {
    local exit_code=$?
    echo ""
    echo "[*] Stopping container session..."
    # Clean up any leftover host lock and socket files
    rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}" 2>/dev/null || true
    rm -f "${USER_X11_DIR}/X${DISPLAY_NUM}" 2>/dev/null || true
    exit "$exit_code"
}

trap cleanup_host INT TERM EXIT

echo "===================================================================="
echo " Launching TurboVNC (:${DISPLAY_NUM}) + stock noVNC in Apptainer Container"
echo " Container Image: $IMAGE_FILE"
echo "===================================================================="

# ------------------------------------------------------------------------------
# 6. Execute run-turbovnc-novnc.sh Inside Container
# ------------------------------------------------------------------------------
exec "$CONTAINER_CMD" exec \
    "${EXTRA_OPTS[@]}" \
    "${BINDS[@]}" \
    --pwd "$PROJECT_ROOT" \
    "$IMAGE_FILE" \
    bash "$SCRIPT_DIR/run-turbovnc-novnc.sh" "$@"
