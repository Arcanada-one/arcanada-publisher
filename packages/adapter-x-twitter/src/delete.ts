// R13: delete an X tweet or reply with a mandatory read-before-delete oracle.
// Read the rendered target → compare against expectedContent → only then delete
// (caret → Delete → confirm). A mismatch fails closed with no DOM mutation.

import { type Page } from "playwright";
import {
  AdapterError,
  ErrorCode,
  ProfileManager,
  DeleteResultSchema,
  type DeleteInput,
  type DeleteResult,
} from "@arcanada/publisher-core";
import { selectors } from "./selectors.js";
import { launchSession, withScreenshotOnFail } from "./context.js";

const X_HOSTNAMES = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]);

export interface DeleteOptions {
  headed?: boolean;
  profileManager?: ProfileManager;
  page?: Page;
  /** Test seam: read the rendered target text (defaults to tweet-body read). */
  __readContent?: (page: Page, input: DeleteInput) => Promise<string>;
  /** Test seam: perform the destructive caret → Delete → confirm flow. */
  __performDelete?: (page: Page, input: DeleteInput) => Promise<void>;
  skipTeardown?: boolean;
}

export async function del(input: DeleteInput, options: DeleteOptions = {}): Promise<DeleteResult> {
  assertTargetHost(input.targetUrl);
  if (!input.expectedContent || input.expectedContent.trim() === "") {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      "delete: 'expectedContent' is required (read-before-delete oracle)",
    );
  }

  const profiles = options.profileManager ?? new ProfileManager();
  const profileDir = profiles.ensureProfileExists("x", input.profile);

  if (options.page) {
    return runDeleteFlow(options.page, input, options);
  }

  const session = await launchSession({
    profileDir,
    ...(options.headed !== undefined ? { headed: options.headed } : {}),
  });
  try {
    return await runDeleteFlow(session.page, input, options);
  } finally {
    if (!options.skipTeardown) {
      await session.close();
    }
  }
}

async function runDeleteFlow(
  page: Page,
  input: DeleteInput,
  options: DeleteOptions,
): Promise<DeleteResult> {
  return withScreenshotOnFail(page, "delete", async () => {
    const readContent = options.__readContent ?? defaultReadContent;
    const seen = await readContent(page, input);
    if (!seen.includes(input.expectedContent)) {
      throw new AdapterError(
        ErrorCode.VERIFY_FAILED,
        "delete: rendered content does not match expectedContent — aborting without deletion",
        { targetUrl: input.targetUrl, kind: input.kind, xErrorType: "verify_mismatch" },
      );
    }

    const performDelete = options.__performDelete ?? defaultPerformDelete;
    await performDelete(page, input);

    return DeleteResultSchema.parse({
      ok: true,
      platform: "x",
      account: "self",
      deleted: true,
      targetUrl: input.targetUrl,
    });
  });
}

/**
 * PUB-0033: extract the numeric status id from an X status URL
 * (https://x.com/<handle>/status/<id>) so the oracle can target the EXACT
 * tweet, not whichever article renders first.
 */
export function statusIdFromUrl(targetUrl: string): string | null {
  const m = /\/status\/(\d+)/.exec(targetUrl);
  return m ? m[1] : null;
}

/**
 * PUB-0033: locate the article element for the target tweet on a permalink
 * page. A reply permalink renders the PARENT post first, so `.first()` reads the
 * wrong tweet — the read-before-delete oracle then mismatches (fail-closed) or,
 * worse, the caret/Delete acts on the parent. Match the article that contains an
 * anchor to the target status id; fall back to `.first()` only when the id is
 * unknown (e.g. a non-status URL) so existing single-tweet behaviour is kept.
 */
export function locateTargetArticle(page: Page, input: DeleteInput) {
  const id = statusIdFromUrl(input.targetUrl);
  if (id) {
    return page.locator(`article:has(a[href*="/status/${id}"])`).first();
  }
  return page.locator("article").first();
}

async function defaultReadContent(page: Page, input: DeleteInput): Promise<string> {
  await page.goto(input.targetUrl);
  const article = locateTargetArticle(page, input);
  await article.waitFor({ state: "visible", timeout: 10_000 });
  // Prefer the body text node; fall back to the whole article when absent.
  const body = article.locator('[data-testid="tweetText"]').first();
  if ((await body.count()) > 0) {
    return (await body.innerText()) ?? "";
  }
  return (await article.innerText()) ?? "";
}

async function defaultPerformDelete(page: Page, input: DeleteInput): Promise<void> {
  // PUB-0033: open the caret WITHIN the target article so a reply permalink
  // does not act on the parent post's menu.
  const article = locateTargetArticle(page, input);
  const caret = article.locator(selectors.caret).first();
  await caret.waitFor({ state: "visible", timeout: 10_000 });
  await caret.click();
  const deleteItem = page.getByRole("menuitem", { name: /^(Delete|Удалить)$/ }).first();
  await deleteItem.waitFor({ state: "visible", timeout: 5_000 });
  await deleteItem.click();
  const confirm = page.getByRole("button", { name: /^(Delete|Удалить)$/, exact: true });
  await confirm.first().waitFor({ state: "visible", timeout: 5_000 });
  await confirm.first().click();
  await page.waitForTimeout(3_000);
}

function assertTargetHost(targetUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch (cause) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `delete: targetUrl is not a valid URL: ${targetUrl}`,
      { cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
  if (!X_HOSTNAMES.has(parsed.hostname)) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `delete: targetUrl host '${parsed.hostname}' is not an X (Twitter) host`,
      { targetUrl },
    );
  }
}
