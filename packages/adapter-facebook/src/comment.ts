// Migrated from Arcanada-one/fb-publish@8df49fa51822795075f746ad7389c8bd400b1aa4 on 2026-05-21
// Source: bin/fb-edit-comment.sh + bin/fb-publish.sh (first-comment publish flow).

import { type Locator, type Page } from "playwright";
import { createHash } from "node:crypto";
import {
  AdapterError,
  ErrorCode,
  ProfileManager,
  CommentResultSchema,
  DeleteResultSchema,
  type CommentInput,
  type CommentResult,
  type DeleteResult,
} from "@arcanada/publisher-core";
import { extractAccountFromUrl, extractPostUrlFromHref } from "./url-extraction.js";
import { launchSession, withScreenshotOnFail } from "./context.js";
import { selectors } from "./selectors.js";
import { typeMultiline } from "./input.js";
import { VERIFY_DELAY_MS } from "./timing.js";
import { matchesElidedText, matchesElidedTextSource } from "./elided-text.js";

const FB_HOSTNAME = "www.facebook.com";

export interface CommentOptions {
  headed?: boolean;
  profileManager?: ProfileManager;
  page?: Page;
  /** Optional verifier — defaults to `fetch HEAD` against the parent URL. */
  verifyParent?: (parentPostUrl: string) => Promise<boolean>;
  skipTeardown?: boolean;
}

export async function comment(
  input: CommentInput,
  options: CommentOptions = {},
): Promise<CommentResult> {
  assertParentHost(input.parentPostUrl);
  if (!input.text || input.text.trim() === "") {
    throw new AdapterError(ErrorCode.MISSING_INPUT, "comment: 'text' is required");
  }

  const verifyParent = options.verifyParent ?? defaultVerifyParent;
  const parentOk = await verifyParent(input.parentPostUrl);
  if (!parentOk) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      `comment: parent post is not reachable: ${input.parentPostUrl}`,
      { parentPostUrl: input.parentPostUrl, fbErrorType: "verify_mismatch" },
    );
  }

  const profiles = options.profileManager ?? new ProfileManager();
  const profileDir = profiles.ensureProfileExists("facebook", input.profile);

  if (options.page) {
    return runCommentFlow(options.page, input);
  }

  const session = await launchSession({
    profileDir,
    ...(options.headed !== undefined ? { headed: options.headed } : {}),
  });
  try {
    return await runCommentFlow(session.page, input);
  } finally {
    if (!options.skipTeardown) {
      await session.close();
    }
  }
}

async function runCommentFlow(page: Page, input: CommentInput): Promise<CommentResult> {
  return withScreenshotOnFail(page, "comment", async () => {
    await page.goto(input.parentPostUrl);
    const composer = page.getByRole("textbox", { name: selectors.commentComposer }).first();
    await composer.waitFor({ state: "visible", timeout: 10_000 });
    await composer.click();
    // R6: a multi-line first comment (CTA links + TG cross-link) must use
    // Shift+Enter between lines — a raw "\n" makes FB submit on the first line,
    // dropping links 2-N (the "only the first link is inserted" bug). The final
    // plain Enter submits the comment.
    await typeMultiline(page, input.text, { submit: true });
    await page.waitForTimeout(VERIFY_DELAY_MS);

    const rawHref = await page.$eval(
      'a[href*="comment_id="]',
      (a) => (a as unknown as { href: string }).href,
    );
    const commentHref = extractPostUrlFromHref(rawHref);
    const commentId = new URL(commentHref).searchParams.get("comment_id");
    if (!commentId) {
      throw new AdapterError(
        ErrorCode.VERIFY_FAILED,
        "comment: posted but commentId missing from rendered href",
        { commentHref, fbErrorType: "verify_mismatch" },
      );
    }
    return CommentResultSchema.parse({
      ok: true,
      platform: "facebook",
      account: extractAccountFromUrl(input.parentPostUrl),
      commentId,
      parentPostUrl: input.parentPostUrl,
    });
  });
}

function assertParentHost(parentPostUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(parentPostUrl);
  } catch (cause) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `comment: parentPostUrl is not a valid URL: ${parentPostUrl}`,
      { cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
  if (parsed.hostname !== FB_HOSTNAME) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `comment: parentPostUrl host '${parsed.hostname}' is not '${FB_HOSTNAME}'`,
      { parentPostUrl },
    );
  }
}

