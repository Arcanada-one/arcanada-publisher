// Migrated from Arcanada-one/li-publish@7ddadf81a1662abd66d7f04ea2b7acf737d6afe2 on 2026-05-21 (PUB-0004)
// Source: bin/li-comment.sh (first-comment publish flow).
//
// Memory reference: [[playwright-submit-vs-trigger]] — LinkedIn renders TWO
// buttons under the same logical «comment» label: a *trigger* (opens the
// reply composer; identified by `aria-label`) and a *submit* (sends the
// composed text; no aria-label, just an inner-text «Comment»). The legacy
// bash li-comment.sh:144-178 disambiguates by querying the submit button
// inside the open composer scope. We preserve that semantics: locate the
// editable textbox, type, then submit via Ctrl+Enter (LinkedIn's canonical
// keyboard shortcut) — this elides the submit/trigger ambiguity entirely.

import { type Page } from "playwright";
import {
  AdapterError,
  ErrorCode,
  ProfileManager,
  CommentResultSchema,
  type CommentInput,
  type CommentResult,
} from "@arcanada/publisher-core";
import { launchSession, withScreenshotOnFail } from "./context.js";
import { selectors } from "./selectors.js";
import { ACTIVITY_URN_RE, extractActivityId } from "./url-extraction.js";

const LINKEDIN_HOSTNAME = "www.linkedin.com";

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
  assertParentActivityUrl(input.parentPostUrl);
  if (!input.text || input.text.trim() === "") {
    throw new AdapterError(ErrorCode.MISSING_INPUT, "comment: 'text' is required");
  }

  const verifyParent = options.verifyParent ?? defaultVerifyParent;
  const parentOk = await verifyParent(input.parentPostUrl);
  if (!parentOk) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      `comment: parent post is not reachable: ${input.parentPostUrl}`,
      { parentPostUrl: input.parentPostUrl, liErrorType: "verify_mismatch" },
    );
  }

  const profiles = options.profileManager ?? new ProfileManager();
  const profileDir = profiles.ensureProfileExists("linkedin", input.profile);

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
    const editor = page.getByRole("textbox", { name: selectors.commentBox }).first();
    await editor.waitFor({ state: "visible", timeout: 10_000 });
    await editor.click();
    await page.keyboard.insertText(input.text);
    // Ctrl+Enter is LinkedIn's canonical submit shortcut — bypasses the
    // submit/trigger button disambiguation per [[playwright-submit-vs-trigger]].
    await page.keyboard.press("Control+Enter");
    await page.waitForTimeout(4_000);

    // Comments inherit the parent activity id; LinkedIn's DOM exposes
    // `data-id="urn:li:comment:(activity:<id>,<comment-id>)"` on the rendered
    // node. Extract from the freshly rendered comment thread.
    const commentId = (await page.evaluate(`
      (() => {
        const nodes = Array.from(document.querySelectorAll('[data-id^="urn:li:comment"]'));
        const top = nodes[0];
        if (!top) return '';
        const raw = top.getAttribute('data-id') || '';
        const m = /urn:li:comment:\\(.*?,(\\d+)\\)/.exec(raw);
        return m && m[1] ? m[1] : '';
      })()
    `)) as string;
    if (!commentId) {
      throw new AdapterError(
        ErrorCode.VERIFY_FAILED,
        "comment: posted but commentId could not be extracted from DOM",
        { parentPostUrl: input.parentPostUrl, liErrorType: "verify_mismatch" },
      );
    }
    const account = `urn:li:activity:${extractActivityId(input.parentPostUrl)}`;
    return CommentResultSchema.parse({
      ok: true,
      platform: "linkedin",
      account,
      commentId,
      parentPostUrl: input.parentPostUrl,
    });
  });
}

function assertParentActivityUrl(parentPostUrl: string): void {
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
  if (parsed.hostname !== LINKEDIN_HOSTNAME) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `comment: parentPostUrl host '${parsed.hostname}' is not '${LINKEDIN_HOSTNAME}'`,
      { parentPostUrl },
    );
  }
  if (!ACTIVITY_URN_RE.test(parentPostUrl)) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      "comment: parentPostUrl must match the strict activity URN pattern",
      { parentPostUrl, pattern: ACTIVITY_URN_RE.source },
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

