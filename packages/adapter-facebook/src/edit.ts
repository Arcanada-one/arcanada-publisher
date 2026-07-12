// Migrated from Arcanada-one/fb-publish@8df49fa51822795075f746ad7389c8bd400b1aa4 on 2026-05-21
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
import { typeMultiline } from "./input.js";
import {
  canonicalFacebookPostUrl,
  facebookProfileIdentity,
  normalizeFacebookText,
  readFacebookPost,
  type FacebookPostReadback,
} from "./post-readback.js";

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
  if (!input.commentId && (!input.expectedContent || !input.expectedAuthorProfileUrl)) {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      "edit-post requires expectedContent and expectedAuthorProfileUrl",
    );
  }
  if (!input.commentId && input.expectedMediaKind !== "image") {
    throw new AdapterError(ErrorCode.INVALID_ARGS, "edit-post requires expectedMediaKind=image");
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
    const target = canonicalFacebookPostUrl(input.postUrl);
    const expectedAuthor = facebookProfileIdentity(input.expectedAuthorProfileUrl!);
    const before = await readFacebookPost(page, target);
    if (
      before.canonicalPermalink !== target ||
      before.authorProfileIdentity !== expectedAuthor ||
      before.normalizedBody !== normalizeFacebookText(input.expectedContent!) ||
      !before.hasImage
    ) {
      throw new AdapterError(ErrorCode.VERIFY_FAILED, "edit-post: pre-edit oracle mismatch", {
        stage: "pre_edit_verify",
      });
    }
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
      await typeMultiline(page, input.text, { submit: false });
      const composerBody = normalizeFacebookText(await textbox.innerText().catch(() => ""));
      if (composerBody !== normalizeFacebookText(input.text)) {
        throw new AdapterError(ErrorCode.VERIFY_FAILED, "edit-post: exact composer body mismatch", {
          stage: "pre_save_text",
        });
      }
    }

    const save = page.getByRole("button", { name: selectors.saveButton, exact: true });
    if ((await save.count()) === 0) {
      throw new AdapterError(ErrorCode.PUBLISH_BUTTON_ABSENT, "edit-post: save button absent", {
        postUrl: input.postUrl,
      });
    }
    const after = await completePostEditMutation({
      save: () => save.first().click(),
      settle: () => page.waitForTimeout(3_000),
      readback: () => readFacebookPost(page, target),
      before,
      target,
      expectedAuthor,
      expectedBody: input.text!,
    });
    void after;
    try {
      return EditResultSchema.parse({
        ok: true,
        platform: "facebook",
        account: extractAccountFromUrl(target),
        postUrl: target,
        edited: true,
      });
    } catch {
      throw unknownEdit();
    }
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

function unknownEdit(): AdapterError {
  return new AdapterError(ErrorCode.VERIFY_FAILED, "edit-post: state unknown after save", {
    unknown: true,
    reconcileRequired: true,
    stage: "post_edit_verify",
    artifactId: "facebook-edit-unknown",
  });
}

export async function completePostEditMutation(input: {
  save(): Promise<unknown>;
  settle(): Promise<unknown>;
  readback(): Promise<FacebookPostReadback>;
  before: FacebookPostReadback;
  target: string;
  expectedAuthor: string;
  expectedBody: string;
}): Promise<FacebookPostReadback> {
  try {
    await input.save();
    await input.settle();
    const after = await input.readback();
    if (
      after.canonicalPermalink !== input.target ||
      after.authorProfileIdentity !== input.expectedAuthor ||
      after.normalizedBody !== normalizeFacebookText(input.expectedBody) ||
      !after.hasImage ||
      after.mediaIdentity !== input.before.mediaIdentity
    )
      throw new Error("post-edit mismatch");
    return after;
  } catch {
    throw unknownEdit();
  }
}
