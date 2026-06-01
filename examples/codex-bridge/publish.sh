#!/usr/bin/env bash
# Codex CLI bridge: publish through the arcanada-publisher loopback API.
# Identical wire contract to the Claude Code bridge — the agent starts the
# server once (`arcanada-publisher server`) and POSTs a JSON payload per
# publish. No credentials travel in the payload.
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
