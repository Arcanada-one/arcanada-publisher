// Facebook publish flow, hardened with the learned publish mechanics:
// image-mandatory (R1), image-first ordering (R8), Shift+Enter multiline (R6),
// pre/post-submit verification with a network-level publish confirmation (R7),
// and a ≥12s settle window (R11).
//
// The DOM choreography is split into named steps behind a recorder seam
// (`PublishStepRecorder`) so the ordering invariants (image-before-text,
// pre-verify-before-submit, post-verify-after-submit) are unit-testable on a
// fake page without a browser.

import { statSync, existsSync } from "node:fs";
import { basename, extname, resolve as resolvePath } from "node:path";
import { createHash } from "node:crypto";
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
import { extractPostUrlFromHref, extractAccountFromUrl } from "./url-extraction.js";
import { classifyFbError, mapFbError } from "./errors.js";
import { typeMultiline } from "./input.js";
import { VERIFY_DELAY_MS } from "./timing.js";
import {
  canonicalFacebookPostUrl,
  facebookProfileIdentity,
  normalizeFacebookText,
  readFacebookPost,
  type FacebookPostReadback,
} from "./post-readback.js";

const MEDIA_EXT_ALLOWLIST = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".mp4",
  ".m4v",
  ".mov",
  ".webm",
]);
const FB_HOME = "https://www.facebook.com/";
const FB_ME = "https://www.facebook.com/me";
/** R7: a GraphQL 200 response is the real publish confirmation (DOM caches/lies). */
const FB_GRAPHQL_PATH = "/api/graphql/";
const IMAGE_RERENDER_SETTLE_MS = 10_000;

/** Result of the R7 pre-submit composer snapshot. */
export interface PreSubmitSnapshot {
  normalizedBody: string;
  attachments: Array<{ name: string; size: number }>;
}

/**
 * Injectable publish steps (test seam). Each step is a named slice of the DOM
 * choreography; the orchestrator calls them in the R8/R7 order. Unit tests
 * provide a recorder to assert ordering without a browser.
 */
export interface PublishStepRecorder {
  openComposer(page: Page): Promise<void>;
  /** R8/R1: attach every image first; the composer re-renders after upload. */
  uploadImages(page: Page, imagePaths: string[]): Promise<void>;
  /** R6/R8: type the body AFTER the image upload settles. */
  typeBody(page: Page, text: string): Promise<void>;
  /** R7: snapshot the composer — both text and image must be present. */
  preSubmitSnapshot(page: Page, input: PublishInput): Promise<PreSubmitSnapshot>;
  /**
   * R7: submit and confirm via the GraphQL network response; returns post URL.
   * `publishedText` (the body just published) is used to disambiguate the
   * just-published post from older posts in the /me feed (PUB-0030).
   */
  submitAndConfirm(page: Page, publishedText?: string): Promise<string>;
  /** R7/R11: re-open the post and confirm text + image round-trip. */
  postVerify(page: Page, postUrl: string): Promise<FacebookPostReadback>;
}

export interface PublishOptions {
  headed?: boolean;
  profileManager?: ProfileManager;
  /** Inject a pre-built page (smoke / integration). When set, `launchSession` is skipped. */
  page?: Page;
  /** Skip browser teardown — used by callers that own the session. */
  skipTeardown?: boolean;
  /** Test seam: override the publish-step choreography. */
  __recorder?: PublishStepRecorder;
}

/** R1: collect every media path (imagePaths is the legacy shared input name). */
function collectImagePaths(input: PublishInput): string[] {
  if (input.imagePaths && input.imagePaths.length > 0) {
    return input.imagePaths;
  }
  if (input.imagePath) {
    return [input.imagePath];
  }
  return [];
}

function attachmentForPath(src: string): { kind: "image" | "video"; src: string } {
  return MEDIA_EXT_ALLOWLIST.has(extname(src).toLowerCase()) &&
    [".mp4", ".m4v", ".mov", ".webm"].includes(extname(src).toLowerCase())
    ? { kind: "video", src }
    : { kind: "image", src };
}

