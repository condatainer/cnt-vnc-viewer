#!/usr/bin/env bash
# ==============================================================================
# Same TurboVNC launch as run-turbovnc.sh, but serves the stock noVNC reference
# client (vnc.html) via websockify instead of cnt-vnc-viewer. Exists to A/B
# whether a rendering/flashing/underrun issue comes from noVNC's own core
# (core/rfb.js, core/display.js - the exact code cnt-vnc-viewer's own
# web/node_modules/@novnc/novnc vendors, pinned to the same version here - see
# turbovnc-xfce.def's NOVNC_VERSION) or from something in cnt-vnc-viewer's own
# wrapper code (VncClient.ts's hooks/debounce, the render-stats instrumentation,
# etc.).
#
# Video/render only: websockify has no audio-bridging capability at all, so
# this can't compare the audio path - only screen rendering/update behavior.
#
# Defaults to a different display/port than run-turbovnc.sh (DISPLAY_NUM=11,
# WEB_PORT=8081) so both can run side by side for a direct comparison without
# colliding.
#
# Traps Ctrl+C (SIGINT / SIGTERM) to ensure all child processes are killed cleanly.
# ==============================================================================

set -euo pipefail

# Configuration defaults (can be overridden via environment variables)
DISPLAY_NUM="${DISPLAY_NUM:-11}"
WEB_PORT="${WEB_PORT:-8081}"
LISTEN_ADDR="${LISTEN_ADDR:-0.0.0.0}"
GEOMETRY="${GEOMETRY:-1280x720}"
SECURITY_TYPES="${SECURITY_TYPES:-none}"
TURBOVNC_DIR="${TURBOVNC_DIR:-/opt/TurboVNC}"
NOVNC_DIR="${NOVNC_DIR:-/opt/noVNC}"
# Same meaning as in run-turbovnc.sh - see that script's comment and
# assets/notes/deferupdate-and-update-rate.md for the full writeup on why
# this needs to be passed explicitly and what a good value is. Kept at the
# same default here so a comparison run isn't accidentally testing two
# different update rates.
DEFER_UPDATE_MS="${DEFER_UPDATE_MS:-40}"

VNC_PORT=$((5900 + DISPLAY_NUM))
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Locate TurboVNC vncserver binary
if [[ -x "$TURBOVNC_DIR/bin/vncserver" ]]; then
    VNC_SERVER="$TURBOVNC_DIR/bin/vncserver"
elif command -v vncserver &>/dev/null; then
    VNC_SERVER="$(command -v vncserver)"
else
    echo "[-] Error: TurboVNC vncserver not found at $TURBOVNC_DIR/bin/vncserver or in PATH." >&2
    exit 1
fi

# Locate vncpasswd binary
VNCPASSWD_BIN=""
if [[ -x "$TURBOVNC_DIR/bin/vncpasswd" ]]; then
    VNCPASSWD_BIN="$TURBOVNC_DIR/bin/vncpasswd"
elif command -v vncpasswd &>/dev/null; then
    VNCPASSWD_BIN="$(command -v vncpasswd)"
fi

if [[ ! -f "$NOVNC_DIR/vnc.html" ]]; then
    echo "[-] Error: noVNC not found at $NOVNC_DIR/vnc.html." >&2
    echo "    Rebuild the .sqf with noVNC installed - see turbovnc-xfce.def's NOVNC_VERSION" >&2
    echo "    and assets/test/build-sqf.sh." >&2
    exit 1
fi
if ! command -v websockify &>/dev/null; then
    echo "[-] Error: websockify not found in PATH." >&2
    echo "    Rebuild the .sqf with websockify installed - see turbovnc-xfce.def." >&2
    exit 1
fi

echo "===================================================================="
echo " Starting TurboVNC on :${DISPLAY_NUM} (Port: ${VNC_PORT})"
echo " Stock noVNC reference client listening on http://${LISTEN_ADDR}:${WEB_PORT}"
echo "===================================================================="

# Variable to track child server PID and temp files
SERVER_PID=""
PASSWD_FILE=""
XSTARTUP_FILE=""

