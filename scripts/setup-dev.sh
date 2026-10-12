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

# deploy.env is git-ignored, so a new worktree starts without it. Copy the main
# checkout's file, which holds this operator's deploy target.
main="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
if [[ ! -e deploy.env && -e "$main/deploy.env" && "$main" != "$ROOT" ]]; then
  cp "$main/deploy.env" deploy.env
fi
