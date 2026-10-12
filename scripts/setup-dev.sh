#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# The p3-stack skills in .agents/skills link into this submodule.
git submodule update --init

pnpm install --frozen-lockfile

if [[ ! -e worker/.dev.vars ]]; then
  cp worker/.dev.vars.example worker/.dev.vars
fi
