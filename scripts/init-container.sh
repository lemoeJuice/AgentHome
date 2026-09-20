#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PODMAN="${PODMAN_COMMAND:-podman}"
CONTAINER="${AGENT_HOME_CONTAINER:-agent-home-default}"
IMAGE="${AGENT_HOME_IMAGE:-agent-home:latest}"
VOLUME="${AGENT_HOME_VOLUME:-agent-home-default-state}"
BOOTSTRAP_FILE="${AGENT_HOME_BOOTSTRAP_FILE:-}"
initialized=false

command -v "$PODMAN" >/dev/null || { printf '%s\n' "missing dependency: $PODMAN" >&2; exit 2; }
"$PODMAN" volume inspect "$VOLUME" >/dev/null 2>&1 || "$PODMAN" volume create "$VOLUME" >/dev/null

if ! "$PODMAN" inspect "$CONTAINER" >/dev/null 2>&1; then
  "$PODMAN" run -d --name "$CONTAINER" --volume "${VOLUME}:/state:Z,U" --network slirp4netns "$IMAGE" hold >/dev/null
elif [[ "$("$PODMAN" inspect -f '{{.State.Running}}' "$CONTAINER")" != true ]]; then
  "$PODMAN" start "$CONTAINER" >/dev/null
fi

if [[ -n "$BOOTSTRAP_FILE" ]]; then
  [[ -r "$BOOTSTRAP_FILE" ]] || { printf '%s\n' "bootstrap file is not readable: $BOOTSTRAP_FILE" >&2; exit 2; }
  "$PODMAN" exec -i "$CONTAINER" agent-home bootstrap --stdin <"$BOOTSTRAP_FILE"
  initialized=true
elif [[ -f "${AGENT_HOME_CONFIG:-$ROOT_DIR/config/agent-home.json}" ]]; then
  CONFIG_PATH="${AGENT_HOME_CONFIG:-$ROOT_DIR/config/agent-home.json}"
  if CONFIG_PATH="$CONFIG_PATH" node --input-type=module -e 'import fs from "node:fs"; const c=JSON.parse(fs.readFileSync(process.env.CONFIG_PATH,"utf8")); if (!c.owner?.userId || c.owner.userId.startsWith("REPLACE_") || !c.snowluma?.endpoint) process.exit(1);'; then
    CONFIG_PATH="$CONFIG_PATH" node --input-type=module -e 'import fs from "node:fs"; const c=JSON.parse(fs.readFileSync(process.env.CONFIG_PATH,"utf8")); const tokenName=c.snowluma.accessTokenEnv ?? "SNOWLUMA_ACCESS_TOKEN"; const payload={format:"agent-home-bootstrap",version:1,instanceId:c.instanceId,owner:{platform:c.owner.platform,accountId:c.owner.accountId,userId:c.owner.userId},snowluma:{endpoint:c.snowluma.endpoint,apiEndpoint:c.snowluma.apiEndpoint,credential:process.env[tokenName]}}; process.stdout.write(JSON.stringify(payload));' | "$PODMAN" exec -i "$CONTAINER" agent-home bootstrap --stdin
    initialized=true
  else
    printf '%s\n' 'container is running; configure owner.userId and SnowLuma endpoint, then rerun init-container.sh' >&2
  fi
else
  printf '%s\n' 'container is running; provide AGENT_HOME_BOOTSTRAP_FILE or config/agent-home.json to initialize it' >&2
fi

if "$PODMAN" exec "$CONTAINER" agent-home control ping >/dev/null 2>&1; then
  exit 0
fi
if [[ "$initialized" != true ]]; then
  exit 0
fi
if ! "$PODMAN" exec "$CONTAINER" agent-home control ping >/dev/null 2>&1; then
  "$PODMAN" exec -d "$CONTAINER" agent-home runtime >/dev/null
  for _ in {1..30}; do
    "$PODMAN" exec "$CONTAINER" agent-home control ping >/dev/null 2>&1 && exit 0
    sleep 0.2
  done
  printf '%s\n' 'runtime did not become ready' >&2
  exit 1
fi