export async function publish(
  input: PublishInput,
  options: PublishOptions = {},
): Promise<PublishResult> {
  if (!input?.text || input.text.trim() === "") {
    throw new AdapterError(ErrorCode.MISSING_INPUT, "publish: 'text' is required");
  }
  // R1: a Facebook post MUST carry at least one image (image-mandatory).
  const rawImagePaths = collectImagePaths(input);
  if (rawImagePaths.length === 0) {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      "publish: at least one image is required (R1 image-mandatory)",
    );
  }
  const safeImagePaths = rawImagePaths.map(validateImagePath);
  if (!input.expectedAuthorProfileUrl && !input.dryRun) {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      "publish: expectedAuthorProfileUrl is required",
    );
  }

  // Dry-run validates inputs but performs no IO — it must not require a real
  // on-disk profile or a browser session. (Recorder-injected tests still drive
  // the dry-run path through runPublishFlow via the explicit page seam below.)
  if (input.dryRun && !options.page) {
    return PublishResultSchema.parse({
      ok: true,
      platform: "facebook",
      account: "dry-run",
      postUrl: "https://www.facebook.com/dry-run/posts/0",
      attachments: safeImagePaths.map(attachmentForPath),
      commentIds: [],
    });
  }

  const profiles = options.profileManager ?? new ProfileManager();
  const profileDir = profiles.ensureProfileExists("facebook", input.profile);

  if (options.page) {
    return runPublishFlow(options.page, input, safeImagePaths, options.__recorder);
  }

  const session = await launchSession({
    profileDir,
    ...(options.headed !== undefined ? { headed: options.headed } : {}),
  });
  try {
    return await runPublishFlow(session.page, input, safeImagePaths, options.__recorder);
  } finally {
    if (!options.skipTeardown) {
      await session.close();
    }
  }
}

async function runPublishFlow(
  page: Page,
  input: PublishInput,
  imagePaths: string[],
  recorder?: PublishStepRecorder,
): Promise<PublishResult> {
  const steps = recorder ?? defaultSteps;
  return withScreenshotOnFail(page, "publish", async () => {
    if (input.dryRun) {
      return PublishResultSchema.parse({
        ok: true,
        platform: "facebook",
        account: "dry-run",
        postUrl: "https://www.facebook.com/dry-run/posts/0",
        attachments: imagePaths.map(attachmentForPath),
        commentIds: [],
      });
    }

    await steps.openComposer(page);
    // R8: image FIRST — the React/Lexical composer re-renders on setInputFiles
    // and wipes any pre-typed text, so text must be typed AFTER the upload.
    await steps.uploadImages(page, imagePaths);
    await steps.typeBody(page, input.text);

    // R7: pre-submit snapshot — both text and media must be present, else ABORT.
    const snap = await steps.preSubmitSnapshot(page, input);
    if (snap.normalizedBody !== normalizeFacebookText(input.text)) {
      throw new AdapterError(
        ErrorCode.VERIFY_FAILED,
        "publish: pre-submit snapshot found no text in the composer — aborting (R7)",
        { fbErrorType: "verify_mismatch", stage: "pre_submit_text" },
      );
    }
    const expectedAttachments = imagePaths.map((path) => ({
      name: basename(path),
      size: statSync(path).size,
    }));
    if (JSON.stringify(snap.attachments) !== JSON.stringify(expectedAttachments)) {
      throw new AdapterError(
        ErrorCode.VERIFY_FAILED,
        "publish: pre-submit snapshot found no media in the composer — aborting (R7)",
        { fbErrorType: "verify_mismatch", stage: "pre_submit_image" },
      );
    }

    // R7: submit and confirm via the GraphQL network response, not the DOM.
    // PUB-0030: pass the published body so the step can disambiguate the
    // just-published post from older posts in the /me feed.
    try {
      const postUrl = await steps.submitAndConfirm(page, input.text);
      const expectedAuthor = facebookProfileIdentity(input.expectedAuthorProfileUrl!);
      const verified = await steps.postVerify(page, postUrl);
      if (
        verified.normalizedBody !== normalizeFacebookText(input.text) ||
        verified.authorProfileIdentity !== expectedAuthor ||
        !(verified.hasImage || verified.hasVideo) ||
        verified.mediaIdentity === "" ||
        verified.canonicalPermalink !== canonicalFacebookPostUrl(postUrl)
      ) {
        throw new Error("post-submit mismatch");
      }
      return PublishResultSchema.parse({
        ok: true,
        platform: "facebook",
        account: extractAccountFromUrl(postUrl),
        postUrl,
        attachments: imagePaths.map(attachmentForPath),
        commentIds: [],
      });
    } catch (error) {
      if (error instanceof AdapterError && error.details?.["unknown"] === true) throw error;
      throw unknownPublish();
    }
  });
}

