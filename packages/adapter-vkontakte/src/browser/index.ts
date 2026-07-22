// VK browser-mode adapter: wires the pure orchestrators (publish/comment) to
// concrete Playwright DOM steps over a persistent profile. The pure ordering and
// guard logic is unit-tested (tests/browser/*); the DOM step bodies below are
// live-verified on the Mac headed run (deploy-deferred, PUB-0034 Phase 3) and
// their selectors captured into datarim/tasks/PUB-0034-fixtures.md.

import { type Page } from "playwright";
import {
  AdapterError,
  BaseAdapter,
  CommentResultSchema,
  ErrorCode,
  ProfileManager,
  PublishResultSchema,
  type CommentInput,
  type CommentResult,
  type DeleteInput,
  type DeleteResult,
  type EditInput,
  type EditResult,
  type LoginOptions,
  type PublishInput,
  type PublishResult,
} from "@arcanada/publisher-core";
import { preflightPostText } from "./sanitize.js";
import { launchSession, openVkFeed, withScreenshotOnFail } from "./context.js";
import { login as headedLogin } from "./login.js";
import { isCaptchaBlob, isLinksForbiddenBlob } from "./selectors.js";
import { extractWallPermalink } from "./url-extraction.js";
import { runVkPublish, type VkPublishSteps } from "./publish.js";
import { runVkComment, type VkCommentSteps } from "./comment.js";
import { type SessionState } from "./session-guard.js";
import { type WallPostSummary } from "./duplicate-guard.js";
import { WALL_PATH_RE } from "./url-extraction.js";
import { uploadMediaAfterComposerSettles } from "./media-upload.js";
import { waitForFinalMediaPreview } from "./final-media-preview.js";
import { enterAndSettleComposerText, waitForFinalTextPreview } from "./composer-text.js";
import { runVkDelete, type VkDeleteSteps } from "./delete.js";

/** Preview settle ceiling and publish-enabled ceiling (video transcoding). */
const VIDEO_PREVIEW_TIMEOUT_MS = 120_000;
const PUBLISH_READY_TIMEOUT_MS = 180_000;
const POST_SELECTOR = '[data-testid="post"]';
const PROFILE_READY_SELECTOR = '[data-testid="posting_create_post_button"]';
const COMPOSER_TITLE_SELECTOR = '[data-testid="modalheader-title"]';

function extractUrls(text: string): string[] {
  return text.match(/https?:\/\/[^\s]+/g)?.map((url) => url.replace(/[),.;]+$/, "")) ?? [];
}

function mediaKind(path: string): "image" | "video" {
  return /\.(?:avi|m4v|mkv|mov|mp4|webm)$/i.test(path) ? "video" : "image";
}

async function openOwnProfile(page: Page): Promise<void> {
  const profileLink = page
    .locator('[data-testid="leftmenu"] a')
    .filter({ hasText: /^Профиль$/ })
    .first();
  await profileLink.waitFor({ state: "visible", timeout: 15_000 });
  const href = await profileLink.getAttribute("href");
  if (!href) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "vk: own-profile link is not observable — STOP before composer",
    );
  }
  await page.goto(new URL(href, page.url()).toString(), { waitUntil: "domcontentloaded" });
  await page.locator(PROFILE_READY_SELECTOR).waitFor({ state: "visible", timeout: 30_000 });
}

function wallIdFromPermalink(permalink: string): string {
  const match = new URL(permalink).pathname.match(WALL_PATH_RE);
  if (!match) {
    throw new AdapterError(ErrorCode.VERIFY_FAILED, "vk: cannot bind target wall post", {
      permalink,
    });
  }
  return `${match[1]}_${match[2]}`;
}

export function targetPost(page: Page, permalink: string) {
  const wallId = wallIdFromPermalink(permalink);
  const currentPath = new URL(page.url()).pathname;
  if (currentPath === `/wall${wallId}`) {
    // On VK's direct wall route the post timestamp is rendered without an
    // href, so the permalink anchor used on profile/feed pages is absent.
    // The exact current URL is itself the binding oracle.
    return page.locator(POST_SELECTOR).first();
  }
  return page.locator(`${POST_SELECTOR}:has(a[href*="/wall${wallId}"])`).first();
}

