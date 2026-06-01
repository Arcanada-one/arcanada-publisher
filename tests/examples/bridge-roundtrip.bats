#!/usr/bin/env bats
# AC-8: each agent bridge is a runnable round-trip. Start the built loopback
# server on an ephemeral port, drive both bridge wrappers with a dry-run X
# payload, and assert exit 0 + a JSON ok:true response. Requires the project to
# be built (dist/) and `jq` on PATH.

setup() {
  ROOT="${BATS_TEST_DIRNAME}/../.."
  PORT=4291
  IMG_DIR="$(mktemp -d)"
  IMG="${IMG_DIR}/hero.png"
  printf '\x89PNG\r\n\x1a\n' >"$IMG"
  node "${ROOT}/packages/cli/dist/index.js" server --port "$PORT" >/tmp/bridge-bats-server.log 2>&1 &
  SERVER_PID=$!
  # Wait for the loopback listener to come up.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then break; fi
    sleep 0.3
  done
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
