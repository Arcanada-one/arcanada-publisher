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
import { launchSession, withScreenshotOnFail } from "./context.js";
import { login as headedLogin } from "./login.js";
import { selectors, isCaptchaBlob, isLinksForbiddenBlob } from "./selectors.js";
import { extractWallPermalink } from "./url-extraction.js";
import { runVkPublish, type VkPublishSteps } from "./publish.js";
import { runVkComment, type VkCommentSteps } from "./comment.js";
import { type SessionState } from "./session-guard.js";
import { type WallPostSummary } from "./duplicate-guard.js";

/** Preview settle ceiling and publish-enabled ceiling (video transcoding). */
const VIDEO_PREVIEW_TIMEOUT_MS = 120_000;
const PUBLISH_READY_TIMEOUT_MS = 180_000;

export interface VkBrowserPublishInput extends PublishInput {
  /** Path to the native video (passed via --image on the CLI). */
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
async function readSessionState(page: Page): Promise<SessionState> {
  const url = page.url();
  const idHref = await page
    .locator('a[href^="/id"]')
    .first()
    .getAttribute("href")
    .catch(() => null);
  const accountId = idHref ? idHref.replace(/^\/id/, "") : undefined;
  const accountName =
    (await page
      .locator('[data-testid="profile_name"], .top_profile_name')
      .first()
      .innerText()
      .catch(() => "")) || undefined;
  const loggedIn = Boolean(accountId) || Boolean(accountName);
  const state: SessionState = { loggedIn, url };
  if (accountId !== undefined) state.accountId = accountId;
  if (accountName !== undefined) state.accountName = accountName;
  return state;
}

async function guardPlatformRefusals(page: Page): Promise<void> {
  const blob = await page.content().catch(() => "");
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

/** Build the concrete publish steps over a live page. */
function publishSteps(page: Page): VkPublishSteps {
  return {
    readSession: () => readSessionState(page),
    async readRecentPosts(): Promise<WallPostSummary[]> {
      // Read the operator's own wall via Node-side locators (no in-browser DOM types).
      const posts = page.locator('[data-testid="wall_post"], .post');
      const count = Math.min(await posts.count().catch(() => 0), 20);
      const out: WallPostSummary[] = [];
      for (let i = 0; i < count; i++) {
        const p = posts.nth(i);
        const text = await p
          .locator(".wall_post_text, [data-testid='wall_post_text']")
          .first()
          .innerText()
          .catch(() => "");
        const hasVideo =
          (await p
            .locator("video, [data-testid='video_preview']")
            .count()
            .catch(() => 0)) > 0;
        const href = await p
          .locator('a[href*="/wall"]')
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
    async uploadVideoAndAwaitReady(videoPath: string): Promise<void> {
      const fileInput = page.locator('input[type="file"]').first();
      await fileInput.setInputFiles(videoPath);
      await page
        .locator(selectors.attachedVideoPreview)
        .first()
        .waitFor({ state: "visible", timeout: VIDEO_PREVIEW_TIMEOUT_MS })
        .catch(() => {});
      await guardPlatformRefusals(page);
    },
    async typeText(text: string): Promise<void> {
      const box = page.getByRole("textbox").last();
      await box.click();
      await page.keyboard.insertText(text);
    },
    async preSubmitSnapshot() {
      const composerText = await page
        .getByRole("textbox")
        .last()
        .innerText()
        .catch(() => "");
      const hasVideo = (await page.locator(selectors.attachedVideoPreview).count()) > 0;
      return { hasText: composerText.trim().length > 0, hasVideo };
    },
    async submit(): Promise<string> {
      const publishBtn = page.getByRole("button", { name: selectors.publishButton }).first();
      await publishBtn
        .waitFor({ state: "visible", timeout: PUBLISH_READY_TIMEOUT_MS })
        .catch(() => {});
      await publishBtn.click();
      await guardPlatformRefusals(page);
      await page.waitForTimeout(3_000);
      const href = await page
        .locator('a[href*="/wall"]')
        .first()
        .evaluate((a) => (a as unknown as { href: string }).href);
      return extractWallPermalink(href);
    },
    async readBack(permalink: string) {
      await page.goto(permalink);
      const article = page.locator('[data-testid="wall_post"], .post').first();
      await article.waitFor({ state: "visible", timeout: 15_000 });
      const text = (await article.innerText().catch(() => "")) ?? "";
      const hasVideo = (await article.locator("video, [data-testid='video_preview']").count()) > 0;
      const authorName =
        (await article
          .locator(".author, [data-testid='post_author']")
          .first()
          .innerText()
          .catch(() => "")) || "";
      return { account: authorName, text, hasVideo };
    },
  };
}

function commentSteps(page: Page): VkCommentSteps {
  return {
    readSession: () => readSessionState(page),
    async postTopLevelComment(text: string) {
      const composer = page.getByRole("textbox", { name: selectors.commentComposer }).first();
      await composer.click();
      await page.keyboard.insertText(text);
      const submit = page.getByRole("button", { name: selectors.commentSubmit }).first();
      await submit.click();
      await guardPlatformRefusals(page);
      await page.waitForTimeout(2_000);
      const idAttr = await page
        .locator('[data-testid="comment"], .reply')
        .last()
        .getAttribute("data-comment-id")
        .catch(() => null);
      return { commentId: idAttr ?? "unknown" };
    },
    async readBackComment(commentId: string) {
      const block = page.locator(`[data-comment-id="${commentId}"], .reply`).last();
      const text = (await block.innerText().catch(() => "")) ?? "";
      const isReply = (await block.getAttribute("data-reply-to").catch(() => null)) !== null;
      const links = await block
        .locator("a[href]")
        .evaluateAll((els) => els.map((a) => (a as unknown as { href: string }).href));
      return { text, isReply, links };
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
    const videoPath = vi.videoPath ?? vi.imagePaths?.[0] ?? vi.imagePath;
    if (!videoPath) {
      throw new AdapterError(
        ErrorCode.MISSING_INPUT,
        "vk browser publish: a video (--image) is required",
      );
    }
    // Dry-run validates inputs (text preflight + video presence) with no browser IO.
    if (input.dryRun) {
      preflightPostText(input.text);
      return PublishResultSchema.parse({
        ok: true,
        platform: "vkontakte",
        account: "dry-run",
        postUrl: "https://vk.com/wall0_0",
        attachments: [{ kind: "video" as const, src: videoPath }],
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
            videoPath,
            profile: input.profile,
            expectedAccount,
            requireVideo: true,
          },
          publishSteps(page),
        ),
      ),
    );
  }

  async comment(input: CommentInput): Promise<CommentResult> {
    const vi = input as VkBrowserCommentInput & { dryRun?: boolean };
    const links = vi.links ?? [];
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
          { parentPostUrl: input.parentPostUrl, links, profile: input.profile, expectedAccount },
          commentSteps(page),
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

  async delete(_input: DeleteInput): Promise<DeleteResult> {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      "vk browser: delete is not supported in browser mode (operator deletes in the VK UI)",
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
      return await op(session.page);
    } finally {
      await session.close();
    }
  }
}

export { runVkPublish, type VkPublishSteps } from "./publish.js";
export { runVkComment, type VkCommentSteps } from "./comment.js";
export { assertAuthorized, detectExpiredFromUrl, type SessionState } from "./session-guard.js";
export { preflightPostText, sanitizeComposerText, POST_MAX_CHARS } from "./sanitize.js";
export {
  assertNotDuplicate,
  normalizeFragment,
  isSameTypedActionError,
} from "./duplicate-guard.js";
export { extractWallPermalink } from "./url-extraction.js";
export { assertPostReadBack } from "./readback.js";
