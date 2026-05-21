// Migrated from Arcanada-one/fb-publish@8df49fa51822795075f746ad7389c8bd400b1aa4 on 2026-05-21 (PUB-0003)
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
    const composer = page
      .getByRole("textbox", { name: /(Напишите комментарий|Write a comment)/ })
      .first();
    await composer.waitFor({ state: "visible", timeout: 10_000 });
    await composer.click();
    await page.keyboard.insertText(input.text);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(3_000);

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