/** The production DOM choreography. Each method is a named, replaceable step. */
const defaultSteps: PublishStepRecorder = {
  async openComposer(page: Page): Promise<void> {
    await page.goto(FB_HOME);
    const composer = page.getByRole("button", { name: selectors.composerButton }).first();
    try {
      await composer.waitFor({ state: "visible", timeout: 10_000 });
    } catch (cause) {
      const blob = await safeContent(page);
      const klass = classifyFbError(blob);
      void cause;
      throw mapFbError(klass !== "unknown" ? klass : "not_logged_in");
    }
    await composer.click();
    const dialog = page
      .getByRole("dialog")
      .filter({ has: page.getByText(selectors.composerDialog) });
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
  },

  async uploadImages(page: Page, imagePaths: string[]): Promise<void> {
    // Facebook now clears the backing file input immediately after accepting
    // the upload. Open the composer media control and satisfy the resulting
    // file chooser instead of targeting the first (often feed-level) input.
    const mediaButton = page.getByRole("button", { name: /^(?:Photo\/video|Фото\/видео)$/ }).last();
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), mediaButton.click()]);
    await chooser.setFiles(imagePaths);
    // R8/R11: wait for the composer to re-render around the media layer.
    await page.waitForTimeout(IMAGE_RERENDER_SETTLE_MS);
    await page
      .getByRole("button", {
        name: /^(?:Remove attachment from your post|Удалить вложение из публикации)$/,
      })
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
  },

  async typeBody(page: Page, text: string): Promise<void> {
    // R8: after the image re-render the active textbox is the last visible one
    // (the media layer adds extra textboxes — see memory fb-composer-automation).
    const textbox = page.getByRole("textbox").last();
    await textbox.click();
    // R6: never hand a raw multi-line string to FB — type line-by-line.
    await typeMultiline(page, text, { submit: false });
  },

  async preSubmitSnapshot(page: Page, _input: PublishInput): Promise<PreSubmitSnapshot> {
    const composerText = await page
      .getByRole("textbox")
      .last()
      .innerText()
      .catch(() => "");
    const normalizedBody = normalizeFacebookText(composerText);
    // The upload input is ephemeral and is empty after Facebook accepts the
    // file. The stable pre-submit oracle is the composer's visible attachment
    // removal control. Preserve the metadata contract only when every expected
    // image has a corresponding rendered attachment.
    const renderedAttachmentCount = await page
      .getByRole("button", {
        name: /^(?:Remove attachment from your post|Удалить вложение из публикации)$/,
      })
      .count();
    const imagePaths = collectImagePaths(_input);
    const attachments =
      renderedAttachmentCount === imagePaths.length
        ? imagePaths.map((path) => ({ name: basename(path), size: statSync(path).size }))
        : [];
    return { normalizedBody, attachments };
  },

  async submitAndConfirm(page: Page, publishedText?: string): Promise<string> {
    const publishBtn = page.getByRole("button", { name: selectors.publishButton, exact: true });
    const nextBtn = page.getByRole("button", { name: selectors.nextButton, exact: true });
    if ((await nextBtn.count()) > 0 && (await nextBtn.first().isVisible())) {
      await nextBtn.first().click();
      // FB's two-step composer renders the publish/back screen asynchronously;
      // a fixed pause races the render. Wait for the publish button to appear.
      await publishBtn
        .first()
        .waitFor({ state: "visible", timeout: 10_000 })
        .catch(() => undefined);
    }
    if ((await publishBtn.count()) === 0) {
      throw mapFbError("composer_not_found");
    }
    if (await publishBtn.first().isDisabled()) {
      throw mapFbError("publish_button_disabled");
    }
    // R7: the GraphQL 200 is the publish confirmation — the DOM caches and lies.
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(FB_GRAPHQL_PATH) && r.status() === 200, {
        timeout: VERIFY_DELAY_MS,
      }),
      publishBtn.first().click(),
    ]);
    void response;

    await page.goto(FB_ME);
    // PUB-0030: do NOT blindly grab the FIRST article on /me — the feed render
    // races the just-published post, so the first `[role=article]` is often the
    // PREVIOUS post and we return the wrong pfbid. Resolve the article whose
    // body matches the text we just published, then read ITS post href.
    const rawHref = await resolveJustPublishedHref(page, publishedText);
    return extractPostUrlFromHref(rawHref);
  },

  async postVerify(page: Page, postUrl: string): Promise<FacebookPostReadback> {
    // R11: wait out the "publishing…" indicator before the first read-back.
    await page.waitForTimeout(VERIFY_DELAY_MS);
    return readFacebookPost(page, postUrl);
  },
};

