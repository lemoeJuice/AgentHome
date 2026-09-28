#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib.sh"

PODMAN="$PODMAN_COMMAND"
CONTAINER="$SNOWLUMA_CONTAINER"
QR_SCREENSHOT="${SNOWLUMA_QR_SCREENSHOT:-$ROOT_DIR/.agent-home/qq-desktop.png}"
QR_XWD="${QR_SCREENSHOT%.png}.xwd"
DISPLAY_VALUE="${SNOWLUMA_DISPLAY:-$("$PODMAN" exec "$CONTAINER" sh -lc 'printf "%s" "${DISPLAY:-:0}"' 2>/dev/null || printf '%s' :0)}"

onebot_listening() {
  "$PODMAN" exec -e PORT="$SNOWLUMA_WS_PORT" "$CONTAINER" node --input-type=module -e 'import net from "node:net"; const socket=new net.Socket(); socket.setTimeout(700); socket.once("connect",()=>{socket.destroy();process.exit(0)}); socket.once("error",()=>process.exit(1)); socket.once("timeout",()=>{socket.destroy();process.exit(1)}); socket.connect(Number(process.env.PORT), "127.0.0.1")' >/dev/null 2>&1
}

wait_for_onebot() {
  local attempts="${1:-30}"
  for ((index=0; index<attempts; index++)); do
    onebot_listening && return 0
    sleep 1
  done
  return 1
}

capture_screen() {
  mkdir -p "$(dirname "$QR_SCREENSHOT")"
  if "$PODMAN" exec "$CONTAINER" sh -lc 'command -v import >/dev/null'; then
    "$PODMAN" exec -e DISPLAY="$DISPLAY_VALUE" "$CONTAINER" import -window root png:- >"$QR_SCREENSHOT" 2>/dev/null
  elif "$PODMAN" exec "$CONTAINER" sh -lc 'command -v scrot >/dev/null'; then
    "$PODMAN" exec -e DISPLAY="$DISPLAY_VALUE" "$CONTAINER" scrot - >"$QR_SCREENSHOT" 2>/dev/null
  elif "$PODMAN" exec "$CONTAINER" sh -lc 'command -v xwd >/dev/null'; then
    "$PODMAN" exec -e DISPLAY="$DISPLAY_VALUE" "$CONTAINER" xwd -root -silent -out /tmp/agent-home-qq-screen.xwd >/dev/null 2>&1 || return 1
    "$PODMAN" cp "$CONTAINER:/tmp/agent-home-qq-screen.xwd" "$QR_XWD" >/dev/null 2>&1 || return 1
    chmod 600 "$QR_XWD"
    if command -v magick >/dev/null; then magick "$QR_XWD" "png:$QR_SCREENSHOT"; elif command -v convert >/dev/null; then convert "$QR_XWD" "png:$QR_SCREENSHOT"; else return 1; fi
    rm -f "$QR_XWD"
  else
    return 1
  fi
  [[ -s "$QR_SCREENSHOT" ]] && chmod 600 "$QR_SCREENSHOT"
}

decode_screen_qr() {
  local size width height
  command -v magick >/dev/null || command -v convert >/dev/null || return 1
  size="$(identify -format '%w %h' "$QR_SCREENSHOT" 2>/dev/null || magick identify -format '%w %h' "$QR_SCREENSHOT" 2>/dev/null || true)"
  read -r width height <<<"$size"
  [[ "$width" =~ ^[0-9]+$ && "$height" =~ ^[0-9]+$ ]] || return 1
  if command -v magick >/dev/null; then
    magick "$QR_SCREENSHOT" -depth 8 rgba:- | python3 "$ROOT_DIR/scripts/qq/qr-decode.py" "$width" "$height"
  else
    convert "$QR_SCREENSHOT" -depth 8 rgba:- | python3 "$ROOT_DIR/scripts/qq/qr-decode.py" "$width" "$height"
  fi
}

