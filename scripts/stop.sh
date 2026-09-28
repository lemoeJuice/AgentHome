#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib.sh"
umask 077

PID_FILE="${AGENT_HOME_PID_FILE:-$AGENT_HOME_RUNTIME_DIR/gateway.pid}"
if [[ -s "$PID_FILE" ]]; then
  PID="$(<"$PID_FILE")"
  if [[ "$PID" =~ ^[0-9]+$ ]] && kill -0 "$PID" 2>/dev/null; then
    kill -TERM "$PID"
    for _ in {1..100}; do kill -0 "$PID" 2>/dev/null || break; sleep 0.1; done
    if kill -0 "$PID" 2>/dev/null; then
      printf 'gateway did not stop gracefully; sending SIGKILL (pid %s)\n' "$PID" >&2
      kill -KILL "$PID"
    fi
    printf 'gateway stopped (pid %s)\n' "$PID"
  else
    printf '%s\n' 'gateway is not running'
  fi
  rm -f "$PID_FILE"
else
  printf '%s\n' 'gateway is not running'
fi

if "$PODMAN_COMMAND" container exists "$AGENT_HOME_CONTAINER" && [[ "$("$PODMAN_COMMAND" container inspect -f '{{.State.Running}}' "$AGENT_HOME_CONTAINER")" == true ]]; then
  printf 'stopping Agent Home container (%s); SnowLuma remains running\n' "$AGENT_HOME_CONTAINER"
  "$PODMAN_COMMAND" stop --time 30 "$AGENT_HOME_CONTAINER" >/dev/null
else
  printf '%s\n' 'Agent Home container is not running'
fi

PROXY_RELAY_PID_FILE="${AGENT_HOME_PROXY_RELAY_PID_FILE:-$AGENT_HOME_RUNTIME_DIR/proxy-relay.pid}"
PROXY_RELAY_SETTINGS_FILE="${AGENT_HOME_PROXY_RELAY_SETTINGS_FILE:-$AGENT_HOME_RUNTIME_DIR/proxy-relay.settings}"
if [[ -s "$PROXY_RELAY_PID_FILE" ]]; then
  PROXY_RELAY_PID="$(<"$PROXY_RELAY_PID_FILE")"
  if [[ "$PROXY_RELAY_PID" =~ ^[0-9]+$ ]] && kill -0 "$PROXY_RELAY_PID" 2>/dev/null; then
    kill -TERM "$PROXY_RELAY_PID"
    for _ in {1..100}; do kill -0 "$PROXY_RELAY_PID" 2>/dev/null || break; sleep 0.1; done
    if kill -0 "$PROXY_RELAY_PID" 2>/dev/null; then kill -KILL "$PROXY_RELAY_PID"; fi
    printf 'proxy relay stopped (pid %s)\n' "$PROXY_RELAY_PID"
  else
    printf '%s\n' 'proxy relay is not running'
  fi
fi
rm -f "$PROXY_RELAY_PID_FILE" "$PROXY_RELAY_SETTINGS_FILE"
