// Migrated from Arcanada-one/li-publish@7ddadf81a1662abd66d7f04ea2b7acf737d6afe2 on 2026-05-21 (PUB-0004)
// Source: bin/li-publish.sh (publish flow, lines 200-460).
//
// INFRA-0259 fix (shadow-DOM image intercept): we never click the «Add a
// photo» / «Добавить фото» button — that path is intercepted by a LinkedIn
// `interop-outlet` shadow root and fails with «pointer events intercepted».
// Instead we wait for the composer dialog and call `setInputFiles` directly
// on the hidden `input[type=file]` inside the dialog. Native Playwright
// locators auto-pierce shadow DOM, but we skip the click entirely — the file
// input handler accepts files without the modal-helper detour.
//
// INFRA-0260 fix (URN extraction): we walk visible `<a href>` candidates,
// filter through the strict `ACTIVITY_URN_RE` in `url-extraction.ts`, and fall
// back to `/in/me/recent-activity/all/` only if the toast yielded nothing.
// Recommended-card `/company/.../posts/` candidates are rejected by
// construction.

import { statSync, existsSync } from "node:fs";
import { extname, resolve as resolvePath } from "node:path";
import { type Page } from "playwright";
import {
  AdapterError,
  ErrorCode,
  ProfileManager,
  PublishResultSchema,
  type PublishInput,
  type PublishResult,
} from "@arcanada/publisher-core";
import { selectors } from "./selectors.js";
import { launchSession, withScreenshotOnFail } from "./context.js";
import { ACTIVITY_URN_RE, extractActivityUrn, pickFirstActivityHref } from "./url-extraction.js";
import { classifyLiError, mapLiError } from "./errors.js";

const IMAGE_EXT_ALLOWLIST = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const LINKEDIN_FEED = "https://www.linkedin.com/feed/";
const RECENT_ACTIVITY = "https://www.linkedin.com/in/me/recent-activity/all/";
const POST_BODY_LIMIT = 3000;

export interface PublishOptions {
  headed?: boolean;
  profileManager?: ProfileManager;
  /** Inject a pre-built page (smoke / integration). When set, `launchSession` is skipped. */
  page?: Page;
  /** Skip browser teardown — used by callers that own the session. */
  skipTeardown?: boolean;
}

export async function publish(
  input: PublishInput,
  options: PublishOptions = {},
): Promise<PublishResult> {
  if (!input?.text || input.text.trim() === "") {
    throw new AdapterError(ErrorCode.MISSING_INPUT, "publish: 'text' is required");
  }
  if (input.text.length > POST_BODY_LIMIT) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `publish: text exceeds LinkedIn limit of ${POST_BODY_LIMIT} characters (got ${input.text.length})`,
    );
  }
  const safeImagePath = input.imagePath ? validateImagePath(input.imagePath) : undefined;
  const profiles = options.profileManager ?? new ProfileManager();
  const profileDir = profiles.ensureProfileExists("linkedin", input.profile);

  if (options.page) {
    return runPublishFlow(options.page, input, safeImagePath);
  }

  const session = await launchSession({
    profileDir,
    ...(options.headed !== undefined ? { headed: options.headed } : {}),
  });
  try {
    return await runPublishFlow(session.page, input, safeImagePath);
  } finally {
    if (!options.skipTeardown) {
      await session.close();
    }
  }
}