print_qr() {
  local payload="$1"
  if ! command -v qrencode >/dev/null; then
    printf '%s\n' 'QR was recognized, but qrencode is missing; install qrencode to render it in the terminal.' >&2
    return 1
  fi
  printf '%s\n' 'QQ login QR (scan this terminal code):'
  printf '%s' "$payload" | qrencode -t ANSIUTF8 -o -
}

click_desktop() {
  local x="$1" y="$2"
  "$PODMAN" cp "$ROOT_DIR/scripts/qq/x11-click.py" "$CONTAINER:/tmp/agent-home-x11-click.py" >/dev/null
  "$PODMAN" exec -e DISPLAY="$DISPLAY_VALUE" "$CONTAINER" python3 /tmp/agent-home-x11-click.py "$x" "$y"
}

refresh_qr() {
  local payload=""
  local refresh_x="${SNOWLUMA_QR_REFRESH_X:-960}"
  local refresh_y="${SNOWLUMA_QR_REFRESH_Y:-582}"
  printf 'Refreshing QQ QR at fixed screen position (%s,%s).\n' "$refresh_x" "$refresh_y"
  click_desktop "$refresh_x" "$refresh_y"
  sleep 2
  if capture_screen; then payload="$(decode_screen_qr 2>/dev/null || true)"; fi
  if [[ -z "$payload" ]]; then
    # A clean QQ login screen may start in password mode; switch to scan mode.
    local scan_x="${SNOWLUMA_QR_SCAN_MODE_X:-919}"
    local scan_y="${SNOWLUMA_QR_SCAN_MODE_Y:-722}"
    printf 'No QR after refresh; switching QQ to scan-login mode at (%s,%s).\n' "$scan_x" "$scan_y"
    click_desktop "$scan_x" "$scan_y"
    sleep 2
    if capture_screen; then payload="$(decode_screen_qr 2>/dev/null || true)"; fi
  fi
  if [[ -n "$payload" ]]; then
    printf 'QQ desktop screenshot saved privately: %s\n' "$QR_SCREENSHOT"
    print_qr "$payload"
  else
    printf '%s\n' 'No readable QQ QR was found; inspect the desktop through noVNC.'
  fi
}

if wait_for_onebot 15; then
  printf 'QQ/OneBot is online (container WebSocket port %s is listening).\n' "$SNOWLUMA_WS_PORT"
  exit 0
fi

printf 'QQ/OneBot is offline (container WebSocket port %s is not listening).\n' "$SNOWLUMA_WS_PORT"
DISPLAY_HOST="$SNOWLUMA_UI_BIND_ADDRESS"
if [[ "$DISPLAY_HOST" == 0.0.0.0 || "$DISPLAY_HOST" == :: ]]; then DISPLAY_HOST='<host-ip>'; fi
printf 'Open noVNC if needed: http://%s:%s/\n' "$DISPLAY_HOST" "$SNOWLUMA_NOVNC_PORT"

qr_payload=""
if capture_screen; then qr_payload="$(decode_screen_qr 2>/dev/null || true)"; fi
if [[ -n "$qr_payload" ]]; then
  printf 'QQ desktop screenshot saved privately: %s\n' "$QR_SCREENSHOT"
  print_qr "$qr_payload"
else
  refresh_qr
fi

if [[ ! -t 0 ]]; then
  printf '%s\n' 'No interactive terminal; QR was printed when available. Re-run scripts/qq-login.sh to refresh it.' >&2
  exit 0
fi

printf '%s\n' 'Scan the QR. After scanning, press any key to check login; if still offline, the script refreshes and prints a new QR. Press q to leave this prompt.'
while IFS= read -r -n 1 -s key; do
  printf '\n'
  if [[ "$key" == q || "$key" == Q ]]; then
    printf '%s\n' 'Leaving QQ login wait; deployment remains running.'
    exit 0
  fi
  if wait_for_onebot 8; then
    printf 'QQ/OneBot is online (container WebSocket port %s is listening).\n' "$SNOWLUMA_WS_PORT"
    exit 0
  fi
  refresh_qr
  printf '%s\n' 'Press any key after scanning to check again, or q to leave.'
done

printf '%s\n' 'Input closed; deployment remains running.'
