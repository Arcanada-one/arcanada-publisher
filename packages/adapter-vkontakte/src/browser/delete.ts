import {
  AdapterError,
  DeleteResultSchema,
  ErrorCode,
  type DeleteResult,
} from "@arcanada/publisher-core";
import { assertAuthorized, type ExpectedAccount, type SessionState } from "./session-guard.js";

const VK_HOSTS = new Set(["vk.com", "vk.ru", "m.vk.com"]);
const WALL_PATH = /^\/wall(-?\d+)_(\d+)$/;

export interface VkDeleteTarget {
  wallId: string;
  author: string;
  renderedContent: string;
  deleted: boolean;
}

export interface VkDeleteReadBack {
  wallId: string;
  deleted: boolean;
}

export interface VkBrowserDeleteInput {
  targetUrl: string;
  expectedContent: string;
  profile: string;
  expectedAccount: ExpectedAccount;
}

export interface VkDeleteSteps {
  readSession(): Promise<SessionState>;
  readTarget(): Promise<VkDeleteTarget>;
  performDelete(): Promise<void>;
  readAfter(): Promise<VkDeleteReadBack>;
}

function parseTarget(targetUrl: string): { ownerId: string; wallId: string } {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new AdapterError(ErrorCode.INVALID_ARGS, "vk delete: targetUrl is not a valid URL", {
      targetUrl,
    });
  }
  const match = parsed.pathname.match(WALL_PATH);
  if (!VK_HOSTS.has(parsed.hostname) || !match) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      "vk delete: targetUrl must be an exact VK wall permalink",
      { targetUrl },
    );
  }
  return { ownerId: match[1]!, wallId: `${match[1]}_${match[2]}` };
}

/**
 * Fail-closed browser deletion: bind the exact wall id, prove session + author
 * + rendered oracle, click once, then prove VK's soft-deleted state. VK's
 * current menu has no confirmation dialog, so any uncertain post-click outcome
 * is marked reconcileRequired and MUST NOT be retried blindly.
 */
export async function runVkDelete(
  input: VkBrowserDeleteInput,
  steps: VkDeleteSteps,
): Promise<DeleteResult> {
  const target = parseTarget(input.targetUrl);
  if (!input.expectedContent || input.expectedContent.trim() === "") {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      "vk delete: expectedContent is required (read-before-delete oracle)",
    );
  }

  const session = await steps.readSession();
  assertAuthorized(session, input.expectedAccount);

  const before = await steps.readTarget();
  if (before.wallId !== target.wallId) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "vk delete: rendered wall id does not match targetUrl — aborting without deletion",
      { expectedWallId: target.wallId, observedWallId: before.wallId },
    );
  }
  if (before.deleted) {
    throw new AdapterError(ErrorCode.VERIFY_FAILED, "vk delete: target is already deleted", {
      targetUrl: input.targetUrl,
    });
  }
  if (
    input.expectedAccount.accountName !== undefined &&
    before.author !== input.expectedAccount.accountName
  ) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "vk delete: target author does not match the expected operator account",
      { expected: input.expectedAccount.accountName, observed: before.author },
    );
  }
  if (!before.renderedContent.includes(input.expectedContent)) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "vk delete: rendered content does not match expectedContent — aborting without deletion",
      { targetUrl: input.targetUrl, vkErrorType: "verify_mismatch" },
    );
  }

  await steps.performDelete();

  let after: VkDeleteReadBack;
  try {
    after = await steps.readAfter();
  } catch (cause) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "vk delete: post-click outcome is unknown — reconcile by reading targetUrl; do not retry",
      {
        targetUrl: input.targetUrl,
        reconcileRequired: true,
        cause: cause instanceof Error ? cause.message : String(cause),
      },
    );
  }
  if (after.wallId !== target.wallId || !after.deleted) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "vk delete: post-click deletion was not proven — reconcile by reading targetUrl; do not retry",
      {
        targetUrl: input.targetUrl,
        expectedWallId: target.wallId,
        observedWallId: after.wallId,
        reconcileRequired: true,
      },
    );
  }

  return DeleteResultSchema.parse({
    ok: true,
    platform: "vkontakte",
    account: target.ownerId,
    deleted: true,
    targetUrl: input.targetUrl,
  });
}
