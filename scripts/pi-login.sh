#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/lib.sh"

PI_COMMAND="${PI_COMMAND:-pi}"
PI_PROVIDER="${PI_PROVIDER:-openai-codex}"
if [[ "$("$PODMAN_COMMAND" container inspect -f '{{.State.Running}}' "$AGENT_HOME_CONTAINER" 2>/dev/null || true)" != true ]]; then
  printf '%s\n' "Agent Home container is not running: $AGENT_HOME_CONTAINER" >&2
  exit 1
fi

printf '%s\n' "Starting native Pi login inside $AGENT_HOME_CONTAINER." >&2
printf '%s\n' "In Pi, run /login and choose openai-codex. Credentials stay in the named /state volume." >&2
exec "$PODMAN_COMMAND" exec -it "$AGENT_HOME_CONTAINER" "$PI_COMMAND" --provider "$PI_PROVIDER" "$@"
