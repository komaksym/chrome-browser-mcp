#!/usr/bin/env bash
set -euo pipefail
rm -f "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.komaksym.chrome_browser_mcp.json"
printf 'Removed the Chrome Browser MCP native host manifest. Remove the extension from chrome://extensions separately.\n'
