// Upload ledger: the local duplicate gate keyed by file sha256 ALONE (title is
// data, not key — a re-titled re-submit must still be caught before quota is
// spent). JSONL at 0600 under the profile dir. Fail-closed on corruption: a
// half-written line means a crashed prior upload — exactly when the gate
// matters most (plan C12, D-REQ-06).

import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";
import { RecoveryJournal } from "./recovery-journal.js";
import { acquireFileLease, type LeaseBackend } from "./file-lease.js";

export interface LedgerEntry {
  state?: "uploading" | "uploaded" | "finalized";
  /** Written before the first data PUT; false is positive proof that no bytes were sent. */
  transferStarted?: boolean;
  sha256: string;
  title: string;
  totalBytes: number;
  startedAt: string;
  /** Bearer capability — scrubbed by {@link UploadLedger.complete}; never logged. */
  sessionUri?: string;
  videoId?: string;
  completedAt?: string;
}

function normalizeEntry(entry: LedgerEntry): LedgerEntry {
  if (entry.state) return entry;
  if (entry.completedAt) return { ...entry, state: "finalized" };
  if (entry.videoId) return { ...entry, state: "uploaded" };
  return { ...entry, state: "uploading", transferStarted: entry.transferStarted ?? true };
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class UploadLedger {
  constructor(
    private readonly path: string,
    private readonly leaseBackend?: LeaseBackend,
  ) {}

  recoveryJournal(): RecoveryJournal {
    return new RecoveryJournal(join(dirname(this.path), "recovery.json"));
  }

  /** Run `fn` exclusively across API/CLI processes sharing this ledger path. */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = await acquireFileLease(this.path, 5_000, this.leaseBackend);
    try {
      return await fn();
    } finally {
      await release();
    }
  }

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
          return normalizeEntry(JSON.parse(line) as LedgerEntry);
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
    if (match?.state === "finalized") {
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
    await appendFile(
      this.path,
      `${JSON.stringify({ state: "uploading", transferStarted: false, ...entry })}\n`,
      { mode: 0o600 },
    );
    await chmod(this.path, 0o600);
  }

  async markTransferStarted(sha256: string): Promise<void> {
    await this.rewriteLatest(sha256, (entry) => ({
      ...entry,
      state: "uploading",
      transferStarted: true,
    }));
  }

  async markUploaded(sha256: string, videoId: string): Promise<void> {
    await this.rewriteLatest(sha256, (entry) => ({
      ...entry,
      state: "uploaded",
      videoId,
    }));
  }

  /** Finalize and compact every historical copy of the session URI from disk. */
  async finalize(sha256: string, videoId: string): Promise<void> {
    await this.withLock(async () => {
      const entries = await this.load();
      const updated = entries.map((entry) => {
        if (entry.sha256 !== sha256) return entry;
        const { sessionUri: _scrubbed, ...rest } = entry;
        return {
          ...rest,
          state: "finalized" as const,
          videoId,
          completedAt: new Date().toISOString(),
        };
      });
      await this.writeAll(updated);
    });
  }

  /** Backward-compatible name retained for callers outside this package. */
  async complete(sha256: string, videoId: string): Promise<void> {
    await this.finalize(sha256, videoId);
  }

  private async rewriteLatest(
    sha256: string,
    transform: (entry: LedgerEntry) => LedgerEntry,
  ): Promise<void> {
    const entries = await this.load();
    let index = -1;
    for (let candidate = entries.length - 1; candidate >= 0; candidate -= 1) {
      if (entries[candidate]?.sha256 === sha256) {
        index = candidate;
        break;
      }
    }
    if (index < 0) {
      throw new AdapterError(ErrorCode.INVALID_ARGS, "upload ledger entry not found");
    }
    entries[index] = transform(entries[index] as LedgerEntry);
    await this.writeAll(entries);
  }

  private async writeAll(entries: LedgerEntry[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const body = entries.map((entry) => JSON.stringify(entry)).join("\n");
    const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    let moved = false;
    try {
      await writeFile(temp, body === "" ? "" : `${body}\n`, { mode: 0o600, flag: "wx" });
      await chmod(temp, 0o600);
      const handle = await open(temp, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, this.path);
      moved = true;
      await chmod(this.path, 0o600);
    } finally {
      if (!moved) await unlink(temp).catch(() => undefined);
    }
  }
}
