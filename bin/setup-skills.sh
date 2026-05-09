#!/usr/bin/env bash
# Clone or update the microsoft/azure-skills repo, then symlink it into this repo.
# Single source of truth at $SKILLS_HOME — no vendoring, no drift.
#
# Usage:
#   bin/setup-skills.sh
#
# Re-run any time to pull latest skills.

set -euo pipefail

SKILLS_HOME="${SKILLS_HOME:-$HOME/.local/share/azure-skills}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -d "$SKILLS_HOME/.git" ]; then
  echo "→ updating $SKILLS_HOME"
  git -C "$SKILLS_HOME" pull --ff-only
else
  echo "→ cloning microsoft/azure-skills to $SKILLS_HOME"
  mkdir -p "$(dirname "$SKILLS_HOME")"
  git clone --depth 1 https://github.com/microsoft/azure-skills.git "$SKILLS_HOME"
fi

mkdir -p "$REPO_ROOT/.copilot/skills"
ln -sfn "$SKILLS_HOME/skills" "$REPO_ROOT/.copilot/skills/azure"

echo "✅ azure-skills linked:"
echo "   $REPO_ROOT/.copilot/skills/azure -> $(readlink "$REPO_ROOT/.copilot/skills/azure")"
echo "   $(ls "$REPO_ROOT/.copilot/skills/azure" | wc -l | tr -d ' ') skills available"
