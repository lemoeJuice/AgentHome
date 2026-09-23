#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/lib.sh"

PODMAN="$PODMAN_COMMAND"
NETWORK="$SNOWLUMA_NETWORK"
CONTAINER="$SNOWLUMA_CONTAINER"
IMAGE="$SNOWLUMA_IMAGE"
HTTP_PORT="$SNOWLUMA_HTTP_PORT"
WS_PORT="$SNOWLUMA_WS_PORT"
WEBUI_PORT="$SNOWLUMA_WEBUI_PORT"
WEBUI_CONTAINER_PORT="${SNOWLUMA_WEBUI_CONTAINER_PORT:-5099}"
NOVNC_PORT="$SNOWLUMA_NOVNC_PORT"
NOFILE_ULIMIT="${SNOWLUMA_NOFILE_ULIMIT:-65536:524288}"
CONFIG_PATH="${AGENT_HOME_CONFIG:-$ROOT_DIR/config/agent-home.json}"
OWNER_CONFIG_PATH="${AGENT_HOME_OWNER_CONFIG:-}"
container_changed=false

fail() {
  printf 'SnowLuma setup error: %s\n' "$1" >&2
  exit 2
}

command -v node >/dev/null || fail 'missing dependency: node'
command -v "$PODMAN" >/dev/null || fail "missing dependency: $PODMAN"

