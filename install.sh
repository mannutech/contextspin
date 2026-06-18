#!/usr/bin/env bash
# ContextSpin one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/mannutech/contextspin/main/install.sh | bash
#
# Wires a SessionStart hook into ~/.claude/settings.json (so ContextSpin
# self-heals every session) and sets up the config, statusline, and daemon.
# Non-destructive: any existing statusline is composed, not replaced.
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "ContextSpin needs Node.js 18+ — install it from https://nodejs.org and re-run." >&2
  exit 1
fi

MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${MAJOR}" -lt 18 ]; then
  echo "ContextSpin needs Node.js 18+, but found $(node -v). Please upgrade." >&2
  exit 1
fi

echo "Installing ContextSpin…"
# Run from a neutral dir so npx never resolves a confused local package.
cd /tmp
npx --yes contextspin@latest install
