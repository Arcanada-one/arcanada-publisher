# Facebook Read-only Profile Inspection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `subagent-driven-development` (recommended, when your runtime supports spawning isolated agents) or `executing-plans` (single-session execution) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Publisher-owned Facebook `inspect-profile-post` command that locates one existing Pavel-authored post and records private read-back evidence without exposing any mutation capability.

**Architecture:** A new `inspect-profile.ts` module owns bounded DOM scanning, stable profile identity checks, exact/explicit-excerpt matching, canonical permalink extraction, direct-comment evidence, and private evidence writing. The CLI only validates arguments, calls the Facebook adapter, and serializes a hash/length-only summary; raw bodies never cross stdout or error boundaries.

**Tech Stack:** TypeScript, Playwright, Node `crypto`/`fs`, pnpm, Vitest.

---

### Task 1: Read-only adapter and fake-DOM coverage

**Files:**

- Create: `packages/adapter-facebook/src/inspect-profile.ts`
- Create: `packages/adapter-facebook/tests/inspect-profile.test.ts`
- Modify: `packages/adapter-facebook/src/index.ts`

- [ ] Write a fake-DOM test for one exact normalized full-body match with a stable Pavel header profile anchor and a canonical `/posts/` permalink.
- [ ] Run `pnpm --filter @arcanada/publisher-facebook exec vitest run tests/inspect-profile.test.ts` and verify RED because the module does not exist.
- [ ] Implement `inspectFacebookProfilePost()` with input fields `profileUrl`, `expectedAuthorProfileUrl`, `expectedBody`, optional `contentExcerpt`, `evidenceDir`, `maxScrolls`, and `profile`; inject an optional Playwright page for tests.
- [ ] Add RED cases one at a time for wrong header identity, zero matches, multiple matches, missing canonical permalink, and bounded scroll exhaustion; implement fail-closed handling after each failure.
- [ ] Add explicit excerpt tests: it is used only when no exact body is supplied, and zero or multiple excerpt matches fail closed.
- [ ] Add direct-comment tests: report only comments owned directly by the matched post, excluding nested replies; each result contains numeric ID, normalized SHA-256, normalized length, and stable header profile identity.
- [ ] Add evidence tests requiring directory mode `0700`, raw body file mode `0600`, screenshot capture, and no raw body in returned summary/errors.
- [ ] Export the read-only function and types from `packages/adapter-facebook/src/index.ts`; keep the module free of action-menu, composer, edit, delete, publish, and comment imports/selectors.
- [ ] Re-run the focused test and verify GREEN.

### Task 2: CLI contract and log-denial coverage

**Files:**

- Modify: `packages/cli/src/parse-args.ts`
- Modify: `packages/cli/src/run.ts`
- Create: `packages/cli/tests/inspect-profile-post.test.ts`
- Modify: `packages/cli/tests/parse-args.test.ts`

- [ ] Write RED parser cases for `inspect-profile-post`, `--profile-url`, `--expected-author-profile-url`, exactly one of `--expected-content-file` or `--content-excerpt`, required `--evidence-dir`, and positive bounded `--max-scrolls`.
- [ ] Implement only the required parser fields and validation, then verify parser GREEN.
- [ ] Write a RED routing test whose adapter result contains canonical parent permalink, post hash/length/profile identity, direct-comment summaries, and search coverage; assert stdout JSON contains no raw post/comment bodies.
- [ ] Dispatch only Facebook `inspect-profile-post` to the read-only adapter and serialize the summary JSON; reject all other platforms.
- [ ] Run `pnpm --filter @arcanada/publisher exec vitest run tests/parse-args.test.ts tests/inspect-profile-post.test.ts` and verify GREEN.

### Task 3: Documentation, gates, PR, and live read-only use

**Files:**

- Modify: `packages/adapter-facebook/README.md`
- Modify: `docs/explanation/facebook-read-only-profile-inspection.md`

- [ ] Document the exact command, primary full-body oracle, explicit excerpt fallback, scroll bound, stdout privacy contract, and evidence permissions.
- [ ] Run `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm test`.
- [ ] Verify `git diff` changes no LinkedIn files and contains no mutation selector/control in the inspection module.
- [ ] Commit on a feature branch based on current Publisher `main`, push, open a PR, obtain independent review, and require all CI checks green before merge.
- [ ] Rebuild merged `main` on the Mac and run one read-only profile inspection against Pavel's authenticated profile using the exact CONTENT-0377 Facebook source body; if exact matching cannot locate it, run the explicitly supplied unique excerpt fallback within the same bounded inspection contract.
- [ ] Report canonical DOM permalink, header identity, normalized hashes/lengths, direct comment IDs/identities, evidence paths and search coverage. If no post exists, report bounded coverage and do not publish a duplicate.
