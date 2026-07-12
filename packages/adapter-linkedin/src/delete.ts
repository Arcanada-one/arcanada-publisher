// R13: delete a LinkedIn post or comment with a mandatory read-before-delete
// oracle. The fail-closed safety contract (read → compare → abort) lives here;
// the live «...» control-menu → Delete → confirm choreography in
// `defaultPerformDelete` is hardened against UI drift during the LinkedIn
// adapter phase.

import { type Page } from "playwright";
import {
  AdapterError,
  ErrorCode,
  ProfileManager,
  DeleteResultSchema,
  type DeleteInput,
  type DeleteResult,
} from "@arcanada/publisher-core";
import { selectors, shadowClickPatterns } from "./selectors.js";
import { launchSession, withScreenshotOnFail } from "./context.js";
import { shadowClickButtonJs, shadowFindActivityUrnJs } from "./dom-shadow.js";

const DELETE_TARGET_ATTR = "data-arcanada-delete-target";

const LINKEDIN_HOSTNAME = "www.linkedin.com";

export interface DeleteOptions {
  headed?: boolean;
  profileManager?: ProfileManager;
  page?: Page;
  /** Test seam: read the rendered target text (defaults to article-body read). */
  __readContent?: (page: Page, input: DeleteInput) => Promise<string>;
  /** Test seam: perform the destructive control-menu → Delete → confirm flow. */
  __performDelete?: (page: Page, input: DeleteInput) => Promise<void>;
  skipTeardown?: boolean;
}

export async function del(input: DeleteInput, options: DeleteOptions = {}): Promise<DeleteResult> {
  assertTargetHost(input.targetUrl);
  if (!input.expectedContent || input.expectedContent.trim() === "") {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      "delete: 'expectedContent' is required (read-before-delete oracle)",
    );
  }

  const profiles = options.profileManager ?? new ProfileManager();
  const profileDir = profiles.ensureProfileExists("linkedin", input.profile);

  if (options.page) {
    return runDeleteFlow(options.page, input, options);
  }

  const session = await launchSession({
    profileDir,
    ...(options.headed !== undefined ? { headed: options.headed } : {}),
  });
  try {
    return await runDeleteFlow(session.page, input, options);
  } finally {
    if (!options.skipTeardown) {
      await session.close();
    }
  }
}

async function runDeleteFlow(
  page: Page,
  input: DeleteInput,
  options: DeleteOptions,
): Promise<DeleteResult> {
  return withScreenshotOnFail(page, "delete", async () => {
    const readContent = options.__readContent ?? defaultReadContent;
    const seen = await readContent(page, input);
    if (!seen.includes(input.expectedContent)) {
      throw new AdapterError(
        ErrorCode.VERIFY_FAILED,
        "delete: rendered content does not match expectedContent — aborting without deletion",
        { targetUrl: input.targetUrl, kind: input.kind, liErrorType: "verify_mismatch" },
      );
    }

    const performDelete = options.__performDelete ?? defaultPerformDelete;
    await performDelete(page, input);

    return DeleteResultSchema.parse({
      ok: true,
      platform: "linkedin",
      account: "self",
      deleted: true,
      targetUrl: input.targetUrl,
    });
  });
}

export async function defaultReadContent(page: Page, input: DeleteInput): Promise<string> {
  await page.goto(input.targetUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(4_000);
  // LinkedIn can auto-translate an English post into the account language
  // (observed FI: "Näytä alkuperäinen"). The expected-content oracle is the
  // operator-approved original, so restore the original before reading it.
  const showOriginal = page.getByRole("button", { name: selectors.showOriginal });
  const showOriginalCount = await showOriginal.count().catch(() => 0);
  for (let index = 0; index < showOriginalCount; index++) {
    const button = showOriginal.nth(index);
    if (await button.isVisible().catch(() => false)) await button.click();
  }
  if (showOriginalCount > 0) await page.waitForTimeout(1_000);
  // The 2026 UI may omit data-urn/article on vanity post pages. Read the page
  // region, then bind expectedContent to one unique container that owns a post
  // control. Never trust `.first()`: an unrelated first post can contain the
  // expected text in a nested comment/repost.
  const main = page.locator("main").first();
  const region = (await main.count()) > 0 ? main : page.locator("body").first();
  await region.waitFor({ state: "visible", timeout: 5_000 });
  const text = (await region.innerText()) ?? "";
  if (text.includes(input.expectedContent)) {
    const marked = (await page.evaluate(
      markDeleteTargetJs(
        input.expectedContent,
        DELETE_TARGET_ATTR,
        `(?:${selectors.editPostActionEn.source})|(?:${selectors.editPostActionRu.source})`,
        activityIdFromUrl(input.targetUrl),
      ),
    )) as number;
    if (marked === 1) return text;
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "delete: expected content is not bound to exactly one post control — aborting without deletion",
      { targetUrl: input.targetUrl, liErrorType: "verify_mismatch", candidateCount: marked },
    );
  }
  const urn = (await page.evaluate(shadowFindActivityUrnJs()).catch(() => null)) as string | null;
  throw new AdapterError(
    ErrorCode.VERIFY_FAILED,
    urn
      ? "delete: rendered post does not match expectedContent — aborting without deletion"
      : "delete: post not found or not rendered — aborting without deletion",
    { targetUrl: input.targetUrl, liErrorType: "verify_mismatch" },
  );
}

