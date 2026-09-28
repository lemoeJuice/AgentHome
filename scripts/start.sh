#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/lib.sh"
umask 077
mkdir -p "$AGENT_HOME_RUNTIME_DIR"
PROXY_RELAY_PID_FILE="${AGENT_HOME_PROXY_RELAY_PID_FILE:-$AGENT_HOME_RUNTIME_DIR/proxy-relay.pid}"
PROXY_RELAY_SETTINGS_FILE="${AGENT_HOME_PROXY_RELAY_SETTINGS_FILE:-$AGENT_HOME_RUNTIME_DIR/proxy-relay.settings}"
IFS=$'\t' read -r relay_enabled relay_listen_port relay_upstream_host relay_upstream_port <<<"$(agent_home_proxy_relay_settings)"
relay_build="$(ROOT_DIR="$ROOT_DIR" node --input-type=module -e 'import { createHash } from "node:crypto";import { readFileSync } from "node:fs";const root=process.env.ROOT_DIR;const hash=createHash("sha256");for(const file of ["dist/cli.js","dist/proxy-relay.js"])hash.update(readFileSync(`${root}/${file}`));process.stdout.write(hash.digest("hex"));')"
relay_signature="${relay_listen_port}|${relay_upstream_host}|${relay_upstream_port}|${relay_build}"
relay_pid=""
if [[ -s "$PROXY_RELAY_PID_FILE" ]]; then relay_pid="$(<"$PROXY_RELAY_PID_FILE")"; fi
if [[ "$relay_enabled" == 1 ]]; then
  if [[ -n "$relay_pid" ]] && kill -0 "$relay_pid" 2>/dev/null && [[ -s "$PROXY_RELAY_SETTINGS_FILE" && "$(<"$PROXY_RELAY_SETTINGS_FILE")" == "$relay_signature" ]]; then
    printf '%s\n' 'proxy relay already running with configured ports'
  else
    if [[ -n "$relay_pid" ]] && kill -0 "$relay_pid" 2>/dev/null; then
      kill "$relay_pid"
      for _ in {1..100}; do kill -0 "$relay_pid" 2>/dev/null || break; sleep 0.1; done
      if kill -0 "$relay_pid" 2>/dev/null; then kill -KILL "$relay_pid"; fi
    fi
    rm -f "$PROXY_RELAY_PID_FILE" "$PROXY_RELAY_SETTINGS_FILE"
    nohup env AGENT_HOME_PROXY_RELAY_LISTEN_PORT="$relay_listen_port" AGENT_HOME_PROXY_RELAY_UPSTREAM_HOST="$relay_upstream_host" AGENT_HOME_PROXY_RELAY_UPSTREAM_PORT="$relay_upstream_port" node "$ROOT_DIR/dist/cli.js" proxy-relay >"${AGENT_HOME_PROXY_RELAY_LOG:-$AGENT_HOME_RUNTIME_DIR/proxy-relay.log}" 2>&1 &
    printf '%s\n' "$!" >"$PROXY_RELAY_PID_FILE"
    printf '%s\n' "$relay_signature" >"$PROXY_RELAY_SETTINGS_FILE"
    sleep 0.2
    if ! kill -0 "$(<"$PROXY_RELAY_PID_FILE")" 2>/dev/null; then printf '%s\n' 'proxy relay failed to start; see .agent-home/runtime-state/proxy-relay.log' >&2; exit 1; fi
    printf 'proxy relay started (pid %s, listen=%s, upstream=%s:%s)\n' "$(<"$PROXY_RELAY_PID_FILE")" "$relay_listen_port" "$relay_upstream_host" "$relay_upstream_port"
  fi
else
  if [[ -n "$relay_pid" ]] && kill -0 "$relay_pid" 2>/dev/null; then kill "$relay_pid"; fi
  rm -f "$PROXY_RELAY_PID_FILE" "$PROXY_RELAY_SETTINGS_FILE"
  printf '%s\n' 'proxy relay disabled by configuration'
fi
if "$PODMAN_COMMAND" container exists "$AGENT_HOME_CONTAINER"; then
  if [[ "$("$PODMAN_COMMAND" container inspect -f '{{.State.Running}}' "$AGENT_HOME_CONTAINER")" != true ]]; then
    "$PODMAN_COMMAND" start "$AGENT_HOME_CONTAINER" >/dev/null
    printf 'Agent Home container started (%s)\n' "$AGENT_HOME_CONTAINER"
  else
    printf 'Agent Home container already running (%s)\n' "$AGENT_HOME_CONTAINER"
  fi
else
  printf 'Agent Home container does not exist: %s (run scripts/deploy.sh first)\n' "$AGENT_HOME_CONTAINER" >&2
  exit 1
fi
PID_FILE="${AGENT_HOME_PID_FILE:-$AGENT_HOME_RUNTIME_DIR/gateway.pid}"
if [[ -s "$PID_FILE" ]] && kill -0 "$(<"$PID_FILE")" 2>/dev/null; then printf '%s\n' 'gateway already running'; exit 0; fi
nohup node "$ROOT_DIR/dist/cli.js" gateway >"${AGENT_HOME_GATEWAY_LOG:-$AGENT_HOME_RUNTIME_DIR/gateway.log}" 2>&1 &
printf '%s\n' "$!" >"$PID_FILE"
printf 'gateway started (pid %s)\n' "$!"
