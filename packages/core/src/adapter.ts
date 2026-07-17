import type {
  CommentResult,
  DeleteResult,
  EditResult,
  PublishResult,
  VerifyResult,
} from "./result.js";
import type { Platform } from "./platform.js";

export interface PublishInput {
  text: string;
  /** @deprecated single-image alias — use {@link PublishInput.imagePaths}. */
  imagePath?: string;
  /** R1: one or more image paths; adapters require at least one (image-mandatory). */
  imagePaths?: string[];
  profile: string;
  dryRun?: boolean;
  /** Reddit-specific target subreddit (without the `r/` prefix). */
  subreddit?: string;
  /** Reddit self-post title; Telegram article-bundle media title. */
  title?: string;
  /** VK-specific wall owner id. */
  ownerId?: number;
  /** Telegram target chat/channel id or @username. */
  chatId?: string;
  /**
   * PUB-0033: opt-in X Premium long-form mode. When true, the X adapter gates
   * the body on the 25 000 UTF-16-unit Premium ceiling instead of the free-tier
   * 280 limit. Ignored by adapters without a tiered length limit.
   */
  premium?: boolean;
  /** Stable author-profile oracle required by adapters that verify ownership after publish. */
  expectedAuthorProfileUrl?: string;
  /** YouTube-specific: path to the video file to upload (video-mandatory platform). */
  videoPath?: string;
  /** YouTube-specific: video language driving fail-closed playlist routing; the adapter validates the allowed set. */
  language?: string;
  /** YouTube-specific: requested visibility; effective status is read back after processing. */
  privacyStatus?: "private" | "unlisted" | "public";
}

export interface CommentInput {
  parentPostUrl: string;
  text: string;
  profile: string;
}

export interface EditInput {
  postUrl: string;
  text?: string;
  imagePath?: string;
  /** Read-before-edit oracle; Telegram requires it for media replacement. */
  expectedContent?: string;
  /** Read-before-edit media oracle for adapters that can inspect the current artifact. */
  expectedMediaKind?: "image" | "video" | "none";
  /** Explicit read-before-edit reply-parent oracle: exact URL or `none`. */
  expectedParentUrl?: string | "none";
  /** Stable author-profile oracle for read-before/edit/read-after binding. */
  expectedAuthorProfileUrl?: string;
  videoWidth?: number;
  videoHeight?: number;
  videoDuration?: number;
  /** YouTube-specific: metadata-only title update via videos.update. */
  title?: string;
  /** YouTube-specific: requested visibility update via videos.update(part=status). */
  privacyStatus?: "private" | "unlisted" | "public";
  profile: string;
}

export interface LoginOptions {
  profile: string;
  headed: true;
}

/**
 * R13: delete a post or comment with a mandatory read-before-delete oracle.
 * `expectedContent` is REQUIRED — the adapter must read the rendered target,
 * confirm it contains this content, and only then delete. A mismatch fails
 * closed (throws) with no DOM mutation.
 */
export interface DeleteInput {
  targetUrl: string;
  kind: "post" | "comment";
  expectedContent: string;
  profile: string;
}

export interface Adapter {
  readonly platform: Platform;
  login(options: LoginOptions): Promise<void>;
  publish(input: PublishInput): Promise<PublishResult>;
  comment(input: CommentInput): Promise<CommentResult>;
  edit(input: EditInput): Promise<EditResult>;
  delete(input: DeleteInput): Promise<DeleteResult>;
  verify(postUrl: string): Promise<VerifyResult>;
}

export abstract class BaseAdapter implements Adapter {
  abstract readonly platform: Platform;

  abstract login(options: LoginOptions): Promise<void>;
  abstract publish(input: PublishInput): Promise<PublishResult>;
  abstract comment(input: CommentInput): Promise<CommentResult>;
  abstract edit(input: EditInput): Promise<EditResult>;
  abstract delete(input: DeleteInput): Promise<DeleteResult>;

  async verify(postUrl: string): Promise<VerifyResult> {
    const response = await fetch(postUrl, { method: "HEAD", redirect: "follow" });
    return {
      ok: response.ok,
      platform: this.platform,
      postUrl,
      reachable: response.ok,
      status: response.status,
    };
  }
}
