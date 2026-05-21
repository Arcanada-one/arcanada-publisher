// Migrated from Arcanada-one/fb-publish@8df49fa51822795075f746ad7389c8bd400b1aa4 on 2026-05-21 (PUB-0003)
// Source: bin/fb-publish.sh (publish flow) + lib/playwright-helpers.sh.

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
import { extractPostUrlFromHref, extractAccountFromUrl } from "./url-extraction.js";
import { classifyFbError, mapFbError } from "./errors.js";

const IMAGE_EXT_ALLOWLIST = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const FB_HOME = "https://www.facebook.com/";
const FB_ME = "https://www.facebook.com/me";

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
  const safeImagePath = input.imagePath ? validateImagePath(input.imagePath) : undefined;
  const profiles = options.profileManager ?? new ProfileManager();
  const profileDir = profiles.ensureProfileExists("facebook", input.profile);

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
    await page.goto(FB_HOME);

    const composer = page.getByRole("button", { name: selectors.composerButton }).first();
    try {
      await composer.waitFor({ state: "visible", timeout: 10_000 });
    } catch (cause) {
      const blob = await safeContent(page);
      const klass = classifyFbError(blob);
      if (klass !== "unknown") {
        throw mapFbError(klass, { cause });
      }
      throw mapFbError("not_logged_in", { cause });
    }

    if (input.dryRun) {
      const href = "https://www.facebook.com/dry-run/posts/0";
      return PublishResultSchema.parse({
        ok: true,
        platform: "facebook",
        account: "dry-run",
        postUrl: href,
        attachments: imagePath ? [{ kind: "image", src: imagePath }] : [],
        commentIds: [],
      });
    }

    await composer.click();
    const dialog = page
      .getByRole("dialog")
      .filter({ has: page.getByText(selectors.composerDialog) });
    await dialog.waitFor({ state: "visible", timeout: 10_000 });

    await page.keyboard.insertText(input.text);

    if (imagePath) {
      const fileInput = page.locator('input[type="file"]').first();
      await fileInput.setInputFiles(imagePath);
      await page.waitForTimeout(3_000);
    }

    const publishBtn = page.getByRole("button", { name: selectors.publishButton, exact: true });
    const nextBtn = page.getByRole("button", { name: selectors.nextButton, exact: true });
    if ((await nextBtn.count()) > 0 && (await nextBtn.first().isVisible())) {
      await nextBtn.first().click();
      await page.waitForTimeout(1_500);
    }
    if ((await publishBtn.count()) === 0) {
      throw mapFbError("composer_not_found");
    }
    if (await publishBtn.first().isDisabled()) {
      throw mapFbError("publish_button_disabled");
    }
    await publishBtn.first().click();
    await page.waitForTimeout(5_000);

    await page.goto(FB_ME);
    const rawHref = await page.$eval(
      '[role="article"] a[href*="/posts/"]',
      (a) => (a as unknown as { href: string }).href,
    );
    const postUrl = extractPostUrlFromHref(rawHref);

    return PublishResultSchema.parse({
      ok: true,
      platform: "facebook",
      account: extractAccountFromUrl(postUrl),
      postUrl,
      attachments: imagePath ? [{ kind: "image", src: imagePath }] : [],
      commentIds: [],
    });
  });
}

function validateImagePath(rawPath: string): string {
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
