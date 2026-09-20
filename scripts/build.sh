#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
if command -v pnpm >/dev/null; then pnpm run build; else npm run build; fi
PODMAN="${PODMAN_COMMAND:-podman}"
"$PODMAN" build --tag "${AGENT_HOME_IMAGE:-agent-home:latest}" --file Containerfile .