async function renderedPostText(post: ReturnType<Page["locator"]>): Promise<string> {
  const showMore = post.locator('[data-testid="showmoretext-after"]').first();
  if (await showMore.isVisible().catch(() => false)) {
    await showMore.click();
  }
  return (
    (await post
      .locator('[data-testid="showmoretext-in-expanded"], [data-testid="showmoretext-in"]')
      .first()
      .innerText()
      .catch(() => "")) || ""
  );
}

export interface VkBrowserPublishInput extends PublishInput {
  /** Path to the native image or video (passed via --image on the CLI). */
  videoPath?: string;
  /** Expected operator account id/name (identity-assertion target). */
  expectedAccountId?: string;
  expectedAccountName?: string;
}

export interface VkBrowserCommentInput extends CommentInput {
  /** Exactly four links, in order Telegram, X, Site, Article. */
  links?: string[];
  expectedAccountId?: string;
  expectedAccountName?: string;
}

export interface VkBrowserOptions {
  headed?: boolean;
  profileManager?: ProfileManager;
  /** Inject a page (integration/smoke); when set, launchSession is skipped. */
  page?: Page;
}

/** Read the logged-in identity + current URL off the live page. */
export async function readSessionState(page: Page): Promise<SessionState> {
  const url = page.url();
  const idLink = page.locator('a[href^="/id"]').first();
  const idHref =
    (await idLink.count().catch(() => 0)) > 0
      ? await idLink.getAttribute("href").catch(() => null)
      : null;
  const accountId = idHref ? idHref.replace(/^\/id/, "") : undefined;
  const legacyName = page.locator('[data-testid="profile_name"], .top_profile_name').first();
  let accountName =
    (await legacyName.count().catch(() => 0)) > 0
      ? (await legacyName.innerText().catch(() => "")) || undefined
      : undefined;

  // VK's current desktop UI exposes only a profile-menu button in the top bar.
  // Open that read-only menu to obtain the display name used by the positive
  // identity assertion, then close it before any composer interaction.
  const profileMenuButton = page.locator('[data-testid="header-profile-menu-button"]').first();
  const hasProfileMenu = await profileMenuButton.isVisible().catch(() => false);
  if (!accountName && hasProfileMenu) {
    await profileMenuButton.click();
    const profileMenu = page.locator('[data-testid="header-profile-menu"]').first();
    await profileMenu.waitFor({ state: "visible", timeout: 5_000 });
    accountName =
      (await profileMenu
        .locator('[class*="UserPlaceholder-module_header"]')
        .first()
        .innerText()
        .catch(() => "")) || undefined;
    await page.keyboard.press("Escape").catch(() => {});
  }

  const loggedIn = Boolean(accountId) || Boolean(accountName) || hasProfileMenu;
  const state: SessionState = { loggedIn, url };
  if (accountId !== undefined) state.accountId = accountId;
  if (accountName !== undefined) state.accountName = accountName;
  return state;
}

export async function guardPlatformRefusals(page: Page): Promise<void> {
  // Inspect rendered user-visible text only. VK's application bundle contains
  // dormant strings such as "captcha" even during a normal authorised flow;
  // scanning page.content() therefore creates a guaranteed false positive.
  const blob = await page
    .locator("body")
    .innerText()
    .catch(() => "");
  if (isCaptchaBlob(blob)) {
    throw new AdapterError(
      ErrorCode.RATE_LIMIT,
      "vk: captcha / bot-check detected — STOP (operator decides)",
    );
  }
  if (isLinksForbiddenBlob(blob)) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "vk: platform refused links (hyperlinks forbidden) — STOP",
    );
  }
}

