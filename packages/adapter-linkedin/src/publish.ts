// Migrated from Arcanada-one/li-publish@7ddadf81a1662abd66d7f04ea2b7acf737d6afe2 on 2026-05-21
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
import { cssSelectors, selectors } from "./selectors.js";
import { launchSession, withScreenshotOnFail } from "./context.js";
import { ACTIVITY_URN_RE, extractActivityUrn, pickFirstActivityHref } from "./url-extraction.js";
import { classifyLiError, mapLiError } from "./errors.js";
import { prepareMediaClipboard } from "./media-clipboard.js";
import {
  markComposerScopeJs,
  shadowClickComposerButtonJs,
  scopedVideoCountJs,
  shadowCountJs,
} from "./dom-shadow.js";

// PUB-0031: .mp4 and .mov added so the generated cover+narration video attaches
// via the same --image path on LinkedIn, mirroring the X adapter (PUB-0027).
// LinkedIn's «Add media» control accepts both images and video through the same
// file chooser; the difference is downstream — LinkedIn transcodes video and
// generates a preview thumbnail, so the «Next/Done» affordance appears much later
// than for a still image (see VIDEO_PROCESS_* below). Additive, guarded: existing
// image behaviour is unchanged.
const IMAGE_EXT_ALLOWLIST = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".mov"]);
const VIDEO_EXT = new Set([".mp4", ".mov"]);
const LINKEDIN_FEED = "https://www.linkedin.com/feed/";
const RECENT_ACTIVITY = "https://www.linkedin.com/in/me/recent-activity/all/";
const POST_BODY_LIMIT = 3000;
/** R7: the share-creation API call is the real publish confirmation. */
const LINKEDIN_SHARE_API = "voyager/api/contentcreation";

/** R1: collect every image path (imagePaths wins; imagePath is the legacy alias). */
export function collectImagePaths(input: PublishInput): string[] {
  if (input.imagePaths && input.imagePaths.length > 0) {
    return input.imagePaths;
  }
  if (input.imagePath) {
    return [input.imagePath];
  }
  return [];
}

/** PUB-0031: a path is a video attachment iff its extension is .mp4 / .mov. */
export function isVideoPath(path: string): boolean {
  return VIDEO_EXT.has(extname(path).toLowerCase());
}

/**
 * No-publish dry-run result (PublishOptions.abortBeforePost). The composer flow
 * ran end-to-end against the live UI and aborted before clicking «Post», so
 * nothing was published — `aborted` is always true and there is no `postUrl`.
 * `mediaAttached` reflects whether the scoped media preview was detected (the
 * PUB-0031 signal): for a video it means a `<video>` rendered INSIDE the composer
 * (not page-wide), proving the attach path works without publishing.
 */
export interface AbortedPublishResult {
  ok: true;
  platform: "linkedin";
  aborted: true;
  mediaAttached: boolean;
  attachments: { kind: "image" | "video"; src: string }[];
}

/** Type guard: distinguish the abort-before-post dry-run from a real publish. */
export function isAbortedPublish(
  r: PublishResult | AbortedPublishResult,
): r is AbortedPublishResult {
  return (r as AbortedPublishResult).aborted === true;
}

/** PUB-0031: attachment descriptor with the correct kind (video vs image). */
function attachmentsFor(paths: string[]): { kind: "image" | "video"; src: string }[] {
  return paths.map((src) => ({ kind: isVideoPath(src) ? "video" : "image", src }));
}

export interface PublishOptions {
  headed?: boolean;
  profileManager?: ProfileManager;
  /** Inject a pre-built page (smoke / integration). When set, `launchSession` is skipped. */
  page?: Page;
  /** Skip browser teardown — used by callers that own the session. */
  skipTeardown?: boolean;
  /**
   * PUB-0031 test seam: assert that the just-published post at `postUrl` carries
   * a real `<video>` player. Defaults to {@link defaultVerifyPostVideo}, which
   * re-fetches the live post page and polls for a `<video>`, distinguishing
   * "still transcoding" from "no video". Returning `false` makes `publish` throw
   * `verify_mismatch` (fail-closed) rather than report a false success.
   */
  __verifyPostVideo?: (page: Page, postUrl: string) => Promise<boolean>;
  /**
   * No-publish live verification (PUB-0031/PUB-0032 §"test without posting"): run
   * the FULL composer flow against the real LinkedIn UI — open the composer,
   * attach the media, wait for the SCOPED video/image preview, type the text —
   * then ABORT immediately before clicking «Post». NOTHING is published. The
   * returned result has `aborted: true` and `postUrl: ""`. This exercises every
   * selector + the scoped-video detection on the live DOM with zero side effects,
   * closing the "fake DOM ≠ real DOM" gap that unit tests cannot. Mutually useful
   * with a headed browser so the operator can watch the composer populate.
   */
  abortBeforePost?: boolean;
  /** Test seam and point-of-use clipboard ownership hook. */
  __prepareMediaClipboard?: (path: string) => unknown;
}

