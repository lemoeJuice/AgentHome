#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/lib.sh"
CONFIG_PATH="${AGENT_HOME_CONFIG:-$ROOT_DIR/config/agent-home.json}"
if [[ "$CONFIG_PATH" != /* ]]; then CONFIG_PATH="$ROOT_DIR/$CONFIG_PATH"; fi
OWNER_CONFIG_PATH="${AGENT_HOME_OWNER_CONFIG:-$(dirname "$CONFIG_PATH")/owner.json}"
if [[ "$OWNER_CONFIG_PATH" != /* ]]; then OWNER_CONFIG_PATH="$ROOT_DIR/$OWNER_CONFIG_PATH"; fi

fail() {
  printf 'configuration error: %s\n' "$1" >&2
  exit 2
}

command -v node >/dev/null || fail 'node >= 22.5 is required'
case "$CONFIG_PATH" in "$ROOT_DIR"/*) ;; *) fail 'AGENT_HOME_CONFIG must be inside the project directory' ;; esac
case "$OWNER_CONFIG_PATH" in "$ROOT_DIR"/*) ;; *) fail 'AGENT_HOME_OWNER_CONFIG must be inside the project directory' ;; esac
if [[ ! -e "$OWNER_CONFIG_PATH" ]]; then
  mkdir -p "$(dirname "$OWNER_CONFIG_PATH")"
  cp "$ROOT_DIR/config/owner.example.json" "$OWNER_CONFIG_PATH"
  chmod 600 "$OWNER_CONFIG_PATH"
  printf 'created optional Bot Owner config template: %s\n' "$OWNER_CONFIG_PATH" >&2
fi
OWNER_CONFIG_PATH="$OWNER_CONFIG_PATH" node --input-type=module -e 'import fs from "node:fs"; const owner=JSON.parse(fs.readFileSync(process.env.OWNER_CONFIG_PATH,"utf8")); const configured=owner.userId && !owner.userId.startsWith("REPLACE_"); if (configured && (!owner.platform || !owner.accountId)) process.exit(1);' || fail "owner config is invalid: $OWNER_CONFIG_PATH"

printf '%s\n' 'Configuring rootless Podman, Agent Home, and SnowLuma endpoints...'
scripts/setup-podman-portable.sh
source "$ROOT_DIR/scripts/lib.sh"
ROOTLESS="$($PODMAN_COMMAND info --format '{{.Host.Security.Rootless}}')" || fail 'portable Podman is not usable by the current user'
[[ "$ROOTLESS" == true ]] || fail 'portable Podman must run rootless; do not run this setup through sudo'
scripts/setup.sh
printf '%s\n' 'Podman, SnowLuma, Agent Home, and the host gateway are running; scan QQ through the printed noVNC URL if it is not already logged in.'
