#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/lib.sh"

CONTAINER="$AGENT_HOME_CONTAINER"
TEST_PATH="/tmp/guest-isolation.integration.mjs"
[[ "$("$PODMAN_COMMAND" container inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)" == true ]] || { printf 'Agent Home container is not running: %s\n' "$CONTAINER" >&2; exit 2; }
"$PODMAN_COMMAND" cp "$ROOT_DIR/test/guest-isolation.integration.mjs" "$CONTAINER:$TEST_PATH"
cleanup() { "$PODMAN_COMMAND" exec --user 0 "$CONTAINER" rm -f "$TEST_PATH" >/dev/null 2>&1 || true; }
trap cleanup EXIT
"$PODMAN_COMMAND" exec --user 0 "$CONTAINER" node "$TEST_PATH"
