// X reply (the "first comment" with CTA links). A reply is itself a tweet, so
// the 280 UTF-16 unit limit and the R12 rate-limit guard apply here too.

import { type Page } from "playwright";
import {
  AdapterError,
  ErrorCode,
  ProfileManager,
  CommentResultSchema,
  type CommentInput,
  type CommentResult,
} from "@arcanada/publisher-core";
import { withinTweetLimit, utf16Length, X_MAX_UTF16_UNITS } from "./counter.js";
import { selectors, isRateLimited } from "./selectors.js";
import { launchSession, withScreenshotOnFail } from "./context.js";

const CREATE_TWEET_API = "/CreateTweet";
const X_HOSTNAMES = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]);

export interface CommentOptions {
  headed?: boolean;
  profileManager?: ProfileManager;
  page?: Page;
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
  if (!withinTweetLimit(input.text)) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `comment: reply exceeds ${X_MAX_UTF16_UNITS} UTF-16 units (got ${utf16Length(input.text)})`,
      { length: utf16Length(input.text), limit: X_MAX_UTF16_UNITS },
    );
  }

  const verifyParent = options.verifyParent ?? defaultVerifyParent;
  if (!(await verifyParent(input.parentPostUrl))) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      `comment: parent tweet is not reachable: ${input.parentPostUrl}`,
      { parentPostUrl: input.parentPostUrl, xErrorType: "verify_mismatch" },
    );
  }

  const profiles = options.profileManager ?? new ProfileManager();
  const profileDir = profiles.ensureProfileExists("x", input.profile);

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

    const blob = await page.content().catch(() => "");
    if (isRateLimited(blob)) {
      throw new AdapterError(
        ErrorCode.RATE_LIMIT,
        "comment: X anti-bot rate-limit detected — stopping (no retry/circumvention)",
        { xErrorType: "rate_limited" },
      );
    }

    const replyBox = page.locator(selectors.tweetTextarea).first();
    await replyBox.waitFor({ state: "visible", timeout: 15_000 });
    await replyBox.click();
    await page.keyboard.insertText(input.text);

    const inline = page.locator(selectors.tweetButtonInline).first();
    const modal = page.locator(selectors.tweetButton).first();
    const button = (await inline.count()) > 0 ? inline : modal;
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(CREATE_TWEET_API) && r.status() === 200, {
        timeout: 20_000,
      }),
      button.click(),
    ]);
    void response;
    await page.waitForTimeout(3_000);

    const link = page.locator('a[href*="/status/"]').first();
    const href = (await link.getAttribute("href")) ?? "";
    const commentId = href.split("/status/")[1]?.split(/[/?]/)[0] ?? "";
    if (!commentId) {
      throw new AdapterError(
        ErrorCode.VERIFY_FAILED,
        "comment: posted but reply id missing from rendered href",
        { parentPostUrl: input.parentPostUrl, xErrorType: "verify_mismatch" },
      );
    }
    return CommentResultSchema.parse({
      ok: true,
      platform: "x",
      account: "self",
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
  if (!X_HOSTNAMES.has(parsed.hostname)) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `comment: parentPostUrl host '${parsed.hostname}' is not an X (Twitter) host`,
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
