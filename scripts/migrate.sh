#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP="${1:?usage: migrate.sh BACKUP_DIRECTORY_OR_FILE}"
if [[ "$BACKUP" != /* ]]; then BACKUP="$ROOT_DIR/$BACKUP"; fi
export AGENT_HOME_MIGRATION_BACKUP="$BACKUP"
exec bash "$ROOT_DIR/scripts/deploy.sh"
