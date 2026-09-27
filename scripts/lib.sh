#!/usr/bin/env bash

# Deployment defaults are fixed here so setup never depends on a user-maintained
# environment file or a host-specific binary path.
if [[ -z "${ROOT_DIR:-}" ]]; then
  ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

FIXED_PODMAN="$ROOT_DIR/.agent-home/podman/bin/podman"
AGENT_HOME_PODMAN_STORAGE_CONF="$ROOT_DIR/.agent-home/podman/storage.conf"
if [[ -z "${CONTAINERS_STORAGE_CONF:-}" && -r "$AGENT_HOME_PODMAN_STORAGE_CONF" ]]; then
  export CONTAINERS_STORAGE_CONF="$AGENT_HOME_PODMAN_STORAGE_CONF"
fi
if [[ -x "$FIXED_PODMAN" ]] && "$FIXED_PODMAN" info --format '{{.Host.Security.Rootless}}' >/dev/null 2>&1; then
  PODMAN_COMMAND="$FIXED_PODMAN"
else
  SYSTEM_PODMAN="$(command -v podman || true)"
  PODMAN_COMMAND="${SYSTEM_PODMAN:-${PODMAN_COMMAND:-}}"
fi
PODMAN_COMMAND="${PODMAN_COMMAND:-$FIXED_PODMAN}"
export PODMAN_COMMAND

AGENT_HOME_IMAGE="${AGENT_HOME_IMAGE:-agent-home:latest}"
AGENT_HOME_BASE_IMAGE="${AGENT_HOME_BASE_IMAGE:-node:22-bookworm-slim}"
AGENT_HOME_VOLUME="${AGENT_HOME_VOLUME:-agent-home-default-state}"
AGENT_HOME_NETWORK="${AGENT_HOME_NETWORK:-agent-home-net}"
AGENT_HOME_CONTAINER="${AGENT_HOME_CONTAINER:-agent-home-default}"
export AGENT_HOME_IMAGE AGENT_HOME_BASE_IMAGE AGENT_HOME_VOLUME AGENT_HOME_NETWORK AGENT_HOME_CONTAINER
export AGENT_HOME_HOST_SECRET_ROOT="${AGENT_HOME_HOST_SECRET_ROOT:-$ROOT_DIR/.agent-home}"

SNOWLUMA_CONFIG_FILE="${SNOWLUMA_CONFIG_FILE:-$ROOT_DIR/config/snowluma.env}"
if [[ ! -e "$SNOWLUMA_CONFIG_FILE" && -f "$ROOT_DIR/config/snowluma.env.example" ]]; then
  cp "$ROOT_DIR/config/snowluma.env.example" "$SNOWLUMA_CONFIG_FILE"
  chmod 600 "$SNOWLUMA_CONFIG_FILE"
fi
if [[ -r "$SNOWLUMA_CONFIG_FILE" ]]; then
  while IFS='=' read -r config_key config_value; do
    config_value="${config_value%$'\r'}"
    [[ -z "$config_key" || "$config_key" == \#* ]] && continue
    case "$config_key" in
      SNOWLUMA_SERVICE_BIND_ADDRESS|SNOWLUMA_UI_BIND_ADDRESS|SNOWLUMA_HTTP_PORT|SNOWLUMA_WS_PORT|SNOWLUMA_WEBUI_PORT|SNOWLUMA_NOVNC_PORT|SNOWLUMA_ACCEPT_EULA|SNOWLUMA_ACCEPT_PRIVACY)
        [[ -v "$config_key" ]] || printf -v "$config_key" '%s' "$config_value"
        ;;
    esac
  done < "$SNOWLUMA_CONFIG_FILE"
fi

SNOWLUMA_IMAGE="docker.io/motricseven7/snowluma:latest"
SNOWLUMA_ACCESS_TOKEN_FILE="${SNOWLUMA_ACCESS_TOKEN_FILE:-$ROOT_DIR/.agent-home/snowluma-access-token}"
if [[ -s "$SNOWLUMA_ACCESS_TOKEN_FILE" ]]; then
  export SNOWLUMA_ACCESS_TOKEN="$(<"$SNOWLUMA_ACCESS_TOKEN_FILE")"
fi
SNOWLUMA_WEBSOCKET_ACCESS_TOKEN_FILE="${SNOWLUMA_WEBSOCKET_ACCESS_TOKEN_FILE:-$ROOT_DIR/.agent-home/snowluma-websocket-access-token}"
if [[ -s "$SNOWLUMA_WEBSOCKET_ACCESS_TOKEN_FILE" ]]; then
  export SNOWLUMA_WEBSOCKET_ACCESS_TOKEN="$(<"$SNOWLUMA_WEBSOCKET_ACCESS_TOKEN_FILE")"
fi

if [[ -s "$ROOT_DIR/.agent-home/control-token" ]]; then
  export AGENT_HOME_CONTROL_TOKEN="$(<"$ROOT_DIR/.agent-home/control-token")"
fi
if [[ -s "$ROOT_DIR/.agent-home/artifact-transfer-secret" ]]; then
  export AGENT_ARTIFACT_TRANSFER_SECRET="$(<"$ROOT_DIR/.agent-home/artifact-transfer-secret")"
fi
if [[ -s "$ROOT_DIR/.agent-home/gateway-artifact-transfer-secret" ]]; then
  export GATEWAY_ARTIFACT_TRANSFER_SECRET="$(<"$ROOT_DIR/.agent-home/gateway-artifact-transfer-secret")"
fi
if [[ -s "$ROOT_DIR/.agent-home/mcp-main-token" ]]; then
  export GATEWAY_MCP_TOKEN="$(<"$ROOT_DIR/.agent-home/mcp-main-token")"
fi
if [[ -s "$ROOT_DIR/.agent-home/mcp-control-token" ]]; then
  export GATEWAY_MCP_CONTROL_TOKEN="$(<"$ROOT_DIR/.agent-home/mcp-control-token")"
fi
SNOWLUMA_CONTAINER="${SNOWLUMA_CONTAINER:-snowluma}"
SNOWLUMA_NETWORK="$AGENT_HOME_NETWORK"
SNOWLUMA_SERVICE_BIND_ADDRESS="${SNOWLUMA_SERVICE_BIND_ADDRESS:-127.0.0.1}"
SNOWLUMA_UI_BIND_ADDRESS="${SNOWLUMA_UI_BIND_ADDRESS:-0.0.0.0}"
SNOWLUMA_HTTP_PORT="${SNOWLUMA_HTTP_PORT:-3000}"
SNOWLUMA_WS_PORT="${SNOWLUMA_WS_PORT:-3001}"
SNOWLUMA_WEBUI_PORT="${SNOWLUMA_WEBUI_PORT:-5100}"
SNOWLUMA_NOVNC_PORT="${SNOWLUMA_NOVNC_PORT:-6081}"
SNOWLUMA_ACCEPT_EULA="${SNOWLUMA_ACCEPT_EULA:-1}"
SNOWLUMA_ACCEPT_PRIVACY="${SNOWLUMA_ACCEPT_PRIVACY:-1}"
for snowluma_bind_address in "$SNOWLUMA_SERVICE_BIND_ADDRESS" "$SNOWLUMA_UI_BIND_ADDRESS"; do
  if [[ ! "$snowluma_bind_address" =~ ^[A-Za-z0-9.:-]+$ ]]; then
    printf '%s\n' "unsafe SnowLuma bind address: $snowluma_bind_address" >&2
    return 2 2>/dev/null || exit 2
  fi
done
for snowluma_consent in "$SNOWLUMA_ACCEPT_EULA" "$SNOWLUMA_ACCEPT_PRIVACY"; do
  case "$snowluma_consent" in
    0|1|true|false) ;;
    *) printf '%s\n' 'SnowLuma consent settings must be 0, 1, true, or false' >&2; return 2 2>/dev/null || exit 2 ;;
  esac