async function defaultVerifyParent(parentPostUrl: string): Promise<boolean> {
  try {
    const response = await fetch(parentPostUrl, { method: "HEAD", redirect: "follow" });
    return response.ok;
  } catch {
    return false;
  }
}

// --- R10: comment-text change = DELETE + ADD (never in-place edit) ---------
//
// Editing a Facebook comment's contenteditable field breaks it (collapses to
// the first line on focus/clear, keystrokes do not print). The only
// reliable way to change a comment's text is to delete the old one and add a
// new one. This is intentionally NOT an `edit()` arm: the two-step contract has
// no in-place edit path.

export interface ReplaceCommentInput {
  parentPostUrl: string;
  /** Exact existing Facebook comment id (digits only). */
  commentId: string;
  /** Exact stable Facebook profile URL expected on old and replacement headers. */
  expectedAuthorProfileUrl: string;
  /** Read-before-delete oracle: the current text of the comment to replace. */
  oldText: string;
  /** The new comment body (may be multi-line — typed via Shift+Enter, R6). */
  text: string;
  profile: string;
}

/** Injectable two-step choreography (test seam): delete old, then add new. */
export interface ReplaceCommentRecorder {
  deleteOldComment(page: Page, input: ReplaceCommentInput): Promise<DeleteCommentEvidence>;
  addNewComment(page: Page, input: ReplaceCommentInput): Promise<NewCommentEvidence>;
}

export interface DeleteCommentEvidence {
  preDeleteCommentIds: readonly string[];
}

export interface NewCommentEvidence {
  commentId: string;
  commentHref: string;
  preSubmitCommentIds: readonly string[];
  renderedBody: string;
  renderedAuthorProfileUrl: string;
}

export interface ReplaceCommentOptions {
  headed?: boolean;
  profileManager?: ProfileManager;
  page?: Page;
  __recorder?: ReplaceCommentRecorder;
  skipTeardown?: boolean;
}

/**
 * PUB-0039: standalone comment deletion. `replaceCommentText` already carried a
 * hardened delete step, but it was reachable only by writing a replacement
 * comment — there was no way to remove a comment outright (the gap that forced
 * an operator to delete duplicate link-comments by hand). The destructive
 * choreography is NOT duplicated here: `deleteCommentById` and
 * `replaceCommentText` share `deleteExactComment` below, so the
 * bind-to-exact-id → verify-author → verify-body → confirm → prove-detached
 * contract has exactly one implementation.
 */
export interface DeleteCommentInput {
  parentPostUrl: string;
  /** Exact existing Facebook comment id (digits only). */
  commentId: string;
  /** Exact stable Facebook profile URL expected on the comment header. */
  expectedAuthorProfileUrl: string;
  /** Read-before-delete oracle: the current text of the comment to delete. */
  expectedContent: string;
  profile: string;
}

export interface DeleteCommentOptions {
  headed?: boolean;
  profileManager?: ProfileManager;
  page?: Page;
  /** Test seam: perform the bind → verify → confirm → prove-detached step. */
  __deleteStep?: (page: Page, input: DeleteCommentInput) => Promise<DeleteCommentEvidence>;
  skipTeardown?: boolean;
}

export interface CommentBindingEvidence {
  commentHref: string;
  commentId: string;
  renderedBodyCandidates: readonly string[];
  renderedAuthorProfileHrefs: readonly string[];
}

export async function deleteCommentById(
  input: DeleteCommentInput,
  options: DeleteCommentOptions = {},
): Promise<DeleteResult> {
  assertParentHost(input.parentPostUrl);
  assertExactMutationTarget("deleteCommentById", {
    commentId: input.commentId,
    expectedAuthorProfileUrl: input.expectedAuthorProfileUrl,
    oracleText: input.expectedContent,
    oracleField: "expectedContent",
  });

  const profiles = options.profileManager ?? new ProfileManager();
  const profileDir = profiles.ensureProfileExists("facebook", input.profile);

  if (options.page) {
    return runDeleteCommentFlow(options.page, input, options);
  }

  const session = await launchSession({
    profileDir,
    ...(options.headed !== undefined ? { headed: options.headed } : {}),
  });
  try {
    return await runDeleteCommentFlow(session.page, input, options);
  } finally {
    if (!options.skipTeardown) {
      await session.close();
    }
  }
}

