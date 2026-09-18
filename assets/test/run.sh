#!/usr/bin/env bash
# ==============================================================================
# Helper script to execute TurboVNC + cnt-vnc-viewer inside an Apptainer /
# Singularity container (SquashFS .sqf), binding the client binary into container's PATH.
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
    echo "      SQF_PATH=/path/to/image.sqf ./run.sh" >&2
    exit 1
fi

# ------------------------------------------------------------------------------
# 3. Locate & Verify cnt-vnc-viewer Binary
# ------------------------------------------------------------------------------
SERVER_BIN="$PROJECT_ROOT/cnt-vnc-viewer"
if [[ ! -x "$SERVER_BIN" ]]; then
    echo "[*] cnt-vnc-viewer binary not found on host. Attempting to build..."
    if command -v make &>/dev/null; then
        make -C "$PROJECT_ROOT" server
    else
        echo "[-] Error: Please build cnt-vnc-viewer first (run 'make all')." >&2
        exit 1
    fi
fi

# ------------------------------------------------------------------------------
# 4. Configure Bind Mounts & Environment
# ------------------------------------------------------------------------------
BINDS=(
    # Bind the compiled server binary directly to the container executable path (/usr/local/bin)
    "-B" "$SERVER_BIN:/usr/local/bin/cnt-vnc-viewer:ro"
    # Also bind the project root so helper scripts are accessible inside container
    "-B" "$PROJECT_ROOT:$PROJECT_ROOT"
)

# Crucial for Apptainer: host /tmp/.X11-unix is owned by host root, which maps to
# 'nobody' in unprivileged containers. libXtrans refuses to bind sockets in 'nobody' dirs.
# Providing a user-owned directory allows Xvnc to create /tmp/.X11-unix/X<N> without error.
USER_X11_DIR="/tmp/x11-unix-${USER:-user}"
mkdir -p "$USER_X11_DIR"
chmod 1777 "$USER_X11_DIR"
BINDS+=("-B" "$USER_X11_DIR:/tmp/.X11-unix")

# ------------------------------------------------------------------------------
# 5. Check GPU Acceleration
# ------------------------------------------------------------------------------
EXTRA_OPTS=()
if command -v nvidia-smi &>/dev/null || [[ -e /dev/nvidia0 ]]; then
    echo "[*] NVIDIA GPU detected. Enabling --nv flag for VirtualGL acceleration."
    EXTRA_OPTS+=("--nv")
fi

# ------------------------------------------------------------------------------
# 6. Cleanup Trap for Clean Teardown
# ------------------------------------------------------------------------------
DISPLAY_NUM="${DISPLAY_NUM:-10}"

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
echo " Launching TurboVNC (:${DISPLAY_NUM}) in Apptainer Container"
echo " Container Image: $IMAGE_FILE"
echo " Bound Binary:    $SERVER_BIN -> /usr/local/bin/cnt-vnc-viewer"
echo "===================================================================="

# ------------------------------------------------------------------------------
# 7. Execute run-turbovnc.sh Inside Container
# ------------------------------------------------------------------------------
exec "$CONTAINER_CMD" exec \
    "${EXTRA_OPTS[@]}" \
    "${BINDS[@]}" \
    --pwd "$PROJECT_ROOT" \
    "$IMAGE_FILE" \
    bash "$SCRIPT_DIR/run-turbovnc.sh" "$@"

