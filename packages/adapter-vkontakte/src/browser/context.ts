// Chromium persistent-context wrapper for the VK browser mode.
// Ported from adapter-facebook/src/context.ts — persistent profile (session
// cookies at rest), screenshot-on-fail artefacts, outbound-only browser.

import { mkdirSync, existsSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";

const PACKAGE_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

export interface LaunchOptions {
  profileDir: string;
  headed?: boolean;
  viewport?: { width: number; height: number };
}

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

/** Resolve the screenshot-artefacts directory, ensuring it exists. */
export function resolveArtifactsDir(override?: string): string {
  const target = override
    ? isAbsolute(override)
      ? override
      : resolve(process.cwd(), override)
    : join(PACKAGE_ROOT, "artifacts");
  if (!existsSync(target)) {
    mkdirSync(target, { recursive: true });
  }
  return target;
}

/** Compose a stable, sortable artefact filename. */
export function artifactFilename(stage: string, ext: "png" | "txt" = "png"): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeStage = stage.replace(/[^a-z0-9-]+/gi, "-");
  return `${stamp}-${safeStage}.${ext}`;
}

/** Launch a persistent Chromium context for a given profile dir. */
export async function launchSession(options: LaunchOptions): Promise<BrowserSession> {
  const context = await chromium.launchPersistentContext(options.profileDir, {
    headless: !(options.headed ?? false),
    viewport: options.viewport ?? { width: 1280, height: 800 },
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  return {
    context,
    page,
    async close() {
      await context.close();
    },
  };
}

/** Capture a screenshot to the artefacts directory; swallow IO errors. */
export async function screenshotOnFail(
  page: Page | undefined,
  stage: string,
  artefactsDir = resolveArtifactsDir(),
): Promise<string | null> {
  if (!page || typeof page.isClosed !== "function" || page.isClosed()) return null;
  const target = join(artefactsDir, artifactFilename(stage, "png"));
  try {
    await page.screenshot({ path: target, fullPage: true });
    return target;
  } catch {
    return null;
  }
}

/** Run an async op; on failure capture a screenshot and re-throw as AdapterError. */
export async function withScreenshotOnFail<T>(
  page: Page,
  stage: string,
  op: () => Promise<T>,
  artefactsDir = resolveArtifactsDir(),
): Promise<T> {
  try {
    return await op();
  } catch (err) {
    const shot = await screenshotOnFail(page, stage, artefactsDir);
    if (err instanceof AdapterError) {
      if (shot && err.details && typeof err.details === "object") {
        (err.details as Record<string, unknown>)["screenshot"] = shot;
      }
      throw err;
    }
    throw new AdapterError(
      ErrorCode.INTERNAL_PANIC,
      `vk: unhandled error during '${stage}': ${err instanceof Error ? err.message : String(err)}`,
      { stage, screenshot: shot ?? undefined },
    );
  }
}
