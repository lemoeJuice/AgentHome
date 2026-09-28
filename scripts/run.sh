#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/lib.sh"
umask 077

mkdir -p "$AGENT_HOME_RUNTIME_DIR"
RUN_LOG="${AGENT_HOME_RUN_LOG:-$AGENT_HOME_RUNTIME_DIR/run.log}"
GATEWAY_LOG="${AGENT_HOME_GATEWAY_LOG:-$AGENT_HOME_RUNTIME_DIR/gateway.log}"
PROXY_LOG="${AGENT_HOME_PROXY_RELAY_LOG:-$AGENT_HOME_RUNTIME_DIR/proxy-relay.log}"
GATEWAY_PID_FILE="${AGENT_HOME_PID_FILE:-$AGENT_HOME_RUNTIME_DIR/gateway.pid}"
PROXY_PID_FILE="${AGENT_HOME_PROXY_RELAY_PID_FILE:-$AGENT_HOME_RUNTIME_DIR/proxy-relay.pid}"
logger_pids=()
stopping=false

cleanup() {
  local status=$?
  [[ "$stopping" == true ]] && return "$status"
  stopping=true
  trap - INT TERM EXIT
  for pid in "${logger_pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${logger_pids[@]}"; do wait "$pid" 2>/dev/null || true; done
  printf '\nStopping Agent Home services (SnowLuma will remain running)...\n' | tee -a "$RUN_LOG"
  "$ROOT_DIR/scripts/stop.sh" 2>&1 | tee -a "$RUN_LOG" || status=$?
  printf 'Agent Home services stopped. SnowLuma container was left running.\n' | tee -a "$RUN_LOG"
  exit "$status"
}
trap cleanup INT TERM EXIT

printf 'Starting Agent Home services. Persistent log: %s\n' "$RUN_LOG" | tee -a "$RUN_LOG"
"$ROOT_DIR/scripts/start.sh" 2>&1 | tee -a "$RUN_LOG"
touch "$GATEWAY_LOG" "$PROXY_LOG"
chmod 600 "$GATEWAY_LOG" "$PROXY_LOG" "$RUN_LOG"

tail --lines=0 --follow=name --retry "$GATEWAY_LOG" "$PROXY_LOG" 2>&1 | tee -a "$RUN_LOG" &
logger_pids+=("$!")
if "$PODMAN_COMMAND" container exists "$AGENT_HOME_CONTAINER"; then
  "$PODMAN_COMMAND" logs --follow --since=1s "$AGENT_HOME_CONTAINER" 2>&1 | sed -u 's/^/[agent-home] /' | tee -a "$RUN_LOG" &
  logger_pids+=("$!")
fi

printf 'Services are running. Press Ctrl+C to stop Gateway, Agent Home, and Proxy Relay; SnowLuma remains running.\n' | tee -a "$RUN_LOG"
while :; do
  sleep 2
  gateway_running=false
  if [[ -s "$GATEWAY_PID_FILE" ]]; then
    gateway_pid="$(<"$GATEWAY_PID_FILE")"
    if [[ "$gateway_pid" =~ ^[0-9]+$ ]] && kill -0 "$gateway_pid" 2>/dev/null; then gateway_running=true; fi
  fi
  proxy_running=false
  if [[ -s "$PROXY_PID_FILE" ]]; then
    proxy_pid="$(<"$PROXY_PID_FILE")"
    if [[ "$proxy_pid" =~ ^[0-9]+$ ]] && kill -0 "$proxy_pid" 2>/dev/null; then proxy_running=true; fi
  fi
  container_running=false
  if "$PODMAN_COMMAND" container exists "$AGENT_HOME_CONTAINER" && [[ "$("$PODMAN_COMMAND" container inspect -f '{{.State.Running}}' "$AGENT_HOME_CONTAINER" 2>/dev/null || true)" == true ]]; then
    container_running=true
  fi
  if [[ "$gateway_running" == false && "$proxy_running" == false && "$container_running" == false ]]; then
    printf 'All managed services have stopped.\n' | tee -a "$RUN_LOG"
    exit 0
  fi
done
