#!/usr/bin/env bash
# ==============================================================================
# Builds a TurboVNC + XFCE4 SquashFS (.sqf) container image directly:
#   1. Builds a temporary sandbox directory in /tmp using Apptainer/Singularity
#   2. Packs the sandbox with 'mksquashfs -all-root' (all files mapped to root/0:0)
#   3. Cleans up the temporary sandbox from /tmp
#
# Directly packs into SquashFS format (.sqf) with root ownership for all files.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

DEF_FILE="${1:-$SCRIPT_DIR/turbovnc-xfce.def}"
DEF_DIR="$(cd "$(dirname "$DEF_FILE")" && pwd)"
DEF_BASE="$(basename "$DEF_FILE" .def)"
OUTPUT_SQF="${2:-$DEF_DIR/${DEF_BASE}.sqf}"

# ------------------------------------------------------------------------------
# 1. Locate Tools
# ------------------------------------------------------------------------------
if command -v apptainer &>/dev/null; then
    CONTAINER_CMD="apptainer"
elif command -v singularity &>/dev/null; then
    CONTAINER_CMD="singularity"
else
    echo "[-] Error: Neither 'apptainer' nor 'singularity' was found in PATH." >&2
    exit 1
fi

if ! command -v mksquashfs &>/dev/null; then
    echo "[-] Error: 'mksquashfs' not found in PATH. Please install squashfs-tools." >&2
    exit 1
fi

if [[ ! -f "$DEF_FILE" ]]; then
    echo "[-] Error: Definition file not found at '$DEF_FILE'." >&2
    exit 1
fi

# ------------------------------------------------------------------------------
# 2. Setup Temporary Sandbox in Parent Directory (/tmp)
# ------------------------------------------------------------------------------
# Do not pre-create the sandbox directory; specify a path under its parent (/tmp)
# so Apptainer creates the sandbox directory itself without "already exists" errors.
PARENT_DIR="${TMPDIR:-/tmp}"
TMP_SANDBOX="$(mktemp -u "${PARENT_DIR}/tvnc-sandbox.XXXXXX")"

cleanup() {
    local exit_code=$?
    if [[ -e "$TMP_SANDBOX" ]]; then
        echo "[*] Cleaning up temporary sandbox: $TMP_SANDBOX..."
        chmod -R u+rwX "$TMP_SANDBOX" 2>/dev/null || true
        rm -rf "$TMP_SANDBOX" 2>/dev/null || true
    fi
    exit "$exit_code"
}

trap cleanup INT TERM EXIT

echo "===================================================================="
echo " Building SquashFS (.sqf) Container Image"
echo " Definition: $DEF_FILE"
echo " Output SQF: $OUTPUT_SQF"
echo " Sandbox:    $TMP_SANDBOX"
echo "===================================================================="

# ------------------------------------------------------------------------------
# 3. Build Sandbox directly to its parent directory (/tmp)
# ------------------------------------------------------------------------------
echo "[*] Building container sandbox from $DEF_FILE..."
"$CONTAINER_CMD" build --force --fix-perms --sandbox "$TMP_SANDBOX" "$DEF_FILE"

# ------------------------------------------------------------------------------
# 4. Pack with mksquashfs using -all-root
# ------------------------------------------------------------------------------
echo "[*] Packing sandbox to $OUTPUT_SQF with -all-root..."
# Remove any existing output file to avoid append prompts
rm -f "$OUTPUT_SQF"

mksquashfs "$TMP_SANDBOX" "$OUTPUT_SQF" -all-root -noappend

echo ""
echo "===================================================================="
echo " [SUCCESS] Created SquashFS container: $OUTPUT_SQF"
echo " Filesize: $(du -h "$OUTPUT_SQF" | cut -f1)"
echo " All UIDs/GIDs are mapped to 0 (root) for unprivileged user mapping."
echo " Temporary sandbox in /tmp has been cleaned."
echo "===================================================================="

