#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/lib.sh"

PI_COMMAND="${PI_COMMAND:-pi}"
CONFIG_PATH="${AGENT_HOME_CONFIG:-$ROOT_DIR/config/agent-home.json}"
[[ "$CONFIG_PATH" == /* ]] || CONFIG_PATH="$ROOT_DIR/$CONFIG_PATH"
PI_AGENT_DIR="$(CONFIG_PATH="$CONFIG_PATH" node --input-type=module -e 'import fs from "node:fs";try{const c=JSON.parse(fs.readFileSync(process.env.CONFIG_PATH,"utf8"));process.stdout.write(c.runtime?.piAgentDir||"/state/home/.pi/agent")}catch{process.stdout.write("/state/home/.pi/agent")}')"
if [[ "$("$PODMAN_COMMAND" container inspect -f '{{.State.Running}}' "$AGENT_HOME_CONTAINER" 2>/dev/null || true)" != true ]]; then
  printf '%s\n' "Agent Home container is not running: $AGENT_HOME_CONTAINER" >&2
  exit 1
fi
PI_PROVIDER="$("$PODMAN_COMMAND" exec --env "PI_CODING_AGENT_DIR=$PI_AGENT_DIR" "$AGENT_HOME_CONTAINER" node --input-type=module -e 'import fs from "node:fs";try{const dir=process.env.PI_CODING_AGENT_DIR||"/state/home/.pi/agent";const settings=JSON.parse(fs.readFileSync(`${dir}/settings.json`,"utf8"));process.stdout.write(settings.defaultProvider||"")}catch{}')"
if [[ -z "$PI_PROVIDER" ]]; then
  printf '%s\n' 'Pi has no selected provider yet. Run scripts/pi-provider-onboarding.sh to open Pi’s model selector first.' >&2
  exit 1
fi

printf '%s\n' "Starting native Pi login inside $AGENT_HOME_CONTAINER." >&2
printf '%s\n' "Configured provider: $PI_PROVIDER. In Pi, run /login. Pi reads and stores provider credentials in the named /state volume." >&2
exec "$PODMAN_COMMAND" exec -it --env "PI_CODING_AGENT_DIR=$PI_AGENT_DIR" "$AGENT_HOME_CONTAINER" "$PI_COMMAND" "$@"
