# Changelog

All notable changes to `arcanada-publisher` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) from `0.1.0` onward.

## [Unreleased]

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
