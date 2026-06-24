# Changelog

All notable changes to `arcanada-publisher` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) from `0.1.0` onward.

## [Unreleased]

### Added

- `docs/how-to/blog-audio-narration.md` — recipe for generating RU (Silero) + EN (Kokoro) blog narration. Documents the mandatory **normalize-don't-strip** rule for RU text (numbers->words via `num2words`, Latin->Cyrillic transliteration, stress markers with `+` before the stressed vowel), the md5 method for verifying a stress marker without listening, the fragile sidecar-tunnel workflow (sequential RU/EN, resumable, keepalive), `MAX_CHUNK_CHARS=600`, and the **mandatory Cloudflare cache purge** after overwriting an R2 audio asset. Mirrored as a rule in `skills/publishing/SKILL.md` § Blog audio narration.
- `@arcanada/publisher-video` 0.1.0-pre.0 — new `packages/video-generator`
  package. Turns a cover image + optional audio into a polished MP4 for social
  posts using only ffmpeg built-in filters (no plugins). Provides ≥3 presets
  selectable via `--preset` (zoompan, cqt, cycle); the `cycle` preset is the
  house style (timeline-changing, ported from `dev-tools/video/make-cycle-video.sh`).
  Exposed via the `arcanada-publisher video` CLI subcommand. X adapter allowlist
  extended to accept `.mp4`/`.mov` so generated videos attach via the existing
  `--image` path. 74 unit + integration tests; ffmpeg spawned with arg-array
  (no shell-string interpolation).
- `--max-bitrate <kbps>` flag for the `video` subcommand (PUB-0028) — the cycle
  final assembly pass is now a bounded re-encode (`-c:v libx264 -maxrate Nk
-bufsize 2Nk`) instead of a lossless copy (`-c:v copy`). Default: 600 kbps
  (compact social-video target, ≤ ~35 MB for a 7–8 min clip). Configurable via
  `--max-bitrate` CLI flag or `maxBitrateKbps` programmatic option. Resolves X /
  Telegram upload rejections on long high-motion clips. VBV ceiling also applied
  consistently to `zoompan` and `cqt` presets via a shared `boundedVideoArgs()`
  helper. `dev-tools/video/make-cycle-video.sh` mirrored accordingly
  (`MAX_BITRATE_KBPS` / `CRF` env vars).
- `@arcanada/publisher-linkedin` 0.1.0 — LinkedIn adapter ported from
  `Arcanada-one/li-publish@7ddadf8` to native TypeScript + Playwright
  (PUB-0004, Phase 2 of `PUB-0001`). 60 unit tests + 2 gated live smoke
  cases. See `packages/adapter-linkedin/CHANGELOG.md` for the per-package
  history.

### Added

- **PUB-0031/PUB-0032 — no-publish verification.** Three layers to verify the
  LinkedIn adapter without posting/deleting/commenting on a real account:
  (1) unit tests (offline); (2) label fixtures
  (`tests/fixtures/*.labels.json` + `tests/dom-fixtures.test.ts`) asserting
  captured real-UI control labels match the production selector regexes; (3) an
  abort-before-post dry-run — `LinkedInAdapter.publishDryRunNoPost()` /
  `PublishOptions.abortBeforePost` runs the full composer flow against the live UI
  (attaches media, waits for the scoped `<video>` preview, types text) and aborts
  before «Post». Gated live smoke probes `LI_DRYRUN_PROBE=1` (P1 video, P2
  text-only) never publish. How-to: `docs/how-to/verify-linkedin-without-publishing.md`.

### Fixed

- **PUB-0031** — LinkedIn video publish is now fail-closed. The composer-side
  attach check counted `<video>` elements page-wide, so a stray feed/profile
  video produced a false positive and the post published text-only while
  reporting success. Video detection is now scoped to the composer / media-editor
  subtree (`scopedVideoCountJs`, shadow-aware), and a mandatory post-publish
  re-verify (`__verifyPostVideo`, default re-fetches the live post page and polls
  for a `<video>` player) throws `VERIFY_FAILED` instead of returning ok when the
  attach silently dropped. The page-walk helpers were extracted to
  `src/dom-shadow.ts` (shared with delete/comment).
- **PUB-0032** — LinkedIn delete + comment selector drift on the 2026 UI. The
  post control-menu, delete menu-item, confirm button, and comment composer now
  match multi-locale labels (added DE/FI alongside RU/EN) and fall back to a
  shadow-walk DOM `.click()` (delete) or a structural CSS hook (comment composer)
  when the localized accessible-name locator misses. The delete read-before-delete
  oracle falls back to a body-wide read guarded by a structural activity-URN probe
  when the article container class drifts.
- **INFRA-0259** — LinkedIn composer shadow-DOM image intercept closed
  structurally in `@arcanada/publisher-linkedin` by bypassing the «Add a
  photo» button click and calling `setInputFiles` on the hidden
  `input[type="file"]` scoped to the composer dialog.
- **INFRA-0260** — LinkedIn activity URN extraction tightened to the strict
  `^https://(?:www\.)?linkedin\.com/feed/update/urn:li:activity:\d+/?$`
  pattern; recommended-company-card `/company/.../posts/` candidates are
  rejected by construction.
- **INFRA-0261** — LinkedIn `edit` flow now accepts an optional image
  attachment (`imagePath` or `imageFile` alias) so a text-only post can be
  retrofitted with a cover image without hand-crafting in the UI.

## [0.1.0-pre.0] — 2026-05-21

### Added

- pnpm-workspaces monorepo skeleton with eight packages: `core`, `cli`, `api`, and five adapter placeholders (`adapter-facebook`, `adapter-linkedin`, `adapter-x-twitter`, `adapter-reddit`, `adapter-vkontakte`).
- `@arcanada/publisher-core` exporting:
  - `Adapter` interface and `BaseAdapter` abstract class with a default HEAD-based `verify` implementation.
  - Zod schemas for `PublishResult`, `CommentResult`, `EditResult`, `VerifyResult`.
  - `ErrorCode` enum (`0`–`8`, `99`) and `AdapterError` with structured `toJSON`.
  - `ProfileManager` for persistent browser-profile directories with `0700` permissions.
  - `assertLoopback` network guard (Tier 1 default).
- OSS hygiene: MIT `LICENSE`, `README.md`, `SECURITY.md`, `accepted-risk.yml` for five platforms, `CHANGELOG.md`, `.editorconfig`, `.gitignore`, `.nvmrc`, `.npmrc`.
- Autonomy declaration in `aal.yaml` (`current_aal: L1`, `target_aal: L2`).
- Diátaxis documentation skeleton under `docs/`.
- GitHub Actions CI workflow with lint, typecheck, test, and audit jobs.

### Security

- Loopback-only HTTP bind is enforced at the contract level via `assertLoopback`; the HTTP server package itself is a placeholder and ships in a later release.