done
export SNOWLUMA_CONFIG_FILE SNOWLUMA_CONTAINER SNOWLUMA_NETWORK SNOWLUMA_SERVICE_BIND_ADDRESS SNOWLUMA_UI_BIND_ADDRESS SNOWLUMA_HTTP_PORT SNOWLUMA_WS_PORT SNOWLUMA_WEBUI_PORT SNOWLUMA_NOVNC_PORT SNOWLUMA_ACCEPT_EULA SNOWLUMA_ACCEPT_PRIVACY

agent_home_model_proxy_url() {
  if [[ -v AGENT_HOME_MODEL_PROXY_URL ]]; then
    printf '%s' "$AGENT_HOME_MODEL_PROXY_URL"
    return
  fi
  local config_path="${AGENT_HOME_CONFIG:-$ROOT_DIR/config/agent-home.json}"
  if [[ "$config_path" != /* ]]; then config_path="$ROOT_DIR/$config_path"; fi
  CONFIG_PATH="$config_path" node --input-type=module -e 'import fs from "node:fs"; const config=JSON.parse(fs.readFileSync(process.env.CONFIG_PATH,"utf8")); const network=config.network??{}; if(Object.hasOwn(network,"modelProxyUrl")){process.stdout.write(network.modelProxyUrl??"");}else{const relay=network.proxyRelay??{enabled:true,listenPort:17890};process.stdout.write(relay.enabled===false?"":`http://host.containers.internal:${relay.listenPort??17890}`);}'
}

agent_home_proxy_relay_settings() {
  local config_path="${AGENT_HOME_CONFIG:-$ROOT_DIR/config/agent-home.json}"
  if [[ "$config_path" != /* ]]; then config_path="$ROOT_DIR/$config_path"; fi
  CONFIG_PATH="$config_path" node --input-type=module -e 'import fs from "node:fs";const config=JSON.parse(fs.readFileSync(process.env.CONFIG_PATH,"utf8"));const relay=config.network?.proxyRelay??{enabled:true,listenPort:17890,upstreamHost:"127.0.0.1",upstreamPort:7890};const values=[relay.enabled===false?"0":"1",relay.listenPort??17890,relay.upstreamHost??"127.0.0.1",relay.upstreamPort??7890];if(values.some((value)=>String(value).includes("\n")||String(value).includes("\t")))process.exit(2);process.stdout.write(values.join("\t"));'
}

AGENT_HOME_PROXY_BYPASS="localhost,127.0.0.1,::1,host.containers.internal,$SNOWLUMA_CONTAINER,$AGENT_HOME_CONTAINER"
export AGENT_HOME_PROXY_BYPASS

for topology_name in "$AGENT_HOME_VOLUME" "$AGENT_HOME_NETWORK" "$AGENT_HOME_CONTAINER"; do
  if [[ ! "$topology_name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$ ]]; then
    printf '%s\n' "unsafe Podman topology name: $topology_name" >&2
    return 2 2>/dev/null || exit 2
  fi
done
if [[ "$AGENT_HOME_IMAGE" == *$'\n'* || "$AGENT_HOME_IMAGE" == *$'\r'* || "$AGENT_HOME_IMAGE" == *[[:space:]]* ]]; then
  printf '%s\n' "unsafe Agent Home image reference" >&2
  return 2 2>/dev/null || exit 2
fi
