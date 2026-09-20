#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="${AGENT_HOME_PID_FILE:-$ROOT_DIR/runtime-state/gateway.pid}"
if [[ ! -s "$PID_FILE" ]]; then printf '%s\n' 'gateway is not running'; exit 0; fi
PID="$(<"$PID_FILE")"
if kill -0 "$PID" 2>/dev/null; then kill "$PID"; fi
rm -f "$PID_FILE"