async function runPublishFlow(
  page: Page,
  input: PublishInput,
  imagePath: string | undefined,
): Promise<PublishResult> {
  return withScreenshotOnFail(page, "publish", async () => {
    await page.goto(LINKEDIN_FEED);

    const startPost = page.getByRole("button", { name: selectors.startPostButton }).first();
    try {
      await startPost.waitFor({ state: "visible", timeout: 10_000 });
    } catch (cause) {
      const blob = await safeContent(page);
      const klass = classifyLiError(blob);
      throw mapLiError(klass === "unknown" ? "not_logged_in" : klass, { cause });
    }

    if (input.dryRun) {
      return PublishResultSchema.parse({
        ok: true,
        platform: "linkedin",
        account: "dry-run",
        postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:0/",
        attachments: imagePath ? [{ kind: "image", src: imagePath }] : [],
        commentIds: [],
      });
    }

    await startPost.click();
    const dialog = page
      .getByRole("dialog")
      .filter({ has: page.getByText(selectors.composerDialog) })
      .first();
    await dialog.waitFor({ state: "visible", timeout: 15_000 });

    const editor = dialog.getByRole("textbox", { name: selectors.editor }).first();
    await editor.click();
    await page.keyboard.insertText(input.text);

    if (imagePath) {
      // INFRA-0259 fix: target the hidden input directly; do NOT click «Add a photo».
      // The composer renders a hidden <input type="file"> at dialog scope before
      // the photo modal opens; setInputFiles populates it without going through
      // the shadow-DOM-intercepted button.
      const fileInput = dialog.locator('input[type="file"]').first();
      await fileInput.waitFor({ state: "attached", timeout: 10_000 });
      await fileInput.setInputFiles(imagePath);
      // Wait for the upload-complete state — Done/Next button enabled.
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

    const postBtn = page.getByRole("button", { name: selectors.postButton, exact: true });
    if ((await postBtn.count()) === 0) {
      throw mapLiError("composer_not_found");
    }
    if (await postBtn.first().isDisabled()) {
      throw mapLiError("publish_button_disabled");
    }
    await postBtn.first().click();
    await page.waitForTimeout(6_000);

    const postUrl = await extractPublishedUrl(page);

    return PublishResultSchema.parse({
      ok: true,
      platform: "linkedin",
      account: extractAccountFromActivityUrl(postUrl),
      postUrl,
      attachments: imagePath ? [{ kind: "image", src: imagePath }] : [],
      commentIds: [],
    });
  });
}

/**
 * INFRA-0260 fix: visible-only candidate walk → strict regex normaliser →
 * fallback to /in/me/recent-activity/all/. Throws `urn_not_found` if neither
 * source yields a clean activity URL.
 */
async function extractPublishedUrl(page: Page): Promise<string> {
  // Toast / inline links: collect href list from visible <a> nodes, then pick.
  // The page.evaluate callback runs in the browser context — DOM types live
  // there. We cast through `unknown` to avoid pulling DOM lib into the
  // node-side compile target.
  const collectVisibleHrefs = `
    Array.from(document.querySelectorAll('a[href]'))
      .filter(a => a.offsetParent !== null)
      .map(a => a.href)
  `;
  const toastCandidates = (await page.evaluate(collectVisibleHrefs)) as string[];
  const fromToast = pickFirstActivityHref(toastCandidates);
  if (fromToast) {
    return fromToast;
  }

  // Fallback: navigate to recent-activity feed, grab visible candidates.
  await page.goto(RECENT_ACTIVITY, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4_000);
  const feedCandidates = (await page.evaluate(collectVisibleHrefs)) as string[];
  const fromFeed = pickFirstActivityHref(feedCandidates);
  if (fromFeed) {
    return fromFeed;
  }

  throw mapLiError("urn_not_found", {
    extra: {
      toastCandidateCount: toastCandidates.length,
      feedCandidateCount: feedCandidates.length,
    },
  });
}

function validateImagePath(rawPath: string): string {
  if (rawPath.includes("\0")) {
    throw new AdapterError(ErrorCode.INVALID_ARGS, "publish: imagePath contains NUL byte");
  }
  const abs = resolvePath(rawPath);
  if (!existsSync(abs)) {
    throw new AdapterError(ErrorCode.MISSING_INPUT, `publish: image not found: ${abs}`, {
      imagePath: abs,
    });
  }
  const stat = statSync(abs);
  if (!stat.isFile()) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `publish: imagePath is not a regular file: ${abs}`,
    );
  }
  const ext = extname(abs).toLowerCase();
  if (!IMAGE_EXT_ALLOWLIST.has(ext)) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `publish: unsupported image extension '${ext}'`,
      { imagePath: abs, allowed: Array.from(IMAGE_EXT_ALLOWLIST) },
    );
  }
  return abs;
}

async function safeContent(page: Page): Promise<string> {
  try {
    return await page.content();
  } catch {
    return "";
  }
}

/** LinkedIn activity URLs are not tied to an account slug; we return `"self"`
 *  for owner-published posts since `extractActivityUrn` is profile-agnostic.
 *  Future enhancement (post-PUB-0008): derive author from DOM author-card. */
function extractAccountFromActivityUrl(activityUrl: string): string {
  // Sanity-check format; throws if drift breaks contract.
  extractActivityUrn(activityUrl);
  if (!ACTIVITY_URN_RE.test(activityUrl)) {
    return "unknown";
  }
  return "self";
}
