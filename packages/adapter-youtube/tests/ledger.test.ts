// PUB-0035 upload ledger: sha256-keyed duplicate gate with fail-closed
// corruption handling (plan Phase 3.3, V-AC-1/V-AC-3 fixtures).

import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterError } from "@arcanada/publisher-core";
import { describe, expect, it } from "vitest";
import { UploadLedger, sha256Bytes } from "../src/ledger.js";

async function tmpLedgerPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pub0035-ledger-"));
  return join(dir, "ledger.jsonl");
}

const ENTRY = {
  sha256: "a".repeat(64),
  title: "Заголовок",
  totalBytes: 1024,
  startedAt: "2026-07-16T15:00:00Z",
  sessionUri: "https://upload.example/session?upload_id=SECRET",
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
    expect(pending?.sessionUri).toContain("upload_id=SECRET");
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
    expect(body).not.toContain("upload_id=SECRET");
    expect(body).toContain('"videoId":"vid123"');
  });

  it("ledger file is written 0600", async () => {
    const path = await tmpLedgerPath();
    const ledger = new UploadLedger(path);
    await ledger.append(ENTRY);
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
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
