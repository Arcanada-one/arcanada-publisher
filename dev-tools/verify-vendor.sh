#!/usr/bin/env bash
# verify-vendor.sh — re-derive the content hash of the vendored video-shotcraft
# subtree and compare it against vendor/video-shotcraft.lock (ARCA-0191, V-AC-6).
#
# Supply-chain pin (DESIGN §3 / D3): the vendored assets are checked in and
# pinned by { commit, contentHash }. This script recomputes the tree hash
# offline (no network, no curl|bash) and fails non-zero on any drift. Run in CI
# and locally after a deliberate vendor bump (then --write to update the lock).
#
# Usage:
#   dev-tools/verify-vendor.sh            # verify (default) — exit non-zero on mismatch
#   dev-tools/verify-vendor.sh --write    # recompute and write the contentHash into the lock

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
VENDOR_DIR="${REPO_ROOT}/packages/video-shotcraft/vendor/video-shotcraft"
LOCK_FILE="${REPO_ROOT}/packages/video-shotcraft/vendor/video-shotcraft.lock"

if [ ! -d "${VENDOR_DIR}" ]; then
  echo "verify-vendor: vendored subtree missing: ${VENDOR_DIR}" >&2
  exit 1
fi

# Deterministic content hash: for every regular file (relative, LC_ALL=C sorted),
# hash "<sha256>  <relpath>" lines, then hash the concatenation. Independent of
# absolute path and filesystem traversal order.
compute_hash() {
  (
    cd "${VENDOR_DIR}"
    find . -type f -print0 \
      | LC_ALL=C sort -z \
      | while IFS= read -r -d '' f; do
          printf '%s  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$f"
        done \
      | sha256sum \
      | cut -d' ' -f1
  )
}

COMPUTED="$(compute_hash)"

if [ "${1:-}" = "--write" ]; then
  if [ ! -f "${LOCK_FILE}" ]; then
    echo "verify-vendor: lock file missing, cannot --write: ${LOCK_FILE}" >&2
    exit 1
  fi
  tmp="$(mktemp)"
  # Replace the contentHash line, preserving the rest of the JSON.
  sed "s/\"contentHash\": *\"[^\"]*\"/\"contentHash\": \"sha256:${COMPUTED}\"/" \
    "${LOCK_FILE}" >"${tmp}"
  mv "${tmp}" "${LOCK_FILE}"
  echo "verify-vendor: wrote contentHash sha256:${COMPUTED}"
  exit 0
fi

if [ ! -f "${LOCK_FILE}" ]; then
  echo "verify-vendor: lock file missing: ${LOCK_FILE}" >&2
  exit 1
fi

EXPECTED="$(grep -o '"contentHash": *"[^"]*"' "${LOCK_FILE}" | sed 's/.*"\(sha256:[^"]*\)"/\1/')"

if [ "sha256:${COMPUTED}" != "${EXPECTED}" ]; then
  echo "verify-vendor: CONTENT HASH MISMATCH" >&2
  echo "  expected: ${EXPECTED}" >&2
  echo "  computed: sha256:${COMPUTED}" >&2
  echo "  vendored subtree drifted from the pin — review the diff or re-pin with --write." >&2
  exit 1
fi

echo "verify-vendor: OK — vendored subtree matches the pin (sha256:${COMPUTED})"
