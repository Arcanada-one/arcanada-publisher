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
    await page.goto(input.postUrl, { waitUntil: "domcontentloaded" });
    // PUB-0062: FB profile-post permalinks hydrate the surrounding feed
    // asynchronously; the per-post "Actions" kebab can take well over 10s to
    // become visible. Settle briefly and give it a generous window.
    await page.waitForTimeout(4_000);
    // PUB-0062: FB permalinks occasionally auto-open a stray overlay (e.g. the
    // "no more stories" modal) that covers the per-post kebab and blocks the
    // Actions button. Dismiss it via its own OK/Close button ONLY — do NOT press
    // Escape, which collapses the post-permalink modal itself and drops the page
    // back to the news feed (the kebab then belongs to some other feed post).
    for (let i = 0; i < 3; i++) {
      const dialogClose = page
        .getByRole("button", { name: /^(OK|ОК)$/, exact: true })
        .first();
      if (await dialogClose.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await dialogClose.click().catch(() => {});
        await page.waitForTimeout(800);
      } else {
        break;
      }
    }
    await page.waitForTimeout(500);
    const actions = page
      .getByRole("button", { name: selectors.editPostAction })
      .or(page.getByRole("button", { name: selectors.editPostActionEn }))
      .first();
    await actions.waitFor({ state: "visible", timeout: 30_000 });

    const editItem = page
      .getByRole("menuitem", { name: selectors.editPostMenuItem })
      .or(page.getByRole("menuitem", { name: selectors.editPostMenuItemFallback }))
      .first();
    // PUB-0062: the kebab menu sometimes fails to open on the first click (a
    // hover/focus race); retry the Actions click until the Edit menu item shows.
    let editVisible = false;
    for (let attempt = 0; attempt < 3 && !editVisible; attempt++) {
      await actions.click();
      editVisible = await editItem.isVisible({ timeout: 6_000 }).catch(() => false);
      if (!editVisible) {
        // Re-click the kebab to toggle the (wrong/partial) menu closed instead of
        // pressing Escape, which would collapse the post-permalink modal itself.
        await actions.click().catch(() => {});
        await page.waitForTimeout(600);
      }
    }
    if (!editVisible) {
      await editItem.waitFor({ state: "visible", timeout: 6_000 });
    }
    await editItem.click();

    if (input.text) {
      const textbox = page.getByRole("textbox").first();
      await textbox.click();
      await page.waitForTimeout(400);
      // PUB-0062: the 2026 FB post-edit composer is a Lexical contenteditable that
      // ignores Control/Meta+A → Delete/Backspace and swallows a following
      // insertText (it appends to the un-cleared body and then stalls, leaving the
      // old text in place). The reliable clear is per-character Backspace from the
      // end; only once the field is genuinely empty does insertText commit the full
      // body. Verify the field is empty before typing so we never edit-append.
      const existing = ((await textbox.innerText().catch(() => "")) || "").trim();
      await page.keyboard.press("End").catch(() => {});
      for (let i = 0; i < existing.length + 40; i++) {
        await page.keyboard.press("Backspace");
      }
      await page.waitForTimeout(300);
      const cleared = ((await textbox.innerText().catch(() => "")) || "").trim();
      if (cleared.length > 0) {
        throw new AdapterError(ErrorCode.VERIFY_FAILED, "edit-post: composer would not clear", {
          postUrl: input.postUrl,
        });
      }
      await page.keyboard.insertText(input.text);
      await page.waitForTimeout(800);
    }

    // PUB-0062: the 2026 FB "Редактировать публикацию" dialog turned edit into a
    // multi-step composer flow — a post that carries media shows a «Далее» / "Next"
    // button first, and the «Сохранить» / "Save" button only appears on the next
    // screen. Advance through «Далее» (if present and no Save yet) before looking
    // for Save, so we don't fail with "save button absent" on media posts.
    let save = page.getByRole("button", { name: selectors.saveButton, exact: true });
    if ((await save.count()) === 0) {
      const next = page.getByRole("button", { name: selectors.nextButton, exact: true });
      if ((await next.count()) > 0) {
        await next.first().click();
        await page.waitForTimeout(2_000);
        save = page.getByRole("button", { name: selectors.saveButton, exact: true });
      }
    }
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
