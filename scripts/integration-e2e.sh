#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/lib.sh"

[[ "${AGENT_HOME_RUN_INTEGRATION:-0}" == 1 ]] || { printf '%s\n' 'set AGENT_HOME_RUN_INTEGRATION=1 to run real integration checks' >&2; exit 2; }
"$ROOT_DIR/scripts/setup-podman-portable.sh"
source "$ROOT_DIR/scripts/lib.sh"
PODMAN="$PODMAN_COMMAND"
CONTAINER="$AGENT_HOME_CONTAINER"
"$PODMAN" info >/dev/null
[[ "$($PODMAN container inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)" == true ]] || { printf '%s\n' "Agent Home container is not running: $CONTAINER" >&2; exit 2; }

PI_VERSION="$($PODMAN exec "$CONTAINER" pi --version)"
printf 'Pi: %s\n' "$PI_VERSION"
INSPECT_JSON="$($PODMAN inspect "$CONTAINER")" node --input-type=module -e 'const containers=JSON.parse(process.env.INSPECT_JSON); const container=containers[0] ?? {}; const mounts=container.Mounts ?? []; if (mounts.some((mount)=>mount.Type !== "volume" || mount.Destination !== "/state")) throw new Error(`forbidden Agent Home mount: ${JSON.stringify(mounts)}`); const hostConfig=container.HostConfig ?? {}; if (hostConfig.NetworkMode === "host") throw new Error("Agent Home uses host networking"); const ports=hostConfig.PortBindings ?? container.NetworkSettings?.Ports ?? {}; if (Object.keys(ports).length) throw new Error(`Agent Home publishes ports: ${JSON.stringify(ports)}`); if (!mounts.some((mount)=>mount.Type === "volume" && mount.Destination === "/state")) throw new Error("Agent Home /state volume is missing");'
PODMAN_COMMAND="$PODMAN" AGENT_HOME_RUN_INTEGRATION=1 pnpm test

SNOWLUMA_API="${SNOWLUMA_API_ENDPOINT:-http://127.0.0.1:3000}"
SNOWLUMA_API="$SNOWLUMA_API" node --input-type=module -e 'const base=process.env.SNOWLUMA_API.replace(/\/$/,""); const token=process.env.SNOWLUMA_ACCESS_TOKEN; const response=await fetch(`${base}/get_login_info`,{method:"POST",headers:{"content-type":"application/json",...(token?{authorization:`Bearer ${token}`}:{})},body:"{}"}); if(!response.ok) throw new Error(`SnowLuma HTTP ${response.status}`); const body=await response.json(); if(body.status!=="ok" || body.retcode!==0) throw new Error(`SnowLuma OneBot failure: ${JSON.stringify(body)}`);'

"$PODMAN" restart "$CONTAINER" >/dev/null
for _ in {1..30}; do
  if "$PODMAN" exec "$CONTAINER" agent-home control ping >/dev/null 2>&1; then break; fi
  sleep 1
done
"$PODMAN" exec "$CONTAINER" agent-home control ping >/dev/null

if [[ "${AGENT_HOME_RUN_BACKUP_RESTORE:-1}" == 1 ]]; then
  mkdir -p "$ROOT_DIR/backups"
  BACKUP_ROOT="$(mktemp -d "$ROOT_DIR/backups/integration-XXXXXX")"
  trap 'rm -rf "$BACKUP_ROOT"' EXIT
  scripts/backup.sh "$BACKUP_ROOT"
  BACKUPS=("$BACKUP_ROOT"/agent-home-*)
  [[ -d "${BACKUPS[0]}" ]] || { printf '%s\n' 'backup did not produce a deployment directory' >&2; exit 1; }
  scripts/restore.sh "${BACKUPS[0]}"
  "$PODMAN" exec "$CONTAINER" agent-home control ping >/dev/null
  RESTORED_PI_VERSION="$($PODMAN exec "$CONTAINER" pi --version)"
  [[ "$RESTORED_PI_VERSION" == "$PI_VERSION" ]] || { printf 'Pi changed across restore: before=%s after=%s\n' "$PI_VERSION" "$RESTORED_PI_VERSION" >&2; exit 1; }
fi

printf '%s\n' 'real integration checks passed; QR login and user-message delivery remain explicit acceptance actions.'
