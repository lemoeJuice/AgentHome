#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP="${1:?usage: restore.sh BACKUP_DIRECTORY}"
[[ -f "$BACKUP/manifest.json" && -f "$BACKUP/state.tar" ]] || { printf '%s\n' 'invalid backup: manifest.json and state.tar are required' >&2; exit 2; }
python3 - "$BACKUP/manifest.json" <<'PY'
import json, sys
manifest=json.load(open(sys.argv[1]))
if manifest.get("format") != "agent-home-deployment" or manifest.get("version") != 1:
    raise SystemExit("unsupported backup format")
PY
VOLUME="${AGENT_HOME_VOLUME:-agent-home-default-state}"
PODMAN="${PODMAN_COMMAND:-podman}"
"$PODMAN" volume inspect "$VOLUME" >/dev/null 2>&1 || "$PODMAN" volume create "$VOLUME" >/dev/null
"$PODMAN" volume import "$VOLUME" "$BACKUP/state.tar"
[[ -f "$BACKUP/gateway.sqlite" ]] && mkdir -p "$ROOT_DIR/runtime-state" && cp "$BACKUP/gateway.sqlite" "$ROOT_DIR/runtime-state/gateway.sqlite"
[[ -f "$BACKUP/plugin-data.tar.gz" ]] && tar -xzf "$BACKUP/plugin-data.tar.gz" -C "$ROOT_DIR/runtime-state"
