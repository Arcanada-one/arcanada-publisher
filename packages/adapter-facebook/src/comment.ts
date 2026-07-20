// Migrated from Arcanada-one/fb-publish@8df49fa51822795075f746ad7389c8bd400b1aa4 on 2026-05-21
// Source: bin/fb-edit-comment.sh + bin/fb-publish.sh (first-comment publish flow).

import { type Page } from "playwright";
import {
  AdapterError,
  ErrorCode,
  ProfileManager,
  CommentResultSchema,
  type CommentInput,
  type CommentResult,
} from "@arcanada/publisher-core";
import { extractAccountFromUrl, extractPostUrlFromHref } from "./url-extraction.js";
import { launchSession, withScreenshotOnFail } from "./context.js";
import { selectors } from "./selectors.js";
import { typeMultiline } from "./input.js";
import { VERIFY_DELAY_MS } from "./timing.js";

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
    await page.goto(input.parentPostUrl, { waitUntil: "domcontentloaded" });
    // PUB-0062: FB permalinks hydrate slowly and can auto-open a stray overlay
    // (e.g. the "no more stories" modal) that covers the comment composer.
    // Dismiss it via its own OK button ONLY (never Escape — that collapses the
    // post-permalink modal itself), then give the composer a generous window.
    await page.waitForTimeout(4_000);
    for (let i = 0; i < 3; i++) {
      const ok = page.getByRole("button", { name: /^(OK|ОК)$/, exact: true }).first();
      if (await ok.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await ok.click().catch(() => {});
        await page.waitForTimeout(800);
      } else {
        break;
      }
    }
    const composer = page.getByRole("textbox", { name: selectors.commentComposer }).first();
    await composer.waitFor({ state: "visible", timeout: 30_000 });
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
  // PUB-0062: an unauthenticated HEAD to a FB profile-post permalink is redirected
  // to the login wall and comes back non-ok (or 400), so this gate produced a
  // false "parent post is not reachable" for posts that ARE reachable under the
  // logged-in browser session. FB permalinks are not anonymously fetchable by
  // design — reachability is instead proven inside runCommentFlow, where the
  // comment composer must render (composer.waitFor) before we type. Only reject
  // here on a hard network failure (DNS/connection), never on an HTTP status the
  // login wall produces.
  try {
    await fetch(parentPostUrl, { method: "HEAD", redirect: "follow" });
    return true;
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
  /** Read-before-delete oracle: the current text of the comment to replace. */
  oldText: string;
  /** The new comment body (may be multi-line — typed via Shift+Enter, R6). */
  text: string;
  profile: string;
}

/** Injectable two-step choreography (test seam): delete old, then add new. */
export interface ReplaceCommentRecorder {
  deleteOldComment(page: Page, input: ReplaceCommentInput): Promise<void>;
  /** Returns the new comment id. */
  addNewComment(page: Page, input: ReplaceCommentInput): Promise<string>;
}

export interface ReplaceCommentOptions {
  headed?: boolean;
  profileManager?: ProfileManager;
  page?: Page;
  __recorder?: ReplaceCommentRecorder;
  skipTeardown?: boolean;
}

export async function replaceCommentText(
  input: ReplaceCommentInput,
  options: ReplaceCommentOptions = {},
): Promise<CommentResult> {
  assertParentHost(input.parentPostUrl);
  if (!input.text || input.text.trim() === "") {
    throw new AdapterError(ErrorCode.MISSING_INPUT, "replaceCommentText: 'text' is required");
  }
  if (!input.oldText || input.oldText.trim() === "") {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      "replaceCommentText: 'oldText' is required (read-before-delete oracle)",
    );
  }

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
    // R10: delete the old comment FIRST, then add the new one.
    await steps.deleteOldComment(page, input);
    const commentId = await steps.addNewComment(page, input);
    return CommentResultSchema.parse({
      ok: true,
      platform: "facebook",
      account: extractAccountFromUrl(input.parentPostUrl),
      commentId,
      parentPostUrl: input.parentPostUrl,
    });
  });
}

const defaultReplaceSteps: ReplaceCommentRecorder = {
  async deleteOldComment(page: Page, input: ReplaceCommentInput): Promise<void> {
    await page.goto(input.parentPostUrl);
    // Read-before-delete: the comment menu is only opened for the comment whose
    // rendered text matches `oldText`; a mismatch aborts before any click.
    const commentBlock = page
      .locator('[role="article"]')
      .filter({ hasText: input.oldText })
      .first();
    await commentBlock.waitFor({ state: "visible", timeout: 10_000 });
    const menu = commentBlock.getByLabel(selectors.commentActionsMenu).first();
    await menu.click();
    const deleteItem = page.getByRole("menuitem", { name: selectors.deleteMenuItem }).first();
    await deleteItem.waitFor({ state: "visible", timeout: 5_000 });
    await deleteItem.click();
    const confirm = page.getByRole("button", { name: selectors.confirmDelete, exact: true });
    await confirm.first().click();
    await page.waitForTimeout(VERIFY_DELAY_MS);
  },

  async addNewComment(page: Page, input: ReplaceCommentInput): Promise<string> {
    const composer = page.getByRole("textbox", { name: selectors.commentComposer }).first();
    await composer.waitFor({ state: "visible", timeout: 10_000 });
    await composer.click();
    // R6: multi-line comment via Shift+Enter, final Enter submits.
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
        "replaceCommentText: added but commentId missing from rendered href",
        { commentHref, fbErrorType: "verify_mismatch" },
      );
    }
    return commentId;
  },
};