async function runDeleteCommentFlow(
  page: Page,
  input: DeleteCommentInput,
  options: DeleteCommentOptions,
): Promise<DeleteResult> {
  return withScreenshotOnFail(page, "comment-delete", async () => {
    const step = options.__deleteStep ?? defaultDeleteCommentStep;
    await step(page, input);
    // Deletion is terminal — unlike replace there is no second mutation whose
    // failure could leave the comment half-replaced. `deleteExactComment` only
    // returns after proving the comment block detached from the DOM.
    return DeleteResultSchema.parse({
      ok: true,
      platform: "facebook",
      account: extractAccountFromUrl(input.parentPostUrl),
      deleted: true,
      targetUrl: commentPermalink(input.parentPostUrl, input.commentId),
    });
  });
}

async function defaultDeleteCommentStep(
  page: Page,
  input: DeleteCommentInput,
): Promise<DeleteCommentEvidence> {
  await page.goto(input.parentPostUrl);
  return deleteExactComment(page, {
    label: "deleteCommentById",
    parentPostUrl: input.parentPostUrl,
    commentId: input.commentId,
    expectedAuthorProfileUrl: input.expectedAuthorProfileUrl,
    oldText: input.expectedContent,
  });
}

/** Comment permalink identity for the DeleteResult receipt. */
function commentPermalink(parentPostUrl: string, commentId: string): string {
  const url = new URL(parentPostUrl);
  url.searchParams.set("comment_id", commentId);
  return url.href;
}

export async function replaceCommentText(
  input: ReplaceCommentInput,
  options: ReplaceCommentOptions = {},
): Promise<CommentResult> {
  assertParentHost(input.parentPostUrl);
  if (!input.text || input.text.trim() === "") {
    throw new AdapterError(ErrorCode.MISSING_INPUT, "replaceCommentText: 'text' is required");
  }
  assertExactMutationTarget("replaceCommentText", {
    commentId: input.commentId,
    expectedAuthorProfileUrl: input.expectedAuthorProfileUrl,
    oracleText: input.oldText,
    oracleField: "oldText",
  });

  const profiles = options.profileManager ?? new ProfileManager();
  const profileDir = profiles.ensureProfileExists("facebook", input.profile);

  if (options.page) {
    return runReplaceFlow(options.page, input, options.__recorder);
  }

  const session = await launchSession({
    profileDir,
    ...(options.headed !== undefined ? { headed: options.headed } : {}),
  });
  try {
    return await runReplaceFlow(session.page, input, options.__recorder);
  } finally {
    if (!options.skipTeardown) {
      await session.close();
    }
  }
}

async function runReplaceFlow(
  page: Page,
  input: ReplaceCommentInput,
  recorder?: ReplaceCommentRecorder,
): Promise<CommentResult> {
  const steps = recorder ?? defaultReplaceSteps;
  return withScreenshotOnFail(page, "comment-replace", async () => {
    const deletion = await steps.deleteOldComment(page, input);
    let addition: NewCommentEvidence;
    try {
      addition = await steps.addNewComment(page, input);
    } catch (error) {
      throw asUnknownReplaceState("add-or-verify", input, error, {
        preDeleteCommentIds: deletion.preDeleteCommentIds,
      });
    }
    return CommentResultSchema.parse({
      ok: true,
      platform: "facebook",
      account: extractAccountFromUrl(input.parentPostUrl),
      commentId: addition.commentId,
      parentPostUrl: input.parentPostUrl,
    });
  });
}

const defaultReplaceSteps: ReplaceCommentRecorder = {
  async deleteOldComment(page: Page, input: ReplaceCommentInput): Promise<DeleteCommentEvidence> {
    await page.goto(input.parentPostUrl);
    return deleteExactComment(page, {
      label: "replaceCommentText",
      parentPostUrl: input.parentPostUrl,
      commentId: input.commentId,
      expectedAuthorProfileUrl: input.expectedAuthorProfileUrl,
      oldText: input.oldText,
      replacementText: input.text,
    });
  },

  async addNewComment(page: Page, input: ReplaceCommentInput): Promise<NewCommentEvidence> {
    const composer = page.getByRole("textbox", { name: selectors.commentComposer }).first();
    await composer.waitFor({ state: "visible", timeout: 10_000 });
    await composer.click();
    await typeMultiline(page, input.text);
    const preSubmitCommentIds = await collectParentCommentIds(page, input.parentPostUrl);
    if (preSubmitCommentIds.includes(input.commentId)) {
      throw asUnknownReplaceState("pre-submit-old-comment-still-present", input, undefined, {
        preSubmitCommentIds,
      });
    }
    try {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(VERIFY_DELAY_MS);
      return await findExactNewComment(page, input, preSubmitCommentIds);
    } catch (error) {
      throw asUnknownReplaceState("submit-or-verify", input, error, {
        preSubmitCommentIds,
      });
    }
  },
};

