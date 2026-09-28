#!/usr/bin/env bash
set -euo pipefail

# The supported one-command deployment entrypoint. Lower-level scripts remain
# independently usable for maintenance, while this file owns the full lifecycle.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/lib.sh"

fail() {
  printf 'deployment error: %s\n' "$1" >&2
  exit 2
}

command -v node >/dev/null || fail 'node >= 22.5 is required'
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 5)) process.exit(1)' || fail 'node >= 22.5 is required'

CONFIG_PATH="${AGENT_HOME_CONFIG:-$ROOT_DIR/config.json}"
if [[ "$CONFIG_PATH" != /* ]]; then CONFIG_PATH="$ROOT_DIR/$CONFIG_PATH"; fi
case "$CONFIG_PATH" in "$ROOT_DIR"/*) ;; *) fail 'AGENT_HOME_CONFIG must be inside the project directory' ;; esac
export AGENT_HOME_CONFIG="$CONFIG_PATH"

if command -v pnpm >/dev/null; then PACKAGE_MANAGER=pnpm; elif command -v npm >/dev/null; then PACKAGE_MANAGER=npm; else fail 'pnpm or npm is required'; fi
mkdir -p config "$AGENT_HOME_RUNTIME_DIR/plugin-data" backups .agent-home
umask 077
exec > >(tee -a "$AGENT_HOME_RUNTIME_DIR/deploy.log") 2>&1
printf '%s\n' '== Environment and update check =='
if [[ ! -s node_modules/.modules.yaml && ! -d node_modules ]]; then
  printf '%s\n' 'host dependencies are missing; setup will install them'
else
  printf '%s\n' 'host dependencies are present; setup will reuse them unless AGENT_HOME_REFRESH_DEPS=1'
fi
if [[ "${AGENT_HOME_REBUILD_IMAGE:-0}" == 1 ]]; then
  printf '%s\n' 'Agent Home image refresh requested'
elif "$PODMAN_COMMAND" image exists "$AGENT_HOME_IMAGE" >/dev/null 2>&1; then
  printf 'Agent Home image %s is present; source fingerprint check will decide reuse vs. rebuild\n' "$AGENT_HOME_IMAGE"
else
  printf 'Agent Home image %s is absent; it will be built\n' "$AGENT_HOME_IMAGE"
fi
if [[ "${SNOWLUMA_REFRESH_IMAGE:-0}" == 1 ]]; then
  printf '%s\n' 'SnowLuma image refresh requested'
fi

printf '%s\n' '== Rootless container environment =='
bash "$ROOT_DIR/scripts/setup-podman-portable.sh"
source "$ROOT_DIR/scripts/lib.sh"
ROOTLESS="$("$PODMAN_COMMAND" info --format '{{.Host.Security.Rootless}}')" || fail 'Podman local engine is not available'
[[ "$ROOTLESS" == true ]] || fail 'Podman must be rootless; do not run deployment through sudo'

validate_migration_backup() {
  local input="$1" backup_dir missing
  if [[ -f "$input" ]]; then
    backup_dir="$(dirname "$(realpath "$input")")"
  elif [[ -d "$input" ]]; then
    backup_dir="$(realpath "$input")"
  else
    printf 'backup path does not exist: %s\n' "$input" >&2
    return 2
  fi
  if missing="$(BACKUP_DIR="$backup_dir" node --input-type=module -e '
    import fs from "node:fs";
    import path from "node:path";
    const dir=process.env.BACKUP_DIR;
    const missing=[];
    for(const file of ["manifest.json","state.tar","image.tar"])if(!fs.existsSync(path.join(dir,file)))missing.push(file);
    try {
      const m=JSON.parse(fs.readFileSync(path.join(dir,"manifest.json"),"utf8"));
      const optional=[["gatewaySqliteSha256","gateway.sqlite"],["pluginDataSha256","plugin-data.tar.gz"],["gatewayArtifactsSha256","gateway-artifacts.tar.gz"],["deploymentSecretsSha256","deployment-secrets.tar.gz"],["deploymentConfigSha256","deployment-config.json"],["snowlumaGatewayDataSha256","snowluma-gateway-data.tar"],["snowlumaClientConfigSha256","snowluma-client-config.tar"],["snowlumaClientDataSha256","snowluma-client-data.tar"]];
      for(const [hash,file] of optional)if(m[hash]&&!fs.existsSync(path.join(dir,file)))missing.push(file);
    } catch { if(fs.existsSync(path.join(dir,"manifest.json")))missing.push("manifest.json (invalid JSON)"); }
    process.stdout.write(missing.join("\n"));
    if(missing.length)process.exitCode=1;
  ')"; then
    :
  else
    printf 'migration backup is incomplete: %s\n' "$backup_dir" >&2
    [[ -z "$missing" ]] || printf '%s\n' "$missing" >&2
    printf '%s\n' 'Required: manifest.json, state.tar, image.tar, and every manifest-referenced archive.' >&2
    return 2
  fi
  printf 'Restoring Agent Home from backup directory: %s\n' "$backup_dir"
  bash "$ROOT_DIR/scripts/restore.sh" "$backup_dir"
}

if [[ -n "${AGENT_HOME_MIGRATION_BACKUP:-}" ]]; then
  validate_migration_backup "$AGENT_HOME_MIGRATION_BACKUP" || fail 'migration restore failed'
elif ! "$PODMAN_COMMAND" volume inspect "$AGENT_HOME_VOLUME" >/dev/null 2>&1; then
  printf 'Agent Home volume %s does not exist yet.\n' "$AGENT_HOME_VOLUME"
  printf '%s\n' '  1) Initialize a new Agent Home volume' '  2) Restore from an existing deployment backup'
  printf '%s\n' 'A restore needs a backup directory containing manifest.json, state.tar, image.tar, and every manifest-referenced file. Enter that directory or one of its file paths.'
  if [[ ! -t 0 ]]; then fail 'non-interactive startup needs AGENT_HOME_MIGRATION_BACKUP or an interactive volume choice'; fi
  read -r -p 'Choose [1/2]: ' volume_choice
  case "$volume_choice" in
    1|i|I) printf '%s\n' 'A new empty Agent Home volume will be initialized.' ;;
    2|m|M)
      read -r -p 'Backup directory or file path: ' migration_path
      [[ -n "$migration_path" ]] || fail 'a backup path is required for migration'
      validate_migration_backup "$migration_path" || fail 'migration restore failed'
      ;;
    *) fail 'startup cancelled before creating the Agent Home volume' ;;
  esac
else
  printf 'Reusing existing Agent Home volume %s.\n' "$AGENT_HOME_VOLUME"
fi

printf '%s\n' '== Build, configure, and start =='
bash "$ROOT_DIR/scripts/setup.sh"

printf '%s\n' '== Final QQ login step =='
bash "$ROOT_DIR/scripts/qq-login.sh"

printf '\n%s\n' '== Foreground service mode ==' 'Logs: .agent-home/runtime-state/deploy.log, gateway.log, proxy-relay.log, and run.log' 'Press Ctrl+C to stop Gateway, Agent Home, and Proxy Relay. SnowLuma remains running.'
exec "$ROOT_DIR/scripts/run.sh"
