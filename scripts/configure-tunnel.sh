#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TUNNEL_ID="${CONTROL_PLANE_TUNNEL_ID:-}"
INSTANCE="chrome"
FORCE=0
POSITIONAL=()
for ARG in "$@"; do
  if [[ $ARG == --force ]]; then
    FORCE=1
  else
    POSITIONAL+=("$ARG")
  fi
done
if (( ${#POSITIONAL[@]} > 2 )); then
  echo "Usage: $0 tunnel_<32 lowercase hex characters> [chrome|chrome2] [--force]" >&2
  exit 2
fi
if (( ${#POSITIONAL[@]} >= 1 )); then TUNNEL_ID="${POSITIONAL[0]}"; fi
if (( ${#POSITIONAL[@]} >= 2 )); then INSTANCE="${POSITIONAL[1]}"; fi
if [[ ! "$TUNNEL_ID" =~ ^tunnel_[0-9a-f]{32}$ ]]; then
  echo "Usage: $0 tunnel_<32 lowercase hex characters> [chrome|chrome2] [--force]" >&2
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
  instance.runtimeKeyEnv,
].join("\t"));
NODE
)" || {
  echo "Unknown Chrome instance: $INSTANCE" >&2
  exit 2
}
IFS=$'\t' read -r PROFILE PORT RUNTIME_KEY_ENV <<<"$INSTANCE_RECORD"
MCP_SERVER_URL="http://127.0.0.1:$PORT/mcp"
if ! command -v tunnel-client >/dev/null 2>&1; then
  echo "tunnel-client is not installed or not on PATH." >&2
  echo "Download the supported binary from OpenAI Platform tunnel settings." >&2
  exit 2
fi
INIT_ARGS=(
  --sample sample_mcp_remote_no_auth
  --profile "$PROFILE"
  --tunnel-id "$TUNNEL_ID"
  --mcp-server-url "$MCP_SERVER_URL"
  --control-plane-api-key-ref "env:$RUNTIME_KEY_ENV"
)
if (( FORCE )); then INIT_ARGS+=(--force); fi

tunnel-client init "${INIT_ARGS[@]}"

ACTION=created
if (( FORCE )); then ACTION=replaced; fi
cat <<NEXT
Profile $ACTION for Chrome instance $INSTANCE.
Target: $MCP_SERVER_URL

With the matching Chrome profile and extension open, run:

  export $RUNTIME_KEY_ENV="sk-..."
  tunnel-client doctor --profile $PROFILE --explain
  tunnel-client run --profile $PROFILE
NEXT
