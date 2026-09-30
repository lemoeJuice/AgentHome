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

CONFIG_PATH="${AGENT_HOME_CONFIG:-$ROOT_DIR/config.json}"
if [[ "$CONFIG_PATH" != /* ]]; then CONFIG_PATH="$ROOT_DIR/$CONFIG_PATH"; fi
node "$ROOT_DIR/scripts/migrate-config.mjs" "$CONFIG_PATH"

AGENT_HOME_REBUILD_IMAGE=1 bash "$ROOT_DIR/scripts/setup-podman.sh"
"$PODMAN_COMMAND" run --rm --user 0 --volume "${AGENT_HOME_VOLUME}:/state:Z" --network none "$AGENT_HOME_IMAGE" migrate-state

AGENT_HOME_REBOOTSTRAP=1 bash "$ROOT_DIR/scripts/setup.sh"
"$ROOT_DIR/scripts/restart.sh"
printf 'upgrade complete; backup=%s\n' "$BACKUP_PATH"