export async function publish(
  input: PublishInput,
  options: PublishOptions = {},
): Promise<PublishResult | AbortedPublishResult> {
  if (!input?.text || input.text.trim() === "") {
    throw new AdapterError(ErrorCode.MISSING_INPUT, "publish: 'text' is required");
  }
  if (input.text.length > POST_BODY_LIMIT) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `publish: text exceeds LinkedIn limit of ${POST_BODY_LIMIT} characters (got ${input.text.length})`,
    );
  }
  // R1: validate every image path (multi-image); the array order is preserved.
  const safeImagePaths = collectImagePaths(input).map(validateImagePath);

  // Dry-run validates inputs but performs no IO — no profile store, no browser.
  // (A page-injected test still exercises the dry-run branch in runPublishFlow.)
  if (input.dryRun && !options.page) {
    return PublishResultSchema.parse({
      ok: true,
      platform: "linkedin",
      account: "dry-run",
      postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:0/",
      attachments: attachmentsFor(safeImagePaths),
      commentIds: [],
    });
  }

  const clipboardPreparer = options.__prepareMediaClipboard ?? prepareMediaClipboard;
  if (safeImagePaths.length > 0 && (!options.page || options.__prepareMediaClipboard)) {
    clipboardPreparer(safeImagePaths[0]);
  }

  const profiles = options.profileManager ?? new ProfileManager();
  const profileDir = profiles.ensureProfileExists("linkedin", input.profile);

  if (options.page) {
    return runPublishFlow(options.page, input, safeImagePaths, options);
  }

  const session = await launchSession({
    profileDir,
    ...(options.headed !== undefined ? { headed: options.headed } : {}),
  });
  try {
    return await runPublishFlow(session.page, input, safeImagePaths, options);
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
  options: PublishOptions,
): Promise<PublishResult | AbortedPublishResult> {
  return withScreenshotOnFail(page, "publish", async () => {
    // PUB-0033: hard-load the feed so any composer left open by a prior failed
    // run is gone — a lingering empty composer would otherwise swallow the
    // trigger click and the post would publish empty (or the trigger would miss).
    // `waitForTimeout` is guarded so the unit-test fake page (which mocks only a
    // subset of the Page API) does not trip on the settle.
    await page.goto(LINKEDIN_FEED, { waitUntil: "domcontentloaded" });
    if (typeof page.waitForTimeout === "function") {
      await page.waitForTimeout(1_500);
    }

    // PUB-0031: language-agnostic composer trigger. Try the stable component
    // CSS class first (locale-independent), fall back to the localized button
    // text only if the class hook drifts. Either locator landing means we are
    // logged in and on the feed.
    const startPostCss = page.locator(cssSelectors.startPostButton).first();
    const startPostText = page.getByRole("button", { name: selectors.startPostButton }).first();
    let startPost = startPostCss;
    try {
      await startPostCss.waitFor({ state: "visible", timeout: 10_000 });
    } catch {
      try {
        await startPostText.waitFor({ state: "visible", timeout: 10_000 });
        startPost = startPostText;
      } catch (cause) {
        const blob = await safeContent(page);
        const klass = classifyLiError(blob);
        throw mapLiError(klass === "unknown" ? "not_logged_in" : klass, { cause });
      }
    }

    if (input.dryRun) {
      return PublishResultSchema.parse({
        ok: true,
        platform: "linkedin",
        account: "dry-run",
        postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:0/",
        attachments: attachmentsFor(imagePaths),
        commentIds: [],
      });
    }

    // PUB-0031 (verified live 2026-06: mixed EN/DE composer): the feed share-box
    // exposes dedicated «Video» / «Foto/Photo» entry buttons that open the media
    // flow AND fire the native filechooser directly. The OLD flow clicked the
    // generic «Start a post» trigger first and then looked for an «Add media»
    // button INSIDE the composer — that button does not exist in the current
    // composer, so the filechooser never fired (timeout). The reliable order is:
    //   - media post: click the feed «Video»/«Foto» entry → filechooser → setFiles
    //     (this opens the composer with the media already attached; the editor
    //      and Post button are located AFTERWARDS).
    //   - text-only post: click «Start a post» to open the composer, then type.
    // So we only click `startPost` up front for the text-only case.
    if (imagePaths.length === 0) {
      await startPost.click();
    }

    // PUB-0031: open the composer first (text-only AND media posts), then attach
    // media by CLIPBOARD PASTE — NOT a file chooser. The publisher policy
    // (docs/explanation/social-links-and-comments-policy.md §6.4) is explicit:
    // "Prefer pasting over the file-picker … the clipboard is the only reliable
    // attach path and it requires media-before-text." The file-chooser /
    // setInputFiles path is unreliable (host paths rejected, fires no event in
    // the 2026 composer) and is therefore NOT used. The caller places the media
    // file on the OS clipboard as a POSIX-file reference before invoking publish;
    // we paste it into the open composer with Ctrl/Cmd+V, wait for the upload to
    // settle, then type the text.
    // INFRA-0259 / PUB-0031: the composer lives inside an open shadow root
    // (<div id="interop-outlet">), so a Playwright pointer-click on buttons
    // inside it is intercepted ("interop-outlet intercepts pointer events").
    // The reliable click is a DOM `.click()` issued from INSIDE the shadow tree
    // via evaluate(); the scoped shadow walker matches the final Post control
    // by locale-tolerant accessible name inside the exact marked composer.
    // PUB-0033: «Add media» and «Next/Done» are no longer clicked — media is
    // pasted directly into the editor (no sub-modal, no advance step). Only the
    // final «Post» is driven via the shadow-walk click.
    const POST_RE = "/^(Post|Posten|Veröffentlichen|Опубликовать|Julkaise|Teilen)$/i";

    await startPost.click();

    // Locate the Quill editor in the open composer. CSS hook first
    // (locale-independent), localized textbox name as fallback.
    const editorCss = page.locator(cssSelectors.editor).first();
    const editor =
      (await editorCss.count()) > 0
        ? editorCss
        : page.getByRole("textbox", { name: selectors.editor }).first();
    await editor.waitFor({ state: "visible", timeout: 15_000 });
    const composerMarked = (await editor.evaluate((element, source) => {
      const marker = new Function(`return ${source}`)() as (node: typeof element) => boolean;
      return marker(element);
    }, markComposerScopeJs())) as boolean;
    if (!composerMarked) {
      throw mapLiError("composer_not_found", { extra: { stage: "composer_scope_unresolved" } });
    }
    // PUB-0033 (verified live 2026-06-26): the composer needs a moment to finish
    // initialising after it becomes visible — a paste issued immediately lands
    // nowhere and the media never attaches. A short settle before the first paste
    // makes the attach deterministic.
    await page.waitForTimeout(3_000);

    // Media FIRST via clipboard paste (operator rule §6.4: media-before-text).
    // PUB-0033: paste media DIRECTLY into the composer editor (see the block
    // below) — never click «Add media» (it opens the native OS file-picker in the
    // 2026 UI) and never use a file chooser. `mediaAttached` is reported by the
    // abortBeforePost dry-run (PUB-0031 signal).
    let mediaAttached = imagePaths.length === 0;
    if (imagePaths.length > 0) {
      const hasVideo = imagePaths.some(isVideoPath);

      // PUB-0033 (verified live 2026-06-26): paste the clipboard media DIRECTLY
      // into the composer editor — do NOT click «Add media». In the 2026 UI the
      // «Add media» button opens the NATIVE OS file-picker (a Finder dialog that
      // is invisible to automation and violates the clipboard-only rule §6.4),
      // and the subsequent Cmd/Ctrl+V lands nowhere → media never attaches. A
      // direct paste into the focused `.ql-editor` ingests the clipboard POSIX
      // file as media (a <video>/<img> preview appears, Post enables) with no
      // picker. Use the concrete OS accelerator: macOS Chromium did not deliver
      // a POSIX-file paste through the abstract ControlOrMeta alias.
      await editor.click();
      // Re-establish and verify at point of use, after focus and with no await or
      // clipboard write between this proof and the paste keystroke.
      if (!options.page || options.__prepareMediaClipboard) {
        (options.__prepareMediaClipboard ?? prepareMediaClipboard)(imagePaths[0]);
      }
      await page.keyboard.press(process.platform === "darwin" ? "Meta+v" : "Control+v");
      // Wait for ingest: a <video> (or <img> for a still) preview appears. Video
      // transcodes server-side, much longer than an image — bounded poll.
      await page.waitForTimeout(hasVideo ? 6_000 : 3_000);
      // PUB-0031 fail-closed video detection: the OLD detector matched `video`
      // ANYWHERE on the page (`page.locator("video, ...")`), so a stray feed/
      // profile <video> produced a FALSE positive — the post then published
      // text-only on a non-existent attachment. We now count ONLY <video>
      // elements that descend from a composer / media-editor scope via
      // `scopedVideoCountJs` (shadow-aware). For images we keep the page-level
      // blob/preview hooks (still images do not false-positive the same way and
      // there is no scoped image equivalent in the 2026 composer).
      let attached = false;
      // Large videos (tens of MB / many minutes) need longer than the 180s
      // default before their <video> preview appears in the composer. Override
      // via LINKEDIN_VIDEO_PREVIEW_POLLS (× 500ms). Default 360 = 180s.
      const videoPreviewPolls = Number(process.env["LINKEDIN_VIDEO_PREVIEW_POLLS"] ?? 360);
      const maxPolls = hasVideo ? videoPreviewPolls : 40; // video default ≤180s, image ≤20s
      const imagePreviewSel =
        "img[src^='blob:'], img[src*='media'], [data-test-media-preview], .share-images";
      for (let i = 0; i < maxPolls; i++) {
        if (hasVideo) {
          const n = (await page.evaluate(scopedVideoCountJs())) as number;
          if (n > 0) {
            attached = true;
            break;
          }
        } else if ((await page.locator(imagePreviewSel).count()) > 0) {
          attached = true;
          break;
        }
        await page.waitForTimeout(500);
      }
      if (!attached) {
        throw mapLiError("composer_not_found", {
          extra: { stage: hasVideo ? "video_paste_no_preview" : "image_paste_no_preview" },
        });
      }
      mediaAttached = true;

      // PUB-0033: with the direct-paste-into-editor flow the media lands straight
      // in the composer — there is NO media sub-modal and therefore NO «Next»/
      // «Done» step to advance through (the legacy Add-media path opened a
      // sub-modal that needed it). Clicking a stray «Next»/«Done» here used to
      // hit an unrelated control and reset the composer to empty. We just let the
      // upload settle in place; for a video, give the transcode a moment.
      await page.waitForTimeout(hasVideo ? 4_000 : 2_500);
    }

    // Fill text AFTER media (operator rule §6.4: media-before-text).
    await editor.click();
    await page.keyboard.insertText(input.text);

    // No-publish dry-run (PublishOptions.abortBeforePost): the composer is now
    // fully populated — media attached + text typed — and we are ONE click away
    // from publishing. Abort here so NOTHING goes out. This is the highest-fidelity
    // verification possible without posting: every selector resolved on the live
    // DOM and (for video) the scoped <video> preview was detected. Returns the
    // aborted result; the «Post» click below is never reached.
    if (options.abortBeforePost) {
      return {
        ok: true,
        platform: "linkedin",
        aborted: true,
        mediaAttached,
        attachments: attachmentsFor(imagePaths),
      } satisfies AbortedPublishResult;
    }

    // PUB-0031: the «Post» button is inside the interop-outlet shadow root too,
    // so a Playwright pointer-click is intercepted — click it via shadow-walk
    // DOM click (the scoped walker skips disabled buttons, so a disabled Post simply
    // yields false and we keep polling). For a video the button stays disabled
    // until LinkedIn finishes finalising the upload, so poll a generous window.
    // R7: the share-creation API call is the publish confirmation; the DOM toast
    // caches and lies. We race the (polled) click against the network response.
    const publishingVideo = imagePaths.some(isVideoPath);
    // The Post button stays disabled until LinkedIn finalises the upload; a
    // large video needs longer than the 60s default. Override via
    // LINKEDIN_POST_BUTTON_POLLS (× 500ms). Default 120 = 60s.
    const postMaxPolls = publishingVideo
      ? Number(process.env["LINKEDIN_POST_BUTTON_POLLS"] ?? 120)
      : 20; // ~60s / ~10s @ 500ms
    let posted = false;
    const clickPost = async (): Promise<void> => {
      for (let i = 0; i < postMaxPolls; i++) {
        posted = (await page.evaluate(shadowClickComposerButtonJs(POST_RE))) as boolean;
        if (posted) return;
        await page.waitForTimeout(500);
      }
    };
    // Share-API confirmation timeout: a large video's finalisation can exceed the
    // 30s default. Override via LINKEDIN_SHARE_API_TIMEOUT_MS. Default 30000.
    const shareApiTimeoutMs = publishingVideo
      ? Number(process.env["LINKEDIN_SHARE_API_TIMEOUT_MS"] ?? 30_000)
      : 15_000;
    await Promise.all([
      page
        .waitForResponse((r) => r.url().includes(LINKEDIN_SHARE_API), {
          timeout: shareApiTimeoutMs,
        })
        .catch(() => null),
      clickPost(),
    ]);
    if (!posted) {
      throw mapLiError("publish_button_disabled");
    }
    await page.waitForTimeout(publishingVideo ? 9_000 : 6_000);

    const postUrl = await extractPublishedUrl(page);

    // PUB-0031 fail-closed post-publish re-verify: when we attached a video, the
    // composer-side check (scopedVideoCountJs above) can still be fooled if the
    // upload silently dropped between «Next» and «Post». The authoritative oracle
    // is the LIVE post page — re-fetch it and assert it renders a <video> player.
    // LinkedIn transcodes asynchronously and lazy-renders the player, so the
    // verifier polls a bounded window and only throws when the post genuinely
    // carries no video (distinguishing «no video» from «still transcoding» by
    // exhausting the bounded retry). Reported success now implies a verified
    // video — never a text-only post on a "video" publish (§6.2/§6.3).
    if (imagePaths.some(isVideoPath)) {
      const verify = options.__verifyPostVideo ?? defaultVerifyPostVideo;
      const hasVideo = await verify(page, postUrl);
      if (!hasVideo) {
        throw mapLiError("verify_mismatch", {
          message:
            "published post does not render a <video> player (video attach silently dropped)",
          extra: { postUrl, stage: "post_publish_video_reverify" },
        });
      }
    }

    return PublishResultSchema.parse({
      ok: true,
      platform: "linkedin",
      account: extractAccountFromActivityUrl(postUrl),
      postUrl,
      attachments: attachmentsFor(imagePaths),
      commentIds: [],
    });
  });
}

