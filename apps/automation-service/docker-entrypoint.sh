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
user_slots="${GDMS_USER_VNC_SLOTS:-16}"

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

  # Skip fluxbox — its top toolbar steals pixels and clips Chromium in noVNC.
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
  slot=0
  while [ "$slot" -lt "$user_slots" ]; do
    enq_display=$((101 + slot))
    fup_display=$((117 + slot))
    enq_rfb=$((5902 + slot))
    fup_rfb=$((5918 + slot))
    enq_ws=$((6082 + slot))
    fup_ws=$((6098 + slot))
    start_vnc_workspace ":${enq_display}" "$enq_rfb" "$enq_ws"
    start_vnc_workspace ":${fup_display}" "$fup_rfb" "$fup_ws"
    slot=$((slot + 1))
  done
fi

exec node dist/server.js
