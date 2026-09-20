#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
if command -v pnpm >/dev/null; then pnpm run --silent doctor; else npm run --silent doctor; fi