/**
 * The ONLY implementation of Facebook comment deletion: bind to one exact
 * comment id under the exact parent, require the exact rendered body and the
 * expected author before opening any menu, refuse when the menu item or the
 * confirmation button is ambiguous, and prove the block detached afterwards.
 *
 * Shared by `deleteCommentById` (delete outright) and `replaceCommentText`
 * (delete + add). Every abort before `confirm().click()` is non-destructive;
 * after the click the state is reported UNKNOWN with hashes only, never blindly
 * retried.
 */
async function deleteExactComment(
  page: Page,
  target: {
    label: string;
    parentPostUrl: string;
    commentId: string;
    expectedAuthorProfileUrl: string;
    oldText: string;
    /** Present only on the replace path — carried into UNKNOWN evidence. */
    replacementText?: string;
  },
): Promise<DeleteCommentEvidence> {
  const binding: ReplaceCommentInput = {
    parentPostUrl: target.parentPostUrl,
    commentId: target.commentId,
    expectedAuthorProfileUrl: target.expectedAuthorProfileUrl,
    oldText: target.oldText,
    // The binding/UNKNOWN helpers are shared with the replace path; on a plain
    // delete there is no replacement body, so mirror oldText to keep the
    // evidence hashes well-formed without inventing content.
    text: target.replacementText ?? target.oldText,
    profile: "",
  };
  const commentBlock = await findExactExistingComment(page, binding, target.label);
  const menu = await findExactOwnedActionMenu(commentBlock, target.commentId, target.label);
  await menu.click();
  // PUB-0039: Facebook renders the comment kebab's entries as role="button"
  // inside a role="menu" container — NOT as role="menuitem". Querying
  // `getByRole("menuitem")` therefore found 0 items, and widening to
  // `getByRole("button")` page-wide would match ~100 unrelated buttons
  // ("ambiguous"). Scope the lookup to the just-opened menu and accept either
  // role, so the target stays unambiguous without loosening the guard.
  const openMenu = page.locator('[role="menu"]').last();
  await openMenu.waitFor({ state: "visible", timeout: 5_000 });
  const deleteItems = openMenu
    .getByRole("menuitem", { name: selectors.deleteMenuItem })
    .or(openMenu.getByRole("button", { name: selectors.deleteMenuItem }));
  if ((await deleteItems.count()) !== 1) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      `${target.label}: exact delete menu item is ambiguous; refusing delete`,
      {
        commentId: target.commentId,
        observedDeleteItems: await deleteItems.count(),
        fbErrorType: "verify_mismatch",
      },
    );
  }
  const deleteItem = deleteItems.first();
  await deleteItem.waitFor({ state: "visible", timeout: 5_000 });
  await deleteItem.click();
  // The confirmation lives in a modal dialog. Scope to the topmost dialog when
  // one is present: a page-wide search can collide with the post's own «Удалить»
  // affordances, and an ambiguous match must never reach a destructive click.
  await page.waitForTimeout(800);
  const confirmDialog = page.locator('[role="dialog"]').last();
  const scope = (await confirmDialog.count()) > 0 ? confirmDialog : page;
  const confirms = scope.getByRole("button", { name: selectors.confirmDelete, exact: true });
  if ((await confirms.count()) !== 1) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      `${target.label}: exact delete confirmation is ambiguous; refusing delete`,
      {
        commentId: target.commentId,
        observedConfirmButtons: await confirms.count(),
        scopedToDialog: (await confirmDialog.count()) > 0,
        fbErrorType: "verify_mismatch",
      },
    );
  }
  const preDeleteCommentIds = await collectParentCommentIds(page, target.parentPostUrl);
  try {
    await confirms.first().click();
    await page.waitForTimeout(VERIFY_DELAY_MS);
    await commentBlock.waitFor({ state: "detached", timeout: 10_000 });
  } catch (error) {
    throw asUnknownReplaceState("delete-confirm-or-detach", binding, error, {
      preDeleteCommentIds,
    });
  }
  return { preDeleteCommentIds };
}

