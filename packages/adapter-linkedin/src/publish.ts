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
      // CONTENT-0051 fix: LinkedIn 2026 composer lives inside an open shadow
      // root (<div id="interop-outlet">). The «Add media» button is the only
      // image trigger now (aria-label="Add media", no «Add a photo» anymore).
      // Clicking it opens a NATIVE OS file chooser, not an in-page
      // input[type=file] — so setInputFiles on a dialog-scoped locator fails
      // (the element doesn't exist before the click, and the click itself is
      // pointer-event-intercepted from light DOM).
      //
      // Strategy: register a filechooser handler via Promise.all, click «Add
      // media» via shadow-walking JS (DOM .click() from inside the shadow tree
      // works), then setFiles on the chooser. After upload, click «Next» /
      // «Done» — also via shadow walk because pointer events are intercepted.
      // We pass the JS as a string to evaluate() to avoid pulling DOM lib types
      // into the node-side TS compile target.
      const clickAddMediaJs = `(function(){
        function walk(root, visit) {
          visit(root);
          const els = root.querySelectorAll ? root.querySelectorAll('*') : [];
          for (const el of els) if (el.shadowRoot) walk(el.shadowRoot, visit);
        }
        let hit = null;
        walk(document, function(r){
          if (hit) return;
          const btns = r.querySelectorAll('button, [role=button]');
          for (const b of btns) {
            const lbl = (b.getAttribute('aria-label') || '').trim();
            const txt = (b.innerText || '').trim();
            const vis = b.offsetWidth + b.offsetHeight > 0;
            if (!vis) continue;
            if (/^(Add media|Добавить медиа)$/i.test(lbl) || /^(Add media|Добавить медиа)$/i.test(txt)) {
              hit = b; return;
            }
          }
        });
        if (!hit) return { ok: false };
        hit.click();
        return { ok: true };
      })()`;
      const clickNextDoneJs = `(function(){
        function walk(root, visit) {
          visit(root);
          const els = root.querySelectorAll ? root.querySelectorAll('*') : [];
          for (const el of els) if (el.shadowRoot) walk(el.shadowRoot, visit);
        }
        let hit = null;
        walk(document, function(r){
          if (hit) return;
          const btns = r.querySelectorAll('button, [role=button]');
          for (const b of btns) {
            const lbl = (b.getAttribute('aria-label') || '').trim();
            const txt = (b.innerText || '').trim();
            const vis = b.offsetWidth + b.offsetHeight > 0;
            if (!vis || b.disabled) continue;
            if (/^(Next|Далее|Done|Готово|Save|Сохранить)$/i.test(lbl) || /^(Next|Далее|Done|Готово|Save|Сохранить)$/i.test(txt)) {
              hit = b; return;
            }
          }
        });
        if (!hit) return false;
        hit.click();
        return true;
      })()`;

      const [chooser, clickResult] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 15_000 }),
        page.evaluate(clickAddMediaJs) as Promise<{ ok: boolean }>,
      ]);
      if (!clickResult.ok) {
        throw mapLiError("composer_not_found", {
          extra: { stage: "add_media_button" },
        });
      }
      await chooser.setFiles(imagePath);
      await page.waitForTimeout(3_500);
      let done = false;
      for (let i = 0; i < 40; i++) {
        done = (await page.evaluate(clickNextDoneJs)) as boolean;
        if (done) break;
        await page.waitForTimeout(500);
      }
      if (!done) {
        throw mapLiError("composer_not_found", {
          extra: { stage: "image_done_button" },
        });
      }
      await page.waitForTimeout(2_500);
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
 * INFRA-0260 / CONTENT-0051 fix: visible-only candidate walk → strict regex
 * normaliser → fallback to /in/me/recent-activity/all/ using `data-urn`
 * attribute (most reliable signal — author-scoped article container).
 * Throws `urn_not_found` if neither source yields a clean activity URL.
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

  // Fallback 1: navigate to recent-activity feed, prefer data-urn over href.
  // CONTENT-0051: visible-href walk can grab company-card hrefs from the feed
  // sidebar; data-urn on the article container is author-scoped.
  await page.goto(RECENT_ACTIVITY, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4_000);
  await page.evaluate(`window.scrollBy(0, 600)`);
  await page.waitForTimeout(2_000);
  const dataUrn = (await page.evaluate(`(function(){
    const arts = document.querySelectorAll(
      "[data-urn*='urn:li:activity'], [data-id*='urn:li:activity']"
    );
    if (!arts.length) return "";
    return arts[0].getAttribute("data-urn") || arts[0].getAttribute("data-id") || "";
  })()`)) as string;
  if (dataUrn && /^urn:li:activity:\d+$/.test(dataUrn)) {
    return `https://www.linkedin.com/feed/update/${dataUrn}/`;
  }

  // Fallback 2: visible href walk on recent-activity (less reliable).
  const feedCandidates = (await page.evaluate(collectVisibleHrefs)) as string[];
  const fromFeed = pickFirstActivityHref(feedCandidates);
  if (fromFeed) {
    return fromFeed;
  }

  throw mapLiError("urn_not_found", {
    extra: {
      toastCandidateCount: toastCandidates.length,
      feedCandidateCount: feedCandidates.length,
      dataUrnFound: !!dataUrn,
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
