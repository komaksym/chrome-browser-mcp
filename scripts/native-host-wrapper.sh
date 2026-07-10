#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec /usr/bin/env node "$ROOT/dist/bridge/index.js" "$@"