/** Input validation shared by the delete-outright and replace paths. */
function assertExactMutationTarget(
  label: string,
  target: {
    commentId: string;
    expectedAuthorProfileUrl: string;
    oracleText: string;
    oracleField: string;
  },
): void {
  if (!target.oracleText || target.oracleText.trim() === "") {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      `${label}: '${target.oracleField}' is required (read-before-delete oracle)`,
    );
  }
  if (!target.commentId || target.commentId.trim() === "") {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      `${label}: 'commentId' is required (exact mutation target)`,
    );
  }
  if (!/^\d+$/.test(target.commentId)) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `${label}: 'commentId' must contain Facebook's numeric comment id`,
      { commentId: target.commentId },
    );
  }
  if (!target.expectedAuthorProfileUrl || target.expectedAuthorProfileUrl.trim() === "") {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      `${label}: 'expectedAuthorProfileUrl' is required (stable ownership oracle)`,
    );
  }
  facebookAccountIdentity(target.expectedAuthorProfileUrl);
}

/** Fail-closed read-before-delete check shared by the live path and unit tests. */
export function assertExactCommentBinding(
  input: ReplaceCommentInput,
  evidence: CommentBindingEvidence,
  label = "replaceCommentText",
): void {
  if (evidence.commentId !== input.commentId) {
    throw bindingError("comment id mismatch", input, evidence, label);
  }
  if (
    facebookParentIdentity(evidence.commentHref) !== facebookParentIdentity(input.parentPostUrl)
  ) {
    throw bindingError("parent post mismatch", input, evidence, label);
  }
  const expected = normalizeExactText(input.oldText);
  if (
    !evidence.renderedBodyCandidates.some((candidate) => matchesElidedText(candidate, expected))
  ) {
    throw bindingError("exact old content mismatch", input, evidence, label);
  }
  // Operator input stays strict; rendered hrefs are normalized leniently because
  // Facebook appends comment_id/__cft__ tracking to the author link itself.
  const expectedAuthorIdentity = facebookAccountIdentity(input.expectedAuthorProfileUrl);
  if (
    !evidence.renderedAuthorProfileHrefs.some((href) => {
      try {
        return facebookAccountIdentity(href, { strict: false }) === expectedAuthorIdentity;
      } catch {
        return false; // not a profile URL at all — cannot vouch for ownership
      }
    })
  ) {
    throw bindingError("expected author mismatch", input, evidence, label);
  }
}

async function findExactExistingComment(
  page: Page,
  input: ReplaceCommentInput,
  label = "replaceCommentText",
): Promise<Locator> {
  const anchors = page.locator('a[href*="comment_id="]');
  const count = await anchors.count();
  for (let index = 0; index < count; index += 1) {
    const anchor = anchors.nth(index);
    const href = await anchor.getAttribute("href");
    if (!href) continue;
    const commentHref = new URL(href, page.url()).href;
    const commentId = new URL(commentHref).searchParams.get("comment_id");
    if (commentId !== input.commentId) continue;
    const block = anchor.locator('xpath=ancestor::*[@role="article"][1]');
    await block.waitFor({ state: "visible", timeout: 10_000 });
    const renderedBodyCandidates = await collectOwnedBodyCandidates(block, input.commentId);
    const renderedAuthorProfileHrefs = await collectOwnedAuthorProfileHrefs(
      block,
      input.commentId,
      input.oldText,
    );
    assertExactCommentBinding(
      input,
      {
        commentHref,
        commentId,
        renderedBodyCandidates,
        renderedAuthorProfileHrefs,
      },
      label,
    );
    return block;
  }
  throw new AdapterError(
    ErrorCode.VERIFY_FAILED,
    `${label}: exact comment id '${input.commentId}' was not found under parent`,
    {
      parentPostUrl: input.parentPostUrl,
      commentId: input.commentId,
      fbErrorType: "verify_mismatch",
    },
  );
}