# ------------------------------------------------------------------------------
# Cleanup handler: guarantees all processes and locks are stopped on Ctrl+C / EXIT
# ------------------------------------------------------------------------------
cleanup() {
    local exit_code=$?
    echo ""
    echo "[*] Caught termination signal. Stopping all services..."

    # 1. Terminate websockify
    if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
        echo " -> Stopping websockify (PID: $SERVER_PID)..."
        kill -TERM "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi

    # 2. Terminate TurboVNC server
    echo " -> Stopping TurboVNC on :${DISPLAY_NUM}..."
    "$VNC_SERVER" -kill ":${DISPLAY_NUM}" 2>/dev/null || true

    # 3. Clean up any leftover X11 lock files for this display
    rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}" 2>/dev/null || true

    # 4. Clean up temporary files created by this run
    if [[ -n "${PASSWD_FILE:-}" ]] && [[ -f "$PASSWD_FILE" ]]; then
        rm -f "$PASSWD_FILE" 2>/dev/null || true
    fi
    if [[ -n "${XSTARTUP_FILE:-}" ]] && [[ -f "$XSTARTUP_FILE" ]]; then
        rm -f "$XSTARTUP_FILE" 2>/dev/null || true
    fi

    echo "[+] All processes cleanly terminated."
    exit "$exit_code"
}

trap cleanup INT TERM EXIT

# Pre-launch cleanup of any stale previous instance on this display
echo "[*] Ensuring display :${DISPLAY_NUM} is clear..."
"$VNC_SERVER" -kill ":${DISPLAY_NUM}" 2>/dev/null || true
rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}" 2>/dev/null || true
sleep 0.5

# Ensure writable runtime directory for DBus and XFCE in container/unprivileged env
export XDG_RUNTIME_DIR="/tmp/runtime-${USER:-user}-novnc"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

# Generate dedicated xstartup script that guarantees DBus launches XFCE cleanly.
# No PulseAudio routing here (unlike run-turbovnc.sh) - websockify/noVNC has no audio
# bridging capability at all, so there's nothing on the browser end to route audio to.
XSTARTUP_FILE="/tmp/xstartup-${USER:-user}-novnc.sh"
cat <<EOF > "$XSTARTUP_FILE"
#!/usr/bin/env bash
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS

export DISPLAY=:${DISPLAY_NUM}
export XDG_RUNTIME_DIR="/tmp/runtime-${USER:-user}-novnc"
mkdir -p "\$XDG_RUNTIME_DIR"
chmod 700 "\$XDG_RUNTIME_DIR"

# Disable screensaver and locker
xset s off 2>/dev/null || true
xset -dpms 2>/dev/null || true

# Launch XFCE4 session
if command -v dbus-launch &>/dev/null; then
    exec dbus-launch --exit-with-session startxfce4
elif command -v startxfce4 &>/dev/null; then
    exec startxfce4
elif command -v xfce4-session &>/dev/null; then
    exec xfce4-session
else
    xsetroot -solid grey
    xterm &
fi
EOF
chmod 755 "$XSTARTUP_FILE"

if [[ -n "${VNC_PASSWORD:-}" ]]; then
    if [[ -z "$VNCPASSWD_BIN" ]]; then
        echo "[-] Error: vncpasswd binary not found at $TURBOVNC_DIR/bin/vncpasswd or in PATH." >&2
        exit 1
    fi
    PASSWD_FILE="$(mktemp /tmp/tvnc-passwd.XXXXXX)"
    echo "$VNC_PASSWORD" | "$VNCPASSWD_BIN" -f > "$PASSWD_FILE"
    chmod 600 "$PASSWD_FILE"
    SECURITY_TYPES="vnc"
fi

if [[ "$DEFER_UPDATE_MS" == "none" ]]; then
    echo "[*] Launching TurboVNC on :${DISPLAY_NUM} (deferupdate=<wrapper default, 1ms>)..."
else
    echo "[*] Launching TurboVNC on :${DISPLAY_NUM} (deferupdate=${DEFER_UPDATE_MS}ms)..."
