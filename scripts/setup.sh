#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/lib.sh"

command -v node >/dev/null || { printf '%s\n' 'missing dependency: node >= 22.5' >&2; exit 2; }
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 5)) process.exit(1)' || { printf '%s\n' 'node >= 22.5 is required' >&2; exit 2; }
if command -v pnpm >/dev/null; then PACKAGE_MANAGER=pnpm; elif command -v npm >/dev/null; then PACKAGE_MANAGER=npm; else printf '%s\n' 'missing dependency: pnpm or npm' >&2; exit 2; fi
mkdir -p config "$AGENT_HOME_RUNTIME_DIR/plugin-data" backups
mkdir -p .agent-home
CONFIG_PATH="${AGENT_HOME_CONFIG:-$ROOT_DIR/config.json}"
if [[ "$CONFIG_PATH" != /* ]]; then CONFIG_PATH="$ROOT_DIR/$CONFIG_PATH"; fi
case "$CONFIG_PATH" in "$ROOT_DIR"/*) ;; *) printf '%s\n' 'AGENT_HOME_CONFIG must be inside the project directory' >&2; exit 2 ;; esac
mkdir -p "$(dirname "$CONFIG_PATH")"
if [[ ! -s .agent-home/control-token ]]; then
  node --input-type=module -e 'import crypto from "node:crypto"; process.stdout.write(crypto.randomBytes(32).toString("hex")+"\n")' >.agent-home/control-token
  chmod 600 .agent-home/control-token
fi
export AGENT_HOME_CONTROL_TOKEN="$(<.agent-home/control-token)"
if [[ ! -s .agent-home/artifact-transfer-secret ]]; then
  node --input-type=module -e 'import crypto from "node:crypto"; process.stdout.write(crypto.randomBytes(32).toString("hex")+"\n")' >.agent-home/artifact-transfer-secret
  chmod 600 .agent-home/artifact-transfer-secret
fi
export AGENT_ARTIFACT_TRANSFER_SECRET="$(<.agent-home/artifact-transfer-secret)"
if [[ ! -s .agent-home/gateway-artifact-transfer-secret ]]; then
  node --input-type=module -e 'import crypto from "node:crypto"; process.stdout.write(crypto.randomBytes(32).toString("hex")+"\n")' >.agent-home/gateway-artifact-transfer-secret
  chmod 600 .agent-home/gateway-artifact-transfer-secret
fi
export GATEWAY_ARTIFACT_TRANSFER_SECRET="$(<.agent-home/gateway-artifact-transfer-secret)"
if [[ ! -s .agent-home/mcp-main-token ]]; then
  node --input-type=module -e 'import crypto from "node:crypto"; process.stdout.write(crypto.randomBytes(32).toString("hex")+"\n")' >.agent-home/mcp-main-token
  chmod 600 .agent-home/mcp-main-token
fi
if [[ ! -e .agent-home/mcp-worker-bindings.json ]]; then
  printf '%s\n' '{}' >.agent-home/mcp-worker-bindings.json
  chmod 600 .agent-home/mcp-worker-bindings.json
fi
if [[ ! -s .agent-home/mcp-control-token ]]; then
  node --input-type=module -e 'import crypto from "node:crypto"; process.stdout.write(crypto.randomBytes(32).toString("hex")+"\n")' >.agent-home/mcp-control-token
  chmod 600 .agent-home/mcp-control-token
fi
export GATEWAY_MCP_TOKEN="$(<.agent-home/mcp-main-token)"
export GATEWAY_MCP_CONTROL_TOKEN="$(<.agent-home/mcp-control-token)"
if [[ ! -e "$CONFIG_PATH" ]]; then cp "$ROOT_DIR/config.example.json" "$CONFIG_PATH"; chmod 600 "$CONFIG_PATH"; printf '%s\n' "created $CONFIG_PATH; set SnowLuma endpoints before starting" >&2; fi

DEPS_FINGERPRINT="$(node --input-type=module -e 'import fs from "node:fs";import crypto from "node:crypto";const h=crypto.createHash("sha256");for(const p of ["package.json","pnpm-lock.yaml","package-lock.json"]){if(fs.existsSync(p)){h.update(p);h.update("\0");h.update(fs.readFileSync(p));h.update("\0")}}process.stdout.write(h.digest("hex"))')"
DEPS_STAMP="$ROOT_DIR/.agent-home/host-deps-lock.sha256"
if [[ "${AGENT_HOME_REFRESH_DEPS:-0}" == 1 || ! -d node_modules || ! -s "$DEPS_STAMP" || "$(<"$DEPS_STAMP")" != "$DEPS_FINGERPRINT" ]]; then
  if [[ "$PACKAGE_MANAGER" == pnpm ]]; then
    if [[ -f pnpm-lock.yaml ]]; then pnpm install --frozen-lockfile; else pnpm install; fi
  else
    npm install
  fi
  printf '%s\n' "$DEPS_FINGERPRINT" >"$DEPS_STAMP"
  chmod 600 "$DEPS_STAMP"
else
  printf '%s\n' 'reusing host dependencies (lockfile fingerprint matches; set AGENT_HOME_REFRESH_DEPS=1 to reinstall)'
fi
"$PACKAGE_MANAGER" run build
scripts/setup-podman.sh
scripts/setup-snowluma.sh
bash scripts/init-container.sh
if [[ "${AGENT_HOME_INSTALL_PI:-1}" != 0 ]]; then bash scripts/install-pi.sh; fi
bash "$ROOT_DIR/scripts/pi-provider-onboarding.sh"
doctor_log="$(mktemp "$AGENT_HOME_RUNTIME_DIR/deploy-doctor.XXXXXX")"
doctor_ok=false
if "$PACKAGE_MANAGER" run doctor >"$doctor_log" 2>&1; then
  doctor_ok=true
elif node - "$doctor_log" <<'NODE'
import fs from "node:fs";
const output = fs.readFileSync(process.argv[2], "utf8");
const start = output.lastIndexOf('{\n  "config":');
const end = output.lastIndexOf("\n}");
if (start < 0 || end < start) process.exit(1);
let report;
try { report = JSON.parse(output.slice(start, end + 2)); } catch { process.exit(1); }
const checks = Object.entries(report).filter(([, value]) => value && typeof value === "object" && "status" in value);
const qqUnavailable = report.snowluma?.status === "temporarily_unavailable";
if (!qqUnavailable || checks.length === 0 || !checks.every(([name, value]) => value.status === "healthy" || (name === "snowluma" && value.status === "temporarily_unavailable"))) process.exit(1);
NODE
then
  doctor_ok=true
  printf '%s\n' 'SnowLuma OneBot is unavailable (QQ login pending); starting Agent Home and Gateway so the printed QR can be scanned.' >&2
fi
if [[ "$doctor_ok" == true ]]; then
  cat "$doctor_log"
else
  cat "$doctor_log" >&2
  rm -f "$doctor_log"
  printf '%s\n' 'setup doctor checks failed; the deployment is not reported as healthy' >&2
  exit 1
fi
rm -f "$doctor_log"
bash "$ROOT_DIR/scripts/restart.sh"
printf '%s\n' 'setup complete; Agent Home and the host gateway are running'
