#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
mkdir -p runtime-state
PID_FILE="${AGENT_HOME_PID_FILE:-$ROOT_DIR/runtime-state/gateway.pid}"
if [[ -s "$PID_FILE" ]] && kill -0 "$(<"$PID_FILE")" 2>/dev/null; then printf '%s\n' 'gateway already running'; exit 0; fi
if command -v pnpm >/dev/null; then RUNNER=pnpm; else RUNNER=npm; fi
nohup "$RUNNER" run gateway >"${AGENT_HOME_GATEWAY_LOG:-$ROOT_DIR/runtime-state/gateway.log}" 2>&1 &
printf '%s\n' "$!" >"$PID_FILE"
printf 'gateway started (pid %s)\n' "$!"