fi
VNC_ARGS=(
    ":${DISPLAY_NUM}"
    "-geometry" "$GEOMETRY"
    "-localhost"
    "-securitytypes" "$SECURITY_TYPES"
    "-xstartup" "$XSTARTUP_FILE"
    "-noautokill"
)
if [[ "$DEFER_UPDATE_MS" != "none" ]]; then
    VNC_ARGS+=("-deferupdate" "$DEFER_UPDATE_MS")
fi

if [[ -n "$PASSWD_FILE" ]]; then
    VNC_ARGS+=("-rfbauth" "$PASSWD_FILE")
fi

"$VNC_SERVER" "${VNC_ARGS[@]}"

# Wait for VNC port to become accessible (up to 10 seconds)
echo "[*] Waiting for TurboVNC port ${VNC_PORT} to be ready..."
PORT_READY=0
HEX_PORT=$(printf "%04X" "$VNC_PORT")
for _ in {1..50}; do
    if command -v ss &>/dev/null && ss -tln 2>/dev/null | grep -qE "(:${VNC_PORT}\b|\]:${VNC_PORT}\b)"; then
        PORT_READY=1
        break
    elif command -v netstat &>/dev/null && netstat -tln 2>/dev/null | grep -qE "(:${VNC_PORT}\b|\]:${VNC_PORT}\b)"; then
        PORT_READY=1
        break
    elif [[ -f /proc/net/tcp ]] && grep -qiE ":${HEX_PORT} [0-9A-Fa-f]{8}:[0-9A-Fa-f]{4} 0A" /proc/net/tcp 2>/dev/null; then
        PORT_READY=1
        break
    elif (exec 3<>/dev/tcp/127.0.0.1/"$VNC_PORT") 2>/dev/null; then
        exec 3>&- # close socket
        PORT_READY=1
        break
    fi
    sleep 0.2
done

if [[ $PORT_READY -eq 0 ]]; then
    echo "[-] Error: TurboVNC failed to open port ${VNC_PORT}." >&2
    exit 1
fi
echo "[+] TurboVNC is ready on 127.0.0.1:${VNC_PORT}."

# ------------------------------------------------------------------------------
# Launch websockify + stock noVNC reference client
# ------------------------------------------------------------------------------
LOG_DIR="${HOME}/.vnc"
mkdir -p "$LOG_DIR"
WEBSOCKIFY_LOG_FILE="${LOG_DIR}/websockify-novnc:${DISPLAY_NUM}.log"

echo "[*] Launching websockify + noVNC on ${LISTEN_ADDR}:${WEB_PORT}..."
echo "[*] websockify log file: ${WEBSOCKIFY_LOG_FILE}"

websockify --web="$NOVNC_DIR" "${LISTEN_ADDR}:${WEB_PORT}" "127.0.0.1:${VNC_PORT}" \
    > "$WEBSOCKIFY_LOG_FILE" 2>&1 &
SERVER_PID=$!

sleep 0.5
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[-] Error: websockify failed to start. Check ${WEBSOCKIFY_LOG_FILE}" >&2
    exit 1
fi

echo ""
echo "===================================================================="
echo " [SUCCESS] VNC & stock noVNC reference client are running!"
echo "===================================================================="
echo " Web Client URL (video/render only - no audio bridging in this path):"
CLIENT_URL="http://localhost:${WEB_PORT}/vnc.html?autoconnect=true"
if [[ -n "${VNC_PASSWORD:-}" ]]; then
    CLIENT_URL="${CLIENT_URL}&password=${VNC_PASSWORD}"
fi
echo "   ${CLIENT_URL}"
echo ""
echo " Logs:"
echo "   websockify Log: ${WEBSOCKIFY_LOG_FILE}"
echo "   TurboVNC Log:   ${LOG_DIR}/$(hostname -s 2>/dev/null || hostname):${DISPLAY_NUM}.log"
echo ""
echo " SSH Port Forwarding (run on your local laptop):"
echo "   ssh -L ${WEB_PORT}:localhost:${WEB_PORT} $(whoami)@$(hostname -f 2>/dev/null || hostname)"
echo ""
echo " Press Ctrl+C at any time to terminate both TurboVNC and websockify."
echo "===================================================================="
echo ""

# Block until user presses Ctrl+C
wait "$SERVER_PID"
