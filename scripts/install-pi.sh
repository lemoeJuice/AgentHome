#!/usr/bin/env bash
set -euo pipefail

PODMAN="${PODMAN_COMMAND:-podman}"
CONTAINER="${AGENT_HOME_CONTAINER:-agent-home-default}"
PI_PACKAGE="${PI_PACKAGE:-@earendil-works/pi-coding-agent}"
PI_COMMAND="${PI_COMMAND:-pi}"

command -v "$PODMAN" >/dev/null || { printf '%s\n' "missing dependency: $PODMAN" >&2; exit 2; }
[[ "$PI_PACKAGE" =~ ^[A-Za-z0-9@_./+-]+$ ]] || { printf '%s\n' 'PI_PACKAGE contains unsupported characters' >&2; exit 2; }
[[ "$("$PODMAN" inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)" == true ]] || { printf '%s\n' "container is not running: $CONTAINER (run scripts/init-container.sh first)" >&2; exit 2; }

# Install as the container image root so the binary is available to the runtime user.
"$PODMAN" exec --user 0 "$CONTAINER" npm install --global --ignore-scripts "$PI_PACKAGE"
"$PODMAN" exec "$CONTAINER" "$PI_COMMAND" --version
