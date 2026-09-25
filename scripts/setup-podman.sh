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
proxy_exec_env_args=()
proxy_build_args=()
if [[ "$AGENT_HOME_USE_PROXY" == 1 ]]; then
  proxy_exec_env_args+=(--env "NODE_USE_ENV_PROXY=1")
  proxy_build_args+=(--build-arg "NODE_USE_ENV_PROXY=1")
  for proxy_name in HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY; do
    proxy_value=""
    case "$proxy_name" in
      HTTP_PROXY) proxy_value="$AGENT_HOME_HTTP_PROXY" ;;
      HTTPS_PROXY) proxy_value="$AGENT_HOME_HTTPS_PROXY" ;;
      ALL_PROXY) proxy_value="$AGENT_HOME_ALL_PROXY" ;;
      NO_PROXY) proxy_value="$AGENT_HOME_NO_PROXY" ;;
    esac
    [[ -n "$proxy_value" ]] || continue
    proxy_exec_env_args+=(--env "$proxy_name=$proxy_value" --env "${proxy_name,,}=$proxy_value")
    proxy_build_args+=(--build-arg "$proxy_name=$proxy_value")
  done
fi

command -v "$PODMAN" >/dev/null || { printf '%s\n' "missing dependency: $PODMAN" >&2; exit 2; }
"$PODMAN" info --format '{{.Host.Security.Rootless}}' | while IFS= read -r rootless; do
  [[ "$rootless" == true ]] || { printf '%s\n' 'Podman must run rootless' >&2; exit 2; }
done
printf 'checking base image updates: %s\n' "$BASE_IMAGE"
if ! "$PODMAN" pull --policy newer "$BASE_IMAGE"; then
  "$PODMAN" image exists "$BASE_IMAGE" || { printf 'base image is unavailable: %s\n' "$BASE_IMAGE" >&2; exit 1; }
  printf 'base image update check failed; continuing with cached %s\n' "$BASE_IMAGE" >&2
fi
BASE_IMAGE_ID="$("$PODMAN" image inspect -f '{{.Id}}' "$BASE_IMAGE")"

if ! "$PODMAN" network inspect "$NETWORK" >/dev/null 2>&1; then
  "$PODMAN" network create "$NETWORK" >/dev/null
fi
if ! "$PODMAN" volume inspect "$VOLUME" >/dev/null 2>&1; then
  "$PODMAN" volume create "$VOLUME" >/dev/null
fi

IMAGE_SOURCE_FINGERPRINT="$(node --input-type=module -e 'import fs from "node:fs";import path from "node:path";import crypto from "node:crypto";const roots=["Containerfile","package.json","pnpm-lock.yaml","tsconfig.json","src"];const files=[];const walk=(p)=>{if(!fs.existsSync(p))return;const s=fs.statSync(p);if(s.isDirectory()){for(const n of fs.readdirSync(p).sort())walk(path.join(p,n));}else files.push(p);};for(const p of roots)walk(p);const h=crypto.createHash("sha256");for(const p of files.sort()){h.update(p);h.update("\0");h.update(fs.readFileSync(p));h.update("\0");}process.stdout.write(h.digest("hex"));')"
IMAGE_SOURCE_FINGERPRINT="${IMAGE_SOURCE_FINGERPRINT}:${BASE_IMAGE_ID}"
IMAGE_SOURCE_STAMP="$ROOT_DIR/.agent-home/agent-home-image-source.sha256"
if [[ -s "$IMAGE_SOURCE_STAMP" ]]; then :
elif "$PODMAN" image exists "$IMAGE"; then
  printf 'adopting existing Agent Home image %s as the initial source baseline\n' "$IMAGE"
  printf '%s\n' "$IMAGE_SOURCE_FINGERPRINT" >"$IMAGE_SOURCE_STAMP"
  chmod 600 "$IMAGE_SOURCE_STAMP"