function unknownPublish(): AdapterError {
  return new AdapterError(ErrorCode.VERIFY_FAILED, "publish: state unknown after submit", {
    unknown: true,
    reconcileRequired: true,
    stage: "post_submit_verify",
    artifactId: createHash("sha256").update("facebook-publish-unknown").digest("hex").slice(0, 16),
  });
}

/**
 * PUB-0030: derive a stable text fragment from the published body to match the
 * just-published article against the /me feed. Uses the first non-empty line,
 * trimmed and capped, so a title-first post (our convention) is matched on its
 * title. Pure (no Page) → unit-testable.
 */
export function publishedTextMatchFragment(text: string | undefined): string {
  if (!text) return "";
  const firstLine = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return "";
  // Cap to keep the Playwright `hasText` filter cheap and resilient to trailing
  // emoji / truncation the feed may apply.
  return firstLine.slice(0, 40);
}

/**
 * PUB-0030: resolve the href of the article we JUST published, not merely the
 * first article in the /me feed.
 *
 * When the body text is known, the matching article is the ONLY acceptable
 * answer. The former behaviour fell through to the first article in the feed
 * whenever the match failed, on the reasoning that a best-effort URL beats a
 * hard failure. It does not: the first article is routinely a PREVIOUS post, so
 * the fallback answers a failed publish with a real-looking permalink pointing
 * at unrelated content. Observed 2026-08-09 — a publish that never landed
 * returned a four-day-old article, and every downstream check then compared
 * against that stranger's post. Failing here is what lets the caller report
 * `reconcileRequired` honestly.
 *
 * The legacy first-article path survives only when there is no text to match on
 * (image-only post), where "first article" is the best identity available.
 */
export async function resolveJustPublishedHref(
  page: Page,
  publishedText?: string,
): Promise<string> {
  const fragment = publishedTextMatchFragment(publishedText);
  if (fragment !== "") {
    const article = page.locator('[role="article"]').filter({ hasText: fragment }).first();
    await article.waitFor({ state: "visible", timeout: 10_000 });
    return await article
      .locator('a[href*="/posts/"]')
      .first()
      .evaluate((a) => (a as unknown as { href: string }).href);
  }
  return page.$eval(
    '[role="article"] a[href*="/posts/"]',
    (a) => (a as unknown as { href: string }).href,
  );
}

function validateImagePath(rawPath: string, index: number): string {
  const artifactId = createHash("sha256").update(rawPath).digest("hex").slice(0, 16);
  if (rawPath.includes("\0")) {
    throw new AdapterError(ErrorCode.INVALID_ARGS, "publish: invalid image path", {
      stage: "image_validation",
      artifactId,
      index,
    });
  }
  const abs = resolvePath(rawPath);
  if (!existsSync(abs)) {
    throw new AdapterError(ErrorCode.MISSING_INPUT, "publish: image file not found", {
      stage: "image_validation",
      artifactId,
      index,
    });
  }
  const stat = statSync(abs);
  if (!stat.isFile()) {
    throw new AdapterError(ErrorCode.INVALID_ARGS, "publish: image is not a regular file", {
      stage: "image_validation",
      artifactId,
      index,
    });
  }
  const ext = extname(abs).toLowerCase();
  if (!MEDIA_EXT_ALLOWLIST.has(ext)) {
    throw new AdapterError(ErrorCode.INVALID_ARGS, "publish: unsupported media extension", {
      stage: "image_validation",
      artifactId,
      index,
      allowed: Array.from(MEDIA_EXT_ALLOWLIST),
    });
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
