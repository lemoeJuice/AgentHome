#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/lib.sh"

PODMAN="$PODMAN_COMMAND"
CONTAINER="$AGENT_HOME_CONTAINER"
IMAGE="$AGENT_HOME_IMAGE"
VOLUME="$AGENT_HOME_VOLUME"
NETWORK="$AGENT_HOME_NETWORK"
BOOTSTRAP_FILE="${AGENT_HOME_BOOTSTRAP_FILE:-}"
initialized=false

command -v "$PODMAN" >/dev/null || { printf '%s\n' "missing dependency: $PODMAN" >&2; exit 2; }
"$PODMAN" volume inspect "$VOLUME" >/dev/null 2>&1 || "$PODMAN" volume create "$VOLUME" >/dev/null
"$PODMAN" network inspect "$NETWORK" >/dev/null 2>&1 || "$PODMAN" network create "$NETWORK" >/dev/null

if "$PODMAN" container exists "$CONTAINER"; then
  privileged="$($PODMAN container inspect -f '{{.HostConfig.Privileged}}' "$CONTAINER")"
  pid_mode="$($PODMAN container inspect -f '{{.HostConfig.PidMode}}' "$CONTAINER")"
  network_mode="$($PODMAN container inspect -f '{{.HostConfig.NetworkMode}}' "$CONTAINER")"
  mount_types="$($PODMAN container inspect -f '{{range .Mounts}}{{.Type}} {{end}}' "$CONTAINER")"
  mount_destinations="$($PODMAN container inspect -f '{{range .Mounts}}{{.Destination}} {{end}}' "$CONTAINER")"
  port_bindings="$($PODMAN container inspect -f '{{json .HostConfig.PortBindings}}' "$CONTAINER")"
  [[ "$privileged" != true && "$pid_mode" != host && "$network_mode" != host ]] || { printf '%s\n' 'existing Agent Home container has unsafe privilege, PID, or network topology' >&2; exit 2; }
  [[ "$mount_types" == "volume " && "$mount_destinations" == "/state " ]] || { printf '%s\n' 'existing Agent Home container has unsafe mount topology' >&2; exit 2; }
  [[ "$port_bindings" == "null" || "$port_bindings" == "{}" ]] || { printf '%s\n' 'existing Agent Home container publishes ports' >&2; exit 2; }
  mounts="$($PODMAN container inspect -f '{{json .Mounts}}' "$CONTAINER")"
  [[ "$mounts" != *"/var/run/podman.sock"* && "$mounts" != *"/run/podman/podman.sock"* && "$mounts" != *"/var/run/docker.sock"* ]] || { printf '%s\n' 'existing Agent Home container exposes a host container socket' >&2; exit 2; }
fi

if ! "$PODMAN" container exists "$CONTAINER"; then
  run_args=(run -d --name "$CONTAINER" --volume "${VOLUME}:/state:Z,U" --network "$NETWORK")
  [[ -n "${AGENT_HOME_MCP_URL:-}" ]] && run_args+=(--env "AGENT_HOME_MCP_URL=${AGENT_HOME_MCP_URL}")
  [[ -n "${AGENT_HOME_MCP_CALLER:-}" ]] && run_args+=(--env "AGENT_HOME_MCP_CALLER=${AGENT_HOME_MCP_CALLER}")
  if [[ -z "${AGENT_HOME_MCP_URL:-}" ]]; then run_args+=(--env "AGENT_HOME_MCP_URL=${AGENT_HOME_MCP_DEFAULT_URL:-http://host.containers.internal:8787/mcp}"); fi
  run_args+=(--env "AGENT_ARTIFACT_PUBLIC_BASE_URL=http://${CONTAINER}:${AGENT_ARTIFACT_TRANSFER_PORT:-8790}")
  run_args+=(--env "AGENT_ARTIFACT_TRANSFER_PORT=${AGENT_ARTIFACT_TRANSFER_PORT:-8790}")
  run_args+=("$IMAGE" supervise)
  "$PODMAN" "${run_args[@]}" >/dev/null
elif [[ "$("$PODMAN" container inspect -f '{{.State.Running}}' "$CONTAINER")" != true ]]; then
  "$PODMAN" start "$CONTAINER" >/dev/null
fi

"$PODMAN" exec "$CONTAINER" sh -c 'mkdir -p /state/home/.pi/agent && chmod 700 /state/home/.pi /state/home/.pi/agent'

if [[ "${AGENT_HOME_REBOOTSTRAP:-0}" != 1 ]] && "$PODMAN" exec "$CONTAINER" agent-home control ping >/dev/null 2>&1; then
  printf '%s\n' 'Agent Home container is already initialized; skipping bootstrap'
  exit 0
fi

if [[ -n "$BOOTSTRAP_FILE" ]]; then
  [[ -r "$BOOTSTRAP_FILE" ]] || { printf '%s\n' "bootstrap file is not readable: $BOOTSTRAP_FILE" >&2; exit 2; }
  AGENT_HOME_BOOTSTRAP_FILE="$BOOTSTRAP_FILE" node --input-type=module -e 'import fs from "node:fs"; const value=JSON.parse(fs.readFileSync(process.env.AGENT_HOME_BOOTSTRAP_FILE,"utf8")); const internal={...(value.internal || {}),...(process.env.AGENT_HOME_CONTROL_TOKEN ? { controlToken: process.env.AGENT_HOME_CONTROL_TOKEN } : {}),...(process.env.AGENT_HOME_MCP_TOKEN ? { mcpToken: process.env.AGENT_HOME_MCP_TOKEN } : {}),...(process.env.GATEWAY_MCP_CONTROL_TOKEN ? { mcpControlToken: process.env.GATEWAY_MCP_CONTROL_TOKEN } : {}),...(process.env.AGENT_ARTIFACT_TRANSFER_SECRET ? { artifactTransferSecret: process.env.AGENT_ARTIFACT_TRANSFER_SECRET } : {})}; if (!internal.mcpToken) { try { internal.mcpToken=fs.readFileSync(".agent-home/mcp-main-token","utf8").trim(); } catch {} } value.internal=internal; process.stdout.write(JSON.stringify(value));' | "$PODMAN" exec -i "$CONTAINER" agent-home bootstrap --stdin
  initialized=true
