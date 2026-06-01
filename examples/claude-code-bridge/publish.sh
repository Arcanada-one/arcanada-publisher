#!/usr/bin/env bash
# Claude Code bridge: publish through the arcanada-publisher loopback API.
# The agent starts the server once (`arcanada-publisher server`) and POSTs a
# JSON payload here per publish — no Playwright, no credentials in the payload.
#
# Usage: ./publish.sh '{"platform":"x","text":"Hello","imagePaths":["/tmp/a.png"],"dryRun":true}'
set -euo pipefail

PORT="${ARCANADA_PUBLISHER_PORT:-8787}"

if [ $# -ne 1 ]; then
  echo "Usage: $0 <json-payload>" >&2
  exit 1
fi

curl -fsS -X POST "http://127.0.0.1:${PORT}/publish" \
  -H "Content-Type: application/json" \
  -d "$1" | jq .
