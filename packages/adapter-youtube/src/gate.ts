// Arming gate + fail-closed audit primitives, shared by publish, edit, and
// playlist bootstrap (own module so playlist-binding does not import publish).

import {
  AdapterError,
  ErrorCode,
  appendAudit,
  type AuditAction,
  type AuditOptions,
  type AuditInput,
} from "@arcanada/publisher-core";
import { RecoveryJournal, type MutationKind, type RecoveryEntry } from "./recovery-journal.js";

export type AuditAppend = typeof appendAudit;
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

export interface MutationControl {
  journal: RecoveryJournal;
  auditOptions: AuditOptions;
  auditAppend?: AuditAppend;
}

export interface MutationSpec {
  kind: MutationKind;
  key: string;
  account: string;
  action: AuditAction;
  postUrl?: string;
  intent: Record<string, unknown>;
}

function auditInput(
  spec: MutationSpec,
  entry: RecoveryEntry,
  phase: "intent" | "outcome",
): AuditInput {
  return {
    platform: "youtube",
    account: spec.account,
    action: spec.action,
    phase,
    operationId: entry.operationId,
    ...(spec.postUrl ? { postUrl: spec.postUrl } : {}),
  };
}

/** Persist recovery intent and its audit record before any remote mutation. */
export async function beginMutation(
  control: MutationControl,
  spec: MutationSpec,
): Promise<RecoveryEntry> {
  const { entry, created } = await control.journal.beginWithStatus(
    spec.kind,
    spec.key,
    spec.intent,
  );
  const append = control.auditAppend ?? appendAudit;
  const ref = await append(auditInput(spec, entry, "intent"), control.auditOptions);
  if (ref === null) {
    if (created) await control.journal.resolve(entry.operationId);
    throw new AdapterError(
      ErrorCode.INTERNAL_PANIC,
      "intent audit failed (audit append failed) - mutation was not attempted",
      { kind: spec.kind, operationId: entry.operationId, recoverable: false },
    );
  }
  return entry;
}

/** Persist the remote result first, then require an outcome audit before resolving. */
export async function completeMutation(
  control: MutationControl,
  spec: MutationSpec,
  entry: RecoveryEntry,
  result: Record<string, unknown>,
): Promise<string> {
  await control.journal.markApplied(entry.operationId, result);
  const append = control.auditAppend ?? appendAudit;
  const ref = await append(auditInput(spec, entry, "outcome"), control.auditOptions);
  if (ref === null) {
    throw new AdapterError(
      ErrorCode.INTERNAL_PANIC,
      `outcome audit failed - remote ${spec.kind} is recoverable via operation ${entry.operationId}`,
      { kind: spec.kind, operationId: entry.operationId, recoverable: true, ...result },
    );
  }
  try {
    await control.journal.resolve(entry.operationId);
  } catch (error) {
    throw new AdapterError(
      ErrorCode.INTERNAL_PANIC,
      `recovery journal resolution failed for operation ${entry.operationId}`,
      { kind: spec.kind, operationId: entry.operationId, recoverable: true, cause: String(error) },
    );
  }
  return ref;
}