elif [[ -f "${AGENT_HOME_CONFIG:-$ROOT_DIR/config/agent-home.json}" ]]; then
  CONFIG_PATH="${AGENT_HOME_CONFIG:-$ROOT_DIR/config/agent-home.json}"
  OWNER_CONFIG_PATH="${AGENT_HOME_OWNER_CONFIG:-}"
  if [[ "$CONFIG_PATH" != /* ]]; then CONFIG_PATH="$ROOT_DIR/$CONFIG_PATH"; fi
  if [[ -z "$OWNER_CONFIG_PATH" ]]; then OWNER_CONFIG_PATH="$(dirname "$CONFIG_PATH")/owner.json"; elif [[ "$OWNER_CONFIG_PATH" != /* ]]; then OWNER_CONFIG_PATH="$ROOT_DIR/$OWNER_CONFIG_PATH"; fi
  case "$CONFIG_PATH" in "$ROOT_DIR"/*) ;; *) printf '%s\n' 'AGENT_HOME_CONFIG must be inside the project directory' >&2; exit 2 ;; esac
  case "$OWNER_CONFIG_PATH" in "$ROOT_DIR"/*) ;; *) printf '%s\n' 'AGENT_HOME_OWNER_CONFIG must be inside the project directory' >&2; exit 2 ;; esac
  if CONFIG_PATH="$CONFIG_PATH" OWNER_CONFIG_PATH="$OWNER_CONFIG_PATH" node --input-type=module -e 'import fs from "node:fs"; const c=JSON.parse(fs.readFileSync(process.env.CONFIG_PATH,"utf8")); if (!c.snowluma?.endpoint) process.exit(1);'; then
     CONFIG_PATH="$CONFIG_PATH" OWNER_CONFIG_PATH="$OWNER_CONFIG_PATH" SNOWLUMA_AGENT_ENDPOINT="${SNOWLUMA_AGENT_ENDPOINT:-ws://snowluma:3001}" SNOWLUMA_AGENT_API_ENDPOINT="${SNOWLUMA_AGENT_API_ENDPOINT:-http://snowluma:3000}" node --input-type=module -e 'import fs from "node:fs"; const c=JSON.parse(fs.readFileSync(process.env.CONFIG_PATH,"utf8")); let owner; try { owner=JSON.parse(fs.readFileSync(process.env.OWNER_CONFIG_PATH,"utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; } const configuredOwner=owner?.platform && owner?.accountId && owner?.userId && !owner.userId.startsWith("REPLACE_"); const credential=process.env.SNOWLUMA_ACCESS_TOKEN; const websocketCredential=process.env.SNOWLUMA_WEBSOCKET_ACCESS_TOKEN; const internal={...(process.env.AGENT_HOME_CONTROL_TOKEN ? { controlToken: process.env.AGENT_HOME_CONTROL_TOKEN } : {}),...(process.env.AGENT_HOME_MCP_TOKEN ? { mcpToken: process.env.AGENT_HOME_MCP_TOKEN } : {}),...(process.env.GATEWAY_MCP_CONTROL_TOKEN ? { mcpControlToken: process.env.GATEWAY_MCP_CONTROL_TOKEN } : {}),...(process.env.AGENT_ARTIFACT_TRANSFER_SECRET ? { artifactTransferSecret: process.env.AGENT_ARTIFACT_TRANSFER_SECRET } : {})}; if (!internal.mcpToken) { try { internal.mcpToken=fs.readFileSync(".agent-home/mcp-main-token","utf8").trim(); } catch {} } const payload={format:"agent-home-bootstrap",version:1,instanceId:c.instanceId,...(configuredOwner ? { owner } : {}),plugins:{allowedActions:c.plugins?.allowedActions || []},...(Object.keys(internal).length ? { internal } : {}),snowluma:{endpoint:process.env.SNOWLUMA_AGENT_ENDPOINT || c.snowluma.endpoint,apiEndpoint:process.env.SNOWLUMA_AGENT_API_ENDPOINT || c.snowluma.apiEndpoint,reverseWebSocketPath:c.snowluma.reverseWebSocketPath || "/onebot/v11/ws",...(credential ? { credential } : {}),...(websocketCredential ? { websocketCredential } : {})}}; process.stdout.write(JSON.stringify(payload));' | "$PODMAN" exec -i "$CONTAINER" agent-home bootstrap --stdin
    initialized=true
  else
    printf '%s\n' 'container is running; configure config/owner.json and SnowLuma endpoint, then rerun init-container.sh' >&2
  fi
else
  printf '%s\n' 'container is running; provide AGENT_HOME_BOOTSTRAP_FILE or config/agent-home.json to initialize it' >&2
fi

if [[ "$initialized" != true ]]; then
  exit 0
fi
for _ in {1..30}; do
  "$PODMAN" exec "$CONTAINER" agent-home control ping >/dev/null 2>&1 && exit 0
  sleep 0.2
done
printf '%s\n' 'runtime did not become ready' >&2
exit 1
