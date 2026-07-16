// Media-first VK wall publish orchestration (D-REQ-03/04/05).
//
// The DOM choreography lives behind a `VkPublishSteps` seam so the ordering
// invariants — identity-before-anything, video-before-text, gate-before-submit,
// read-back-after-submit — are unit-testable on a fake step recorder without a
// browser (the same pattern adapter-facebook uses via PublishStepRecorder).

import { AdapterError, ErrorCode, PublishResultSchema, type PublishResult } from "@arcanada/publisher-core";
import { assertAuthorized, type ExpectedAccount, type SessionState } from "./session-guard.js";
import { preflightPostText } from "./sanitize.js";
import { assertNotDuplicate, type WallPostSummary } from "./duplicate-guard.js";
import { assertPostReadBack } from "./readback.js";

export interface VkBrowserPublishInput {
  /** Full post body (already read from the pinned article asset). */
  text: string;
  /** Path to the native video to attach. */
  videoPath: string;
  profile: string;
  /** The operator account the profile MUST be logged in as. */
  expectedAccount: ExpectedAccount;
  /** Require the video to be attached in read-back (media-first). */
  requireVideo: boolean;
}

export interface PreSubmitSnapshot {
  hasText: boolean;
  hasVideo: boolean;
}

/** Injectable DOM steps (test seam). */
export interface VkPublishSteps {
  readSession(): Promise<SessionState>;
  readRecentPosts(): Promise<WallPostSummary[]>;
  /** Upload the video and BLOCK until it is ready (preview visible + composer publishable). */
  uploadVideoAndAwaitReady(videoPath: string): Promise<void>;
  typeText(text: string): Promise<void>;
  preSubmitSnapshot(): Promise<PreSubmitSnapshot>;
  /** Submit and return the canonical permalink from the live DOM. */
  submit(): Promise<string>;
  readBack(permalink: string): Promise<{ account: string; text: string; hasVideo: boolean }>;
}

/**
 * Run the media-first publish. Order is enforced here, not in the steps:
 * session+identity → preflight text → duplicate guard → video (await ready) →
 * text → pre-submit snapshot (both present) → submit → read-back.
 */
export async function runVkPublish(
  input: VkBrowserPublishInput,
  steps: VkPublishSteps,
): Promise<PublishResult> {
  // 1. Fail-closed identity BEFORE any mutating/upload action.
  const session = await steps.readSession();
  assertAuthorized(session, input.expectedAccount);

  // 2. Preflight the body (length + sanitize) before touching the composer.
  const body = preflightPostText(input.text);

  // 3. Read-before-post duplicate guard.
  const recent = await steps.readRecentPosts();
  assertNotDuplicate({ text: body, hasVideo: true }, recent);

  // 4. Media-first: video upload must complete BEFORE text is typed.
  await steps.uploadVideoAndAwaitReady(input.videoPath);
  await steps.typeText(body);

  // 5. Pre-submit snapshot: both text and video must be present, else ABORT.
  const snap = await steps.preSubmitSnapshot();
  if (!snap.hasText) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "vk publish: pre-submit snapshot found no text — ABORT (never submit)",
    );
  }
  if (!snap.hasVideo) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "vk publish: pre-submit snapshot found no video — ABORT (never submit)",
    );
  }

  // 6. Submit and read back. The expected author is the identity we asserted in
  // step 1 (session), NOT the value we just read back — otherwise the author
  // check would be tautological.
  const expectedAuthor = session.accountName ?? session.accountId;
  const permalink = await steps.submit();
  const rendered = await steps.readBack(permalink);
  if (expectedAuthor !== undefined) {
    assertPostReadBack(rendered, {
      account: expectedAuthor,
      text: body,
      requireVideo: input.requireVideo,
    });
  }

  return PublishResultSchema.parse({
    ok: true,
    platform: "vkontakte",
    account: rendered.account,
    postUrl: permalink,
    attachments: [{ kind: "video" as const, src: input.videoPath }],
    commentIds: [],
  });
}