export async function resolveSavedDraft(page: Page, allowReset: boolean): Promise<void> {
  const savedDraft = page.getByRole("button", { name: "Открыть черновик", exact: true });
  if (!(await savedDraft.isVisible().catch(() => false))) return;

  if (!allowReset) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "vk publish: saved draft detected — STOP; operator must resolve it explicitly",
    );
  }

  const restart = page.getByRole("button", { name: "Начать заново", exact: true });
  if (!(await restart.isVisible().catch(() => false))) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "vk publish: saved draft reset was armed but the explicit reset control is missing — STOP",
    );
  }

  await restart.click();
  const composerTitle = page.locator(COMPOSER_TITLE_SELECTOR).filter({ hasText: "Новый пост" });
  await composerTitle.waitFor({ state: "visible", timeout: 15_000 });

  const attachmentCount = await page
    .locator('[data-testid="posting_attachment_item"]')
    .count()
    .catch(() => -1);
  const composerText = await page
    .locator('[data-testid="posting_base_screen_input_message"]')
    .innerText()
    .catch(() => "__unreadable__");
  if (attachmentCount !== 0 || composerText.trim() !== "") {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "vk publish: saved draft reset did not produce a clean composer — STOP",
    );
  }
}

/** Build the concrete publish steps over a live page. */
function publishSteps(page: Page, kind: "image" | "video"): VkPublishSteps {
  let composerBody = "";
  return {
    readSession: () => readSessionState(page),
    async readRecentPosts(): Promise<WallPostSummary[]> {
      await openOwnProfile(page);
      // Read only the operator's own wall, never the mixed news feed.
      const posts = page.locator(POST_SELECTOR);
      const count = Math.min(await posts.count().catch(() => 0), 20);
      const out: WallPostSummary[] = [];
      for (let i = 0; i < count; i++) {
        const p = posts.nth(i);
        const text = await renderedPostText(p);
        const hasVideo =
          (await p
            .locator('video, [data-testid="primary-attachment-video"]')
            .count()
            .catch(() => 0)) > 0;
        const href = await p
          .locator('[data-testid="post_date_block_preview"][href*="/wall"]')
          .first()
          .getAttribute("href")
          .catch(() => null);
        out.push({
          text,
          hasVideo,
          permalink: href ? new URL(href, "https://vk.com").toString() : "",
        });
      }
      return out;
    },
    async uploadMediaAndAwaitReady(mediaPath: string): Promise<void> {
      const create = page.locator(PROFILE_READY_SELECTOR).first();
      await create.click();

      // Never overwrite a draft unless the caller explicitly arms a one-shot
      // reset. The reset path verifies that VK produced a clean composer.
      const savedDraft = page.getByRole("button", { name: "Открыть черновик", exact: true });
      const composerTitle = page.locator(COMPOSER_TITLE_SELECTOR).filter({ hasText: "Новый пост" });
      await Promise.race([
        savedDraft.waitFor({ state: "visible", timeout: 15_000 }),
        composerTitle.waitFor({ state: "visible", timeout: 15_000 }),
      ]).catch(() => {});
      await resolveSavedDraft(page, process.env.VK_DISCARD_SAVED_DRAFT === "1");
      await composerTitle.waitFor({ state: "visible", timeout: 15_000 });

      const dropZone = page.locator('[data-testid="posting_base_screen_draganddrop"]').first();
      await dropZone.waitFor({ state: "visible", timeout: 15_000 });
      const fileInput = dropZone
        .locator('[data-testid="posting_base_screen_download_from_device"]')
        .first();
      await fileInput.waitFor({ state: "attached", timeout: 15_000 });
      await uploadMediaAfterComposerSettles(page, fileInput, mediaPath);
      await page
        .locator('[data-testid="posting_attachment_item"]')
        .first()
        .waitFor({ state: "visible", timeout: VIDEO_PREVIEW_TIMEOUT_MS });
      await page
        .locator('[data-testid="posting_base_screen_next"]')
        .waitFor({ state: "visible", timeout: VIDEO_PREVIEW_TIMEOUT_MS });
      await guardPlatformRefusals(page);
    },
    async typeText(text: string): Promise<void> {
      const box = page.locator('[data-testid="posting_base_screen_input_message"]');
      const blurTarget = page.locator(COMPOSER_TITLE_SELECTOR).filter({ hasText: "Новый пост" });
      await enterAndSettleComposerText(page, box, blurTarget, text);
      composerBody = text;
    },
    async preSubmitSnapshot() {
      const composerText = await page
        .locator('[data-testid="posting_base_screen_input_message"]')
        .innerText()
        .catch(() => "");
      const hasMedia = (await page.locator('[data-testid="posting_attachment_item"]').count()) > 0;
      return { hasText: composerText.trim().length > 0, hasMedia };
    },
    async submit(): Promise<string> {
      await page.locator('[data-testid="posting_base_screen_next"]').click();
      const publishBtn = page.locator('[data-testid="posting_submit_button"]');
      await publishBtn.waitFor({ state: "visible", timeout: PUBLISH_READY_TIMEOUT_MS });
      await waitForFinalTextPreview(publishBtn, composerBody, PUBLISH_READY_TIMEOUT_MS);
      await waitForFinalMediaPreview(publishBtn, kind, PUBLISH_READY_TIMEOUT_MS);
      if (!(await publishBtn.isEnabled())) {
        throw new AdapterError(
          ErrorCode.VERIFY_FAILED,
          "vk publish: final publish control is disabled — ABORT",
        );
      }
      await publishBtn.click();
      await guardPlatformRefusals(page);
      await publishBtn.waitFor({ state: "hidden", timeout: PUBLISH_READY_TIMEOUT_MS });

      const title = composerBody.split("\n", 1)[0]?.trim();
      if (!title) {
        throw new AdapterError(ErrorCode.VERIFY_FAILED, "vk publish: title oracle is empty");
      }
      const published = page.locator(POST_SELECTOR).filter({ hasText: title }).first();
      await published.waitFor({ state: "visible", timeout: 30_000 });
      const href = await published
        .locator('[data-testid="post_date_block_preview"][href*="/wall"]')
        .first()
        .evaluate((a) => (a as unknown as { href: string }).href);
      return extractWallPermalink(href);
    },
    async readBack(permalink: string) {
      await page.goto(permalink, { waitUntil: "domcontentloaded" });
      const article = targetPost(page, permalink);
      await article.waitFor({ state: "visible", timeout: 15_000 });
      const text = await renderedPostText(article);
      const hasVideo =
        (await article.locator('video, [data-testid="primary-attachment-video"]').count()) > 0;
      const hasImage =
        (await article
          .locator(
            '[data-testid="primary-attachment-photo"], [data-testid="primary-attachment-image-content"]',
          )
          .count()) > 0;
      const authorName =
        (await article
          .locator('[data-testid="post-header-title"]')
          .first()
          .innerText()
          .catch(() => "")) || "";
      return { account: authorName, text, hasVideo, hasImage };
    },
  };
}

