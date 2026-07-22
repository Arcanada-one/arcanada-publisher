# Changelog — @arcanada/publisher-linkedin

All notable changes to this package are documented here. The format is loosely
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Image pre-submit verification is now scoped to the marked composer. Images
  elsewhere in the LinkedIn feed can no longer produce a false attachment
  success and a text-only public post.

## [0.1.0] — 2026-05-21

### Added

- Initial LinkedIn adapter port from
  [`Arcanada-one/li-publish`](https://github.com/Arcanada-one/li-publish) (≈1166 LoC bash)
  to native TypeScript + Playwright (PUB-0004, Phase 2 of `PUB-0001`).
- `LinkedInAdapter` implementing the `Adapter` contract from
  `@arcanada/publisher-core`: `login` / `publish` / `comment` / `edit` / `verify`
  (`verify` inherited from `BaseAdapter`).
- Pure modules: `selectors.ts` (RU/EN UI regex), `errors.ts`
  (`mapLiError` / `classifyLiError`), `url-extraction.ts`
  (`extractActivityUrn`, `extractActivityId`, `pickFirstActivityHref`,
  `ACTIVITY_URN_RE`).
- IO modules: `login.ts` (headed-only, 300 s polling budget), `publish.ts`
  (Start a post → composer dialog → editor → setInputFiles → Post),
  `comment.ts` (first-comment via Ctrl+Enter submit shortcut),
  `edit.ts` (post body replace + optional image attach).
- Persistent Chromium profile under
  `~/.arcanada-publisher/profiles/linkedin/<slug>` (`chmod 700` via
  `ProfileManager.createEmptyProfile`).
- Screenshot-on-fail artefacts under `packages/adapter-linkedin/artifacts/`
  (.gitignored).
- Unit tests (60 cases across selectors, errors, url-extraction, context,
  publish, comment, edit) and Playwright live smoke `tests/smoke.spec.ts`
  gated by `LI_LIVE_SMOKE=1`.

### Fixed

- **INFRA-0259 — shadow-DOM image intercept closure.** The legacy bash
  `bin/li-publish.sh` clicked an «Add a photo» / «Добавить фото» button to
  open the photo modal; LinkedIn renders this control inside an
  `interop-outlet` shadow root and Playwright's `pw click` intercepted the
  pointer events with the error «shadowdom intercepts pointer events». The
  TypeScript port bypasses the click entirely: `publish.ts` (and `edit.ts`)
  wait for the composer dialog to mount, then call `setInputFiles` directly
  on the hidden `input[type="file"]` scoped to the dialog. Native Playwright
  locators auto-pierce shadow DOM, but we skip the modal-opening step
  altogether — the upload handler accepts files without it. Unit assertion:
  `tests/edit.test.ts` covers the `imageFile`/`imagePath` alias contract;
  the structural absence of any photo-button click is guarded by the
  V-AC-2 grep in the archive matrix.

- **INFRA-0260 — Activity URN extraction closure.** The legacy bash
  `extract_post_url()` collected `a[href*="/feed/update/urn:li:activity:"]`
  OR `a[href*="/posts/"]` candidates; the `/posts/` arm matched recommended
  company cards (e.g. `https://www.linkedin.com/company/lazy-programmer/posts/`)
  and surfaced as the wrong post URL after publish. The TypeScript port
  tightens the contract via `ACTIVITY_URN_RE`
  (`^https://(?:www\\.)?linkedin\\.com/feed/update/urn:li:activity:(\\d+)/?$`)
  applied in two stages: (1) `pickFirstActivityHref` filters visible
  `<a href>` candidates in the post-publish toast region, (2) on toast miss,
  navigation to `/in/me/recent-activity/all/` walks the same visible-href
  filter. Recommended cards and other `/company/.../posts/` matches are
  rejected by construction. `tests/url-extraction.test.ts` includes an
  explicit adversarial fixture asserting the company-card URL throws
  `AdapterError(VERIFY_FAILED)`.

- **INFRA-0261 — `li-edit-post` image attachment closure.** The legacy bash
  `bin/li-edit-post.sh` supported body replace only; retrofitting an image
  onto a previously text-only post required hand-craft in the LinkedIn UI.
  The TypeScript port accepts an optional `imagePath` on the core
  `EditInput` type AND a legacy-named `imageFile` alias on
  `LinkedInEditInput` (extends `EditInput`); both feed into the same
  validate-then-`setInputFiles` flow as `publish.ts`. Setting both fields
  to different values is rejected as `INVALID_ARGS`.

### Dependencies

- Runtime: `playwright@^1.60.0`, `zod@^3.25.76`, `@arcanada/publisher-core`
  (workspace).

### Migration notes

- Source repo `Arcanada-one/li-publish` remains LIVE; per Decision Matrix
  D-2 in `prd/PRD-PUB-0001.md` it is archived in Phase 9 (`PUB-0011`), not
  now.
- Each ported TypeScript module carries the attribution header
  `// Migrated from Arcanada-one/li-publish@7ddadf81a1662abd66d7f04ea2b7acf737d6afe2
on 2026-05-21 (PUB-0004)`.

[0.1.0]: https://github.com/Arcanada-one/arcanada-publisher/releases/tag/v0.1.0
