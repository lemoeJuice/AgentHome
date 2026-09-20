#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

command -v node >/dev/null || { printf '%s\n' 'missing dependency: node >= 22.5' >&2; exit 2; }
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 5)) process.exit(1)' || { printf '%s\n' 'node >= 22.5 is required' >&2; exit 2; }
command -v npm >/dev/null || { printf '%s\n' 'missing dependency: npm' >&2; exit 2; }
command -v podman >/dev/null || { printf '%s\n' 'missing dependency: rootless podman' >&2; exit 2; }
podman info --format '{{.Host.Security.Rootless}}' | grep -q true || { printf '%s\n' 'podman is not running rootless' >&2; exit 2; }

mkdir -p config runtime-state/plugin-data backups
if [[ ! -e config/agent-home.json ]]; then cp config.example.json config/agent-home.json; chmod 600 config/agent-home.json; printf '%s\n' 'created config/agent-home.json; set owner.userId and SnowLuma endpoints before starting' >&2; fi

npm install
npm run build
podman volume inspect "${AGENT_HOME_VOLUME:-agent-home-default-state}" >/dev/null 2>&1 || podman volume create "${AGENT_HOME_VOLUME:-agent-home-default-state}" >/dev/null
podman build --tag "${AGENT_HOME_IMAGE:-agent-home:latest}" --file Containerfile .
npm run doctor || true
printf '%s\n' 'setup complete; configure credentials and run scripts/start.sh'
