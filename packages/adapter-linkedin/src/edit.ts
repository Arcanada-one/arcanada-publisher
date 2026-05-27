// Migrated from Arcanada-one/li-publish@7ddadf81a1662abd66d7f04ea2b7acf737d6afe2 on 2026-05-21 (PUB-0004)
// Source: bin/li-edit-post.sh + bin/li-edit-comment.sh.
//
// INFRA-0261 fix: the legacy `bin/li-edit-post.sh` supported body replace only —
// retrofitting an image onto a previously text-only post required hand-craft in
// the LinkedIn UI. The TypeScript port accepts an optional `imagePath` on the
// core `EditInput` type and attaches it via the same shadow-DOM-bypass flow as
// `publish.ts`.

import { statSync, existsSync } from "node:fs";
import { extname, resolve as resolvePath } from "node:path";
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
import { ACTIVITY_URN_RE, extractActivityId } from "./url-extraction.js";

const IMAGE_EXT_ALLOWLIST = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export interface LinkedInEditInput extends EditInput {
  /** Alias for `imagePath` — INFRA-0261 surface naming compatibility. */
  imageFile?: string;
}

export interface EditOptions {
  headed?: boolean;
  profileManager?: ProfileManager;
  page?: Page;
  skipTeardown?: boolean;
}

export async function edit(
  input: LinkedInEditInput,
  options: EditOptions = {},
): Promise<EditResult> {
  if (!input?.postUrl) {
    throw new AdapterError(ErrorCode.MISSING_INPUT, "edit: 'postUrl' is required");
  }
  if (!ACTIVITY_URN_RE.test(input.postUrl)) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      "edit: postUrl must match the activity URN pattern",
      { postUrl: input.postUrl, pattern: ACTIVITY_URN_RE.source },
    );
  }
  // Resolve INFRA-0261 alias: accept either `imageFile` (legacy bash flag name)
  // or core `imagePath`. The two are mutually consistent — fail if both set to
  // different values.
  const imageCandidate = input.imageFile ?? input.imagePath;
  if (input.imageFile && input.imagePath && input.imageFile !== input.imagePath) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      "edit: 'imageFile' and 'imagePath' are aliases and must not be set to different values",
    );
  }
  if (!input.text && !imageCandidate) {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      "edit: at least one of 'text', 'imagePath', or 'imageFile' must be set",
    );
  }
  const safeImagePath = imageCandidate ? validateImagePath(imageCandidate) : undefined;

  const profiles = options.profileManager ?? new ProfileManager();
  const profileDir = profiles.ensureProfileExists("linkedin", input.profile);

  if (options.page) {
    return runEditFlow(options.page, input, safeImagePath);
  }

  const session = await launchSession({
    profileDir,
    ...(options.headed !== undefined ? { headed: options.headed } : {}),
  });
  try {
    return await runEditFlow(session.page, input, safeImagePath);
  } finally {
    if (!options.skipTeardown) {
      await session.close();
    }
  }
}

async function runEditFlow(
  page: Page,
  input: LinkedInEditInput,
  imagePath: string | undefined,
): Promise<EditResult> {
  return withScreenshotOnFail(page, "edit", async () => {
    await page.goto(input.postUrl);
    const actions = page
      .getByRole("button", { name: selectors.editPostActionRu })
      .or(page.getByRole("button", { name: selectors.editPostActionEn }))
      .first();
    await actions.waitFor({ state: "visible", timeout: 10_000 });
    await actions.click();

    const editItem = page.getByRole("menuitem", { name: selectors.editPostMenuItem }).first();
    await editItem.waitFor({ state: "visible", timeout: 5_000 });
    await editItem.click();

    const dialog = page
      .getByRole("dialog")
      .filter({ has: page.getByText(selectors.composerDialog) })
      .first();
    await dialog.waitFor({ state: "visible", timeout: 10_000 });

    if (input.text) {
      const editor = dialog.getByRole("textbox", { name: selectors.editor }).first();
      await editor.click();
      await page.keyboard.press("Control+A");
      await page.keyboard.press("Delete");
      await page.keyboard.insertText(input.text);
    }

    if (imagePath) {
      // INFRA-0261 + INFRA-0259 reuse: bypass Add-a-photo, attach directly to
      // hidden input[type=file].
      const fileInput = dialog.locator('input[type="file"]').first();
      await fileInput.waitFor({ state: "attached", timeout: 10_000 });
      await fileInput.setInputFiles(imagePath);
      const doneBtn = dialog
        .getByRole("button", { name: selectors.doneButton, exact: true })
        .first();
      await doneBtn.waitFor({ state: "visible", timeout: 30_000 });
      if (await doneBtn.isDisabled()) {
        await page.waitForTimeout(3_000);
      }
      await doneBtn.click();
      await page.waitForTimeout(1_500);
    }

    const save = dialog.getByRole("button", { name: selectors.saveButton, exact: true }).first();
    if ((await save.count()) === 0) {
      throw new AdapterError(ErrorCode.PUBLISH_BUTTON_ABSENT, "edit: save button absent", {
        postUrl: input.postUrl,
      });
    }
    await save.click();
    await page.waitForTimeout(4_000);

    return EditResultSchema.parse({
      ok: true,
      platform: "linkedin",
      account: `urn:li:activity:${extractActivityId(input.postUrl)}`,
      postUrl: input.postUrl,
      edited: true,
    });
  });
}

function validateImagePath(rawPath: string): string {
  if (rawPath.includes("\0")) {
    throw new AdapterError(ErrorCode.INVALID_ARGS, "edit: imagePath contains NUL byte");
  }
  const abs = resolvePath(rawPath);
  if (!existsSync(abs)) {
    throw new AdapterError(ErrorCode.MISSING_INPUT, `edit: image not found: ${abs}`, {
      imagePath: abs,
    });
  }
  const stat = statSync(abs);
  if (!stat.isFile()) {
    throw new AdapterError(ErrorCode.INVALID_ARGS, `edit: imagePath is not a regular file: ${abs}`);
  }
  const ext = extname(abs).toLowerCase();
  if (!IMAGE_EXT_ALLOWLIST.has(ext)) {
    throw new AdapterError(ErrorCode.INVALID_ARGS, `edit: unsupported image extension '${ext}'`, {
      imagePath: abs,
      allowed: Array.from(IMAGE_EXT_ALLOWLIST),
    });
  }
  return abs;
}
