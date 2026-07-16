// Upload ledger: the local duplicate gate keyed by file sha256 ALONE (title is
// data, not key — a re-titled re-submit must still be caught before quota is
// spent). JSONL at 0600 under the profile dir. Fail-closed on corruption: a
// half-written line means a crashed prior upload — exactly when the gate
// matters most (plan C12, D-REQ-06).

import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";

export interface LedgerEntry {
  sha256: string;
  title: string;
  totalBytes: number;
  startedAt: string;
  /** Bearer capability — scrubbed by {@link UploadLedger.complete}; never logged. */
  sessionUri?: string;
  videoId?: string;
  completedAt?: string;
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class UploadLedger {
  constructor(private readonly path: string) {}

  async load(): Promise<LedgerEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return raw
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line, index) => {
        try {
          return JSON.parse(line) as LedgerEntry;
        } catch {
          throw new AdapterError(
            ErrorCode.INVALID_ARGS,
            `upload ledger corrupt at line ${index + 1} — fail closed; reconcile via the uploads playlist, then repair the ledger`,
            { line: index + 1 },
          );
        }
      });
  }

  /**
   * Duplicate gate. Completed upload for this hash → throw (duplicate, before
   * any quota spend). Pending entry → return it so the caller resumes the same
   * session instead of starting a fresh one.
   */
  async gate(sha256: string): Promise<LedgerEntry | undefined> {
    const entries = await this.load();
    const match = entries.filter((e) => e.sha256 === sha256).at(-1);
    if (match?.videoId) {
      throw new AdapterError(
        ErrorCode.INVALID_ARGS,
        `duplicate upload blocked by ledger: sha256 already published as video ${match.videoId}`,
        { sha256, videoId: match.videoId, duplicate: true },
      );
    }
    return match;
  }

  async append(entry: LedgerEntry): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    await chmod(this.path, 0o600);
  }

  /** Mark done and SCRUB the sessionUri bearer capability from disk. */
  async complete(sha256: string, videoId: string): Promise<void> {
    const entries = await this.load();
    const updated = entries.map((entry) => {
      if (entry.sha256 !== sha256) return entry;
      const { sessionUri: _scrubbed, ...rest } = entry;
      return { ...rest, videoId, completedAt: new Date().toISOString() };
    });
    const body = updated.map((entry) => JSON.stringify(entry)).join("\n");
    await writeFile(this.path, body === "" ? "" : `${body}\n`, { mode: 0o600 });
    await chmod(this.path, 0o600);
  }
}
