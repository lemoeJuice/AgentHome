#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/lib.sh"

BACKUP_DIR="${AGENT_HOME_UPGRADE_BACKUP_DIR:-$ROOT_DIR/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_PATH="$BACKUP_DIR/agent-home-upgrade-$STAMP"
mkdir -p "$BACKUP_DIR"

AGENT_HOME_BACKUP_DEST="$BACKUP_PATH" bash "$ROOT_DIR/scripts/backup.sh" "$BACKUP_DIR"

AGENT_HOME_REBUILD_IMAGE=1 AGENT_HOME_REBOOTSTRAP=1 bash "$ROOT_DIR/scripts/setup.sh"
"$ROOT_DIR/scripts/restart.sh"
printf 'upgrade complete; backup=%s\n' "$BACKUP_PATH"