/**
 * PUB-0031 default post-publish video oracle: re-fetch the live post page and
 * poll for a `<video>` player inside the post (shadow-aware). Returns true as
 * soon as one appears; false after a bounded wait (≈90s, generous enough to
 * cover LinkedIn's async transcode + lazy player render). Distinguishes "still
 * transcoding" (keeps polling) from "no video" (poll exhausts → false → caller
 * fails closed). Injectable via `PublishOptions.__verifyPostVideo` for tests.
 */
async function defaultVerifyPostVideo(page: Page, postUrl: string): Promise<boolean> {
  await page.goto(postUrl, { waitUntil: "domcontentloaded" });
  // The player container hooks LinkedIn uses for native video. We count <video>
  // anywhere in the post page here (NOT scoped to a composer) because on the live
  // post page the only <video> is the post's own player — there is no composer.
  // A bare `video` plus the known player wrappers covers lazy-render variants.
  const POST_VIDEO_SEL =
    "video, [data-test-native-video], .video-js, [class*='video-player'], [data-vjs-player]";
  for (let i = 0; i < 180; i++) {
    const n = (await page.evaluate(shadowCountJs(POST_VIDEO_SEL))) as number;
    if (n > 0) return true;
    await page.waitForTimeout(500);
  }
  return false;
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
 *  Future enhancement: derive author from DOM author-card. */
function extractAccountFromActivityUrl(activityUrl: string): string {
  // Sanity-check format; throws if drift breaks contract.
  extractActivityUrn(activityUrl);
  if (!ACTIVITY_URN_RE.test(activityUrl)) {
    return "unknown";
  }
  return "self";
}
