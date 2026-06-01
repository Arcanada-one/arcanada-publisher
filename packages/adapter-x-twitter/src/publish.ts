// X (Twitter) publish flow encoding the manual publish mechanics:
// - R1 image-mandatory: a tweet without an image is a defect.
// - 280 UTF-16 unit limit (counter.ts) — over-limit is rejected pre-flight.
// - R7 network confirm: the CreateTweet GraphQL 200 is the publish oracle.
// - R12 rate-limit: a "temporarily limited" notice → graceful stop (no retry,
//   no circumvention) mapped to ErrorCode.RATE_LIMIT.
//
// The DOM choreography is behind a recorder seam so the rate-limit branch and
// the over-limit / image-mandatory guards are unit-tested on a fake page.

import { type Page } from "playwright";
import {
  AdapterError,
  ErrorCode,
  ProfileManager,
  PublishResultSchema,
  type PublishInput,
  type PublishResult,
} from "@arcanada/publisher-core";
import { withinTweetLimit, utf16Length, X_MAX_UTF16_UNITS } from "./counter.js";
import { selectors, isRateLimited } from "./selectors.js";
import { validateImagePath } from "./image.js";
import { launchSession, withScreenshotOnFail } from "./context.js";

/** R7: the CreateTweet GraphQL mutation is the publish confirmation. */
const CREATE_TWEET_API = "/CreateTweet";

export interface PublishStepRecorder {
  openComposer(page: Page): Promise<void>;
  /** R12: probe for the anti-bot rate-limit notice; true = limited. */
  checkRateLimited(page: Page): Promise<boolean>;
  uploadImage(page: Page, imagePath: string): Promise<void>;
  typeTweet(page: Page, text: string): Promise<void>;
  /** R7: submit and confirm via CreateTweet 200; returns the tweet URL. */
  submitAndConfirm(page: Page): Promise<string>;
}

export interface PublishOptions {
  headed?: boolean;
  profileManager?: ProfileManager;
  page?: Page;
  skipTeardown?: boolean;
  __recorder?: PublishStepRecorder;
}

/** R1: collect the image path (imagePaths wins; imagePath is the legacy alias). */
export function collectImagePath(input: PublishInput): string | undefined {
  if (input.imagePaths && input.imagePaths.length > 0) {
    return input.imagePaths[0];
  }
  return input.imagePath;
}

export async function publish(
  input: PublishInput,
  options: PublishOptions = {},
): Promise<PublishResult> {
  if (!input?.text || input.text.trim() === "") {
    throw new AdapterError(ErrorCode.MISSING_INPUT, "publish: 'text' is required");
  }
  // 280 UTF-16 unit pre-flight guard.
  if (!withinTweetLimit(input.text)) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `publish: tweet exceeds ${X_MAX_UTF16_UNITS} UTF-16 units (got ${utf16Length(input.text)})`,
      { length: utf16Length(input.text), limit: X_MAX_UTF16_UNITS },
    );
  }
  // R1: a tweet MUST carry an image (an image-less tweet is a publish defect).
  const rawImagePath = collectImagePath(input);
  if (!rawImagePath) {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      "publish: an image is required (R1 image-mandatory)",
    );
  }
  const safeImagePath = validateImagePath(rawImagePath);

  // Dry-run validates inputs (text, 280 limit, image) but performs no IO — it
  // must not require a real on-disk profile or a browser session.
  if (input.dryRun) {
    return PublishResultSchema.parse({
      ok: true,
      platform: "x",
      account: "dry-run",
      postUrl: "https://x.com/dry-run/status/0",
      attachments: [{ kind: "image", src: safeImagePath }],
      commentIds: [],
    });
  }

  const profiles = options.profileManager ?? new ProfileManager();
  const profileDir = profiles.ensureProfileExists("x", input.profile);

  if (options.page) {
    return runPublishFlow(options.page, input, safeImagePath, options.__recorder);
  }

  const session = await launchSession({
    profileDir,
    ...(options.headed !== undefined ? { headed: options.headed } : {}),
  });
  try {
    return await runPublishFlow(session.page, input, safeImagePath, options.__recorder);
  } finally {
    if (!options.skipTeardown) {
      await session.close();
    }
  }
}

async function runPublishFlow(
  page: Page,
  input: PublishInput,
  imagePath: string,
  recorder?: PublishStepRecorder,
): Promise<PublishResult> {
  const steps = recorder ?? defaultSteps;
  return withScreenshotOnFail(page, "publish", async () => {
    await steps.openComposer(page);

    // R12: stop gracefully if X is rate-limiting — never retry / circumvent.
    if (await steps.checkRateLimited(page)) {
      throw new AdapterError(
        ErrorCode.RATE_LIMIT,
        "publish: X anti-bot rate-limit detected — stopping (limit must not be circumvented, no auto-retry)",
        { xErrorType: "rate_limited" },
      );
    }

    await steps.uploadImage(page, imagePath);
    await steps.typeTweet(page, input.text);
    const postUrl = await steps.submitAndConfirm(page);

    return PublishResultSchema.parse({
      ok: true,
      platform: "x",
      account: extractHandle(postUrl),
      postUrl,
      attachments: [{ kind: "image", src: imagePath }],
      commentIds: [],
    });
  });
}

const defaultSteps: PublishStepRecorder = {
  async openComposer(page: Page): Promise<void> {
    await page.goto("https://x.com/home");
    const textarea = page.locator(selectors.tweetTextarea).first();
    await textarea.waitFor({ state: "visible", timeout: 15_000 });
  },

  async checkRateLimited(page: Page): Promise<boolean> {
    const blob = await page.content().catch(() => "");
    return isRateLimited(blob);
  },

  async uploadImage(page: Page, imagePath: string): Promise<void> {
    const fileInput = page.locator(selectors.fileInput).first();
    await fileInput.setInputFiles(imagePath);
    await page.waitForTimeout(3_000);
  },

  async typeTweet(page: Page, text: string): Promise<void> {
    const textarea = page.locator(selectors.tweetTextarea).first();
    await textarea.click();
    await page.keyboard.insertText(text);
  },

  async submitAndConfirm(page: Page): Promise<string> {
    const inline = page.locator(selectors.tweetButtonInline).first();
    const modal = page.locator(selectors.tweetButton).first();
    const button = (await inline.count()) > 0 ? inline : modal;
    // R7: CreateTweet 200 is the confirmation — the DOM is unreliable.
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(CREATE_TWEET_API) && r.status() === 200, {
        timeout: 20_000,
      }),
      button.click(),
    ]);
    void response;
    // The created tweet's permalink is the most-recent status on the profile.
    await page.goto("https://x.com/home");
    const link = page.locator('a[href*="/status/"]').first();
    const href = await link.getAttribute("href");
    return href ? new URL(href, "https://x.com").toString() : "https://x.com/i/status/0";
  },
};

/** X status URLs are https://x.com/<handle>/status/<id>; pull <handle>. */
function extractHandle(statusUrl: string): string {
  try {
    const parts = new URL(statusUrl).pathname.split("/").filter(Boolean);
    return parts[0] ?? "unknown";
  } catch {
    return "unknown";
  }
}
