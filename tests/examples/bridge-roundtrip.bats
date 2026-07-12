#!/usr/bin/env bats
# AC-8: each agent bridge is a runnable round-trip. Start the built loopback
# server on an ephemeral port, drive both bridge wrappers with a dry-run X
# payload, and assert exit 0 + a JSON ok:true response. Requires the project to
# be built (dist/) and `jq` on PATH.

setup() {
  ROOT="${BATS_TEST_DIRNAME}/../.."
  # publish.sh pipes the API response through jq; a missing jq surfaces as a
  # confusing exit-127 from the wrapper, so fail loudly with a clear reason.
  command -v jq >/dev/null 2>&1 || {
    echo "jq not found on PATH — required by examples/*/publish.sh" >&2
    return 1
  }
  IMG_DIR="$(mktemp -d)"
  IMG="${IMG_DIR}/hero.png"
  SERVER_LOG="${IMG_DIR}/bridge-server.log"
  printf '\x89PNG\r\n\x1a\n' >"$IMG"
  # Pick a free ephemeral port instead of a hard-coded one: parallel CI jobs (or a
  # leftover server from a previous run) can already hold a fixed port, which made
  # the bind silently fail and the round-trip flaky (exit 0 on a clean runner,
  # connection-refused otherwise).
  PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close();});')"
  node "${ROOT}/packages/cli/dist/index.js" server --port "$PORT" >"$SERVER_LOG" 2>&1 &
  SERVER_PID=$!
  # Wait for the loopback listener to come up; fail explicitly on timeout so a
  # dead server is a clear error, not a downstream connection-refused mystery.
  local up=
  for _ in $(seq 1 40); do
    if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then up=1; break; fi
    sleep 0.25
  done
  if [ -z "$up" ]; then
    echo "loopback server did not become healthy on port ${PORT}; log:" >&2
    cat "$SERVER_LOG" >&2 || true
    return 1
  fi
  export ARCANADA_PUBLISHER_PORT="$PORT"
}

teardown() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "${IMG_DIR:-}" ] && rm -rf "$IMG_DIR" || true
}

@test "claude-code-bridge publish.sh dry-run round-trip → exit 0, ok:true" {
  run "${ROOT}/examples/claude-code-bridge/publish.sh" \
    "{\"platform\":\"x\",\"text\":\"bridge smoke\",\"imagePaths\":[\"${IMG}\"],\"dryRun\":true}"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"ok": true'* ]]
}

@test "codex-bridge publish.sh dry-run round-trip → exit 0, ok:true" {
  run "${ROOT}/examples/codex-bridge/publish.sh" \
    "{\"platform\":\"x\",\"text\":\"bridge smoke\",\"imagePaths\":[\"${IMG}\"],\"dryRun\":true}"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"ok": true'* ]]
}
