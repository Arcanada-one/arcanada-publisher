// Append-only audit log: one JSONL record per agent-callable mutation. This is
// the AAL L2 "audit-log-per-publish" control — every publish/comment/edit/delete
// that goes out through the loopback API leaves a tamper-evident, greppable trail
// under the operator's home directory.
//
// SECURITY: the writer persists ONLY the allowlisted fields below. Cookies,
// tokens, passwords, and any other key handed in is dropped — never written. The
// log is for "what was published, when, to where", not for credentials.

import { appendFile, mkdir, chmod, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Platform } from "./platform.js";

export type AuditAction = "publish" | "comment" | "edit" | "delete";

/** The fields an audit record may carry. Anything outside this set is dropped. */
export interface AuditInput {
  platform: Platform;
  account: string;
  action: AuditAction;
  /** Resolved post URL when known (publish/edit/delete-of-post). */
  postUrl?: string;
  /** Opaque correlation token an agent may pass to tie calls together. No secrets. */
  callerToken?: string;
}

export interface AuditOptions {
  /** Audit root. Defaults to ~/.arcanada-publisher/audit. Injectable for tests. */
  baseDir?: string;
  /** Timestamp source. Injectable for deterministic tests. */
  now?: Date;
}

/** auditRef shape: PUB-audit-<YYYYMMDD>-<8 hex chars>. */
export const AUDIT_REF_RE = /^PUB-audit-\d{8}-[0-9a-f]{8}$/;

function defaultBaseDir(): string {
  return join(homedir(), ".arcanada-publisher", "audit");
}

/** YYYY-MM-DD in UTC (the daily file name). */
function dayStamp(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** YYYYMMDD in UTC (the auditRef date segment). */
function refStamp(d: Date): string {
  return dayStamp(d).replace(/-/g, "");
}

/**
 * Append one JSONL audit record and return its auditRef. Fail-soft: on any
 * filesystem error this logs a warning to stderr and returns `null` so a publish
 * is never blocked solely because the audit sink is unwritable.
 */
export async function appendAudit(
  input: AuditInput,
  options: AuditOptions = {},
): Promise<string | null> {
  const now = options.now ?? new Date();
  const baseDir = options.baseDir ?? defaultBaseDir();
  const auditRef = `PUB-audit-${refStamp(now)}-${randomBytes(4).toString("hex")}`;

  // Allowlist projection — drop everything that is not an audit field.
  const record: Record<string, unknown> = {
    ts: now.toISOString(),
    platform: input.platform,
    account: input.account,
    action: input.action,
    auditRef,
  };
  if (input.postUrl !== undefined) record.postUrl = input.postUrl;
  if (input.callerToken !== undefined) record.callerToken = input.callerToken;

  const file = join(baseDir, `${dayStamp(now)}.jsonl`);
  try {
    await mkdir(baseDir, { recursive: true, mode: 0o700 });
    // mkdir's mode is masked by umask; pin it explicitly so the audit trail is
    // owner-only regardless of the operator's umask.
    if (process.platform !== "win32") await chmod(baseDir, 0o700);
    const isNewFile = await stat(file).then(
      () => false,
      () => true,
    );
    await appendFile(file, JSON.stringify(record) + "\n", { mode: 0o600 });
    if (isNewFile && process.platform !== "win32") await chmod(file, 0o600);
    return auditRef;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`audit: failed to write ${file}: ${reason}`);
    return null;
  }
}
