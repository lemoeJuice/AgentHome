#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib.sh"

CONTAINER="$AGENT_HOME_CONTAINER"
PI_COMMAND="${PI_COMMAND:-pi}"
CONFIG_PATH="${AGENT_HOME_CONFIG:-$ROOT_DIR/config.json}"
[[ "$CONFIG_PATH" == /* ]] || CONFIG_PATH="$ROOT_DIR/$CONFIG_PATH"
PI_AGENT_DIR="$(CONFIG_PATH="$CONFIG_PATH" node --input-type=module -e 'import fs from "node:fs";let d="/state/model/pi/agent";try{d=JSON.parse(fs.readFileSync(process.env.CONFIG_PATH,"utf8")).runtime?.piAgentDir||d}catch{}if(d==="/state/home/.pi/agent")d="/state/model/pi/agent";process.stdout.write(d)')"
if [[ "$("$PODMAN_COMMAND" container inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)" != true ]]; then
  printf 'Agent Home container is not running: %s\n' "$CONTAINER" >&2
  exit 2
fi
if ! "$PODMAN_COMMAND" exec "$CONTAINER" "$PI_COMMAND" --version >/dev/null 2>&1; then
  printf '%s\n' 'Pi is not installed; provider onboarding is skipped. Run scripts/install-pi.sh first.' >&2
  exit 0
fi

read_pi_settings() {
  "$PODMAN_COMMAND" exec --env "PI_CODING_AGENT_DIR=$PI_AGENT_DIR" "$CONTAINER" node --input-type=module -e 'import fs from "node:fs";try{const dir=process.env.PI_CODING_AGENT_DIR||"/state/model/pi/agent";const s=JSON.parse(fs.readFileSync(`${dir}/settings.json`,"utf8"));process.stdout.write(`${s.defaultProvider||""}\t${s.defaultModel||""}`)}catch{}'
}

provider_auth_ready() {
  local provider="$1" output
  [[ -n "$provider" ]] || return 1
  output="$("$PODMAN_COMMAND" exec --user 10002:10002 --env HOME=/state/model/home --env "PI_CODING_AGENT_DIR=$PI_AGENT_DIR" "$CONTAINER" "$PI_COMMAND" auth check --provider "$provider" --json --no-refresh 2>/dev/null || true)"
  OUTPUT="$output" node --input-type=module -e 'try{if(JSON.parse(process.env.OUTPUT).status==="ready")process.exit(0)}catch{}process.exit(1)'
}

settings="$(read_pi_settings)"
IFS=$'\t' read -r provider model <<<"$settings"
if [[ -z "$provider" || -z "$model" ]]; then
  printf '%s\n' 'Pi has no default provider/model saved in its own settings.'
  if [[ ! -t 0 ]]; then
    printf '%s\n' 'Non-interactive startup skips Pi onboarding; run scripts/pi-provider-onboarding.sh in a terminal later.'
    exit 0
  fi
  printf '%s\n' '  1) Open Pi’s built-in model/provider selector'
  printf '%s\n' '  2) Skip for now'
  read -r -p 'Choose [2]: ' choice
  case "${choice:-2}" in
    1|c|C|y|Y)
      printf '%s\n' 'In Pi, use /model or Ctrl+P to select from Pi’s provider/model catalog. Run /login to authenticate, then exit Pi.'
      "$PODMAN_COMMAND" exec -it --user 10002:10002 --env HOME=/state/model/home --env "PI_CODING_AGENT_DIR=$PI_AGENT_DIR" "$CONTAINER" "$PI_COMMAND"
      settings="$(read_pi_settings)"
      IFS=$'\t' read -r provider model <<<"$settings"
      ;;
    2|s|S|n|N|q|Q)
      printf '%s\n' 'Pi provider/model onboarding skipped.'
      exit 0
      ;;
    *) printf '%s\n' 'Invalid selection; skipping Pi onboarding.' >&2; exit 0 ;;
  esac
fi

if [[ -z "$provider" || -z "$model" ]]; then
  printf '%s\n' 'Pi still has no default provider/model; continuing without Pi onboarding.' >&2
  exit 0
fi

printf 'Pi provider/model from Pi settings: %s / %s\n' "$provider" "$model"
if provider_auth_ready "$provider"; then
  printf 'Pi provider %s is authenticated.\n' "$provider"
  exit 0
fi

printf 'Pi provider %s does not have ready credentials.\n' "$provider"
if [[ ! -t 0 ]]; then
  printf '%s\n' 'Non-interactive startup skips authentication; run scripts/pi-login.sh in a terminal later.'
  exit 0
fi
printf '%s\n' '  1) Run Pi’s provider authentication flow now'
printf '%s\n' '  2) Skip for now'
read -r -p 'Choose [2]: ' auth_choice
case "${auth_choice:-2}" in
  1|l|L|y|Y)
    bash "$ROOT_DIR/scripts/pi-login.sh"
    if provider_auth_ready "$provider"; then printf 'Pi provider %s authentication is ready.\n' "$provider"; else printf 'Pi provider %s is still unauthenticated; you can run scripts/pi-login.sh later.\n' "$provider" >&2; fi
    ;;
  2|s|S|n|N|q|Q)
    printf '%s\n' 'Pi authentication skipped; run scripts/pi-login.sh later.'
    ;;
  *) printf '%s\n' 'Invalid selection; skipping Pi authentication.' >&2 ;;
esac
