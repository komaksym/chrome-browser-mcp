#!/usr/bin/env bash
set -euo pipefail

HOST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
APP_DIR="$HOME/Library/Application Support/Chrome Browser MCP"
readonly -a HOST_MANIFESTS=(
  "$HOST_DIR/com.komaksym.chrome_browser_mcp.json"
  "$HOST_DIR/com.komaksym.chrome_browser_mcp_2.json"
)
readonly -a INSTALLED_FILES=(
  "$APP_DIR/native-host-wrapper.sh"
  "$APP_DIR/native-host-wrapper-2.sh"
  "$APP_DIR/instances.json"
)

for manifest in "${HOST_MANIFESTS[@]}"; do
  rm -f "$manifest"
done
for file in "${INSTALLED_FILES[@]}"; do
  rm -f "$file"
done
rmdir "$APP_DIR" 2>/dev/null || true

printf 'Removed the Chrome Browser MCP native host manifests and installed wrappers. Remove the extensions from chrome://extensions separately.\n'
