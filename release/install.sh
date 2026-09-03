#!/usr/bin/env bash
# Installs CodeGraph: the MCP server (global) and the VS Code extension.
#
#   ./install.sh --workspace /path/to/your-project
#
# Steps:
#   1. Checks Node.js >= 20.
#   2. npm install -g ./mcp  (global `codegraph-mcp`, `duckgraph-mcp`, `codegraph-setup`)
#   3. codegraph-setup --workspace <dir>  (writes the Claude Desktop entry)
#   4. Installs codegraph-*.vsix via `code --install-extension` (unless --skip-extension).
#
# Flags: --workspace <dir> (default: cwd)  --name <server>  --config-path <file>
#        --skip-mcp  --skip-extension
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="$PWD"
NAME="codegraph"
CONFIG_PATH=""
SKIP_MCP=0
SKIP_EXTENSION=0

while [ $# -gt 0 ]; do
  case "$1" in
    --workspace) WORKSPACE="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --config-path) CONFIG_PATH="$2"; shift 2 ;;
    --skip-mcp) SKIP_MCP=1; shift ;;
    --skip-extension) SKIP_EXTENSION=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

require_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js was not found on PATH. Install Node.js 20+ from https://nodejs.org, then re-run." >&2
    exit 1
  fi
  MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$MAJOR" -lt 20 ]; then
    echo "Node.js $(node --version) found, but CodeGraph needs Node.js 20+. Upgrade, then re-run." >&2
    exit 1
  fi
  echo "Node.js $(node --version) OK"
}

if [ "$SKIP_MCP" -eq 0 ]; then
  require_node
  echo "Installing CodeGraph MCP server globally..."
  npm install -g "$ROOT/mcp" --no-audit --no-fund
  SETUP_ARGS=(--workspace "$WORKSPACE" --name "$NAME")
  [ -n "$CONFIG_PATH" ] && SETUP_ARGS+=(--config-path "$CONFIG_PATH")
  if command -v codegraph-setup >/dev/null 2>&1; then
    codegraph-setup "${SETUP_ARGS[@]}"
  else
    node "$ROOT/mcp/bin/codegraph-setup.js" "${SETUP_ARGS[@]}"
  fi
  echo "MCP server installed. Restart Claude Desktop to pick it up."
fi

if [ "$SKIP_EXTENSION" -eq 0 ]; then
  shopt -s nullglob
  VSIX_FILES=("$ROOT"/codegraph-*.vsix)
  shopt -u nullglob
  if [ ${#VSIX_FILES[@]} -eq 0 ]; then
    echo "WARNING: no codegraph-*.vsix found next to install.sh; skipping extension install." >&2
  elif ! command -v code >/dev/null 2>&1; then
    VSIX="${VSIX_FILES[-1]}"
    echo "WARNING: 'code' CLI not on PATH. Install manually:" >&2
    echo "  code --install-extension $VSIX" >&2
  else
    VSIX="${VSIX_FILES[-1]}"
    echo "Installing VS Code extension $(basename "$VSIX")..."
    code --install-extension "$VSIX" --force
    echo "Extension installed."
  fi
fi

echo "Done."
