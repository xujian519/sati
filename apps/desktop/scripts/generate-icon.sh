#!/usr/bin/env bash
# Regenerate resources/icon.icns from assets/logo-light-1024.png (macOS only).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SRC="${DESKTOP_DIR}/assets/logo-light-1024.png"
ICONSET="${DESKTOP_DIR}/resources/icon.iconset"
OUT="${DESKTOP_DIR}/resources/icon.icns"

[[ -f "$SRC" ]] || { echo "Missing $SRC" >&2; exit 1; }
command -v sips >/dev/null && command -v iconutil >/dev/null \
  || { echo "Requires macOS sips + iconutil" >&2; exit 1; }

rm -rf "$ICONSET"
mkdir -p "$ICONSET"

mk() {
  local size="$1"
  local name="$2"
  sips -z "$size" "$size" "$SRC" --out "${ICONSET}/${name}" >/dev/null
}

mk 16  icon_16x16.png
mk 32  icon_16x16@2x.png
mk 32  icon_32x32.png
mk 64  icon_32x32@2x.png
mk 128 icon_128x128.png
mk 256 icon_128x128@2x.png
mk 256 icon_256x256.png
mk 512 icon_256x256@2x.png
mk 512 icon_512x512.png
mk 1024 icon_512x512@2x.png

iconutil -c icns "$ICONSET" -o "$OUT"
rm -rf "$ICONSET"
echo "Wrote ${OUT}"