function commentSteps(page: Page, parentPostUrl: string): VkCommentSteps {
  let postedCommentId = "";
  return {
    readSession: () => readSessionState(page),
    async postTopLevelComment(text: string) {
      await page.goto(parentPostUrl, { waitUntil: "domcontentloaded" });
      const article = targetPost(page, parentPostUrl);
      await article.waitFor({ state: "visible", timeout: 20_000 });
      const composer = article
        .locator('[data-testid="content-editable-input"][aria-label^="Написать комментарий"]')
        .first();
      await composer.click();
      await page.keyboard.insertText(text);
      const submit = article.locator('[data-testid="send-comment"]');
      await submit.click();
      await guardPlatformRefusals(page);
      const linkOracle = extractUrls(text)[0];
      const comments = article.locator('[data-testid="wall_comments_comment_root"]');
      const posted = linkOracle ? comments.filter({ hasText: linkOracle }).last() : comments.last();
      await posted.waitFor({ state: "visible", timeout: 20_000 });
      const idAttr = await posted.getAttribute("id");
      const commentId = idAttr?.match(/_([0-9]+)$/)?.[1];
      if (!commentId) {
        throw new AdapterError(
          ErrorCode.VERIFY_FAILED,
          "vk comment: posted comment id is not observable — STOP",
        );
      }
      postedCommentId = commentId;
      return { commentId };
    },
    async readBackComment(commentId: string) {
      const block = page
        .locator(`[data-testid="wall_comments_comment_root"][id$="_${commentId}"]`)
        .last();
      await block.waitFor({ state: "visible", timeout: 15_000 });
      const text = (await block.innerText().catch(() => "")) ?? "";
      const isReply =
        (await block
          .locator('xpath=ancestor::*[@data-testid="wall_comments_comment_root"]')
          .count()) > 0;
      const links = await block
        .locator('a[data-testid="link"][href]')
        .evaluateAll((els) => els.map((a) => (a as unknown as { href: string }).href));
      if (postedCommentId && postedCommentId !== commentId) {
        throw new AdapterError(ErrorCode.VERIFY_FAILED, "vk comment read-back id mismatch");
      }
      return { text, isReply, links };
    },
  };
}

