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
proxy_env_entries=()
if [[ "$AGENT_HOME_USE_PROXY" == 1 ]]; then
  proxy_env_entries+=("NODE_USE_ENV_PROXY=1")
  for proxy_name in HTTP HTTPS ALL NO; do
    case "$proxy_name" in
      HTTP) proxy_value="$AGENT_HOME_HTTP_PROXY" ;;
      HTTPS) proxy_value="$AGENT_HOME_HTTPS_PROXY" ;;
      ALL) proxy_value="$AGENT_HOME_ALL_PROXY" ;;
      NO) proxy_value="$AGENT_HOME_NO_PROXY" ;;
    esac
    [[ -n "$proxy_value" ]] || continue
    container_proxy_name="${proxy_name}_PROXY"
    [[ "$proxy_name" == NO ]] && container_proxy_name="NO_PROXY"
    proxy_env_entries+=("$container_proxy_name=$proxy_value" "${container_proxy_name,,}=$proxy_value")
  done
fi

command -v "$PODMAN" >/dev/null || { printf '%s\n' "missing dependency: $PODMAN" >&2; exit 2; }
"$PODMAN" volume inspect "$VOLUME" >/dev/null 2>&1 || "$PODMAN" volume create "$VOLUME" >/dev/null
"$PODMAN" network inspect "$NETWORK" >/dev/null 2>&1 || "$PODMAN" network create "$NETWORK" >/dev/null

if "$PODMAN" container exists "$CONTAINER" && [[ "$($PODMAN container inspect -f '{{.Image}}' "$CONTAINER")" != "$($PODMAN image inspect -f '{{.Id}}' "$IMAGE")" ]]; then
  printf 'replacing existing Agent Home container with updated image %s (state volume is retained)\n' "$IMAGE"
  "$PODMAN" rm -f "$CONTAINER" >/dev/null
