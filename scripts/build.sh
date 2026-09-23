#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/lib.sh"
if command -v pnpm >/dev/null; then pnpm run build; else npm run build; fi
PODMAN="$PODMAN_COMMAND"
BASE_IMAGE="$AGENT_HOME_BASE_IMAGE"
"$PODMAN" pull "$BASE_IMAGE"
"$PODMAN" build --build-arg "BASE_IMAGE=$BASE_IMAGE" --tag "$AGENT_HOME_IMAGE" --file Containerfile .
