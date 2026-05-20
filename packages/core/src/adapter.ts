import type { CommentResult, EditResult, PublishResult, VerifyResult } from "./result.js";
import type { Platform } from "./platform.js";

export interface PublishInput {
  text: string;
  imagePath?: string;
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

export interface Adapter {
  readonly platform: Platform;
  login(options: LoginOptions): Promise<void>;
  publish(input: PublishInput): Promise<PublishResult>;
  comment(input: CommentInput): Promise<CommentResult>;
  edit(input: EditInput): Promise<EditResult>;
  verify(postUrl: string): Promise<VerifyResult>;
}

export abstract class BaseAdapter implements Adapter {
  abstract readonly platform: Platform;

  abstract login(options: LoginOptions): Promise<void>;
  abstract publish(input: PublishInput): Promise<PublishResult>;
  abstract comment(input: CommentInput): Promise<CommentResult>;
  abstract edit(input: EditInput): Promise<EditResult>;

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