fi

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
  networks="$($PODMAN container inspect -f '{{json .NetworkSettings.Networks}}' "$CONTAINER")"
  EXPECTED_VOLUME="$VOLUME" EXPECTED_NETWORK="$NETWORK" MOUNTS_JSON="$mounts" NETWORKS_JSON="$networks" node --input-type=module -e 'const mounts=JSON.parse(process.env.MOUNTS_JSON); const networks=Object.keys(JSON.parse(process.env.NETWORKS_JSON)); if (mounts.length !== 1 || (mounts[0].Name !== process.env.EXPECTED_VOLUME && mounts[0].Source !== process.env.EXPECTED_VOLUME)) process.exit(1); if (networks.length !== 1 || networks[0] !== process.env.EXPECTED_NETWORK) process.exit(1);' || { printf '%s\n' 'existing Agent Home container has mismatched volume or network topology' >&2; exit 2; }
  existing_env="$($PODMAN container inspect -f '{{json .Config.Env}}' "$CONTAINER")"
  expected_proxy_env="$(printf '%s\n' "${proxy_env_entries[@]}")"
  EXISTING_ENV="$existing_env" EXPECTED_PROXY_ENV="$expected_proxy_env" node --input-type=module -e '
    const relevant = new Set(["NODE_USE_ENV_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]);
    const actual = JSON.parse(process.env.EXISTING_ENV || "[]").filter((entry) => relevant.has(entry.split("=", 1)[0])).sort();
    const expected = (process.env.EXPECTED_PROXY_ENV || "").split("\n").filter(Boolean).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) process.exit(1);
  ' || { printf '%s\n' 'existing Agent Home container has mismatched proxy environment' >&2; "$PODMAN" rm -f "$CONTAINER" >/dev/null; }
fi

if ! "$PODMAN" container exists "$CONTAINER"; then
  run_args=(run -d --name "$CONTAINER" --volume "${VOLUME}:/state:Z,U" --network "$NETWORK")
  for proxy_env_entry in "${proxy_env_entries[@]}"; do run_args+=(--env "$proxy_env_entry"); done
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
     CONFIG_PATH="$CONFIG_PATH" OWNER_CONFIG_PATH="$OWNER_CONFIG_PATH" SNOWLUMA_AGENT_ENDPOINT="${SNOWLUMA_AGENT_ENDPOINT:-ws://snowluma:3001}" SNOWLUMA_AGENT_API_ENDPOINT="${SNOWLUMA_AGENT_API_ENDPOINT:-http://snowluma:3000}" node --input-type=module -e 'import fs from "node:fs"; const c=JSON.parse(fs.readFileSync(process.env.CONFIG_PATH,"utf8")); let owner; try { owner=JSON.parse(fs.readFileSync(process.env.OWNER_CONFIG_PATH,"utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; } const configuredOwner=owner?.platform && owner?.accountId && owner?.userId && !owner.userId.startsWith("REPLACE_"); const credential=process.env.SNOWLUMA_ACCESS_TOKEN; const websocketCredential=process.env.SNOWLUMA_WEBSOCKET_ACCESS_TOKEN; const internal={...(process.env.AGENT_HOME_CONTROL_TOKEN ? { controlToken: process.env.AGENT_HOME_CONTROL_TOKEN } : {}),...(process.env.AGENT_HOME_MCP_TOKEN ? { mcpToken: process.env.AGENT_HOME_MCP_TOKEN } : {}),...(process.env.GATEWAY_MCP_CONTROL_TOKEN ? { mcpControlToken: process.env.GATEWAY_MCP_CONTROL_TOKEN } : {}),...(process.env.AGENT_ARTIFACT_TRANSFER_SECRET ? { artifactTransferSecret: process.env.AGENT_ARTIFACT_TRANSFER_SECRET } : {})}; if (!internal.mcpToken) { try { internal.mcpToken=fs.readFileSync(".agent-home/mcp-main-token","utf8").trim(); } catch {} } const plugins={allowedActions:c.plugins?.allowedActions || [],...(c.plugins?.allowedPermissions !== undefined ? { allowedPermissions:c.plugins.allowedPermissions } : {}),...(c.plugins?.guestAllowedActions !== undefined ? { guestAllowedActions:c.plugins.guestAllowedActions } : {}),...(c.plugins?.guestAllowedPermissions !== undefined ? { guestAllowedPermissions:c.plugins.guestAllowedPermissions } : {})}; const payload={format:"agent-home-bootstrap",version:1,instanceId:c.instanceId,...(configuredOwner ? { owner } : {}),plugins,...(Object.keys(internal).length ? { internal } : {}),snowluma:{endpoint:process.env.SNOWLUMA_AGENT_ENDPOINT || c.snowluma.endpoint,apiEndpoint:process.env.SNOWLUMA_AGENT_API_ENDPOINT || c.snowluma.apiEndpoint,reverseWebSocketPath:c.snowluma.reverseWebSocketPath || "/onebot/v11/ws",...(credential ? { credential } : {}),...(websocketCredential ? { websocketCredential } : {})}}; process.stdout.write(JSON.stringify(payload));' | "$PODMAN" exec -i "$CONTAINER" agent-home bootstrap --stdin
    initialized=true
  else
    printf '%s\n' 'container is running; configure config/owner.json and SnowLuma endpoint, then rerun init-container.sh' >&2
  fi
else
  printf '%s\n' 'container is running; provide AGENT_HOME_BOOTSTRAP_FILE or config/agent-home.json to initialize it' >&2
fi

if [[ -f "${AGENT_HOME_CONFIG:-$ROOT_DIR/config/agent-home.json}" ]]; then
  CONFIG_PATH="${AGENT_HOME_CONFIG:-$ROOT_DIR/config/agent-home.json}"
  [[ "$CONFIG_PATH" == /* ]] || CONFIG_PATH="$ROOT_DIR/$CONFIG_PATH"
  deployment_config="$(CONFIG_PATH="$CONFIG_PATH" node --input-type=module -e 'import fs from "node:fs"; const c=JSON.parse(fs.readFileSync(process.env.CONFIG_PATH,"utf8")); const {piProvider:_legacyProvider,piModel:_legacyModel,...runtime}=c.runtime||{}; process.stdout.write(JSON.stringify({ runtime, agent: c.agent || { persona: "" } }));')"
  DEPLOYMENT_CONFIG="$deployment_config" "$PODMAN" exec "$CONTAINER" env DEPLOYMENT_CONFIG="$deployment_config" node --input-type=module -e 'import fs from "node:fs"; const path="/state/config/bootstrap.json"; const value=JSON.parse(fs.readFileSync(path,"utf8")); const deployment=JSON.parse(process.env.DEPLOYMENT_CONFIG); value.runtime=deployment.runtime; value.agent=deployment.agent; fs.writeFileSync(path, JSON.stringify(value)+"\n", { mode: 0o600 }); fs.chmodSync(path, 0o600);'
fi

if [[ "$initialized" == true && "${AGENT_HOME_REBOOTSTRAP:-0}" == 1 ]]; then
  "$PODMAN" restart "$CONTAINER" >/dev/null
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
