#!/usr/bin/env bash
set -euo pipefail

TUNNEL_ID="${1:-${CONTROL_PLANE_TUNNEL_ID:-}}"
if [[ ! "$TUNNEL_ID" =~ ^tunnel_[0-9a-f]{32}$ ]]; then
  echo "Usage: $0 tunnel_<32 lowercase hex characters>" >&2
  exit 2
fi
if ! command -v tunnel-client >/dev/null 2>&1; then
  echo "tunnel-client is not installed or not on PATH." >&2
  echo "Download the supported binary from OpenAI Platform tunnel settings." >&2
  exit 2
fi

tunnel-client init \
  --sample sample_mcp_remote_no_auth \
  --profile chrome-browser-mcp \
  --tunnel-id "$TUNNEL_ID" \
  --mcp-server-url "http://127.0.0.1:2091/mcp"

cat <<'NEXT'
Profile created. With Chrome and the extension open, run:

  export CONTROL_PLANE_API_KEY="sk-..."
  tunnel-client doctor --profile chrome-browser-mcp --explain
  tunnel-client run --profile chrome-browser-mcp
NEXT
