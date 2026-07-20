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

async function defaultReadContent(page: Page, input: DeleteInput): Promise<string> {
  // PUB-0037: the 2026 LinkedIn permalink is a client-rendered SPA that needs a
  // real settle before the post text exists, and it NO LONGER stamps a
  // `data-urn` attribute on the post element (probe: permalink renders the full
  // post — hasCubrim/hasMechty true, main ~1.7k chars — yet zero
  // `[data-urn*="urn:li:activity"]` nodes). The old flow therefore failed twice:
  // the structural `[data-urn]`/`article` selector never matched, and the
  // shadow-URN probe returned null so the fallback threw «container not found»
  // even though the post was on screen. Fix: (1) wait for network to settle so
  // the SPA has painted the post; (2) prefer the structural read but fall back
  // to a body/`main`-wide innerText read WITHOUT gating on a URN. The oracle
  // compares `expectedContent` against this string — a superset (whole main) is
  // safe, a miss is not; fail-closed is preserved because a truly-missing post
  // yields text that does not contain `expectedContent` and the caller aborts.
  await page.goto(input.targetUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(4_000);

  const article = page.locator('[data-urn*="urn:li:activity"], article').first();
  try {
    await article.waitFor({ state: "visible", timeout: 5_000 });
    const t = (await article.innerText()) ?? "";
    if (t.includes(input.expectedContent)) {
      return t;
    }
  } catch {
    // fall through to the main/body-wide read below
  }

  // Prefer <main> (the post-detail region) over <body> to avoid the global nav
  // chrome; fall back to <body> if <main> is absent. A shadow-URN probe is kept
  // only as a best-effort structural signal — its ABSENCE no longer blocks the
  // read (the 2026 UI drops data-urn), so we never throw on a rendered post.
  const main = page.locator("main").first();
  const hasMain = (await main.count()) > 0;
  const region = hasMain ? main : page.locator("body").first();
  await region.waitFor({ state: "visible", timeout: 5_000 });
  const text = (await region.innerText()) ?? "";

  if (!text.includes(input.expectedContent)) {
    // Distinguish «post genuinely absent / deleted» from «drift»: a
    // best-effort shadow-URN probe adds context to the fail-closed error but is
    // NOT required for a successful read above.
    const urn = (await page.evaluate(shadowFindActivityUrnJs()).catch(() => null)) as string | null;
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      urn
        ? "delete: rendered post does not match expectedContent — aborting without deletion"
        : "delete: post not found or not rendered (no matching text, no activity urn) — aborting without deletion",
      { targetUrl: input.targetUrl, liErrorType: "verify_mismatch" },
    );
  }
  return text;
}

async function defaultPerformDelete(page: Page, _input: DeleteInput): Promise<void> {
  // PUB-0032: the «...» control-menu → Delete → confirm choreography drifted on
  // the 2026 UI (the kebab aria-label localized and the menu may sit behind the
  // interop-outlet shadow root, where a Playwright pointer-click is intercepted).
  // Each step tries the role/aria locator first (fast, structural) and falls back
  // to a shadow-walk DOM `.click()` with multi-locale text matching when the
  // locator does not resolve.
  await clickWithShadowFallback(
    page,
    page
      .getByRole("button", { name: selectors.editPostActionRu })
      .or(page.getByRole("button", { name: selectors.editPostActionEn }))
      .first(),
    shadowClickPatterns.postControlMenu,
    "delete_control_menu",
  );

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
