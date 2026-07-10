#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer currently supports macOS only." >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js 20+ and npm are required." >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
npm ci
npm run build

HOST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
HOST_MANIFEST="$HOST_DIR/com.komaksym.chrome_browser_mcp.json"
WRAPPER="$ROOT/scripts/native-host-wrapper.sh"
mkdir -p "$HOST_DIR"
chmod +x "$WRAPPER"

node --input-type=module - "$HOST_MANIFEST" "$WRAPPER" <<'NODE'
import { writeFileSync } from "node:fs";
const [, , manifestPath, wrapperPath] = process.argv;
writeFileSync(
  manifestPath,
  `${JSON.stringify({
    name: "com.komaksym.chrome_browser_mcp",
    description: "Local Chrome bridge for ChatGPT MCP",
    path: wrapperPath,
    type: "stdio",
    allowed_origins: ["chrome-extension://jlpddlfiallighiohmhhkemgbhofpnha/"],
  }, null, 2)}\n`,
);
NODE

cat <<EOF2

Installed the native host manifest:
  $HOST_MANIFEST

Now load this unpacked extension in chrome://extensions:
  $ROOT/dist/extension

Expected extension ID:
  jlpddlfiallighiohmhhkemgbhofpnha

Then keep Chrome open and run:
  npm run verify:local
EOF2