async function findExactNewComment(
  page: Page,
  input: ReplaceCommentInput,
  preSubmitCommentIds: readonly string[],
): Promise<NewCommentEvidence> {
  const anchors = page.locator('a[href*="comment_id="]');
  const count = await anchors.count();
  const matches = new Map<string, NewCommentEvidence>();
  const observedNovelCommentIds = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    const anchor = anchors.nth(index);
    const href = await anchor.getAttribute("href");
    if (!href) continue;
    const commentHref = new URL(href, page.url()).href;
    const commentId = new URL(commentHref).searchParams.get("comment_id");
    if (!commentId || preSubmitCommentIds.includes(commentId)) continue;
    observedNovelCommentIds.add(commentId);
    const block = anchor.locator('xpath=ancestor::*[@role="article"][1]');
    const renderedBodyCandidates = await collectOwnedBodyCandidates(block, commentId);
    const renderedAuthorProfileHrefs = await collectOwnedAuthorProfileHrefs(
      block,
      commentId,
      input.text,
    );
    try {
      assertExactCommentBinding(
        { ...input, commentId, oldText: input.text },
        { commentHref, commentId, renderedBodyCandidates, renderedAuthorProfileHrefs },
      );
      matches.set(commentId, {
        commentId,
        commentHref,
        preSubmitCommentIds,
        renderedBody: input.text,
        renderedAuthorProfileUrl: input.expectedAuthorProfileUrl,
      });
    } catch (error) {
      if (!(error instanceof AdapterError) || error.code !== ErrorCode.VERIFY_FAILED) throw error;
    }
  }
  if (matches.size !== 1) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      `replaceCommentText: expected one exact new comment, found ${matches.size}`,
      {
        parentPostUrl: input.parentPostUrl,
        oldCommentId: input.commentId,
        newCommentIds: [...observedNovelCommentIds],
        preSubmitCommentIds,
        fbErrorType: "verify_mismatch",
      },
    );
  }
  return [...matches.values()][0]!;
}

async function collectParentCommentIds(page: Page, parentPostUrl: string): Promise<string[]> {
  const anchors = page.locator('a[href*="comment_id="]');
  const count = await anchors.count();
  const ids = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    const href = await anchors.nth(index).getAttribute("href");
    if (!href) continue;
    const absolute = new URL(href, page.url()).href;
    const id = new URL(absolute).searchParams.get("comment_id");
    if (id && facebookParentIdentity(absolute) === facebookParentIdentity(parentPostUrl))
      ids.add(id);
  }
  return [...ids];
}

async function collectOwnedBodyCandidates(block: Locator, commentId: string): Promise<string[]> {
  return collectOwnedText(block.locator('[dir="auto"]'), commentId, "body");
}

async function collectOwnedAuthorProfileHrefs(
  block: Locator,
  commentId: string,
  exactBody: string,
): Promise<string[]> {
  const links = block.locator('a[role="link"][href]');
  const result: string[] = [];
  const count = await links.count();
  for (let index = 0; index < count; index += 1) {
    const href = await links.nth(index).evaluate(
      (element, options) => {
        // Facebook elides long URLs when rendering, so the body node's innerText
        // is not byte-equal to the expected body. Rehydrate the ONE canonical
        // matcher from its shipped source rather than keeping a second copy here.
        const bodyEquals = new Function(`return (${options.matcherSource});`)() as (
          rendered: string,
          expected: string,
        ) => boolean;
        const article = element.closest('[role="article"]');
        if (!article) return null;
        const ownsId = [...article.querySelectorAll('a[href*="comment_id="]')].some((anchor) => {
          if (anchor.closest('[role="article"]') !== article) return false;
          const candidateHref = anchor.getAttribute("href");
          if (!candidateHref) return false;
          const base =
            (globalThis as unknown as { location?: { href: string } }).location?.href ??
            "https://www.facebook.com";
          return new URL(candidateHref, base).searchParams.get("comment_id") === options.commentId;
        });
        if (!ownsId) return null;
        const bodyNodes = [...article.querySelectorAll('[dir="auto"]')].filter((candidate) => {
          if (candidate.closest('[role="article"]') !== article) return false;
          if (candidate.querySelector('[role="article"]')) return false;
          if (
            !bodyEquals(
              (candidate as unknown as { innerText: string }).innerText,
              options.exactBody,
            )
          )
            return false;
          return ![...candidate.querySelectorAll('[dir="auto"]')].some(
            (child) =>
              child !== candidate &&
              child.closest('[role="article"]') === article &&
              bodyEquals((child as unknown as { innerText: string }).innerText, options.exactBody),
          );
        });
        if (bodyNodes.length !== 1) return null;
        const body = bodyNodes[0]!;
        if (body.contains(element)) return null;
        // The author-name anchor is part of the comment header and precedes the exact body.
        if ((element.compareDocumentPosition(body) & 4) === 0) return null;
        const accessibleName =
          element.getAttribute("aria-label")?.trim() ||
          (element as unknown as { innerText?: string }).innerText?.trim();
        if (!accessibleName) return null;
        const href = element.getAttribute("href");
        if (!href) return null;
        const base =
          (globalThis as unknown as { location?: { href: string } }).location?.href ??
          "https://www.facebook.com";
        const parsed = new URL(href, base);
        // PUB-0039: do NOT reject on tracking params. Facebook decorates the
        // author link in a comment header with `?comment_id=…&__cft__[0]=…`, so
        // rejecting any href carrying `comment_id` discarded the ONLY real author
        // link and made ownership unprovable ("expected author mismatch" on our
        // own comment, observed live 2026-08-02). Identity is decided by the PATH:
        // `/<slug>` or `/profile.php?id=`. A post permalink still fails below
        // because its path segment (`posts`, `permalink.php`, …) is reserved, and
        // `story_fbid`/`fbid` only appear on those same reserved paths.
        if (parsed.pathname === "/profile.php") return parsed.searchParams.has("id") ? href : null;
        const segments = parsed.pathname.split("/").filter(Boolean);
        const reserved = new Set([
          "groups",
          "photo",
          "photos",
          "permalink.php",
          "posts",
          "reel",
          "share",
          "story.php",
          "videos",
          "watch",
        ]);
        if (segments.length !== 1 || reserved.has(segments[0]!.toLowerCase())) return null;
        return href;
      },
      { commentId, exactBody, matcherSource: matchesElidedTextSource },
    );
    if (typeof href === "string") result.push(href);
  }
  return [...new Set(result)];
}

