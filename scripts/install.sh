#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "[mox] install root=$ROOT"

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  echo "[mox] Node >= 18 required (found $(node -v 2>/dev/null || echo none))"
  exit 1
fi

npm install

# Sanity: materialize path depends on json-schema-faker
node -e "require('json-schema-faker'); require('./lib/infer/shape-json-schema'); require('./lib/materialize');" \
  || { echo "[mox] dependency check failed"; exit 1; }

echo "[mox] npm link..."
npm link

SKILL_LINK="${HOME}/.agents/skills/mox"
mkdir -p "${HOME}/.agents/skills"
ln -sfn "$ROOT" "$SKILL_LINK"
echo "[mox] skill symlink (optional Agent orchestration): $SKILL_LINK -> $ROOT"

echo ""
echo "[mox] done. Primary track (0 backend dependency):"
echo "  mox --help"
echo "  cd <your-frontend-project> && mox init --name=<slug>"
echo "  mox start --name=<slug>          # does not auto-open Chrome"
echo "  mox start --name=<slug> --open   # or later: mox open"
echo "  mox scenario e2e-happy   # or e2e-fault / e2e-slow"
echo "  mox smoke --ci"
echo "  mox quality-gate         # exit 0 = 可提测（零溢出口径）"
echo "  mox gc [--dry-run]       # prune captures / logs / chrome-profiles"
echo "  mox stop --name=<slug>"
echo ""
echo "Selective mock (Whistle-like rules/*.json or *.txt):"
echo "  mox rules use <pack>                  # sticky .data/rules-active"
echo "  mox start --rules=<pack>              # or --rules=a,b (missing names skipped)"
echo "  mox map import ./whistle-map.txt      # one-shot import"
echo ""
echo "Optional fidelity upgrade (needs real upstream; not for E2E):"
echo "  mox start --name=<slug> --capture-open"
echo "  mox stop --auto-merge --name=<slug>"
echo ""

if command -v mox >/dev/null; then
  mox --help | head -n 30
else
  echo "  (mox not on PATH yet — use: node $ROOT/bin/mox.js)"
fi
