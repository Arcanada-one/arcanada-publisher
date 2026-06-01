// Migrated from Arcanada-one/fb-publish@8df49fa51822795075f746ad7389c8bd400b1aa4 on 2026-05-21 (PUB-0003)
// Source: bin/fb-edit-post.sh + bin/fb-edit-comment.sh.

import { type Page } from "playwright";
import {
  AdapterError,
  ErrorCode,
  ProfileManager,
  EditResultSchema,
  type EditInput,
  type EditResult,
} from "@arcanada/publisher-core";
import { selectors } from "./selectors.js";
import { launchSession, withScreenshotOnFail } from "./context.js";
import { extractAccountFromUrl } from "./url-extraction.js";

/**
 * `EditInput` from core supports edit-post only; for edit-comment we accept
 * a discriminator field at the adapter boundary.
 */
export interface FacebookEditInput extends EditInput {
  /** Set to edit an existing comment instead of the post body. */
  commentId?: string;
}

export interface EditOptions {
  headed?: boolean;
  profileManager?: ProfileManager;
  page?: Page;
  /** Test seam: override the dispatch arm explicitly (for routing tests). */
  __editPost?: (page: Page, input: FacebookEditInput) => Promise<EditResult>;
  __editComment?: (page: Page, input: FacebookEditInput) => Promise<EditResult>;
  skipTeardown?: boolean;
}

export async function edit(
  input: FacebookEditInput,
  options: EditOptions = {},
): Promise<EditResult> {
  if (!input?.postUrl) {
    throw new AdapterError(ErrorCode.MISSING_INPUT, "edit: 'postUrl' is required");
  }
  if (!input.text && !input.imagePath) {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      "edit: at least one of 'text' or 'imagePath' must be set",
    );
  }

  const profiles = options.profileManager ?? new ProfileManager();
  const profileDir = profiles.ensureProfileExists("facebook", input.profile);

  const runWith = async (page: Page): Promise<EditResult> => {
    const dispatcher = input.commentId
      ? (options.__editComment ?? editCommentFlow)
      : (options.__editPost ?? editPostFlow);
    return dispatcher(page, input);
  };

  if (options.page) {
    return runWith(options.page);
  }

  const session = await launchSession({
    profileDir,
    ...(options.headed !== undefined ? { headed: options.headed } : {}),
  });
  try {
    return await runWith(session.page);
  } finally {
    if (!options.skipTeardown) {
      await session.close();
    }
  }
}

async function editPostFlow(page: Page, input: FacebookEditInput): Promise<EditResult> {
  return withScreenshotOnFail(page, "edit-post", async () => {
    await page.goto(input.postUrl);
    const actions = page
      .getByRole("button", { name: selectors.editPostAction })
      .or(page.getByRole("button", { name: selectors.editPostActionEn }))
      .first();
    await actions.waitFor({ state: "visible", timeout: 10_000 });
    await actions.click();

    const editItem = page
      .getByRole("menuitem", { name: selectors.editPostMenuItem })
      .or(page.getByRole("menuitem", { name: selectors.editPostMenuItemFallback }))
      .first();
    await editItem.waitFor({ state: "visible", timeout: 5_000 });
    await editItem.click();

    if (input.text) {
      const textbox = page.getByRole("textbox").first();
      await textbox.click();
      await page.keyboard.press("Control+A");
      await page.keyboard.press("Delete");
      await page.keyboard.insertText(input.text);
    }

    const save = page.getByRole("button", { name: selectors.saveButton, exact: true });
    if ((await save.count()) === 0) {
      throw new AdapterError(ErrorCode.PUBLISH_BUTTON_ABSENT, "edit-post: save button absent", {
        postUrl: input.postUrl,
      });
    }
    await save.first().click();
    await page.waitForTimeout(3_000);

    return finalizeEditResult(page, input);
  });
}

// R10: in-place editing of a Facebook comment's contenteditable field is
// broken (the field collapses to its first line on focus/clear and keystrokes
// do not print). Changing a comment's text MUST go through the
// delete-old + add-new path. This arm fails closed and routes the caller to
// `replaceComment` rather than performing the broken in-place edit.
async function editCommentFlow(_page: Page, input: FacebookEditInput): Promise<EditResult> {
  throw new AdapterError(
    ErrorCode.INVALID_ARGS,
    "edit-comment: in-place comment edit is unsafe on Facebook (R10) — " +
      "use replaceComment() (delete old + add new) to change a comment's text",
    { postUrl: input.postUrl, commentId: input.commentId, fbErrorType: "verify_mismatch" },
  );
}

async function finalizeEditResult(page: Page, input: FacebookEditInput): Promise<EditResult> {
  await page.reload();
  const editedMarker = page.getByText(selectors.editedMarker).first();
  let edited = false;
  try {
    edited = await editedMarker.isVisible({ timeout: 5_000 } as never);
  } catch {
    edited = false;
  }
  return EditResultSchema.parse({
    ok: true,
    platform: "facebook",
    account: extractAccountFromUrl(input.postUrl),
    postUrl: input.postUrl,
    edited,
  });
}
