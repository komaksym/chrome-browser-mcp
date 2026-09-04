#!/usr/bin/env bash
set -euo pipefail

TUNNEL_ID="${1:-}"
PROFILE="${LIVE_CHATGPT_TUNNEL_PROFILE:-chrome-browser-mcp-live-smoke}"
PORT="${LIVE_CHATGPT_MCP_PORT:-2191}"

if [[ ! "$TUNNEL_ID" =~ ^tunnel_[0-9a-f]{32}$ ]]; then
  echo "Usage: $0 tunnel_<32 lowercase hex characters>" >&2
  exit 2
fi
if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1024 || PORT > 65535 )); then
  echo "LIVE_CHATGPT_MCP_PORT must be an integer between 1024 and 65535." >&2
  exit 2
fi
if (( PORT == 2091 )); then
  echo "LIVE_CHATGPT_MCP_PORT must not reuse the normal Chrome MCP port 2091." >&2
  exit 2
fi
if [[ "$PROFILE" == "chrome-browser-mcp" ]]; then
  echo "LIVE_CHATGPT_TUNNEL_PROFILE must not reuse the normal chrome-browser-mcp profile." >&2
  exit 2
fi
if ! command -v tunnel-client >/dev/null 2>&1; then
  echo "tunnel-client is not installed or not on PATH." >&2
  exit 2
fi

tunnel-client init \
  --sample sample_mcp_remote_no_auth \
  --profile "$PROFILE" \
  --tunnel-id "$TUNNEL_ID" \
  --mcp-server-url "http://127.0.0.1:${PORT}/mcp"

cat <<NEXT
Dedicated live-smoke tunnel profile created:
  profile: $PROFILE
  target:  http://127.0.0.1:${PORT}/mcp

Do not put CONTROL_PLANE_API_KEY in repository files. Export it only in the shell that runs the live smoke preflight.
NEXT
