#!/bin/sh
set -e

headed="${PLAYWRIGHT_HEADED:-true}"
case "$headed" in
  true|1|TRUE|yes|YES) headed=1 ;;
  *) headed=0 ;;
esac

remote="${GDMS_REMOTE_VIEW:-false}"
case "$remote" in
  true|1|TRUE|yes|YES) remote=1 ;;
  *) remote=0 ;;
esac

preview="${GDMS_PREVIEW_STREAM:-false}"
case "$preview" in
  true|1|TRUE|yes|YES) preview=1 ;;
  *) preview=0 ;;
esac

vnc_w="${GDMS_VNC_WIDTH:-1920}"
vnc_h="${GDMS_VNC_HEIGHT:-1080}"
vnc_pass="${GDMS_VNC_PASSWORD:-gdms}"

start_xvfb() {
  display="$1"
  if ! pgrep -f "Xvfb $display " >/dev/null 2>&1; then
    Xvfb "$display" -screen 0 "${vnc_w}x${vnc_h}x24" -ac +extension GLX +render -noreset &
    sleep 1
  fi
}

start_vnc_workspace() {
  display="$1"
  rfb_port="$2"
  websockify_port="$3"

  start_xvfb "$display"

  if command -v fluxbox >/dev/null 2>&1; then
    fluxbox -display "$display" >/dev/null 2>&1 &
  fi

  mkdir -p /tmp/.vnc
  x11vnc -storepasswd "$vnc_pass" /tmp/.vnc/passwd >/dev/null

  if ! pgrep -f "x11vnc.*-display $display" >/dev/null 2>&1; then
    x11vnc -display "$display" -forever -shared -rfbport "$rfb_port" -rfbauth /tmp/.vnc/passwd -localhost -noxdamage -geometry "${vnc_w}x${vnc_h}" &
    sleep 1
  fi

  if ! pgrep -f "websockify.*${websockify_port}" >/dev/null 2>&1; then
    websockify --web=/usr/share/novnc/ "$websockify_port" "localhost:${rfb_port}" >/dev/null 2>&1 &
  fi
}

# Remote view (noVNC) or headed without preview needs Xvfb.
if [ "$remote" = "1" ] || { [ "$headed" = "1" ] && [ "$preview" = "0" ]; }; then
  export DISPLAY="${DISPLAY:-:99}"
  start_xvfb ":99"
fi

if [ "$remote" = "1" ]; then
  # Workspace 1 — enquiry transfer (:99 → 5900 → 6080)
  start_vnc_workspace ":99" 5900 6080
  # Workspace 2 — follow up skip (:100 → 5901 → 6081)
  start_vnc_workspace ":100" 5901 6081
fi

exec node dist/server.js
