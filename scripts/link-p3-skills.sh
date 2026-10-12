#!/usr/bin/env bash
# Link every p3-stack skill from the .agents/vendor/p3-stack submodule into
# .agents/skills (Codex and other agents) and .claude/skills (Claude Code).
# Run after `git submodule update --remote .agents/vendor/p3-stack` and commit
# the result. Links of skills removed upstream are deleted; project skills,
# which are not links into the submodule, are left alone.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
git submodule update --init .agents/vendor/p3-stack
mkdir -p .agents/skills .claude/skills

for link in .agents/skills/* .claude/skills/*; do
  if [[ -L "$link" && ! -e "$link" ]]; then
    rm "$link"
  fi
done

for skill in .agents/vendor/p3-stack/skills/*/; do
  name="$(basename "$skill")"
  if [[ -e .agents/skills/$name && ! -L .agents/skills/$name ]]; then
    printf 'skip %s (a project skill has this name)\n' "$name"
    continue
  fi
  ln -sfn "../vendor/p3-stack/skills/$name" ".agents/skills/$name"
  ln -sfn "../../.agents/skills/$name" ".claude/skills/$name"
done