async function collectOwnedText(
  candidates: Locator,
  commentId: string,
  kind: "body" | "author",
): Promise<string[]> {
  const result: string[] = [];
  const count = await candidates.count();
  for (let index = 0; index < count; index += 1) {
    const value = await candidates.nth(index).evaluate(
      (element, options) => {
        const article = element.closest('[role="article"]');
        if (!article) return null;
        const ownsId = [...article.querySelectorAll('a[href*="comment_id="]')].some((anchor) => {
          if (anchor.closest('[role="article"]') !== article) return false;
          const href = anchor.getAttribute("href");
          if (!href) return false;
          const base =
            (globalThis as unknown as { location?: { href: string } }).location?.href ??
            "https://www.facebook.com";
          return new URL(href, base).searchParams.get("comment_id") === options.commentId;
        });
        if (!ownsId) return null;
        if (element.querySelector('[role="article"]')) return null;
        if (options.kind === "body" && element.closest('a[role="link"], strong')) return null;
        const text = (element as unknown as { innerText: string }).innerText;
        if (!text) return null;
        if (options.kind === "body") {
          const duplicateChild = [...element.querySelectorAll('[dir="auto"]')].some(
            (child) =>
              child !== element &&
              child.closest('[role="article"]') === article &&
              (child as unknown as { innerText: string }).innerText === text,
          );
          if (duplicateChild) return null;
        }
        return text;
      },
      { commentId, kind },
    );
    if (typeof value === "string") result.push(value);
  }
  return [...new Set(result)];
}

async function findExactOwnedActionMenu(
  block: Locator,
  commentId: string,
  label = "replaceCommentText",
): Promise<Locator> {
  const actions = block.getByLabel(selectors.commentActionsMenu);
  const matches: Locator[] = [];
  const count = await actions.count();
  for (let index = 0; index < count; index += 1) {
    const action = actions.nth(index);
    const owned = await action.evaluate((element, expectedId) => {
      const article = element.closest('[role="article"]');
      if (!article) return false;
      return [...article.querySelectorAll('a[href*="comment_id="]')].some((anchor) => {
        if (anchor.closest('[role="article"]') !== article) return false;
        const href = anchor.getAttribute("href");
        if (!href) return false;
        const base =
          (globalThis as unknown as { location?: { href: string } }).location?.href ??
          "https://www.facebook.com";
        return new URL(href, base).searchParams.get("comment_id") === expectedId;
      });
    }, commentId);
    if (owned) matches.push(action);
  }
  if (matches.length !== 1) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      `${label}: expected one action menu in exact comment container, found ${matches.length}`,
      { commentId, fbErrorType: "verify_mismatch" },
    );
  }
  return matches[0]!;
}

function bindingError(
  reason: string,
  input: ReplaceCommentInput,
  evidence: CommentBindingEvidence,
  label = "replaceCommentText",
): AdapterError {
  return new AdapterError(ErrorCode.VERIFY_FAILED, `${label}: ${reason}; refusing delete`, {
    parentPostUrl: input.parentPostUrl,
    expectedCommentId: input.commentId,
    observedCommentId: evidence.commentId,
    commentHref: evidence.commentHref,
    fbErrorType: "verify_mismatch",
  });
}

