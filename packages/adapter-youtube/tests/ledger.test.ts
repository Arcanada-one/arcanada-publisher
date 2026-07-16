// PUB-0035 upload ledger: sha256-keyed duplicate gate with fail-closed
// corruption handling (plan Phase 3.3, V-AC-1/V-AC-3 fixtures).

import { chmod, mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { AdapterError } from "@arcanada/publisher-core";
import { describe, expect, it } from "vitest";
import { UploadLedger, sha256Bytes } from "../src/ledger.js";
import { RecoveryJournal } from "../src/recovery-journal.js";

async function tmpLedgerPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pub0035-ledger-"));
  return join(dir, "ledger.jsonl");
}

const ENTRY = {
  sha256: "a".repeat(64),
  title: "Заголовок",
  totalBytes: 1024,
  startedAt: "2026-07-16T15:00:00Z",
  sessionUri: "https://upload.example/session/SECRET-CAPABILITY",
};

describe("UploadLedger", () => {
  it("first run: absent file loads as empty, gate passes", async () => {
    const ledger = new UploadLedger(await tmpLedgerPath());
    expect(await ledger.load()).toEqual([]);
    await expect(ledger.gate(ENTRY.sha256)).resolves.toBeUndefined();
  });

  it("completed entry makes the gate throw duplicate BEFORE any upload", async () => {
    const ledger = new UploadLedger(await tmpLedgerPath());
    await ledger.append(ENTRY);
    await ledger.complete(ENTRY.sha256, "vid123");
    await expect(ledger.gate(ENTRY.sha256)).rejects.toThrow(/duplicate/i);
  });

  it("pending entry (crash mid-upload) is returned for resume", async () => {
    const ledger = new UploadLedger(await tmpLedgerPath());
    await ledger.append(ENTRY);
    const pending = await ledger.gate(ENTRY.sha256);
    expect(pending?.sessionUri).toContain("SECRET-CAPABILITY");
  });

  it("corrupt line fails CLOSED with an explicit error", async () => {
    const path = await tmpLedgerPath();
    await writeFile(path, '{"sha256":"x"\n', "utf8"); // truncated JSON — crashed writer
    const ledger = new UploadLedger(path);
    await expect(ledger.load()).rejects.toThrow(AdapterError);
    await expect(ledger.load()).rejects.toThrow(/ledger/i);
  });

  it("complete() scrubs the sessionUri bearer capability", async () => {
    const path = await tmpLedgerPath();
    const ledger = new UploadLedger(path);
    await ledger.append(ENTRY);
    await ledger.complete(ENTRY.sha256, "vid123");
    const body = await readFile(path, "utf8");
    expect(body).not.toContain("SECRET-CAPABILITY");
    expect(body).toContain('"videoId":"vid123"');
  });

  it("preserves the old ledger when an atomic rewrite cannot create its temp file", async () => {
    const path = await tmpLedgerPath();
    const ledger = new UploadLedger(path);
    await ledger.append(ENTRY);
    const before = await readFile(path, "utf8");
    await chmod(dirname(path), 0o500);
    try {
      await expect(ledger.markTransferStarted(ENTRY.sha256)).rejects.toThrow();
    } finally {
      await chmod(dirname(path), 0o700);
    }
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("ledger file is written 0600", async () => {
    const path = await tmpLedgerPath();
    const ledger = new UploadLedger(path);
    await ledger.append(ENTRY);
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

it("keeps an uploaded video resumable until finalize compacts the session URI", async () => {
  const path = await tmpLedgerPath();
  const ledger = new UploadLedger(path);
  await ledger.append({ ...ENTRY, state: "uploading", transferStarted: true });
  await ledger.markUploaded(ENTRY.sha256, "vid-uploaded");
  expect(await ledger.gate(ENTRY.sha256)).toMatchObject({
    state: "uploaded",
    videoId: "vid-uploaded",
    sessionUri: ENTRY.sessionUri,
  });
  expect(await readFile(path, "utf8")).toContain("SECRET-CAPABILITY");
  await ledger.finalize(ENTRY.sha256, "vid-uploaded");
  expect(await readFile(path, "utf8")).not.toContain("SECRET-CAPABILITY");
  await expect(ledger.gate(ENTRY.sha256)).rejects.toThrow(/duplicate/i);
});

it("persists transferStarted before a data PUT can make expiry ambiguous", async () => {
  const ledger = new UploadLedger(await tmpLedgerPath());
  await ledger.append({ ...ENTRY, state: "uploading", transferStarted: false });
  await ledger.markTransferStarted(ENTRY.sha256);
  expect(await ledger.gate(ENTRY.sha256)).toMatchObject({
    state: "uploading",
    transferStarted: true,
  });
});

it("directory-fsyncs transferStarted, uploaded, and finalized ledger rewrites", async () => {
  const path = await tmpLedgerPath();
  const synced: string[] = [];
  const openDirectory = async (directoryPath: string) => ({
    sync: async () => {
      synced.push(directoryPath);
    },
    close: () => Promise.resolve(),
  });
  const ledger = new UploadLedger(path, undefined, openDirectory);
  await ledger.append({ ...ENTRY, state: "uploading", transferStarted: false });
  await ledger.markTransferStarted(ENTRY.sha256);
  await ledger.markUploaded(ENTRY.sha256, "vid-durable");
  await ledger.finalize(ENTRY.sha256, "vid-durable");
  expect(synced).toEqual([dirname(path), dirname(path), dirname(path)]);
});

it.each([
  {
    state: "transferStarted",
    failAtSync: 1,
    mutate: async (ledger: UploadLedger) => ledger.markTransferStarted(ENTRY.sha256),
  },
  {
    state: "uploaded",
    failAtSync: 2,
    mutate: async (ledger: UploadLedger) => {
      await ledger.markTransferStarted(ENTRY.sha256);
      await ledger.markUploaded(ENTRY.sha256, "vid-durable");
    },
  },
  {
    state: "finalized",
    failAtSync: 3,
    mutate: async (ledger: UploadLedger) => {
      await ledger.markTransferStarted(ENTRY.sha256);
      await ledger.markUploaded(ENTRY.sha256, "vid-durable");
      await ledger.finalize(ENTRY.sha256, "vid-durable");
    },
  },
])("fails closed when the $state parent-directory fsync fails", async ({ failAtSync, mutate }) => {
  const path = await tmpLedgerPath();
  let syncCount = 0;
  const openDirectory = async (_directoryPath: string) => ({
    sync: async () => {
      syncCount += 1;
      if (syncCount === failAtSync) {
        throw Object.assign(new Error("directory sync unavailable"), { code: "ENOTSUP" });
      }
    },
    close: () => Promise.resolve(),
  });
  const ledger = new UploadLedger(path, undefined, openDirectory);
  await ledger.append({ ...ENTRY, state: "uploading", transferStarted: false });
  await expect(mutate(ledger)).rejects.toThrow(/directory fsync failed.*refusing/i);
});

it("serializes process-like contenders so only one can claim an absent upload", async () => {
  const path = await tmpLedgerPath();
  const first = new UploadLedger(path);
  const second = new UploadLedger(path);
  const attempt = (ledger: UploadLedger): Promise<boolean> =>
    ledger.withLock(async () => {
      if (await ledger.gate(ENTRY.sha256)) return false;
      await new Promise((resolve) => setTimeout(resolve, 20));
      await ledger.append(ENTRY);
      return true;
    });
  const claims = await Promise.all([attempt(first), attempt(second)]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect(await first.load()).toHaveLength(1);
});

it("reclaims a stale cross-platform lock directory", async () => {
  const path = await tmpLedgerPath();
  await mkdir(`${path}.lock`);
  const stale = new Date(Date.now() - 30_000);
  await utimes(`${path}.lock`, stale, stale);
  const ledger = new UploadLedger(path);
  await expect(ledger.withLock(async () => "acquired")).resolves.toBe("acquired");
  await expect(stat(`${path}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
});

it("fails closed when the lock backend is unavailable", async () => {
  const path = await tmpLedgerPath();
  let mutationRan = false;
  const unavailable = async (): Promise<never> => {
    throw Object.assign(new Error("backend missing"), { code: "ENOENT" });
  };
  const ledger = new UploadLedger(path, unavailable);
  await expect(
    ledger.withLock(async () => {
      mutationRan = true;
    }),
  ).rejects.toThrow(/ownership lease unavailable/i);
  expect(mutationRan).toBe(false);
});
describe("sha256Bytes", () => {
  it("hashes deterministically", async () => {
    const h1 = sha256Bytes(new Uint8Array([1, 2, 3]));
    const h2 = sha256Bytes(new Uint8Array([1, 2, 3]));
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("RecoveryJournal", () => {
  it("durably correlates intent/applied state and compacts resolved operations", async () => {
    const path = await tmpLedgerPath();
    const journal = new RecoveryJournal(path);
    const intent = await journal.begin("playlist-insert", "PLru:vid1", {
      playlistId: "PLru",
      videoId: "vid1",
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await journal.find("playlist-insert", "PLru:vid1")).toMatchObject({
      operationId: intent.operationId,
      state: "intent",
    });
    await journal.markApplied(intent.operationId, { playlistId: "PLru", videoId: "vid1" });
    expect(await journal.find("playlist-insert", "PLru:vid1")).toMatchObject({
      state: "applied",
      result: { playlistId: "PLru", videoId: "vid1" },
    });
    await journal.resolve(intent.operationId);
    expect(await journal.find("playlist-insert", "PLru:vid1")).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe("[]\n");
  });

  it("rejects valid JSON with malformed entry fields", async () => {
    const path = await tmpLedgerPath();
    await writeFile(path, "[{}]\n", "utf8");
    await expect(new RecoveryJournal(path).load()).rejects.toThrow(/journal corrupt/i);
  });

  it("rejects disallowed outgoing recovery fields before persisting them", async () => {
    const journal = new RecoveryJournal(await tmpLedgerPath());
    await expect(
      journal.begin("playlist-insert", "PLru:vid1", {
        playlistId: "PLru",
        videoId: "vid1",
        sessionUri: "secret",
      }),
    ).rejects.toThrow(/schema/i);
    expect(await journal.load()).toEqual([]);
  });

  it("reuses the unresolved operation id for an idempotent retry", async () => {
    const journal = new RecoveryJournal(await tmpLedgerPath());
    const editIntent = { videoId: "vid1", title: "Title", description: "Description" };
    const first = await journal.begin("edit", "vid1:content-hash", editIntent);
    const retry = await journal.begin("edit", "vid1:content-hash", editIntent);
    expect(retry.operationId).toBe(first.operationId);
    expect(await journal.load()).toHaveLength(1);
  });

  it("fails closed when the same recovery key is requested with a different intent", async () => {
    const journal = new RecoveryJournal(await tmpLedgerPath());
    const first = { videoId: "vid1", title: "A", description: "D" };
    await journal.begin("edit", "vid1:content-hash", first);
    await expect(
      journal.begin("edit", "vid1:content-hash", { ...first, title: "B" }),
    ).rejects.toThrow(/intent does not match/i);
    expect(await journal.load()).toHaveLength(1);
  });

  it("serializes the same mutation key across independent journal instances", async () => {
    const path = await tmpLedgerPath();
    const first = new RecoveryJournal(path);
    const second = new RecoveryJournal(path);
    let active = 0;
    let maxActive = 0;
    const contender = (journal: RecoveryJournal): Promise<void> =>
      journal.withMutationLease("edit", "same-key", async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
      });
    await Promise.all([contender(first), contender(second)]);
    expect(maxActive).toBe(1);
  });

  it("fails closed when recovery-journal directory fsync fails", async () => {
    const path = await tmpLedgerPath();
    const openDirectory = async (_directoryPath: string) => ({
      sync: () =>
        Promise.reject(Object.assign(new Error("directory sync unavailable"), { code: "ENOTSUP" })),
      close: () => Promise.resolve(),
    });
    const journal = new RecoveryJournal(path, openDirectory);
    await expect(
      journal.begin("playlist-insert", "PLru:vid1", {
        playlistId: "PLru",
        videoId: "vid1",
      }),
    ).rejects.toThrow(/directory fsync failed.*refusing/i);
  });

  it("preserves the old journal when an atomic rewrite cannot create its temp file", async () => {
    const path = await tmpLedgerPath();
    const journal = new RecoveryJournal(path);
    const entry = await journal.begin("playlist-insert", "PLru:vid1", {
      playlistId: "PLru",
      videoId: "vid1",
    });
    const before = await readFile(path, "utf8");
    await chmod(dirname(path), 0o500);
    try {
      await expect(
        journal.markApplied(entry.operationId, { playlistId: "PLru", videoId: "vid1" }),
      ).rejects.toThrow();
    } finally {
      await chmod(dirname(path), 0o700);
    }
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await journal.find("playlist-insert", "PLru:vid1")).toMatchObject({ state: "intent" });
  });
});