if [[ "$CONFIG_PATH" != /* ]]; then CONFIG_PATH="$ROOT_DIR/$CONFIG_PATH"; fi
if [[ -z "$OWNER_CONFIG_PATH" ]]; then OWNER_CONFIG_PATH="$(dirname "$CONFIG_PATH")/owner.json"; elif [[ "$OWNER_CONFIG_PATH" != /* ]]; then OWNER_CONFIG_PATH="$ROOT_DIR/$OWNER_CONFIG_PATH"; fi
case "$CONFIG_PATH" in
  "$ROOT_DIR"/*) ;;
  *) fail 'AGENT_HOME_CONFIG must be inside the project directory' ;;
esac
case "$OWNER_CONFIG_PATH" in
  "$ROOT_DIR"/*) ;;
  *) fail 'AGENT_HOME_OWNER_CONFIG must be inside the project directory' ;;
esac

mkdir -p "$(dirname "$CONFIG_PATH")"
if [[ ! -f "$CONFIG_PATH" ]]; then
  cp "$ROOT_DIR/config.example.json" "$CONFIG_PATH"
  chmod 600 "$CONFIG_PATH"
fi

if [[ ! -e "$OWNER_CONFIG_PATH" ]]; then
  mkdir -p "$(dirname "$OWNER_CONFIG_PATH")"
  cp "$ROOT_DIR/config/owner.example.json" "$OWNER_CONFIG_PATH"
  chmod 600 "$OWNER_CONFIG_PATH"
  printf 'created optional Bot Owner config template: %s\n' "$OWNER_CONFIG_PATH" >&2
fi
OWNER_CONFIG_PATH="$OWNER_CONFIG_PATH" node --input-type=module -e 'import fs from "node:fs"; const owner=JSON.parse(fs.readFileSync(process.env.OWNER_CONFIG_PATH,"utf8")); const configured=owner.userId && !owner.userId.startsWith("REPLACE_"); if (configured && (!owner.platform || !owner.accountId)) process.exit(1);' || fail "owner config is invalid: $OWNER_CONFIG_PATH"

if [[ "${SNOWLUMA_REFRESH_IMAGE:-0}" == 1 ]]; then
  "$PODMAN" pull "$IMAGE"
else
  "$PODMAN" pull --policy missing "$IMAGE"
fi
if ! "$PODMAN" network inspect "$NETWORK" >/dev/null 2>&1; then
  "$PODMAN" network create "$NETWORK" >/dev/null
fi

for volume in snowluma-gateway-data snowluma-client-config snowluma-client-data; do
  "$PODMAN" volume inspect "$volume" >/dev/null 2>&1 || "$PODMAN" volume create "$volume" >/dev/null
done

if "$PODMAN" container exists "$CONTAINER"; then
  if [[ "$("$PODMAN" container inspect -f '{{.Config.Image}}' "$CONTAINER")" != "$IMAGE" ]]; then
    "$PODMAN" rm -f "$CONTAINER" >/dev/null
  fi
fi

if ! "$PODMAN" container exists "$CONTAINER"; then
  args=(
    run -d --name "$CONTAINER" --restart unless-stopped --network "$NETWORK"
    --shm-size=1g --ulimit "nofile=$NOFILE_ULIMIT" --cap-add=SYS_PTRACE
    --security-opt seccomp=unconfined
    --env SNOWLUMA_WEBUI_HOST=0.0.0.0
    --env "SNOWLUMA_WEBUI_PORT=$WEBUI_CONTAINER_PORT"
    --env 'SNOWLUMA_QQ_FLAGS=--disable-gpu --disable-software-rasterizer --disable-gpu-compositing'
    --env TZ=Asia/Shanghai
    --publish "127.0.0.1:${NOVNC_PORT}:6081"
    --publish "127.0.0.1:${WEBUI_PORT}:${WEBUI_CONTAINER_PORT}"
    --publish "127.0.0.1:${HTTP_PORT}:3000"
    --publish "127.0.0.1:${WS_PORT}:3001"
    --volume 'snowluma-gateway-data:/app/data:Z,U'
    --volume 'snowluma-client-config:/app/.config:Z,U'
    --volume 'snowluma-client-data:/app/.local/share:Z,U'
    "$IMAGE"
  )
  "$PODMAN" "${args[@]}" >/dev/null
  container_changed=true
elif [[ "$("$PODMAN" container inspect -f '{{.State.Running}}' "$CONTAINER")" != true ]]; then
  "$PODMAN" start "$CONTAINER" >/dev/null
  container_changed=true
fi

HOST_WS_PATH="$($PODMAN exec "$CONTAINER" node --input-type=module -e 'import fs from "node:fs"; const value=JSON.parse(fs.readFileSync("/app/data/config/onebot.json", "utf8")); process.stdout.write(value.networks?.wsServers?.[0]?.path || "/");')"
CONFIG_PATH="$CONFIG_PATH" HOST_API_ENDPOINT="http://127.0.0.1:${HTTP_PORT}" HOST_WS_ENDPOINT="ws://127.0.0.1:${WS_PORT}" HOST_WS_PATH="$HOST_WS_PATH" node --input-type=module <<'NODE'
import fs from "node:fs";
const path = process.env.CONFIG_PATH;
const config = JSON.parse(fs.readFileSync(path, "utf8"));
config.snowluma ??= {};
config.snowluma.endpoint = process.env.HOST_WS_ENDPOINT;
config.snowluma.apiEndpoint = process.env.HOST_API_ENDPOINT;
config.snowluma.reverseWebSocketPath = process.env.HOST_WS_PATH || config.snowluma.reverseWebSocketPath || "/onebot/v11/ws";
config.snowluma.accountId ??= "default";
config.runtime ??= {};
config.runtime.workerSandboxCommand ??= "bwrap";
fs.writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(path, 0o600);
NODE

printf '%s\n' "SnowLuma image: $IMAGE"
printf '%s\n' "SnowLuma container: $CONTAINER"
printf '%s\n' "Scan QQ at noVNC: http://127.0.0.1:${NOVNC_PORT}/"
printf '%s\n' "SnowLuma WebUI: http://127.0.0.1:${WEBUI_PORT}/"
printf '%s\n' "OneBot endpoints: HTTP=127.0.0.1:${HTTP_PORT} WS=127.0.0.1:${WS_PORT}"
printf '%s\n' 'SnowLuma uses its persistent QQ volumes and QR login; OneBot tokens are kept in ignored local secret files.'
if [[ "$container_changed" == true || "${SNOWLUMA_QR_PROMPT:-0}" == 1 ]] && [[ -t 0 ]]; then
  read -r -p '完成 noVNC 扫码登录后按 Enter 继续 Agent Home 配置...'
fi

ACCESS_TOKEN_FILE="${SNOWLUMA_ACCESS_TOKEN_FILE:-$ROOT_DIR/.agent-home/snowluma-access-token}"
mkdir -p "$(dirname "$ACCESS_TOKEN_FILE")"
if TOKEN="$($PODMAN exec "$CONTAINER" node --input-type=module -e 'import fs from "node:fs"; const value=JSON.parse(fs.readFileSync("/app/data/config/onebot.json", "utf8")); const token=value.networks?.httpServers?.[0]?.accessToken; if (!token) process.exit(1); process.stdout.write(token);')"; then
  umask 077
  printf '%s\n' "$TOKEN" >"$ACCESS_TOKEN_FILE"
  chmod 600 "$ACCESS_TOKEN_FILE"
fi
WEBSOCKET_ACCESS_TOKEN_FILE="${SNOWLUMA_WEBSOCKET_ACCESS_TOKEN_FILE:-$ROOT_DIR/.agent-home/snowluma-websocket-access-token}"
if TOKEN="$($PODMAN exec "$CONTAINER" node --input-type=module -e 'import fs from "node:fs"; const value=JSON.parse(fs.readFileSync("/app/data/config/onebot.json", "utf8")); const token=value.networks?.wsServers?.[0]?.accessToken; if (!token) process.exit(1); process.stdout.write(token);')"; then
  umask 077
  printf '%s\n' "$TOKEN" >"$WEBSOCKET_ACCESS_TOKEN_FILE"
  chmod 600 "$WEBSOCKET_ACCESS_TOKEN_FILE"
fi
