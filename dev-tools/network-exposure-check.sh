#!/usr/bin/env bash
# network-exposure-check.sh — fail-closed loopback bind verifier for the
# arcanada-publisher API. Mirrors the core network guard (packages/core/src/
# network-guard.ts): the loopback set is exactly {127.0.0.1, localhost, ::1}.
# Any other bind is a non-loopback (Tier-3) exposure and exits 7 — the same
# NETWORK_GUARD code the runtime guard throws — so CI and a human running the
# script see the identical verdict.
#
# Usage: network-exposure-check.sh [BIND] [PORT]
#   BIND defaults to 127.0.0.1, PORT to 8787 (the API defaults).
# Exit: 0 = loopback (Tier 1 OK); 7 = non-loopback (NETWORK_GUARD).
set -euo pipefail

BIND="${1:-127.0.0.1}"
PORT="${2:-8787}"

# NETWORK_GUARD in packages/core/src/errors.ts — keep in lockstep.
readonly EXIT_NETWORK_GUARD=7

case "$BIND" in
  127.0.0.1 | localhost | ::1)
    echo "OK: bind ${BIND}:${PORT} is loopback (Tier 1)"
    exit 0
    ;;
  *)
    echo "FAIL: bind ${BIND}:${PORT} is non-loopback (Tier 3) — refused" >&2
    exit "$EXIT_NETWORK_GUARD"
    ;;
esac
