// R13: delete a LinkedIn post or comment with a mandatory read-before-delete
// oracle. The fail-closed safety contract (read → compare → abort) lives here;
// the live «...» control-menu → Delete → confirm choreography in
// `defaultPerformDelete` is hardened against UI drift during the LinkedIn
// adapter phase.

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

const LINKEDIN_HOSTNAME = "www.linkedin.com";

export interface DeleteOptions {
  headed?: boolean;
  profileManager?: ProfileManager;
  page?: Page;
  /** Test seam: read the rendered target text (defaults to article-body read). */
  __readContent?: (page: Page, input: DeleteInput) => Promise<string>;
  /** Test seam: perform the destructive control-menu → Delete → confirm flow. */
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
  const profileDir = profiles.ensureProfileExists("linkedin", input.profile);

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
        { targetUrl: input.targetUrl, kind: input.kind, liErrorType: "verify_mismatch" },
      );
    }

    const performDelete = options.__performDelete ?? defaultPerformDelete;
    await performDelete(page, input);

    return DeleteResultSchema.parse({
      ok: true,
      platform: "linkedin",
      account: "self",
      deleted: true,
      targetUrl: input.targetUrl,
    });
  });
}

async function defaultReadContent(page: Page, input: DeleteInput): Promise<string> {
  await page.goto(input.targetUrl);
  const article = page.locator('[data-urn*="urn:li:activity"], article').first();
  await article.waitFor({ state: "visible", timeout: 10_000 });
  return (await article.innerText()) ?? "";
}

async function defaultPerformDelete(page: Page, _input: DeleteInput): Promise<void> {
  const control = page
    .getByRole("button", { name: selectors.editPostActionRu })
    .or(page.getByRole("button", { name: selectors.editPostActionEn }))
    .first();
  await control.waitFor({ state: "visible", timeout: 10_000 });
  await control.click();

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
  if (parsed.hostname !== LINKEDIN_HOSTNAME) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `delete: targetUrl host '${parsed.hostname}' is not '${LINKEDIN_HOSTNAME}'`,
      { targetUrl },
    );
  }
}
