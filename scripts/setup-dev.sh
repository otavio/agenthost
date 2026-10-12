#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

pnpm install --frozen-lockfile

if [[ ! -e worker/.dev.vars ]]; then
  cp worker/.dev.vars.example worker/.dev.vars
fi
