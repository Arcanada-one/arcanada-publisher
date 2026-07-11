// Migrated from Arcanada-one/li-publish@7ddadf81a1662abd66d7f04ea2b7acf737d6afe2 on 2026-05-21
// Source: bin/li-comment.sh (first-comment publish flow).
//
// Memory reference: [[playwright-submit-vs-trigger]] — LinkedIn renders TWO
// buttons under the same logical «comment» label: a *trigger* (opens the
// reply composer; identified by `aria-label`) and a *submit* (sends the
// composed text; no aria-label, just an inner-text «Comment»). The legacy
// bash li-comment.sh:144-178 disambiguates by querying the submit button
// inside the open composer scope. We preserve that semantics: locate the
// editable textbox, type, then submit through the enabled localized button in
// the 2026 TipTap composer. Ctrl+Enter remains only for the legacy Quill UI.

import { createHash } from "node:crypto";
import { type Locator, type Page } from "playwright";
import {
  AdapterError,
  ErrorCode,
  ProfileManager,
  CommentResultSchema,
  type CommentInput,
  type CommentResult,
} from "@arcanada/publisher-core";
import { launchSession, withScreenshotOnFail } from "./context.js";
import { cssSelectors, selectors } from "./selectors.js";
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
    const resolved = await resolveCommentEditor(page);
    const baseline = await readExactCommentMatches(page, input.text);
    if (baseline.length > 0) {
      throw new AdapterError(
        ErrorCode.VERIFY_FAILED,
        "comment: exact text already exists before submit; refusing ambiguous duplicate",
        { parentPostUrl: input.parentPostUrl, liErrorType: "verify_mismatch" },
      );
    }

    await resolved.editor.click();
    await page.keyboard.insertText(input.text);

    // Re-scan immediately before the submit action. A virtualized thread can
    // finish hydrating while the composer is being filled; treating a late old
    // match as the newly submitted comment would be a false positive.
    const preSubmit = await readExactCommentMatches(page, input.text);
    if (preSubmit.length > 0) {
      throw new AdapterError(
        ErrorCode.VERIFY_FAILED,
        "comment: exact text appeared before submit; refusing ambiguous duplicate",
        { parentPostUrl: input.parentPostUrl, liErrorType: "verify_mismatch" },
      );
    }

    if (resolved.kind === "tiptap") await submitTipTapComment(page, resolved.editor);
    else await page.keyboard.press("Control+Enter");

    const rendered = await waitForExactComment(page, input.text);
    const activityId = extractActivityId(input.parentPostUrl);
    const commentId = rendered.id || verifiedEvidenceId(activityId, input.text);
    const account = `urn:li:activity:${activityId}`;
    return CommentResultSchema.parse({
      ok: true,
      platform: "linkedin",
      account,
      commentId,
      parentPostUrl: input.parentPostUrl,
    });
  });
}

interface ResolvedCommentEditor {
  editor: Locator;
  kind: "tiptap" | "legacy";
}

/**
 * PUB-0032: resolve the comment composer textbox tolerant to UI drift. The 2026
 * LinkedIn UI localizes the accessible name and now uses TipTap in its 2026
 * composer. Resolve TipTap structurally first so its button-submit contract is
 * unambiguous; only an absent TipTap editor may fall back to legacy Quill role
 * and structural locators.
 */
async function resolveCommentEditor(page: Page): Promise<ResolvedCommentEditor> {
  const tiptap = page.locator(cssSelectors.commentTipTapEditor).first();
  try {
    await tiptap.waitFor({ state: "visible", timeout: 4_000 });
    return { editor: tiptap, kind: "tiptap" };
  } catch {
    // Continue to legacy Quill locators only when TipTap is absent.
  }
  const byName = page.getByRole("textbox", { name: selectors.commentBox }).first();
  try {
    await byName.waitFor({ state: "visible", timeout: 4_000 });
    return { editor: byName, kind: "legacy" };
  } catch {
    const byCss = page.locator(cssSelectors.commentLegacyEditor).first();
    await byCss.waitFor({ state: "visible", timeout: 8_000 });
    return { editor: byCss, kind: "legacy" };
  }
}

async function submitTipTapComment(page: Page, editor: Locator): Promise<void> {
  const composer = editor.locator("xpath=ancestor::form[1]");
  const submit = composer
    .getByRole("button", { name: selectors.commentSubmitButton, exact: true })
    .first();
  try {
    await submit.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    throw new AdapterError(
      ErrorCode.PUBLISH_BUTTON_ABSENT,
      "comment: enabled TipTap submit button was not found in the composer",
      { liErrorType: "publish_button_absent" },
    );
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const enabled = await submit.isEnabled().catch(() => false);
    if (enabled) {
      try {
        await submit.click({ timeout: 5_000 });
        return;
      } catch {
        break;
      }
    }
    if (attempt < 19) await page.waitForTimeout(250);
  }

  throw new AdapterError(
    ErrorCode.PUBLISH_BUTTON_ABSENT,
    "comment: enabled TipTap submit button was not found in the composer",
    { liErrorType: "publish_button_absent" },
  );
}

interface RenderedCommentMatch {
  text: string;
  id: string;
}

async function waitForExactComment(page: Page, text: string): Promise<RenderedCommentMatch> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const matches = await readExactCommentMatches(page, text);
    if (matches[0]) return matches.find((match) => match.id) ?? matches[0];
    await page.waitForTimeout(250);
  }
  throw new AdapterError(
    ErrorCode.VERIFY_FAILED,
    "comment: exact submitted text did not appear newly in the comment thread",
    { liErrorType: "verify_mismatch" },
  );
}

async function readExactCommentMatches(
  page: Page,
  expectedText: string,
): Promise<RenderedCommentMatch[]> {
  return page.evaluate((expected) => {
    interface BrowserElement {
      innerText: string;
      closest(selector: string): BrowserElement | null;
      getAttribute(name: string): string | null;
      querySelectorAll(selector: string): ArrayLike<BrowserElement>;
    }
    const browserDocument = (
      globalThis as unknown as {
        document: { querySelectorAll(selector: string): ArrayLike<BrowserElement> };
      }
    ).document;
    const containers = Array.from(
      browserDocument.querySelectorAll(
        "[data-id^='urn:li:comment'], .comments-comment-item, [class*='comments-comment-item']",
      ),
    );
    const seen = new Set<BrowserElement>();
    const matches: Array<{ text: string; id: string }> = [];
    for (const container of containers) {
      if (seen.has(container)) continue;
      seen.add(container);
      const bodies = [
        container,
        ...Array.from(
          container.querySelectorAll(
            ".comments-comment-item__main-content, .comments-comment-item-content-body, .update-components-text, [data-testid='comment-content'], span[dir='ltr'], p",
          ),
        ),
      ];
      if (!bodies.some((body) => body.innerText === expected)) continue;
      const raw = container.closest("[data-id^='urn:li:comment']")?.getAttribute("data-id") ?? "";
      const id = /urn:li:comment:\(.*?,(\d+)\)/.exec(raw)?.[1] ?? "";
      matches.push({ text: expected, id });
    }
    return matches;
  }, expectedText);
}

function verifiedEvidenceId(activityId: string, text: string): string {
  const digest = createHash("sha256")
    .update(`${activityId}\0${text}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  return `verified:${activityId}:${digest}`;
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
    // PUB-0032: same drift-tolerant resolver as the publish-comment flow.
    const { editor } = await resolveCommentEditor(page);
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
