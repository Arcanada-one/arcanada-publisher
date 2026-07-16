// PUB-0035 upload ledger: sha256-keyed duplicate gate with fail-closed
// corruption handling (plan Phase 3.3, V-AC-1/V-AC-3 fixtures).

import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
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
    await journal.markApplied(intent.operationId, { playlistItemId: "pli1" });
    expect(await journal.find("playlist-insert", "PLru:vid1")).toMatchObject({
      state: "applied",
      result: { playlistItemId: "pli1" },
    });
    await journal.resolve(intent.operationId);
    expect(await journal.find("playlist-insert", "PLru:vid1")).toBeUndefined();
    expect(await readFile(path, "utf8")).not.toContain("pli1");
  });

  it("rejects valid JSON with malformed entry fields", async () => {
    const path = await tmpLedgerPath();
    await writeFile(path, "[{}]\n", "utf8");
    await expect(new RecoveryJournal(path).load()).rejects.toThrow(/journal corrupt/i);
  });

  it("reuses the unresolved operation id for an idempotent retry", async () => {
    const journal = new RecoveryJournal(await tmpLedgerPath());
    const first = await journal.begin("edit", "vid1:content-hash", { videoId: "vid1" });
    const retry = await journal.begin("edit", "vid1:content-hash", { videoId: "vid1" });
    expect(retry.operationId).toBe(first.operationId);
    expect(await journal.load()).toHaveLength(1);
  });
});
