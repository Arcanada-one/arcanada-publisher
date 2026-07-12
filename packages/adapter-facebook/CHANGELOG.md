# Changelog — @arcanada/publisher-facebook

All notable changes to this package are documented here. The format is loosely
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Facebook first-comment replacement now requires the exact numeric comment id,
  exact parent post, stable header profile-link identity, and complete current
  comment body before delete. Body mentions/links cannot satisfy author proof.
  The new ID must be absent from the pre-submit snapshot and is verified against
  the same parent, header identity, and exact replacement body. Any ambiguity
  after confirmation returns `UNKNOWN` with mandatory reconciliation and only
  text hashes/lengths (never full comment bodies).
  The unified CLI exposes this fail-closed flow as `replace-comment`; in-place
  Facebook comment editing remains disabled.

## [0.1.0] — 2026-05-21

### Added

- Initial Facebook adapter port from
  [`Arcanada-one/fb-publish`](https://github.com/Arcanada-one/fb-publish) (≈750 LoC bash)
  to native TypeScript + Playwright (PUB-0003, Phase 1 of `PUB-0001`).
- `FacebookAdapter` implementing the `Adapter` contract from
  `@arcanada/publisher-core`: `login` / `publish` / `comment` / `edit` / `verify`
  (`verify` inherited from `BaseAdapter`).
- Pure modules: `selectors.ts` (RU/EN UI regex), `errors.ts`
  (`mapFbError` / `classifyFbError` mirroring `pw_classify_error`), and
  `url-extraction.ts`.
- IO modules: `login.ts` (headed-only, 300 s polling budget), `publish.ts`
  (composer → Далее → Опубликовать), `comment.ts` (first-comment with
  `verifyCommentParent`), `edit.ts` (post and comment edit flows).
- Persistent Chromium profile under `~/.arcanada-publisher/profiles/facebook/<slug>`
  (chmod 700 via `ProfileManager.createEmptyProfile`).
- Screenshot-on-fail artefacts under `packages/adapter-facebook/artifacts/`
  (.gitignored).
- Unit tests (36 cases across selectors, errors, url-extraction, comment, edit,
  context) and Playwright live smoke `tests/smoke.spec.ts` gated by
  `FB_LIVE_SMOKE=1`.

### Fixed

- **INFRA-0190 — `POST_URL` quote-strip closure.** The legacy bash
  `extract_post_url()` shelled out to `playwright-cli eval --raw`, which
  wrapped the JS-evaluated string in literal `"` quotes. When that value
  was interpolated into `printf 'POST_URL=%s\n'`, downstream `curl -fsI
"$POST_URL"` saw the quotes as part of the URL and returned 404.
  The TypeScript port calls `page.$eval(...)` directly — Playwright returns
  a JS `string` to TypeScript with no shell-quoting wrapper layer — so the
  defect cannot recur. As defence-in-depth, `extractPostUrlFromHref()` also
  strips any incidental wrapping double-quotes and validates the host is
  `www.facebook.com` before returning. AC-3 (`tests/url-extraction.test.ts`)
  asserts the contract regex
  `^https://www\.facebook\.com/[^"]+/posts/[0-9]+$` is matched and that the
  value contains no `"` characters.

### Dependencies

- Runtime: `playwright@^1.60.0`, `zod@^3.25.76`, `@arcanada/publisher-core`
  (workspace).

### Migration notes

- Source repo `Arcanada-one/fb-publish` remains LIVE; per Decision Matrix #2 in
  `prd/PRD-PUB-0001.md` it is archived in Phase 9 (`PUB-0011`), not now.
- Each portered TypeScript module carries the attribution header
  `// Migrated from Arcanada-one/fb-publish@8df49fa51822795075f746ad7389c8bd400b1aa4
on 2026-05-21 (PUB-0003)`.

[0.1.0]: https://github.com/Arcanada-one/arcanada-publisher/releases/tag/v0.1.0
