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
APP_DIR="$HOME/Library/Application Support/Chrome Browser MCP"
BRIDGE_ENTRY="$ROOT/dist/bridge/index.js"
INSTANCES_JSON="$ROOT/scripts/instances.json"
mkdir -p "$HOST_DIR" "$APP_DIR"

# Chrome launched from Finder does not inherit shell initialization, Homebrew,
# or nvm PATH entries. Install dedicated wrappers with absolute executable
# paths so each native host starts in Chrome's minimal environment with its
# own loopback port and accepted extension origin baked in. Instance topology
# (ports, host names, extension IDs) lives in scripts/instances.json.
"$NODE_BIN" --input-type=module - "$INSTANCES_JSON" "$NODE_BIN" "$BRIDGE_ENTRY" "$HOST_DIR" "$APP_DIR" <<'NODE'
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
const [, , instancesPath, nodeBin, bridgeEntry, hostDir, appDir] = process.argv;
const { instances } = JSON.parse(readFileSync(instancesPath, "utf8"));

const shellQuote = (value) => {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return "'" + value.replace(/'/g, "'\\''") + "'";
};

for (const instance of instances) {
  const origin = "chrome-extension://" + instance.extensionId + "/";
  const wrapperPath = appDir + "/" + instance.wrapper;
  const marker = "# chrome-browser-mcp-bridge-base64: " + Buffer.from(bridgeEntry).toString("base64");
  const wrapper = [
    "#!/bin/bash",
    marker,
    "set -euo pipefail",
    "export CHROME_MCP_PORT=\"" + instance.port + "\"",
    "export CHROME_MCP_EXPECTED_ORIGIN=\"" + origin + "\"",
    "exec " + shellQuote(nodeBin) + " " + shellQuote(bridgeEntry) + " \"$@\"",
    "",
  ].join("\n");
  writeFileSync(wrapperPath, wrapper);
  chmodSync(wrapperPath, 0o700);
  writeFileSync(
    hostDir + "/" + instance.hostName + ".json",
    JSON.stringify({
      name: instance.hostName,
      description: "Local Chrome bridge for ChatGPT MCP (" + instance.label + ")",
      path: wrapperPath,
      type: "stdio",
      allowed_origins: [origin],
    }, null, 2) + "\n",
  );
  console.log("Installed " + instance.hostName + " on port " + instance.port + " (extension " + instance.extensionId + ")");
}
NODE
cp "$INSTANCES_JSON" "$APP_DIR/instances.json"
chmod 600 "$APP_DIR/instances.json"

cat <<EOF2

Installed the native host manifests in:
  $HOST_DIR

Installed Chrome-safe native host wrappers using:
  $NODE_BIN
Installed the launcher topology at:
  $APP_DIR/instances.json

Now load these unpacked extensions in chrome://extensions (one per Chrome profile):
  $ROOT/dist/extension
  $ROOT/dist/extension2
  $ROOT/dist/extension3

Use the extension IDs, ports, and profile mapping in scripts/instances.json.

Then keep Chrome open and run:
  npm run verify:local
  npm run verify:local2
  npm run verify:local3
EOF2
