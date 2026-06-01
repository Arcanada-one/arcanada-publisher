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
  await page.goto(input.targetUrl);
  const article = page.locator('[role="article"]').first();
  await article.waitFor({ state: "visible", timeout: 10_000 });
  return (await article.innerText()) ?? "";
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
