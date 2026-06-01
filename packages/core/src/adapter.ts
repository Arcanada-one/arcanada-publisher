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