export function markDeleteTargetJs(
  expected: string,
  attr: string,
  menuPattern: string,
  activityId: string | null = null,
): string {
  return `(() => {
    const expected = ${JSON.stringify(expected)};
    const attr = ${JSON.stringify(attr)};
    const re = new RegExp(${JSON.stringify(menuPattern)}, "i");
    const candidates = Array.from(document.querySelectorAll('[data-urn*="urn:li:activity"], article, div')).filter((element) =>
      (element.innerText || "").includes(expected) &&
      Array.from(element.querySelectorAll("button")).some((button) =>
        re.test(button.getAttribute("aria-label") || button.innerText || "")
      )
    );
    const activityId = ${JSON.stringify(activityId)};
    const activityMatches = activityId ? candidates.filter((candidate) =>
      (candidate.getAttribute("data-urn") || "").includes("urn:li:activity:" + activityId)
    ) : [];
    const pool = activityMatches.length > 0 ? activityMatches : candidates;
    const leafMost = pool.filter((candidate) =>
      !pool.some((other) => other !== candidate && candidate.contains(other))
    );
    if (leafMost.length !== 1) return leafMost.length;
    leafMost[0].setAttribute(attr, "true");
    return 1;
  })()`;
}

function activityIdFromUrl(targetUrl: string): string | null {
  return (
    targetUrl.match(/urn:li:activity:(\d+)/)?.[1] ?? targetUrl.match(/activity-(\d+)/)?.[1] ?? null
  );
}

export async function defaultPerformDelete(page: Page, _input: DeleteInput): Promise<void> {
  // PUB-0032: the «...» control-menu → Delete → confirm choreography drifted on
  // the 2026 UI (the kebab aria-label localized and the menu may sit behind the
  // interop-outlet shadow root, where a Playwright pointer-click is intercepted).
  // Each step tries the role/aria locator first (fast, structural) and falls back
  // to a shadow-walk DOM `.click()` with multi-locale text matching when the
  // locator does not resolve.
  const target = page.locator(`[${DELETE_TARGET_ATTR}="true"]`);
  if ((await target.count()) !== 1)
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "delete: verified target marker is absent or ambiguous — aborting without deletion",
      { liErrorType: "verify_mismatch" },
    );
  const targetMenu = target
    .getByRole("button", { name: selectors.editPostActionRu })
    .or(target.getByRole("button", { name: selectors.editPostActionEn }))
    .first();
  await targetMenu.waitFor({ state: "visible", timeout: 6_000 });
  await targetMenu.click();

  await clickWithShadowFallback(
    page,
    page.getByRole("menuitem", { name: selectors.deleteMenuItem }).first(),
    shadowClickPatterns.deleteMenuItem,
    "delete_menu_item",
  );

  await clickWithShadowFallback(
    page,
    page.getByRole("button", { name: selectors.confirmDelete, exact: true }).first(),
    shadowClickPatterns.confirmDelete,
    "delete_confirm",
  );
  await page.waitForTimeout(3_000);
}

/**
 * PUB-0032: click a control via its Playwright locator, falling back to a
 * shadow-walk DOM `.click()` (multi-locale text match) when the locator does not
 * become visible within a short window. Throws `composer_not_found`-class error
 * if neither path lands the click, so the caller never silently no-ops.
 */
async function clickWithShadowFallback(
  page: Page,
  locator: ReturnType<Page["locator"]>,
  shadowPatternSrc: string,
  stage: string,
): Promise<void> {
  try {
    await locator.waitFor({ state: "visible", timeout: 6_000 });
    await locator.click();
    return;
  } catch {
    // fall through to the shadow-walk DOM click
  }
  for (let i = 0; i < 20; i++) {
    const clicked = (await page.evaluate(shadowClickButtonJs(shadowPatternSrc))) as boolean;
    if (clicked) return;
    await page.waitForTimeout(500);
  }
  throw new AdapterError(
    ErrorCode.PUBLISH_BUTTON_ABSENT,
    `delete: control not found at stage '${stage}' (locator + shadow-walk both failed)`,
    { liErrorType: "composer_not_found", stage },
  );
}

function assertTargetHost(targetUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch (cause) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `delete: targetUrl is not a valid URL: ${targetUrl}`,
      { cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
  if (parsed.hostname !== LINKEDIN_HOSTNAME) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `delete: targetUrl host '${parsed.hostname}' is not '${LINKEDIN_HOSTNAME}'`,
      { targetUrl },
    );
  }
}
