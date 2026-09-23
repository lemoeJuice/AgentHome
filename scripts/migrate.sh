#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
BACKUP="${1:?usage: migrate.sh BACKUP_DIRECTORY}"

# Prepare this host's rootless Podman context before importing the portable archive.
bash "$ROOT_DIR/scripts/setup-podman-portable.sh"
bash "$ROOT_DIR/scripts/restore.sh" "$BACKUP"
bash "$ROOT_DIR/scripts/setup-snowluma.sh"
AGENT_HOME_REBOOTSTRAP=1 bash "$ROOT_DIR/scripts/init-container.sh"
if [[ "${AGENT_HOME_INSTALL_PI:-1}" != 0 ]]; then bash "$ROOT_DIR/scripts/install-pi.sh"; fi

if [[ -s "${AGENT_HOME_PID_FILE:-$ROOT_DIR/runtime-state/gateway.pid}" ]] && kill -0 "$(<"${AGENT_HOME_PID_FILE:-$ROOT_DIR/runtime-state/gateway.pid}")" 2>/dev/null; then
  bash "$ROOT_DIR/scripts/restart.sh"
else
  bash "$ROOT_DIR/scripts/start.sh"
fi

printf 'migration complete; run scripts/doctor.sh after SnowLuma login if required\n'
