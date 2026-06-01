#!/usr/bin/env bash
# arcanada-publisher self-announce dogfood runner (Phase 7).
#
# Publishes the announce posts through arcanada-publisher itself, on three
# platforms. Default mode is --dry-run (no IO, no browser, no login needed):
# it validates text + image + the 280-unit X limit and prints a dry-run URL
# per platform. Live publishing requires the explicit --commit flag AND
# logged-in persistent profiles (arcanada-publisher login --platform <p>).
#
#   ./run.sh                         # dry-run fb + li + x (default)
#   ANNOUNCE_IMAGE=/path/a.png ./run.sh --commit   # LIVE posts on your own accounts
#
# Facebook and X are image-mandatory (R1) — ANNOUNCE_IMAGE must be set for both
# dry-run and live. LinkedIn accepts the same image (optional there).
#
# After a successful --commit publish, add the canonical first comment per
# docs/explanation/canonical-tg-link-policy.md:
#   arcanada-publisher comment --platform <p> --parent-url <postUrl> \
#       --text-file comment.<p>.<lang>.md
# (substitute the real t.me/valentovtypes/<msg_id> in the comment file first).
set -euo pipefail

cd "$(dirname "$0")"

DRY="--dry-run"
if [ "${1:-}" = "--commit" ]; then
  DRY=""
  echo "LIVE mode: real posts will be published on your own accounts." >&2
fi

IMG="${ANNOUNCE_IMAGE:?set ANNOUNCE_IMAGE=/path/to/asset.png (Facebook and X are image-mandatory)}"

BIN="${ARCANADA_PUBLISHER_BIN:-arcanada-publisher}"

run_one() {
  platform="$1"; text="$2"
  echo "--- ${platform} ---" >&2
  "$BIN" publish --platform "$platform" --text-file "$text" --image "$IMG" $DRY
}

run_one facebook announce.fb.ru.md
run_one linkedin announce.li.en.md
run_one x        announce.x.en.md
