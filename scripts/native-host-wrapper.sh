#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export CHROME_MCP_INSTANCE="${CHROME_MCP_INSTANCE:-chrome}"
export CHROME_MCP_LOG_LEVEL="${CHROME_MCP_LOG_LEVEL:-info}"
if [[ -z "${CHROME_MCP_LOG_FILE:-}" ]]; then
  CHROME_MCP_LOG_DIR="${CHROME_MCP_LOG_DIR:-$HOME/Library/Logs/Chrome Browser MCP}"
  export CHROME_MCP_LOG_FILE="$CHROME_MCP_LOG_DIR/chrome.jsonl"
fi
exec /usr/bin/env node "$ROOT/dist/bridge/index.js" "$@"
