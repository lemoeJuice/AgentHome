#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib.sh"
PROXY_RELAY_PID_FILE="${AGENT_HOME_PROXY_RELAY_PID_FILE:-$AGENT_HOME_RUNTIME_DIR/proxy-relay.pid}"
PROXY_RELAY_SETTINGS_FILE="${AGENT_HOME_PROXY_RELAY_SETTINGS_FILE:-$AGENT_HOME_RUNTIME_DIR/proxy-relay.settings}"
if [[ -s "$PROXY_RELAY_PID_FILE" ]]; then
  PROXY_RELAY_PID="$(<"$PROXY_RELAY_PID_FILE")"
  if kill -0 "$PROXY_RELAY_PID" 2>/dev/null; then
    kill "$PROXY_RELAY_PID"
    for _ in {1..100}; do kill -0 "$PROXY_RELAY_PID" 2>/dev/null || break; sleep 0.1; done
    if kill -0 "$PROXY_RELAY_PID" 2>/dev/null; then kill -KILL "$PROXY_RELAY_PID"; fi
  fi
  rm -f "$PROXY_RELAY_PID_FILE"
fi
rm -f "$PROXY_RELAY_SETTINGS_FILE"
PID_FILE="${AGENT_HOME_PID_FILE:-$AGENT_HOME_RUNTIME_DIR/gateway.pid}"
if [[ ! -s "$PID_FILE" ]]; then printf '%s\n' 'gateway is not running'; exit 0; fi
PID="$(<"$PID_FILE")"
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  for _ in {1..100}; do
    kill -0 "$PID" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$PID" 2>/dev/null; then kill -KILL "$PID"; fi
fi
rm -f "$PID_FILE"
