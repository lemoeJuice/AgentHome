#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
BACKUP_DIR="${1:-$ROOT_DIR/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_DIR/agent-home-$STAMP"
mkdir -p "$DEST"
VOLUME="${AGENT_HOME_VOLUME:-agent-home-default-state}"
PODMAN="${PODMAN_COMMAND:-podman}"
"$PODMAN" volume export "$VOLUME" -o "$DEST/state.tar"
[[ -e runtime-state/gateway.sqlite ]] && cp runtime-state/gateway.sqlite "$DEST/gateway.sqlite"
[[ -d runtime-state/plugin-data ]] && tar -czf "$DEST/plugin-data.tar.gz" -C runtime-state plugin-data
cp config.example.json "$DEST/config.example.json"
printf '%s\n' '{"format":"agent-home-deployment","version":1}' > "$DEST/manifest.json"
chmod 600 "$DEST/manifest.json" "$DEST/state.tar"
