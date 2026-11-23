#!/usr/bin/env bash
# Copy web/core.js into an app checkout:  scripts/sync-web-core.sh ../recipes/src/lib/core.js
set -euo pipefail
cp "$(dirname "$0")/../web/core.js" "$1" && echo "copied core.js -> $1"
