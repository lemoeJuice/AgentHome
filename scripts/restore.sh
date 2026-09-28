#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib.sh"
BACKUP="${1:?usage: restore.sh BACKUP_DIRECTORY}"
[[ -f "$BACKUP/manifest.json" && -f "$BACKUP/state.tar" ]] || { printf '%s\n' 'invalid backup: manifest.json and state.tar are required' >&2; exit 2; }
VOLUME="$AGENT_HOME_VOLUME"
PODMAN="$PODMAN_COMMAND"
CONTAINER="$AGENT_HOME_CONTAINER"
SNOWLUMA_CONTAINER="${SNOWLUMA_CONTAINER:-snowluma}"
SNOWLUMA_VOLUMES=(snowluma-gateway-data snowluma-client-config snowluma-client-data)
CONFIG_PATH="${AGENT_HOME_CONFIG:-$ROOT_DIR/config/agent-home.json}"
if [[ "$CONFIG_PATH" != /* ]]; then CONFIG_PATH="$ROOT_DIR/$CONFIG_PATH"; fi
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
STAGING_VOLUME="${VOLUME}.restore-${STAMP}"
OLD_VOLUME="${VOLUME}.pre-restore-${STAMP}"

validate_manifest() {
  CURRENT_RUNTIME_SCHEMA_VERSION="${AGENT_HOME_SCHEMA_VERSION:-19}" \
  CURRENT_GATEWAY_SCHEMA_VERSION="${AGENT_HOME_GATEWAY_SCHEMA_VERSION:-6}" \
  node --input-type=module - \
    "$BACKUP/manifest.json" "$BACKUP/state.tar" "$BACKUP/image.tar" "$BACKUP/gateway.sqlite" \
    "$BACKUP/plugin-data.tar.gz" "$BACKUP/gateway-artifacts.tar.gz" "$BACKUP/deployment-secrets.tar.gz" \
    "$BACKUP/deployment-config.json" "$BACKUP/snowluma-gateway-data.tar" \
    "$BACKUP/snowluma-client-config.tar" "$BACKUP/snowluma-client-data.tar" <<'NODE'
import fs from "node:fs";
import crypto from "node:crypto";

const [manifestPath, ...files] = process.argv.slice(1);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const runtime = Number(process.env.CURRENT_RUNTIME_SCHEMA_VERSION);
const gateway = Number(process.env.CURRENT_GATEWAY_SCHEMA_VERSION);
const runtimeSchema = Number(manifest.runtimeSchemaVersion ?? manifest.schemaVersion ?? 0);
const gatewaySchema = Number(manifest.gatewaySchemaVersion ?? 0);
const hash = (path) => fs.existsSync(path) ? crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex") : undefined;
const check = (field, path) => manifest[field] === undefined || manifest[field] === hash(path);
const validSchema = Number.isInteger(runtimeSchema) && runtimeSchema <= runtime
  && Number.isInteger(gatewaySchema) && gatewaySchema <= gateway;
const valid = manifest.format === "agent-home-deployment"
  && manifest.version === 5
  && typeof manifest.image === "string"
  && manifest.image.length > 0
  && validSchema
  && check("stateTarSha256", files[0])
  && check("imageArchiveSha256", files[1])
  && check("gatewaySqliteSha256", files[2])
  && check("pluginDataSha256", files[3])
  && check("gatewayArtifactsSha256", files[4])
  && check("deploymentSecretsSha256", files[5])
  && check("deploymentConfigSha256", files[6])
  && check("snowlumaGatewayDataSha256", files[7])
  && check("snowlumaClientConfigSha256", files[8])
  && check("snowlumaClientDataSha256", files[9]);
if (!valid) process.exit(1);
process.stdout.write(String(manifest.version));
NODE
}

MANIFEST_VERSION="$(validate_manifest)"

validate_archive() {
  if [[ "$1" == *.gz ]]; then tar -tzf "$1"; else tar -tf "$1"; fi | node --input-type=module -e 'let value=""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => value += chunk); process.stdin.on("end", () => { for (const item of value.split(/\r?\n/).filter(Boolean)) if (item.startsWith("/") || item.split("/").includes("..")) process.exit(1); });'
}

validate_archive "$BACKUP/state.tar" || { printf '%s\n' 'backup state archive contains unsafe paths' >&2; exit 2; }
[[ -f "$BACKUP/image.tar" ]] || { printf '%s\n' 'portable backup is missing image.tar' >&2; exit 2; }
validate_archive "$BACKUP/image.tar" || { printf '%s\n' 'backup image archive contains unsafe paths' >&2; exit 2; }
if [[ -f "$BACKUP/plugin-data.tar.gz" ]]; then validate_archive "$BACKUP/plugin-data.tar.gz" || { printf '%s\n' 'plugin archive contains unsafe paths' >&2; exit 2; }; fi
if [[ -f "$BACKUP/gateway-artifacts.tar.gz" ]]; then validate_archive "$BACKUP/gateway-artifacts.tar.gz" || { printf '%s\n' 'gateway artifact archive contains unsafe paths' >&2; exit 2; }; fi
if [[ -f "$BACKUP/deployment-secrets.tar.gz" ]]; then validate_archive "$BACKUP/deployment-secrets.tar.gz" || { printf '%s\n' 'deployment secret archive contains unsafe paths' >&2; exit 2; }; fi
for snowluma_volume in "${SNOWLUMA_VOLUMES[@]}"; do
  if [[ -f "$BACKUP/$snowluma_volume.tar" ]]; then validate_archive "$BACKUP/$snowluma_volume.tar" || { printf '%s\n' "SnowLuma volume archive contains unsafe paths: $snowluma_volume" >&2; exit 2; }; fi
done

GATEWAY_WAS_RUNNING=false
SNOWLUMA_WAS_RUNNING=false
CONTAINER_WAS_PRESENT=false
CONTAINER_WAS_RUNNING=false
CONTAINER_IMAGE="$(node --input-type=module -e 'import fs from "node:fs"; const m=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(m.image)' "$BACKUP/manifest.json")"
OLD_VOLUME_CREATED=false
STAGING_VOLUME_CREATED=false
RESTORE_COMMITTED=false

recreate_container() {
  AGENT_HOME_IMAGE="$CONTAINER_IMAGE" AGENT_HOME_CONFIG="$CONFIG_PATH" bash "$ROOT_DIR/scripts/init-container.sh"
  if [[ "$CONTAINER_WAS_PRESENT" == true && "$CONTAINER_WAS_RUNNING" != true ]]; then "$PODMAN" stop "$CONTAINER" >/dev/null; fi
}

cleanup() {
  local status=$?
  if [[ "$RESTORE_COMMITTED" != true ]]; then
    if [[ "$CONTAINER_WAS_PRESENT" == true ]] && "$PODMAN" container exists "$CONTAINER"; then "$PODMAN" rm -f "$CONTAINER" >/dev/null || true; fi
    if [[ "$OLD_VOLUME_CREATED" == true ]] && "$PODMAN" volume inspect "$VOLUME" >/dev/null 2>&1; then "$PODMAN" volume rm -f "$VOLUME" >/dev/null || true; fi
    if [[ "$OLD_VOLUME_CREATED" == true ]] && "$PODMAN" volume inspect "$OLD_VOLUME" >/dev/null 2>&1; then "$PODMAN" volume rename "$OLD_VOLUME" "$VOLUME" >/dev/null || true; fi
    if [[ "$STAGING_VOLUME_CREATED" == true ]] && "$PODMAN" volume inspect "$STAGING_VOLUME" >/dev/null 2>&1; then "$PODMAN" volume rm -f "$STAGING_VOLUME" >/dev/null || true; fi
    if [[ "$CONTAINER_WAS_PRESENT" == true ]]; then recreate_container >/dev/null 2>&1 || true; fi
  fi
  if [[ "$SNOWLUMA_WAS_RUNNING" == true ]] && "$PODMAN" container exists "$SNOWLUMA_CONTAINER"; then "$PODMAN" start "$SNOWLUMA_CONTAINER" >/dev/null || true; fi
  if [[ "$GATEWAY_WAS_RUNNING" == true ]]; then "$ROOT_DIR/scripts/start.sh" >/dev/null || true; fi
  exit "$status"
}
trap cleanup EXIT

if [[ -s "${AGENT_HOME_PID_FILE:-$AGENT_HOME_RUNTIME_DIR/gateway.pid}" ]] && kill -0 "$(<"${AGENT_HOME_PID_FILE:-$AGENT_HOME_RUNTIME_DIR/gateway.pid}")" 2>/dev/null; then GATEWAY_WAS_RUNNING=true; "$ROOT_DIR/scripts/stop.sh"; fi
if "$PODMAN" container exists "$CONTAINER"; then
  CONTAINER_WAS_PRESENT=true
  if [[ "$($PODMAN container inspect -f '{{.State.Running}}' "$CONTAINER")" == true ]]; then CONTAINER_WAS_RUNNING=true; "$PODMAN" stop "$CONTAINER" >/dev/null; fi
  "$PODMAN" rm "$CONTAINER" >/dev/null
fi
if "$PODMAN" container exists "$SNOWLUMA_CONTAINER" && [[ "$($PODMAN container inspect -f '{{.State.Running}}' "$SNOWLUMA_CONTAINER")" == true ]]; then
  SNOWLUMA_WAS_RUNNING=true
  "$PODMAN" stop "$SNOWLUMA_CONTAINER" >/dev/null
fi

"$PODMAN" load -i "$BACKUP/image.tar" >/dev/null

"$PODMAN" volume create "$STAGING_VOLUME" >/dev/null
STAGING_VOLUME_CREATED=true
"$PODMAN" volume import "$STAGING_VOLUME" "$BACKUP/state.tar"
if "$PODMAN" volume inspect "$VOLUME" >/dev/null 2>&1; then
  "$PODMAN" volume rename "$VOLUME" "$OLD_VOLUME" >/dev/null
  OLD_VOLUME_CREATED=true
fi
"$PODMAN" volume rename "$STAGING_VOLUME" "$VOLUME" >/dev/null
STAGING_VOLUME_CREATED=false

mkdir -p "$AGENT_HOME_RUNTIME_DIR"
if [[ -f "$BACKUP/gateway.sqlite" ]]; then cp "$BACKUP/gateway.sqlite" "$AGENT_HOME_RUNTIME_DIR/gateway.sqlite.tmp"; mv -f "$AGENT_HOME_RUNTIME_DIR/gateway.sqlite.tmp" "$AGENT_HOME_RUNTIME_DIR/gateway.sqlite"; fi
if [[ -f "$BACKUP/plugin-data.tar.gz" ]]; then tar -xzf "$BACKUP/plugin-data.tar.gz" -C "$AGENT_HOME_RUNTIME_DIR"; fi
if [[ -f "$BACKUP/gateway-artifacts.tar.gz" ]]; then tar -xzf "$BACKUP/gateway-artifacts.tar.gz" -C "$AGENT_HOME_RUNTIME_DIR"; fi
if [[ -f "$BACKUP/deployment-secrets.tar.gz" ]]; then
  mkdir -p "$ROOT_DIR/.agent-home"
  tar -xzf "$BACKUP/deployment-secrets.tar.gz" -C "$ROOT_DIR"
  for secret in control-token artifact-transfer-secret gateway-artifact-transfer-secret mcp-main-token mcp-control-token mcp-worker-bindings.json snowluma-access-token snowluma-websocket-access-token; do
    [[ -f "$ROOT_DIR/.agent-home/$secret" ]] && chmod 600 "$ROOT_DIR/.agent-home/$secret"
  done
fi
if [[ -f "$BACKUP/deployment-config.json" ]]; then mkdir -p "$(dirname "$CONFIG_PATH")"; cp "$BACKUP/deployment-config.json" "$CONFIG_PATH"; chmod 600 "$CONFIG_PATH"; fi
if [[ -f "$BACKUP/snowluma.env" ]]; then mkdir -p "$ROOT_DIR/config"; cp "$BACKUP/snowluma.env" "$ROOT_DIR/config/snowluma.env"; chmod 600 "$ROOT_DIR/config/snowluma.env"; fi
for snowluma_volume in "${SNOWLUMA_VOLUMES[@]}"; do
  if [[ -f "$BACKUP/$snowluma_volume.tar" ]]; then
    "$PODMAN" volume inspect "$snowluma_volume" >/dev/null 2>&1 || "$PODMAN" volume create "$snowluma_volume" >/dev/null
    "$PODMAN" volume import "$snowluma_volume" "$BACKUP/$snowluma_volume.tar"
  fi
done

recreate_container
if [[ "$OLD_VOLUME_CREATED" == true ]]; then "$PODMAN" volume rm "$OLD_VOLUME" >/dev/null; OLD_VOLUME_CREATED=false; fi
RESTORE_COMMITTED=true
printf 'restored backup version %s into fresh volume %s\n' "$MANIFEST_VERSION" "$VOLUME"