function deleteSteps(page: Page, targetUrl: string): VkDeleteSteps {
  const expectedWallId = wallIdFromPermalink(targetUrl);
  const exactPost = () =>
    page.locator(`${POST_SELECTOR}[data-post-id="${expectedWallId}"]`).first();

  return {
    readSession: () => readSessionState(page),
    async readTarget() {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
      const post = exactPost();
      await post.waitFor({ state: "visible", timeout: 20_000 });
      const wallId = (await post.getAttribute("data-post-id")) ?? "";
      const author =
        (await post
          .locator('[data-testid="post-header-title"]')
          .first()
          .innerText()
          .catch(() => "")) || "";
      const renderedContent = (await post.innerText().catch(() => "")) || "";
      const deleted =
        /^(Post deleted|Пост удалён)/i.test(await page.title()) ||
        /(^|\n)(Post deleted|Пост удалён)(\n|$)/i.test(renderedContent);
      return { wallId, author, renderedContent, deleted };
    },
    async performDelete() {
      const post = exactPost();
      if ((await post.count()) !== 1) {
        throw new AdapterError(
          ErrorCode.VERIFY_FAILED,
          "vk delete: exact target post is absent or ambiguous — aborting without deletion",
          { targetUrl, expectedWallId },
        );
      }
      const menuToggle = post.locator('[data-testid="post_context_menu_toggle"]');
      await menuToggle.waitFor({ state: "visible", timeout: 10_000 });
      await menuToggle.click();
      const menu = page.locator('[data-testid="post_context_menu"][role="dialog"]');
      await menu.waitFor({ state: "visible", timeout: 5_000 });
      const deleteItem = menu.locator('[data-testid="post_context_menu_item_delete"]');
      if ((await deleteItem.count()) !== 1) {
        throw new AdapterError(
          ErrorCode.VERIFY_FAILED,
          "vk delete: exact one-click delete item is absent or ambiguous — aborting",
          { targetUrl, expectedWallId },
        );
      }
      // Current VK desktop performs a soft-delete immediately: there is no
      // confirmation dialog after this click. The orchestrator MUST read back.
      await deleteItem.click();
    },
    async readAfter() {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1_000);
      const post = exactPost();
      const present = (await post.count().catch(() => 0)) === 1;
      const rendered = present ? await post.innerText().catch(() => "") : "";
      const title = await page.title().catch(() => "");
      const deleted =
        /^(Post deleted|Пост удалён)/i.test(title) ||
        /(^|\n)(Post deleted|Пост удалён)(\n|$)/i.test(rendered);
      return { wallId: expectedWallId, deleted };
    },
  };
}

/** Expected operator account for identity-assertion (from options or env). */
function resolveExpectedAccount(fromInput: { id?: string; name?: string }): {
  accountId?: string;
  accountName?: string;
} {
  const id = fromInput.id ?? process.env["VK_EXPECTED_ACCOUNT_ID"];
  const name = fromInput.name ?? process.env["VK_EXPECTED_ACCOUNT_NAME"];
  return {
    ...(id ? { accountId: id } : {}),
    ...(name ? { accountName: name } : {}),
  };
}

export class VKontakteBrowserAdapter extends BaseAdapter {
  readonly platform = "vkontakte" as const;
  constructor(private readonly options: VkBrowserOptions = {}) {
    super();
  }

