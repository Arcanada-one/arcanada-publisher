# Facebook Exact Create/Edit Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `executing-plans` (single-session execution) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent title-only Facebook posts from passing Publisher verification and make the one authorized in-place CONTENT-0377 repair provably bound to the exact post, author, body, and image.

**Architecture:** Add one Facebook-owned readback oracle that extracts the canonical post permalink, stable header profile identity, normalized full message body, and image presence from a direct post page. Publish and edit use the same oracle: pre-mutation mismatches abort normally, while any mismatch after GraphQL publish or Save is an `AdapterError` with `unknown=true` and `reconcileRequired=true`.

**Tech Stack:** TypeScript, Playwright, Vitest, pnpm workspaces, existing Publisher `AdapterError`/`ErrorCode` contracts.

---

### Task 1: Add a reusable exact Facebook post readback oracle

**Files:**

- Create: `packages/adapter-facebook/src/post-readback.ts`
- Create: `packages/adapter-facebook/tests/post-readback.test.ts`

- [ ] Write failing fake-DOM tests proving that the oracle expands localized “See more”, selects the article whose canonical `/posts/` permalink equals the requested target, extracts only `[data-ad-preview="message"]`, requires the stable header profile link, and reports image presence.
- [ ] Run `pnpm --dir packages/adapter-facebook test -- post-readback.test.ts`; expect failure because the module does not exist.
- [ ] Implement these exact public contracts:

```ts
export interface FacebookPostReadback {
  canonicalPermalink: string;
  authorProfileIdentity: string;
  normalizedBody: string;
  hasImage: boolean;
}

export function normalizeFacebookText(value: string): string {
  return value.normalize("NFKC").replace(/\r\n/g, "\n").trim();
}

export async function readFacebookPost(
  page: Page,
  targetUrl: string,
): Promise<FacebookPostReadback>;
```

- [ ] Make zero, multiple, wrong-permalink, missing-author, or missing-message matches throw `AdapterError(ErrorCode.VERIFY_FAILED, ...)` without raw bodies.
- [ ] Re-run the focused test; expect PASS.

### Task 2: Harden create before and after the irreversible click

**Files:**

- Modify: `packages/core/src/adapter.ts`
- Modify: `packages/adapter-facebook/src/publish.ts`
- Modify: `packages/adapter-facebook/tests/publish.test.ts`
- Modify: `packages/cli/src/run.ts`
- Modify: `packages/cli/tests/run.test.ts`

- [ ] Add failing tests where a composer containing only the correct title fails before `submitAndConfirm`, and where wrong full body, author, image, or canonical permalink after submit returns UNKNOWN/reconcile.
- [ ] Extend `PublishInput` with `expectedAuthorProfileUrl?: string`; make Facebook publish require it and make CLI forward `--expected-author-profile-url`.
- [ ] Replace `PreSubmitSnapshot.hasText` with exact normalized evidence:

```ts
export interface PreSubmitSnapshot {
  normalizedBody: string;
  hasImage: boolean;
}
```

Compare `normalizedBody === normalizeFacebookText(input.text)` before submit; a title-only snapshot must abort before mutation.

- [ ] Change `postVerify` to return `FacebookPostReadback` and compare exact normalized body, expected stable author, image presence, and canonical permalink against `postUrl`.
- [ ] On any exception or mismatch after `submitAndConfirm` has begun, throw:

```ts
new AdapterError(ErrorCode.VERIFY_FAILED, "publish: state unknown after submit", {
  unknown: true,
  reconcileRequired: true,
  stage: "post_submit_verify",
});
```

- [ ] Run Facebook and CLI focused tests; expect PASS with a regression explicitly named `rejects title-only composer text before submit`.

### Task 3: Harden in-place text edit and image preservation

**Files:**

- Modify: `packages/adapter-facebook/src/edit.ts`
- Modify: `packages/adapter-facebook/tests/edit.test.ts`
- Modify: `packages/cli/src/run.ts`
- Modify: `packages/cli/tests/run.test.ts`

- [ ] Add failing tests requiring Facebook edit inputs `expectedContent`, `expectedAuthorProfileUrl`, and `expectedMediaKind: "image"`; prove mismatch aborts before opening the action menu.
- [ ] Extend `FacebookEditInput` with `expectedAuthorProfileUrl?: string` and add an `EditPostStepRecorder` seam for read-before, open/edit/type, exact pre-save snapshot, save, and read-after.
- [ ] Before opening the menu, call `readFacebookPost(page, input.postUrl)` and require exact current normalized body, canonical target permalink, expected author identity, and `hasImage === true`.
- [ ] Replace raw multiline `keyboard.insertText(input.text)` with `typeMultiline(page, input.text, { submit: false })`; before Save, require the complete normalized textbox body to equal the requested replacement.
- [ ] After Save, re-run the readback and require exact new body, same expected author, same canonical permalink, and image still present. Any exception or mismatch after Save becomes UNKNOWN/reconcile with `stage: "post_edit_verify"`.
- [ ] Make Facebook CLI edit require and forward `--expected-content-file`, `--expected-author-profile-url`, and `--expected-media-kind image`; sanitize read errors without exposing file paths.
- [ ] Run Facebook and CLI focused tests; expect PASS.

### Task 4: Document, verify, review, and merge

**Files:**

- Modify: `packages/adapter-facebook/README.md`
- Create: `docs/explanation/facebook-exact-create-edit-verification.md`

- [ ] Document required Facebook create/edit oracle flags, pre-mutation abort semantics, UNKNOWN/reconcile semantics, and the no-blind-retry rule.
- [ ] Run `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm test`; expect all gates PASS.
- [ ] Commit, push `fix/facebook-exact-create-edit-verification`, open a PR, obtain independent review on the exact head, address findings, and require all CI checks green before merge.

### Task 5: Perform the single authorized live repair after merge

**Files:**

- Private input: `~/.arcanada-publisher/policy/campaigns/CONTENT-0377/evidence/copy/software-publishing-complexity-FB-RU.md`
- Private input: a mode-0600 file containing only `Собрать программу — только начало`
- Private input: `software-publishing-complexity-FB-RU-comment.md`

- [ ] Build the exact merged Publisher `main` in a clean Mac worktree.
- [ ] Execute exactly one Facebook `edit` against canonical parent `pfbid02m7PdPDzapj82GdRJc3NWuW2CiQsr92mkbX5pS7LEN17CFDmEcgBGm4AJZNVAXgTxl`, with exact title-only current-content oracle, expected Pavel profile, and expected media kind image.
- [ ] If edit returns UNKNOWN, stop without retry. Otherwise run read-only exact-body inspection and verify canonical parent, stable author, full-body hash/length, and image evidence.
- [ ] Execute exactly one `comment` under that verified parent using the canonical RU blog + Telegram `/208` + X `2076136745746272281` + Cubrim body. If comment returns UNKNOWN, stop without retry.
- [ ] Run read-only inspection again and report the exact parent, comment ID, comment body hash/length, stable comment author, and private evidence manifest location. Do not delete or republish.

## Self-review

- Spec coverage: exact pre/post create checks, UNKNOWN semantics, title-only regression, bound edit, image preservation, CLI oracles, review/CI, one live edit, and one comment are each mapped above.
- Placeholder scan: no TBD/TODO/“implement later” markers.
- Type consistency: `FacebookPostReadback`, `expectedAuthorProfileUrl`, `normalizedBody`, and UNKNOWN detail keys are used consistently across tasks.
