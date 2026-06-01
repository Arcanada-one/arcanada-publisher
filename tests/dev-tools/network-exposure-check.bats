#!/usr/bin/env bats
# Verifier contract (AC-9): loopback binds pass (exit 0); any non-loopback bind
# is refused with the NETWORK_GUARD exit code (7), matching core's runtime guard.

setup() {
  SCRIPT="${BATS_TEST_DIRNAME}/../../dev-tools/network-exposure-check.sh"
}

@test "default (no args) is loopback → exit 0" {
  run "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"loopback (Tier 1)"* ]]
}

@test "127.0.0.1 → exit 0" {
  run "$SCRIPT" 127.0.0.1 8787
  [ "$status" -eq 0 ]
}

@test "localhost → exit 0" {
  run "$SCRIPT" localhost 8787
  [ "$status" -eq 0 ]
}

@test "::1 (IPv6 loopback) → exit 0" {
  run "$SCRIPT" ::1 8787
  [ "$status" -eq 0 ]
}

@test "0.0.0.0 (all interfaces) → exit 7 NETWORK_GUARD" {
  run "$SCRIPT" 0.0.0.0 8787
  [ "$status" -eq 7 ]
  [[ "$output" == *"non-loopback (Tier 3)"* ]]
}

@test "LAN IP → exit 7 NETWORK_GUARD" {
  run "$SCRIPT" 10.0.0.5 8787
  [ "$status" -eq 7 ]
}

@test "public IP → exit 7 NETWORK_GUARD" {
  run "$SCRIPT" 203.0.113.7 8787
  [ "$status" -eq 7 ]
}
