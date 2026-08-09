// R13: delete a Facebook post or comment with a mandatory read-before-delete
// oracle. The safety contract (read → compare → fail-closed) lives here; the
// live menu→Delete→confirm DOM choreography in `defaultPerformDelete` is
// hardened against UI drift during the Facebook adapter phase.

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
import { extractAccountFromUrl } from "./url-extraction.js";
import { deleteCommentById, type DeleteCommentInput } from "./comment.js";

const FB_HOSTNAME = "www.facebook.com";

/**
 * `DeleteInput` from core carries no author oracle; deleting a COMMENT requires
 * one (a permalink alone cannot prove the comment is ours), so the Facebook
 * adapter widens the input at its boundary — same pattern as
 * `FacebookEditInput`. Core's cross-platform contract stays untouched.
 */
export interface FacebookDeleteInput extends DeleteInput {
  /** Required when `kind === "comment"`: stable profile URL of the comment author. */
  expectedAuthorProfileUrl?: string;
}

export interface DeleteOptions {
  headed?: boolean;
  profileManager?: ProfileManager;
  page?: Page;
  /** Test seam: read the rendered target text (defaults to article-body read). */
  __readContent?: (page: Page, input: DeleteInput) => Promise<string>;
  /** Test seam: perform the destructive menu→Delete→confirm choreography. */
  __performDelete?: (page: Page, input: DeleteInput) => Promise<void>;
  /** Test seam: the comment-deletion arm (defaults to `deleteCommentById`). */
  __deleteComment?: (input: DeleteCommentInput) => Promise<DeleteResult>;
  skipTeardown?: boolean;
}

export async function del(
  input: FacebookDeleteInput,
  options: DeleteOptions = {},
): Promise<DeleteResult> {
  assertTargetHost(input.targetUrl);
  if (!input.expectedContent || input.expectedContent.trim() === "") {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      "delete: 'expectedContent' is required (read-before-delete oracle)",
    );
  }
  // PUB-0039: a comment is not a post — it has no permalink page of its own and
  // its removal must bind to an exact numeric comment id plus an author oracle.
  // Route it to the dedicated hardened flow instead of the post choreography,
  // which would open the PARENT post's action menu and delete the whole post.
  if (input.kind === "comment") {
    return deleteCommentArm(input, options);
  }

  const profiles = options.profileManager ?? new ProfileManager();
  const profileDir = profiles.ensureProfileExists("facebook", input.profile);

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
    // Fail-closed: never delete unless the rendered target matches the oracle.
    if (!seen.includes(input.expectedContent)) {
      throw new AdapterError(
        ErrorCode.VERIFY_FAILED,
        "delete: rendered content does not match expectedContent — aborting without deletion",
        { targetUrl: input.targetUrl, kind: input.kind, fbErrorType: "verify_mismatch" },
      );
    }

    const performDelete = options.__performDelete ?? defaultPerformDelete;
    await performDelete(page, input);

    return DeleteResultSchema.parse({
      ok: true,
      platform: "facebook",
      account: extractAccountFromUrl(input.targetUrl),
      deleted: true,
      targetUrl: input.targetUrl,
    });
  });
}

/**
 * Comment arm: derive the exact numeric comment id and the parent post URL from
 * the comment permalink, then delegate to the hardened `deleteCommentById`
 * (bind-to-id → verify author → verify body → confirm → prove detached).
 */
async function deleteCommentArm(
  input: FacebookDeleteInput,
  options: DeleteOptions,
): Promise<DeleteResult> {
  const target = new URL(input.targetUrl);
  const commentId = target.searchParams.get("comment_id");
  if (!commentId) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      "delete --kind comment: targetUrl must be a comment permalink carrying 'comment_id'",
      { targetUrl: input.targetUrl },
    );
  }
  if (!input.expectedAuthorProfileUrl || input.expectedAuthorProfileUrl.trim() === "") {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      "delete --kind comment: 'expectedAuthorProfileUrl' is required (ownership oracle)",
      { targetUrl: input.targetUrl },
    );
  }
  const parent = new URL(input.targetUrl);
  parent.searchParams.delete("comment_id");
  parent.searchParams.delete("reply_comment_id");

  const run = options.__deleteComment ?? ((i: DeleteCommentInput) => deleteCommentById(i, options));
  return run({
    parentPostUrl: parent.href,
    commentId,
    expectedAuthorProfileUrl: input.expectedAuthorProfileUrl,
    expectedContent: input.expectedContent,
    profile: input.profile,
  });
}

/**
 * Read the body of the post named by `targetUrl` — and of no other post.
 *
 * §6.8: a permalink page renders MULTIPLE articles (the target plus recommended
 * and sibling items), so `[role="article"].first()` is frequently somebody
 * else's content. Feeding that to the read-before-delete oracle is worse than
 * useless: a spurious match would delete the wrong post, and a spurious
 * mismatch blocks a legitimate delete. Observed 2026-08-09 while removing a
 * duplicate — the oracle compared against a neighbouring post and refused
 * forever.
 *
 * The permalink's own `pfbid` is the only stable identity available, so bind to
 * the article carrying a link to it. If no such article exists, fail rather
 * than fall back to a positional guess.
 */
export async function defaultReadContent(page: Page, input: DeleteInput): Promise<string> {
  await page.goto(input.targetUrl);
  const permalinkId = extractPermalinkId(input.targetUrl);
  const article =
    permalinkId === null
      ? page.locator('[role="article"]').first()
      : page.locator(`[role="article"]:has(a[href*="${permalinkId}"])`).first();
  await article.waitFor({ state: "visible", timeout: 10_000 });
  return (await article.innerText()) ?? "";
}

/** Extract the `pfbid…` identity from a Facebook post permalink, if present. */
export function extractPermalinkId(targetUrl: string): string | null {
  const match = /pfbid[A-Za-z0-9]+/.exec(targetUrl);
  return match === null ? null : match[0];
}

async function defaultPerformDelete(page: Page, _input: DeleteInput): Promise<void> {
  const actions = page
    .getByRole("button", { name: selectors.editPostAction })
    .or(page.getByRole("button", { name: selectors.editPostActionEn }))
    .first();
  await actions.waitFor({ state: "visible", timeout: 10_000 });
  await actions.click();

  const deleteItem = page.getByRole("menuitem", { name: selectors.deleteMenuItem }).first();
  await deleteItem.waitFor({ state: "visible", timeout: 5_000 });
  await deleteItem.click();

  const confirm = page.getByRole("button", { name: selectors.confirmDelete, exact: true });
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
  if (parsed.hostname !== FB_HOSTNAME) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `delete: targetUrl host '${parsed.hostname}' is not '${FB_HOSTNAME}'`,
      { targetUrl },
    );
  }
}
