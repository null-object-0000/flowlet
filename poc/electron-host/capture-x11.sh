#!/usr/bin/env bash
# UI evidence capture. This sandbox is a Wayland session with no compositor access
# and Electron's capturePage fails with UnknownVizError, so run the real window on
# an Xvfb display (forcing the X11 ozone backend) and grab the framebuffer with
# ffmpeg. The shell seeds the management token itself (like a desktop app would),
# so the captured frame is the real, data-loaded UI.
#
# Usage: xvfb-run -a -s "-screen 0 1280x800x24" ./capture-x11.sh [output.png]
set -euo pipefail
cd "$(dirname "$0")"
OUT="${1:-evidence/overview-x11.png}"
LOG="evidence/electron-window.log"

# Ozone auto-detects Wayland from the parent session; force X11 so the window is
# actually mapped inside Xvfb (otherwise it renders offscreen and grabs are black).
unset WAYLAND_DISPLAY

./node_modules/electron/dist/electron . \
  --no-sandbox --disable-gpu --disable-gpu-sandbox --disable-dev-shm-usage \
  --ozone-platform=x11 --window-size=1280,800 >"$LOG" 2>&1 &
APP_PID=$!
trap 'kill "$APP_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  grep -q "UI ready" "$LOG" 2>/dev/null && break
  sleep 0.5
done
sleep 5   # let TanStack Query settle and the charts paint
ffmpeg -hide_banner -loglevel error -f x11grab -draw_mouse 0 -video_size 1280x800 \
  -framerate 1 -i "${DISPLAY}.0" -frames:v 1 -y "$OUT"
echo "captured: $OUT ($(stat -c%s "$OUT") bytes)"
