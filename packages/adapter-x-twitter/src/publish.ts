// X (Twitter) publish flow encoding the manual publish mechanics:
// - R1 image-mandatory: a tweet without an image is a defect.
// - UTF-16 unit limit (counter.ts) — over-limit is rejected pre-flight.
//   Default 280 (free tier); premium=true raises it to 25 000 (PUB-0033).
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
import { withinTweetLimit, utf16Length, tweetLimit } from "./counter.js";
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
  // UTF-16 unit pre-flight guard. PUB-0033: premium=true raises the ceiling to
  // the 25 000-unit X Premium long-form limit; default stays the free-tier 280.
  const premium = input.premium === true;
  const limit = tweetLimit(premium);
  if (!withinTweetLimit(input.text, premium)) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `publish: tweet exceeds ${limit} UTF-16 units (got ${utf16Length(input.text)})`,
      { length: utf16Length(input.text), limit },
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
    // PUB-0033: a large video (tens of MB) takes longer to attach than the old
    // fixed 3 s wait. Wait for the attachment preview to appear (the composer
    // always keeps decorative progressbar rings, so we do NOT gate on those —
    // gating on "progressbar hidden" never settles). A short settle then lets X
    // begin server-side processing; the true readiness gate (post button
    // enabled) is enforced in submitAndConfirm.
    await page
      .locator(selectors.attachedMedia)
      .first()
      .waitFor({ state: "visible", timeout: 120_000 })
      .catch(() => {});
    await page.waitForTimeout(2_000);
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
    // PUB-0033: the real readiness gate. After a large-video upload X keeps the
    // post button disabled (aria-disabled="true") until server-side processing
    // finishes; clicking a disabled button is a no-op that strands
    // waitForResponse. Poll until the button is enabled before clicking, with a
    // generous ceiling for video transcoding.
    await page
      .locator(`${selectors.tweetButtonInline}:not([aria-disabled="true"])`)
      .or(page.locator(`${selectors.tweetButton}:not([aria-disabled="true"])`))
      .first()
      .waitFor({ state: "visible", timeout: 180_000 })
      .catch(() => {});
    const profileHref = await page
      .locator(selectors.profileLink)
      .first()
      .getAttribute("href")
      .catch(() => null);
    // R7: CreateTweet 200 is the confirmation — the DOM is unreliable. The
    // ceiling is generous so a large-video compose still confirms in one shot.
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(CREATE_TWEET_API) && r.status() === 200, {
        timeout: 45_000,
      }),
      button.click(),
    ]);
    const payload = await response.json().catch(() => undefined);
    return exactCreatedTweetUrl(payload, profileHref);
  },
};

type JsonObject = Record<string, unknown>;

function exactCreatedTweetUrl(payload: unknown, profileHref: string | null): string {
  const result = asObject(readPath(payload, ["data", "create_tweet", "tweet_results", "result"]));
  const wrappedTweet = asObject(result?.["tweet"]);
  const tweet = wrappedTweet ?? result;
  const tweetId = tweet?.["rest_id"];
  if (typeof tweetId !== "string" || !/^\d+$/.test(tweetId)) {
    throw unresolvedCreateTweet("numeric created tweet rest_id absent");
  }

  const responseHandle = handleFromCreateTweet(tweet, result);
  const profileHandle = handleFromProfileHref(profileHref);
  if (
    responseHandle &&
    profileHandle &&
    responseHandle.toLowerCase() !== profileHandle.toLowerCase()
  ) {
    throw unresolvedCreateTweet("response author and authenticated profile handle mismatch");
  }
  const handle = responseHandle ?? profileHandle;
  if (!handle) throw unresolvedCreateTweet("authenticated handle absent");
  return `https://x.com/${handle}/status/${tweetId}`;
}

function handleFromCreateTweet(
  tweet: JsonObject | undefined,
  result: JsonObject | undefined,
): string | undefined {
  const paths = [
    ["core", "user_results", "result", "legacy", "screen_name"],
    ["core", "user_results", "result", "core", "screen_name"],
    ["author_results", "result", "legacy", "screen_name"],
  ];
  for (const source of [tweet, result]) {
    for (const path of paths) {
      const handle = validHandle(readPath(source, path));
      if (handle) return handle;
    }
  }
  return undefined;
}

function handleFromProfileHref(href: string | null): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href, "https://x.com");
    if (url.hostname !== "x.com" && url.hostname !== "www.x.com") return undefined;
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.length === 1 ? validHandle(parts[0]) : undefined;
  } catch {
    return undefined;
  }
}

function validHandle(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_]{1,15}$/.test(value) ? value : undefined;
}

function readPath(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    current = asObject(current)?.[key];
    if (current === undefined) return undefined;
  }
  return current;
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" ? (value as JsonObject) : undefined;
}

function unresolvedCreateTweet(reason: string): AdapterError {
  return new AdapterError(
    ErrorCode.VERIFY_FAILED,
    `publish: CreateTweet 200 response did not identify the created own tweet (${reason})`,
    { reason },
  );
}

/** X status URLs are https://x.com/<handle>/status/<id>; pull <handle>. */
function extractHandle(statusUrl: string): string {
  try {
    const parts = new URL(statusUrl).pathname.split("/").filter(Boolean);
    return parts[0] ?? "unknown";
  } catch {
    return "unknown";
  }
}