fi
if [[ "${AGENT_HOME_REBUILD_IMAGE:-0}" != 1 ]] && "$PODMAN" image exists "$IMAGE" && [[ -s "$IMAGE_SOURCE_STAMP" && "$(<"$IMAGE_SOURCE_STAMP")" == "$IMAGE_SOURCE_FINGERPRINT" ]]; then
  printf 'reusing up-to-date Agent Home image %s (source fingerprint matches)\n' "$IMAGE"
else
  if [[ "${AGENT_HOME_REBUILD_IMAGE:-0}" != 1 ]] && "$PODMAN" image exists "$IMAGE"; then
    printf 'Agent Home source changed since the last build; rebuilding %s\n' "$IMAGE"
  fi
build_without_overlay_context() (
  set -euo pipefail
  local build_container="${AGENT_HOME_CONTAINER}-build-$$"
  trap '"$PODMAN" rm -f "$build_container" >/dev/null 2>&1 || true' EXIT

  printf '%s\n' 'building Agent Home image without Buildah overlay context'
  "$PODMAN" rm -f "$build_container" >/dev/null 2>&1 || true
  "$PODMAN" create --name "$build_container" "$BASE_IMAGE" sleep infinity >/dev/null
  "$PODMAN" start "$build_container" >/dev/null
  "$PODMAN" exec "${proxy_exec_env_args[@]}" "$build_container" apt-get update
  "$PODMAN" exec "${proxy_exec_env_args[@]}" "$build_container" apt-get install -y --no-install-recommends bubblewrap ca-certificates git python3 make g++
  "$PODMAN" exec "$build_container" rm -rf /var/lib/apt/lists/*
  "$PODMAN" exec "$build_container" mkdir -p /app
  "$PODMAN" cp package.json "$build_container:/app/package.json"
  if [[ -f package-lock.json ]]; then "$PODMAN" cp package-lock.json "$build_container:/app/package-lock.json"; fi
  "$PODMAN" cp tsconfig.json "$build_container:/app/tsconfig.json"
  "$PODMAN" cp src "$build_container:/app/src"
  if [[ -d "$ROOT_DIR/node_modules" ]]; then
    printf '%s\n' 'using the lockfile-verified host node_modules cache for the isolated image build'
    "$PODMAN" cp "$ROOT_DIR/node_modules" "$build_container:/app/node_modules"
  else
    "$PODMAN" exec "${proxy_exec_env_args[@]}" --workdir /app "$build_container" sh -c 'if [ -f package-lock.json ]; then npm ci; else npm install; fi'
  fi
  "$PODMAN" exec "${proxy_exec_env_args[@]}" --workdir /app "$build_container" npm run build
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

  build_status=0
  if [[ "$(stat -f -c '%T' "$ROOT_DIR" 2>/dev/null || true)" == btrfs ]] && ! command -v fuse-overlayfs >/dev/null 2>&1; then
    build_without_overlay_context || build_status=$?
  else
    "$PODMAN" build --build-arg "BASE_IMAGE=$BASE_IMAGE" "${proxy_build_args[@]}" --tag "$IMAGE" --file Containerfile . || build_status=$?
  fi
  if [[ "$build_status" != 0 ]]; then
    if [[ "${AGENT_HOME_REBUILD_IMAGE:-0}" != 1 ]] && "$PODMAN" image exists "$IMAGE"; then
      printf 'Agent Home image build failed; retaining cached image %s (source fingerprint remains stale)\n' "$IMAGE" >&2
    else
      exit "$build_status"
    fi
  else
  printf '%s\n' "$IMAGE_SOURCE_FINGERPRINT" >"$IMAGE_SOURCE_STAMP"
  chmod 600 "$IMAGE_SOURCE_STAMP"
  fi
fi
printf 'Podman ready: image=%s network=%s volume=%s\n' "$IMAGE" "$NETWORK" "$VOLUME"
