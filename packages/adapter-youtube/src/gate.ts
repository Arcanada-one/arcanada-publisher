// Arming gate + fail-closed audit primitives, shared by publish, edit, and
// playlist bootstrap (own module so playlist-binding does not import publish).

import {
  AdapterError,
  ErrorCode,
  appendAudit,
  type AuditAction,
  type AuditOptions,
} from "@arcanada/publisher-core";

export function isArmed(env: NodeJS.ProcessEnv): boolean {
  return env["YOUTUBE_LIVE_ARMED"] === "1";
}

export function requireArmed(env: NodeJS.ProcessEnv, operation: string): void {
  if (!isArmed(env)) {
    throw new AdapterError(
      ErrorCode.NOT_ARMED,
      `${operation}: live YouTube mutations require the operator-armed state (YOUTUBE_LIVE_ARMED=1 after dry-run plan review)`,
      { operation },
    );
  }
}

/** Fail-closed audit: the stock appendAudit is fail-soft; YouTube mutations abort on a null ref. */
export async function auditOrAbort(
  input: { account: string; action: AuditAction; postUrl?: string },
  options: AuditOptions,
): Promise<string> {
  const ref = await appendAudit({ platform: "youtube", ...input }, options);
  if (ref === null) {
    throw new AdapterError(
      ErrorCode.INTERNAL_PANIC,
      "audit append failed — aborting the mutation (fail-closed AAL L2 control)",
    );
  }
  return ref;
}