function asUnknownReplaceState(
  stage: string,
  input: ReplaceCommentInput,
  cause: unknown,
  evidence: Record<string, unknown>,
): AdapterError {
  if (
    cause instanceof AdapterError &&
    cause.details?.["unknown"] === true &&
    cause.details?.["reconcileRequired"] === true
  ) {
    return cause;
  }
  const causeDetails = cause instanceof AdapterError ? cause.details : undefined;
  return new AdapterError(
    ErrorCode.VERIFY_FAILED,
    `replaceCommentText: Facebook state UNKNOWN after irreversible confirmation; do not retry blindly (${stage})`,
    {
      unknown: true,
      reconcileRequired: true,
      stage,
      parentPostUrl: input.parentPostUrl,
      oldCommentId: input.commentId,
      expectedAuthorAccountIdentity: facebookAccountIdentity(input.expectedAuthorProfileUrl),
      expectedOldTextSha256: sha256(input.oldText),
      expectedOldTextLength: input.oldText.length,
      replacementTextSha256: sha256(input.text),
      replacementTextLength: input.text.length,
      newCommentIds: causeDetails?.["newCommentIds"] ?? [],
      evidence,
      causeName:
        cause instanceof Error ? cause.name : cause === undefined ? undefined : typeof cause,
      causeCode: cause instanceof AdapterError ? cause.code : undefined,
      fbErrorType: "verify_mismatch",
    },
  );
}

function normalizeExactText(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Author identity of a URL.
 *
 * `strict` (default) is for OPERATOR-SUPPLIED input: a URL carrying `comment_id`
 * / `story_fbid` / `fbid` is rejected outright, so a permalink can never be
 * passed off as the ownership oracle.
 *
 * `strict: false` is for hrefs READ FROM THE DOM. Facebook decorates the author
 * link inside a comment header with the very same tracking params
 * (`facebook.com/<slug>?comment_id=…&__cft__[0]=…`), so under the strict rule
 * every rendered author href was discarded and the author check could never
 * pass — the comment-delete flow refused with "expected author mismatch" on a
 * genuinely owned comment (observed live 2026-08-02). Identity is decided by the
 * PATH (`/<slug>` or `/profile.php?id=`), which the tracking tail never changes;
 * a real permalink still fails because its path is `/posts/<id>` (reserved).
 */
function facebookAccountIdentity(rawUrl: string, options: { strict?: boolean } = {}): string {
  const strict = options.strict ?? true;
  const parsed = new URL(rawUrl, "https://www.facebook.com");
  assertParentHost(parsed.href);
  if (
    strict &&
    ["comment_id", "reply_comment_id", "story_fbid", "fbid"].some((key) =>
      parsed.searchParams.has(key),
    )
  ) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `replaceCommentText: '${rawUrl}' is a comment/post permalink, not an author profile URL`,
    );
  }
  // Even in lenient mode a `story_fbid`/`fbid` URL is a post permalink, not a
  // profile: those params only ever appear on permalink.php / story.php surfaces
  // whose path is reserved below, so no extra check is needed here.
  if (parsed.pathname === "/profile.php") {
    const id = parsed.searchParams.get("id");
    if (!id) {
      throw new AdapterError(
        ErrorCode.INVALID_ARGS,
        "replaceCommentText: author profile.php URL requires a stable id",
      );
    }
    return `${parsed.hostname}/profile.php?id=${id}`;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const slug = segments[0];
  const reserved = new Set([
    "groups",
    "photo",
    "photos",
    "permalink.php",
    "posts",
    "reel",
    "share",
    "story.php",
    "videos",
    "watch",
  ]);
  if (segments.length !== 1 || !slug || reserved.has(slug.toLowerCase())) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `replaceCommentText: '${rawUrl}' is not a stable Facebook author profile URL`,
    );
  }
  return `${parsed.hostname}/${slug.toLowerCase()}`;
}

function facebookParentIdentity(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  assertParentHost(parsed.href);
  const postPath = parsed.pathname.match(/^(.*\/posts\/[^/]+)/)?.[1];
  if (postPath) return `${parsed.hostname}${postPath.replace(/\/$/, "")}`;
  const identity = new URLSearchParams();
  for (const key of ["id", "story_fbid", "fbid"]) {
    const value = parsed.searchParams.get(key);
    if (value) identity.set(key, value);
  }
  return `${parsed.hostname}${parsed.pathname.replace(/\/$/, "")}?${identity.toString()}`;
}
