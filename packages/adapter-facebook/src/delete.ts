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

const FB_HOSTNAME = "www.facebook.com";

export interface DeleteOptions {
  headed?: boolean;
  profileManager?: ProfileManager;
  page?: Page;
  /** Test seam: read the rendered target text (defaults to article-body read). */
  __readContent?: (page: Page, input: DeleteInput) => Promise<string>;
  /** Test seam: perform the destructive menu→Delete→confirm choreography. */
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

async function defaultReadContent(page: Page, input: DeleteInput): Promise<string> {
  // PUB-0037: on a permalink page the first `[role="article"]` is not always the
  // post body — Facebook renders navigation/related-content articles that can
  // sort ahead of the target, so `.first()` read the wrong node and the
  // read-before-delete oracle mismatched (fail-closed, no deletion). Mirror the
  // LinkedIn PUB-0032 remedy: try the structural article read first; if it does
  // not render OR does not contain the oracle text, fall back to a body-wide
  // innerText read. The oracle compares `expectedContent` against this string —
  // a superset (whole body) is safe (a false match would need the exact post
  // text to appear elsewhere on the permalink, which is the post itself), a miss
  // is not. Fail-closed remains intact: if neither read contains the oracle, the
  // caller aborts without deleting.
  await page.goto(input.targetUrl);
  const article = page.locator('[role="article"]').first();
  try {
    await article.waitFor({ state: "visible", timeout: 10_000 });
    const articleText = (await article.innerText()) ?? "";
    if (articleText.includes(input.expectedContent)) {
      return articleText;
    }
  } catch {
    // fall through to the body-wide read below
  }
  const body = page.locator("body").first();
  await body.waitFor({ state: "visible", timeout: 5_000 });
  return (await body.innerText()) ?? "";
}

async function defaultPerformDelete(page: Page, _input: DeleteInput): Promise<void> {
  const actions = page
    .getByRole("button", { name: selectors.editPostAction })
    .or(page.getByRole("button", { name: selectors.editPostActionEn }))
    .first();
  await actions.waitFor({ state: "visible", timeout: 10_000 });
  await actions.click();

  // PUB-0037: the delete item («Удалить публикацию» / "Delete post") sits
  // directly in the kebab menu — the earlier assumption of an intermediate
  // «Редактировать или удалить» item was wrong. The `deleteMenuItem` selector
  // now covers the «…публикацию»/"…post" label variant, so a direct click is
  // sufficient.
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
