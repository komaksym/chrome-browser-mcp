#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TUNNEL_ID="${1:-${CONTROL_PLANE_TUNNEL_ID:-}}"
INSTANCE="${2:-chrome}"
if (( $# > 2 )); then
  echo "Usage: $0 tunnel_<32 lowercase hex characters> [chrome|chrome2|chrome3]" >&2
  exit 2
fi
if [[ ! "$TUNNEL_ID" =~ ^tunnel_[0-9a-f]{32}$ ]]; then
  echo "Usage: $0 tunnel_<32 lowercase hex characters> [chrome|chrome2|chrome3]" >&2
  exit 2
fi
if ! command -v tunnel-client >/dev/null 2>&1; then
  echo "tunnel-client is not installed or not on PATH." >&2
  echo "Download the supported binary from OpenAI Platform tunnel settings." >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required to resolve the checked-in Chrome instance topology." >&2
  exit 2
fi

INSTANCE_RECORD="$(node --input-type=module - "$ROOT/scripts/instances.json" "$INSTANCE" <<'NODE'
import { readFileSync } from "node:fs";

const [, , instancesPath, requestedName] = process.argv;
const { instances } = JSON.parse(readFileSync(instancesPath, "utf8"));
const instance = instances.find(({ name }) => name === requestedName);
if (!instance) process.exit(1);
process.stdout.write([
  instance.tunnelProfile,
  instance.port,
  instance.extensionId,
  instance.runtimeKeyEnv,
].join("\t"));
NODE
)" || {
  echo "Unknown Chrome instance: $INSTANCE (expected chrome, chrome2, or chrome3)." >&2
  exit 2
}
IFS=$'\t' read -r PROFILE PORT EXTENSION_ID RUNTIME_KEY_ENV <<<"$INSTANCE_RECORD"
MCP_SERVER_URL="http://127.0.0.1:$PORT/mcp"

tunnel-client init \
  --sample sample_mcp_remote_no_auth \
  --profile "$PROFILE" \
  --tunnel-id "$TUNNEL_ID" \
  --mcp-server-url "$MCP_SERVER_URL" \
  --control-plane-api-key-ref "env:$RUNTIME_KEY_ENV"

cat <<NEXT
Profile created for Chrome instance $INSTANCE.
Target: $MCP_SERVER_URL
Expected extension: $EXTENSION_ID

With the matching Chrome profile and extension open, run:

  export $RUNTIME_KEY_ENV="sk-..."
  tunnel-client doctor --profile $PROFILE --explain
  tunnel-client run --profile $PROFILE
NEXT
