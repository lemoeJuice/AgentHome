#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/lib.sh"

# Make direct setup-podman.sh invocations self-sufficient as well as the full setup flow.
"$ROOT_DIR/scripts/setup-podman-portable.sh"
source "$ROOT_DIR/scripts/lib.sh"

PODMAN="$PODMAN_COMMAND"
IMAGE="$AGENT_HOME_IMAGE"
BASE_IMAGE="$AGENT_HOME_BASE_IMAGE"
VOLUME="$AGENT_HOME_VOLUME"
NETWORK="$AGENT_HOME_NETWORK"

command -v "$PODMAN" >/dev/null || { printf '%s\n' "missing dependency: $PODMAN" >&2; exit 2; }
"$PODMAN" info --format '{{.Host.Security.Rootless}}' | while IFS= read -r rootless; do
  [[ "$rootless" == true ]] || { printf '%s\n' 'Podman must run rootless' >&2; exit 2; }
done

if ! "$PODMAN" network inspect "$NETWORK" >/dev/null 2>&1; then
  "$PODMAN" network create "$NETWORK" >/dev/null
fi
if ! "$PODMAN" volume inspect "$VOLUME" >/dev/null 2>&1; then
  "$PODMAN" volume create "$VOLUME" >/dev/null
fi

if [[ "${AGENT_HOME_REBUILD_IMAGE:-0}" != 1 ]] && "$PODMAN" image exists "$IMAGE"; then
  printf 'reusing existing Agent Home image %s (set AGENT_HOME_REBUILD_IMAGE=1 to rebuild)\n' "$IMAGE"
else
  printf 'pulling Agent Home base image %s\n' "$BASE_IMAGE"
  "$PODMAN" pull --policy missing "$BASE_IMAGE"

build_without_overlay_context() (
  set -euo pipefail
  local build_container="${AGENT_HOME_CONTAINER}-build-$$"
  trap '"$PODMAN" rm -f "$build_container" >/dev/null 2>&1 || true' EXIT

  printf '%s\n' 'building Agent Home image without Buildah overlay context'
  "$PODMAN" rm -f "$build_container" >/dev/null 2>&1 || true
  "$PODMAN" create --name "$build_container" "$BASE_IMAGE" sleep infinity >/dev/null
  "$PODMAN" start "$build_container" >/dev/null
  "$PODMAN" exec "$build_container" apt-get update
  "$PODMAN" exec "$build_container" apt-get install -y --no-install-recommends bubblewrap ca-certificates git python3 make g++
  "$PODMAN" exec "$build_container" rm -rf /var/lib/apt/lists/*
  "$PODMAN" exec "$build_container" mkdir -p /app
  "$PODMAN" cp package.json "$build_container:/app/package.json"
  if [[ -f package-lock.json ]]; then "$PODMAN" cp package-lock.json "$build_container:/app/package-lock.json"; fi
  "$PODMAN" cp tsconfig.json "$build_container:/app/tsconfig.json"
  "$PODMAN" cp src "$build_container:/app/src"
  "$PODMAN" exec --workdir /app "$build_container" sh -c 'if [ -f package-lock.json ]; then npm ci; else npm install; fi'
  "$PODMAN" exec --workdir /app "$build_container" npm run build
  "$PODMAN" exec "$build_container" sh -c 'useradd --create-home --uid 10001 agent && mkdir -p /state /cache /scratch /run/agent-home && chown -R agent:agent /app /state /cache /scratch /run/agent-home'
  "$PODMAN" exec "$build_container" sh -c "printf '%s\\n' '#!/bin/sh' 'exec node /app/dist/cli.js \"\$@\"' > /usr/local/bin/agent-home && chmod 755 /usr/local/bin/agent-home"
  "$PODMAN" commit --pause=false \
    --change 'USER agent' \
    --change 'ENV HOME=/state/home' \
    --change 'ENV PATH=/state/pi/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' \
    --change 'ENV XDG_CONFIG_HOME=/state/home/.config' \
    --change 'ENV XDG_DATA_HOME=/state/home/.local/share' \
    --change 'ENV XDG_STATE_HOME=/state/home/.local/state' \
    --change 'ENV XDG_CACHE_HOME=/cache' \
    --change 'ENV TMPDIR=/scratch/tmp' \
    --change 'ENV AGENT_HOME_STATE=/state' \
    --change 'WORKDIR /app' \
    --change 'ENTRYPOINT ["node", "dist/cli.js"]' \
    --change 'CMD ["supervise"]' \
    "$build_container" "$IMAGE" >/dev/null
)

if [[ "$(stat -f -c '%T' "$ROOT_DIR" 2>/dev/null || true)" == btrfs ]] && ! command -v fuse-overlayfs >/dev/null 2>&1; then
  build_without_overlay_context
else
    "$PODMAN" build --build-arg "BASE_IMAGE=$BASE_IMAGE" --tag "$IMAGE" --file Containerfile .
  fi
fi
printf 'Podman ready: image=%s network=%s volume=%s\n' "$IMAGE" "$NETWORK" "$VOLUME"