// --- R10: edit a LinkedIn comment in place (menu → Edit → Save changes) -----
//
// Unlike Facebook (where in-place comment edit is broken and we delete+add),
// LinkedIn supports editing a comment's text: open the comment kebab («View
// more options for <Name>'s comment»), click «Edit», replace the body, and
// commit with «Save changes» (NOT «Save», which is a different control).

export interface EditCommentInput {
  parentPostUrl: string;
  /** Read-before-edit oracle: the current text of the comment to edit. */
  oldText: string;
  /** The replacement comment body. */
  text: string;
  profile: string;
}

/** Injectable choreography (test seam): open menu → edit → save changes. */
export interface EditCommentRecorder {
  openCommentMenu(page: Page, input: EditCommentInput): Promise<void>;
  clickEditItem(page: Page): Promise<void>;
  replaceText(page: Page, text: string): Promise<void>;
  clickSaveChanges(page: Page): Promise<void>;
}

export interface EditCommentOptions {
  headed?: boolean;
  profileManager?: ProfileManager;
  page?: Page;
  __recorder?: EditCommentRecorder;
  skipTeardown?: boolean;
}

export async function editComment(
  input: EditCommentInput,
  options: EditCommentOptions = {},
): Promise<CommentResult> {
  assertParentActivityUrl(input.parentPostUrl);
  if (!input.text || input.text.trim() === "") {
    throw new AdapterError(ErrorCode.MISSING_INPUT, "editComment: 'text' is required");
  }
  if (!input.oldText || input.oldText.trim() === "") {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      "editComment: 'oldText' is required (read-before-edit oracle)",
    );
  }

  const profiles = options.profileManager ?? new ProfileManager();
  const profileDir = profiles.ensureProfileExists("linkedin", input.profile);

  if (options.page) {
    return runEditCommentFlow(options.page, input, options.__recorder);
  }

  const session = await launchSession({
    profileDir,
    ...(options.headed !== undefined ? { headed: options.headed } : {}),
  });
  try {
    return await runEditCommentFlow(session.page, input, options.__recorder);
  } finally {
    if (!options.skipTeardown) {
      await session.close();
    }
  }
}

async function runEditCommentFlow(
  page: Page,
  input: EditCommentInput,
  recorder?: EditCommentRecorder,
): Promise<CommentResult> {
  const steps = recorder ?? defaultEditCommentSteps;
  return withScreenshotOnFail(page, "comment-edit", async () => {
    await steps.openCommentMenu(page, input);
    await steps.clickEditItem(page);
    await steps.replaceText(page, input.text);
    await steps.clickSaveChanges(page);
    const account = `urn:li:activity:${extractActivityId(input.parentPostUrl)}`;
    return CommentResultSchema.parse({
      ok: true,
      platform: "linkedin",
      account,
      commentId: "edited",
      parentPostUrl: input.parentPostUrl,
    });
  });
}

const defaultEditCommentSteps: EditCommentRecorder = {
  async openCommentMenu(page: Page, input: EditCommentInput): Promise<void> {
    await page.goto(input.parentPostUrl);
    // Read-before-edit: scope the kebab to the comment block whose rendered text
    // matches `oldText`, so we never edit the wrong comment.
    const block = page
      .locator("article, [data-id^='urn:li:comment']")
      .filter({ hasText: input.oldText })
      .first();
    await block.waitFor({ state: "visible", timeout: 10_000 });
    await block.scrollIntoViewIfNeeded();
    const menu = block.getByRole("button", { name: selectors.commentOptionsMenu }).first();
    await menu.click();
  },

  async clickEditItem(page: Page): Promise<void> {
    const editItem = page.getByRole("menuitem", { name: selectors.commentEditMenuItem }).first();
    await editItem.waitFor({ state: "visible", timeout: 5_000 });
    await editItem.click();
  },

  async replaceText(page: Page, text: string): Promise<void> {
    const editor = page.getByRole("textbox", { name: selectors.commentBox }).first();
    await editor.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Delete");
    await page.keyboard.insertText(text);
  },

  async clickSaveChanges(page: Page): Promise<void> {
    // R10: the commit control is «Save changes», NOT «Save».
    const save = page.getByRole("button", { name: selectors.commentSaveChanges, exact: true });
    await save.first().waitFor({ state: "visible", timeout: 5_000 });
    await save.first().click();
    await page.waitForTimeout(3_000);
  },
};
