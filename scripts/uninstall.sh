#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "[mox] uninstall"

npm unlink -g mox 2>/dev/null || true
npm unlink 2>/dev/null || true

SKILL_LINK="${HOME}/.agents/skills/mox"
if [[ -L "$SKILL_LINK" ]]; then
  rm -f "$SKILL_LINK"
  echo "[mox] removed symlink $SKILL_LINK"
fi

echo "[mox] uninstall done (data under .data/ kept)"
