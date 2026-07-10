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

NODE_BIN="$(command -v node)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
npm ci
npm run build

HOST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
HOST_MANIFEST="$HOST_DIR/com.komaksym.chrome_browser_mcp.json"
APP_DIR="$HOME/Library/Application Support/Chrome Browser MCP"
INSTALLED_WRAPPER="$APP_DIR/native-host-wrapper.sh"
BRIDGE_ENTRY="$ROOT/dist/bridge/index.js"
mkdir -p "$HOST_DIR" "$APP_DIR"

# Chrome launched from Finder does not inherit shell initialization, Homebrew,
# or nvm PATH entries. Install a dedicated wrapper with absolute executable
# paths so the native host starts in Chrome's minimal environment.
printf -v NODE_BIN_QUOTED '%q' "$NODE_BIN"
printf -v BRIDGE_ENTRY_QUOTED '%q' "$BRIDGE_ENTRY"
cat > "$INSTALLED_WRAPPER" <<EOF
#!/bin/bash
set -euo pipefail
exec $NODE_BIN_QUOTED $BRIDGE_ENTRY_QUOTED "\$@"
EOF
chmod 700 "$INSTALLED_WRAPPER"

"$NODE_BIN" --input-type=module - "$HOST_MANIFEST" "$INSTALLED_WRAPPER" <<'NODE'
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

Installed a Chrome-safe native host wrapper using:
  $NODE_BIN

Now load this unpacked extension in chrome://extensions:
  $ROOT/dist/extension

Expected extension ID:
  jlpddlfiallighiohmhhkemgbhofpnha

Then keep Chrome open and run:
  npm run verify:local
EOF2
