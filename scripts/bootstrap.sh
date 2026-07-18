#!/usr/bin/env bash
# One-shot bootstrap: clone (or update) mox, then run scripts/install.sh
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/sophiezel/mox/main/scripts/bootstrap.sh | bash
#   INSTALL_DIR=/tmp/mox bash scripts/bootstrap.sh
set -euo pipefail

REPO_HTTPS="${MOX_REPO:-https://github.com/sophiezel/mox.git}"
BRANCH="${MOX_BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/mox}"

echo "[mox] bootstrap → $INSTALL_DIR (branch=$BRANCH)"

if ! command -v git >/dev/null 2>&1; then
  echo "[mox] git is required" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "[mox] Node >= 18 is required" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "[mox] npm is required" >&2
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  echo "[mox] Node >= 18 required (found $(node -v 2>/dev/null || echo none))" >&2
  exit 1
fi

if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "[mox] existing clone, updating…"
  git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH" || true
elif [[ -e "$INSTALL_DIR" ]]; then
  echo "[mox] $INSTALL_DIR exists but is not a git repo; set INSTALL_DIR to an empty path" >&2
  exit 1
else
  echo "[mox] cloning $REPO_HTTPS …"
  git clone --depth 1 -b "$BRANCH" "$REPO_HTTPS" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
bash scripts/install.sh
