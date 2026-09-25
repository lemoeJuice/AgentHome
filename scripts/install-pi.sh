#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib.sh"

PODMAN="$PODMAN_COMMAND"
CONTAINER="$AGENT_HOME_CONTAINER"
PI_PACKAGE="${PI_PACKAGE:-@earendil-works/pi-coding-agent}"
PI_COMMAND="${PI_COMMAND:-pi}"
PI_PREFIX="${PI_PREFIX:-/state/pi}"
PI_RECORD="/state/config/pi-install.json"

command -v "$PODMAN" >/dev/null || { printf '%s\n' "missing dependency: $PODMAN" >&2; exit 2; }
[[ "$PI_PACKAGE" =~ ^[A-Za-z0-9@_./+-]+$ ]] || { printf '%s\n' 'PI_PACKAGE contains unsupported characters' >&2; exit 2; }
[[ "$("$PODMAN" container inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)" == true ]] || { printf '%s\n' "container is not running: $CONTAINER (run scripts/init-container.sh first)" >&2; exit 2; }

# Install into the persistent state volume, not the writable container layer.
if [[ "${PI_FORCE_REINSTALL:-0}" != 1 ]] && "$PODMAN" exec "$CONTAINER" env PI_PACKAGE="$PI_PACKAGE" PI_RECORD="$PI_RECORD" PI_COMMAND="$PI_COMMAND" PI_PREFIX="$PI_PREFIX" node --input-type=module -e 'import fs from "node:fs"; try { const record=JSON.parse(fs.readFileSync(process.env.PI_RECORD, "utf8")); if (record.package === process.env.PI_PACKAGE && record.command === process.env.PI_COMMAND && record.prefix === process.env.PI_PREFIX) { const { execFileSync }=await import("node:child_process"); const version=execFileSync(process.env.PI_COMMAND, ["--version"], { env: { ...process.env, PATH: `${process.env.PI_PREFIX}/bin:/usr/local/bin:/usr/bin:/bin` }, encoding: "utf8" }).trim(); if (version === record.version) process.exit(0); } } catch {} process.exit(1)' ; then
  printf '%s\n' 'Pi is already installed in the persistent state volume.'
  exit 0
fi
"$PODMAN" exec --user 0 "$CONTAINER" env NPM_CONFIG_PREFIX="$PI_PREFIX" npm install --global "$PI_PACKAGE"
PI_VERSION="$($PODMAN exec "$CONTAINER" env PATH="$PI_PREFIX/bin:/usr/local/bin:/usr/bin:/bin" "$PI_COMMAND" --version)"
"$PODMAN" exec --user 0 "$CONTAINER" env PI_PACKAGE="$PI_PACKAGE" PI_VERSION="$PI_VERSION" PI_COMMAND="$PI_COMMAND" PI_PREFIX="$PI_PREFIX" node --input-type=module -e 'import fs from "node:fs"; const path="/state/config/pi-install.json"; fs.mkdirSync("/state/config", { recursive: true, mode: 0o700 }); fs.writeFileSync(path, JSON.stringify({ package: process.env.PI_PACKAGE, version: process.env.PI_VERSION, command: process.env.PI_COMMAND, prefix: process.env.PI_PREFIX, installedAt: new Date().toISOString() }, null, 2)+"\n", { mode: 0o600 }); fs.chmodSync(path, 0o600);'
PI_UID="$($PODMAN exec "$CONTAINER" id -u)"
PI_GID="$($PODMAN exec "$CONTAINER" id -g)"
"$PODMAN" exec --user 0 "$CONTAINER" chown "$PI_UID:$PI_GID" "$PI_RECORD"
printf '%s\n' "Pi installed in persistent state: $PI_VERSION"
printf '%s\n' 'Run scripts/pi-login.sh and /login after deployment to authenticate the selected Pi provider.' >&2
