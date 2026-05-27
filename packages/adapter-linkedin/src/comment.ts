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
