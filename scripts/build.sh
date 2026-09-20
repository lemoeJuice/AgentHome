#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
npm run build
podman build --tag "${AGENT_HOME_IMAGE:-agent-home:latest}" --file Containerfile .
