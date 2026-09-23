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
SNOWLUMA_BIND_ADDRESS="${SNOWLUMA_BIND_ADDRESS:-0.0.0.0}"
SNOWLUMA_HTTP_PORT="${SNOWLUMA_HTTP_PORT:-3000}"
SNOWLUMA_WS_PORT="${SNOWLUMA_WS_PORT:-3001}"
SNOWLUMA_WEBUI_PORT="${SNOWLUMA_WEBUI_PORT:-5100}"
SNOWLUMA_NOVNC_PORT="${SNOWLUMA_NOVNC_PORT:-6081}"
if [[ ! "$SNOWLUMA_BIND_ADDRESS" =~ ^[A-Za-z0-9.:-]+$ ]]; then
  printf '%s\n' "unsafe SnowLuma bind address: $SNOWLUMA_BIND_ADDRESS" >&2
  return 2 2>/dev/null || exit 2
fi
export SNOWLUMA_CONTAINER SNOWLUMA_NETWORK SNOWLUMA_BIND_ADDRESS SNOWLUMA_HTTP_PORT SNOWLUMA_WS_PORT SNOWLUMA_WEBUI_PORT SNOWLUMA_NOVNC_PORT

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