  async login(opts: LoginOptions): Promise<void> {
    const ctx = this.options.profileManager ? { profileManager: this.options.profileManager } : {};
    await headedLogin(opts, ctx);
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const vi = input as VkBrowserPublishInput;
    const mediaPath = vi.videoPath ?? vi.imagePaths?.[0] ?? vi.imagePath;
    if (!mediaPath) {
      throw new AdapterError(
        ErrorCode.MISSING_INPUT,
        "vk browser publish: an image or video (--image) is required",
      );
    }
    const kind = mediaKind(mediaPath);
    // Dry-run validates inputs (text preflight + video presence) with no browser IO.
    if (input.dryRun) {
      preflightPostText(input.text);
      return PublishResultSchema.parse({
        ok: true,
        platform: "vkontakte",
        account: "dry-run",
        postUrl: "https://vk.com/wall0_0",
        attachments: [{ kind, src: mediaPath }],
        commentIds: [],
      });
    }
    const expectedAccount = resolveExpectedAccount({
      ...(vi.expectedAccountId !== undefined ? { id: vi.expectedAccountId } : {}),
      ...(vi.expectedAccountName !== undefined ? { name: vi.expectedAccountName } : {}),
    });
    return this.withPage(input.profile, (page) =>
      withScreenshotOnFail(page, "vk-publish", () =>
        runVkPublish(
          {
            text: input.text,
            mediaPath,
            mediaKind: kind,
            profile: input.profile,
            expectedAccount,
          },
          publishSteps(page, kind),
        ),
      ),
    );
  }

  async comment(input: CommentInput): Promise<CommentResult> {
    const vi = input as VkBrowserCommentInput & { dryRun?: boolean };
    const links = vi.links ?? extractUrls(input.text);
    // Dry-run symmetry with publish(): validate inputs, never launch a browser.
    if (vi.dryRun) {
      if (links.length !== 4) {
        throw new AdapterError(
          ErrorCode.MISSING_INPUT,
          "vk browser comment: exactly 4 links are required",
        );
      }
      return CommentResultSchema.parse({
        ok: true,
        platform: "vkontakte",
        account: "dry-run",
        commentId: "0",
        parentPostUrl: input.parentPostUrl,
      });
    }
    const expectedAccount = resolveExpectedAccount({
      ...(vi.expectedAccountId !== undefined ? { id: vi.expectedAccountId } : {}),
      ...(vi.expectedAccountName !== undefined ? { name: vi.expectedAccountName } : {}),
    });
    return this.withPage(input.profile, (page) =>
      withScreenshotOnFail(page, "vk-comment", () =>
        runVkComment(
          {
            parentPostUrl: input.parentPostUrl,
            text: input.text,
            links,
            profile: input.profile,
            expectedAccount,
          },
          commentSteps(page, input.parentPostUrl),
        ),
      ),
    );
  }

  async edit(_input: EditInput): Promise<EditResult> {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      "vk browser: edit is not supported in browser mode (use the API adapter)",
    );
  }

  async delete(input: DeleteInput): Promise<DeleteResult> {
    if (input.kind !== "post") {
      throw new AdapterError(
        ErrorCode.UNSUPPORTED_OPERATION,
        "vk browser delete: comment deletion is not supported",
      );
    }
    const expectedAccount = resolveExpectedAccount({});
    return this.withPage(input.profile, (page) =>
      withScreenshotOnFail(page, "vk-delete", () =>
        runVkDelete(
          {
            targetUrl: input.targetUrl,
            expectedContent: input.expectedContent,
            profile: input.profile,
            expectedAccount,
          },
          deleteSteps(page, input.targetUrl),
        ),
      ),
    );
  }

  private async withPage<T>(profile: string, op: (page: Page) => Promise<T>): Promise<T> {
    if (this.options.page) return op(this.options.page);
    const profiles = this.options.profileManager ?? new ProfileManager();
    const profileDir = profiles.ensureProfileExists("vkontakte", profile);
    const session = await launchSession({
      profileDir,
      ...(this.options.headed !== undefined ? { headed: this.options.headed } : {}),
    });
    try {
      await openVkFeed(session.page);
      return await op(session.page);
    } finally {
      await session.close();
    }
  }
}

export { runVkPublish, type VkPublishSteps } from "./publish.js";
export { runVkComment, type VkCommentSteps } from "./comment.js";
export { runVkDelete, type VkDeleteSteps } from "./delete.js";
export { assertAuthorized, detectExpiredFromUrl, type SessionState } from "./session-guard.js";
export { preflightPostText, sanitizeComposerText, POST_MAX_CHARS } from "./sanitize.js";
export {
  assertNotDuplicate,
  normalizeFragment,
  isSameTypedActionError,
} from "./duplicate-guard.js";
export { extractWallPermalink } from "./url-extraction.js";
export { assertPostReadBack } from "./readback.js";
