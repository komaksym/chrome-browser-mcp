#!/usr/bin/env bash
set -euo pipefail

HOST_MANIFEST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.komaksym.chrome_browser_mcp.json"
APP_DIR="$HOME/Library/Application Support/Chrome Browser MCP"
INSTALLED_WRAPPER="$APP_DIR/native-host-wrapper.sh"

rm -f "$HOST_MANIFEST" "$INSTALLED_WRAPPER"
rmdir "$APP_DIR" 2>/dev/null || true

printf 'Removed the Chrome Browser MCP native host manifest and installed wrapper. Remove the extension from chrome://extensions separately.\n'
