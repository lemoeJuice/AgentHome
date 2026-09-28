#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/lib.sh"
BACKUP_DIR="${1:-$ROOT_DIR/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${AGENT_HOME_BACKUP_DEST:-$BACKUP_DIR/agent-home-$STAMP}"
mkdir -p "$DEST"
VOLUME="$AGENT_HOME_VOLUME"
PODMAN="$PODMAN_COMMAND"
CONTAINER="$AGENT_HOME_CONTAINER"
SNOWLUMA_VOLUMES=(snowluma-gateway-data snowluma-client-config snowluma-client-data)
CONFIG_PATH="${AGENT_HOME_CONFIG:-$ROOT_DIR/config/agent-home.json}"
if [[ "$CONFIG_PATH" != /* ]]; then CONFIG_PATH="$ROOT_DIR/$CONFIG_PATH"; fi
GATEWAY_WAS_RUNNING=false
CONTAINER_WAS_RUNNING=false
RUNTIME_WAS_QUIESCED=false

cleanup() {
  if [[ "$CONTAINER_WAS_RUNNING" == true ]]; then
    "$PODMAN" start "$CONTAINER" >/dev/null || true
    if [[ "$RUNTIME_WAS_QUIESCED" == true ]]; then
      for _ in {1..30}; do
        "$PODMAN" exec "$CONTAINER" agent-home control backup-finish >/dev/null 2>&1 && break
        sleep 0.2
      done
    fi
  fi
  if [[ "$GATEWAY_WAS_RUNNING" == true ]]; then "$ROOT_DIR/scripts/start.sh" >/dev/null || true; fi
}
trap cleanup EXIT

if [[ -s "${AGENT_HOME_PID_FILE:-$AGENT_HOME_RUNTIME_DIR/gateway.pid}" ]] && kill -0 "$(<"${AGENT_HOME_PID_FILE:-$AGENT_HOME_RUNTIME_DIR/gateway.pid}")" 2>/dev/null; then
  GATEWAY_WAS_RUNNING=true
  "$ROOT_DIR/scripts/stop.sh"
fi
if [[ "$($PODMAN container inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)" == true ]]; then
  CONTAINER_WAS_RUNNING=true
  "$PODMAN" exec "$CONTAINER" agent-home control backup-prepare >/dev/null
  RUNTIME_WAS_QUIESCED=true
  "$PODMAN" stop "$CONTAINER" >/dev/null
fi

if [[ -f "$AGENT_HOME_RUNTIME_DIR/gateway.sqlite" ]]; then
  node --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const db=new DatabaseSync(process.argv[1]); db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();' "$AGENT_HOME_RUNTIME_DIR/gateway.sqlite"
fi
RUNTIME_SCHEMA_VERSION="${AGENT_HOME_SCHEMA_VERSION:-19}"
GATEWAY_SCHEMA_VERSION="$(node --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; try { const db=new DatabaseSync(process.argv[1], { readOnly: true }); process.stdout.write(String(db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get().version ?? 0)); db.close(); } catch { process.stdout.write("0"); }' "$AGENT_HOME_RUNTIME_DIR/gateway.sqlite")"
"$PODMAN" volume export "$VOLUME" -o "$DEST/state.tar"
"$PODMAN" image exists "$AGENT_HOME_IMAGE" || { printf '%s\n' "agent home image is not available: $AGENT_HOME_IMAGE" >&2; exit 2; }
"$PODMAN" save "$AGENT_HOME_IMAGE" -o "$DEST/image.tar"
for snowluma_volume in "${SNOWLUMA_VOLUMES[@]}"; do
  if "$PODMAN" volume inspect "$snowluma_volume" >/dev/null 2>&1; then
    "$PODMAN" volume export "$snowluma_volume" -o "$DEST/$snowluma_volume.tar"
  fi
done
[[ -e "$AGENT_HOME_RUNTIME_DIR/gateway.sqlite" ]] && cp "$AGENT_HOME_RUNTIME_DIR/gateway.sqlite" "$DEST/gateway.sqlite"
[[ -d "$AGENT_HOME_RUNTIME_DIR/plugin-data" ]] && tar -czf "$DEST/plugin-data.tar.gz" -C "$AGENT_HOME_RUNTIME_DIR" plugin-data
[[ -d "$AGENT_HOME_RUNTIME_DIR/gateway-artifacts" ]] && tar -czf "$DEST/gateway-artifacts.tar.gz" -C "$AGENT_HOME_RUNTIME_DIR" gateway-artifacts
[[ -f "$ROOT_DIR/config/snowluma.env" ]] && cp "$ROOT_DIR/config/snowluma.env" "$DEST/snowluma.env" && chmod 600 "$DEST/snowluma.env"
cp config/agent-home.example.json "$DEST/config.example.json"
SECRET_FILES=()
for secret in .agent-home/control-token .agent-home/artifact-transfer-secret .agent-home/gateway-artifact-transfer-secret .agent-home/mcp-main-token .agent-home/mcp-control-token .agent-home/mcp-worker-bindings.json .agent-home/snowluma-access-token .agent-home/snowluma-websocket-access-token; do
  [[ -f "$ROOT_DIR/$secret" ]] && SECRET_FILES+=("$secret")
done
if ((${#SECRET_FILES[@]} > 0)); then
  tar -czf "$DEST/deployment-secrets.tar.gz" -C "$ROOT_DIR" "${SECRET_FILES[@]}"
  chmod 600 "$DEST/deployment-secrets.tar.gz"
fi
[[ -f "$CONFIG_PATH" ]] && cp "$CONFIG_PATH" "$DEST/deployment-config.json" && chmod 600 "$DEST/deployment-config.json"
IMAGE="$AGENT_HOME_IMAGE"
  IMAGE="$IMAGE" VOLUME="$VOLUME" CONTAINER="$CONTAINER" STAMP="$STAMP" RUNTIME_SCHEMA_VERSION="$RUNTIME_SCHEMA_VERSION" GATEWAY_SCHEMA_VERSION="$GATEWAY_SCHEMA_VERSION" node --input-type=module - "$DEST/manifest.json" "$DEST/state.tar" "$DEST/gateway.sqlite" "$DEST/plugin-data.tar.gz" "$DEST/gateway-artifacts.tar.gz" "$DEST/deployment-secrets.tar.gz" "$DEST/deployment-config.json" "$DEST/image.tar" "$DEST/snowluma-gateway-data.tar" "$DEST/snowluma-client-config.tar" "$DEST/snowluma-client-data.tar" <<'NODE'
import fs from "node:fs";
import crypto from "node:crypto";

const [manifestPath, ...files] = process.argv.slice(1);
const hash = (path) => fs.existsSync(path) ? crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex") : undefined;
const manifest = {
  format: "agent-home-deployment",
  version: 5,
  schemaVersion: Number(process.env.RUNTIME_SCHEMA_VERSION),
  runtimeSchemaVersion: Number(process.env.RUNTIME_SCHEMA_VERSION),
  gatewaySchemaVersion: Number(process.env.GATEWAY_SCHEMA_VERSION),
  createdAt: process.env.STAMP,
  image: process.env.IMAGE,
  volume: process.env.VOLUME,
  container: process.env.CONTAINER,
  stateTarSha256: hash(files[0]),
  imageArchiveSha256: hash(files[6]),
  ...(hash(files[1]) ? { gatewaySqliteSha256: hash(files[1]) } : {}),
  ...(hash(files[2]) ? { pluginDataSha256: hash(files[2]) } : {}),
  ...(hash(files[3]) ? { gatewayArtifactsSha256: hash(files[3]) } : {}),
  ...(hash(files[4]) ? { deploymentSecretsSha256: hash(files[4]) } : {}),
  ...(hash(files[5]) ? { deploymentConfigSha256: hash(files[5]) } : {}),
  ...(hash(files[7]) ? { snowlumaGatewayDataSha256: hash(files[7]) } : {}),
  ...(hash(files[8]) ? { snowlumaClientConfigSha256: hash(files[8]) } : {}),
  ...(hash(files[9]) ? { snowlumaClientDataSha256: hash(files[9]) } : {}),
  providerConfiguration: "SKIPPED_USER_ACTION_REQUIRED",
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
NODE
  DEST="$DEST" node --input-type=module -e 'import fs from "node:fs";const path=`${process.env.DEST}/manifest.json`;const manifest=JSON.parse(fs.readFileSync(path,"utf8"));manifest.providerConfiguration="PI_SETTINGS_IN_STATE_VOLUME";fs.writeFileSync(path,`${JSON.stringify(manifest,null,2)}\n`,{mode:0o600});fs.chmodSync(path,0o600);'
chmod 600 "$DEST/manifest.json" "$DEST/state.tar"
printf 'backup created: %s\n' "$DEST"
