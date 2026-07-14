import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorCode } from "../../src/errors.js";
import {
  ReceiptLedger,
  issueReceipt,
  parseReceipt,
  verifyReceipt,
} from "../../src/campaign/receipt.js";

const roots: string[] = [];
const NOW = new Date("2026-07-13T20:00:00.000Z");
const HASH = "a".repeat(64);

function secureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "publisher-receipt-"));
  chmodSync(dir, 0o700);
  roots.push(dir);
  return dir;
}

function keyFile(dir: string): string {
  const path = join(dir, "receipt.key");
  writeFileSync(path, Buffer.alloc(32, 7), { mode: 0o600 });
  return path;
}

function input() {
  return {
    manifestSha256: HASH,
    campaignId: "content-0377",
    targetId: "arcanada-x",
    platform: "x" as const,
    profile: "default",
    destination: { authorProfileUrl: "https://example.com/acme" },
    action: "publish" as const,
    textSha256: "b".repeat(64),
    mediaSha256: "c".repeat(64),
    policy: "arcanada-blog-canonical",
    policyVersion: 1,
  };
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("campaign receipts", () => {
  it("issues a unique HMAC-SHA-256 receipt with a 15-minute expiry", () => {
    const dir = secureDir();
    const keyPath = keyFile(dir);
    const first = issueReceipt(input(), { keyPath, now: NOW });
    const second = issueReceipt(input(), { keyPath, now: NOW });
    const a = parseReceipt(first);
    const b = parseReceipt(second);
    expect(a.payload.nonce).not.toBe(b.payload.nonce);
    expect(a.payload.expiresAt).toBe("2026-07-13T20:15:00.000Z");
    expect(a.signature).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ["manifest", { manifestSha256: "f".repeat(64) }],
    ["target", { targetId: "arcanada-linkedin" }],
    ["action", { action: "delete" as const }],
    ["profile", { profile: "other" }],
    ["destination", { destination: { authorProfileUrl: "https://example.com/other" } }],
    ["text", { textSha256: "d".repeat(64) }],
    ["media", { mediaSha256: "e".repeat(64) }],
  ])("rejects %s binding drift", (_name, drift) => {
    const dir = secureDir();
    const keyPath = keyFile(dir);
    const receipt = issueReceipt(input(), { keyPath, now: NOW });
    expect(() =>
      verifyReceipt(receipt, { ...input(), ...drift }, { keyPath, now: NOW }),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.CAMPAIGN_RECEIPT_INVALID }));
  });

  it("rejects signature tampering and expiry deterministically", () => {
    const dir = secureDir();
    const keyPath = keyFile(dir);
    const receipt = issueReceipt(input(), { keyPath, now: NOW });
    const envelope = parseReceipt(receipt);
    envelope.signature = "f".repeat(64);
    const tampered = Buffer.from(JSON.stringify(envelope)).toString("base64url");
    expect(() => verifyReceipt(tampered, input(), { keyPath, now: NOW })).toThrowError(
      expect.objectContaining({ code: ErrorCode.CAMPAIGN_RECEIPT_INVALID }),
    );
    expect(() =>
      verifyReceipt(receipt, input(), {
        keyPath,
        now: new Date("2026-07-13T20:15:00.001Z"),
      }),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.CAMPAIGN_RECEIPT_EXPIRED }));
  });

  it("atomically consumes once across two ledger instances and stores no body or key", async () => {
    const dir = secureDir();
    const keyPath = keyFile(dir);
    const receipt = issueReceipt(input(), { keyPath, now: NOW });
    const payload = verifyReceipt(receipt, input(), { keyPath, now: NOW });
    const ledgerPath = join(dir, "audit", "campaign-receipts.jsonl");
    const ledgers = [new ReceiptLedger(ledgerPath), new ReceiptLedger(ledgerPath)];
    const results = await Promise.allSettled(
      ledgers.map(async (ledger) => ledger.consume(receipt, payload, NOW)),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ code: ErrorCode.CAMPAIGN_RECEIPT_REPLAY }),
    });
    const audit = readFileSync(ledgerPath, "utf8");
    expect(audit).not.toContain(readFileSync(keyPath).toString("hex"));
    expect(audit).not.toContain("post body");
    expect(audit.trim().split("\n")).toHaveLength(1);
  });

  it("rejects a permissive signing key", () => {
    const dir = secureDir();
    const keyPath = keyFile(dir);
    chmodSync(keyPath, 0o644);
    expect(() => issueReceipt(input(), { keyPath, now: NOW })).toThrowError(
      expect.objectContaining({ code: ErrorCode.CAMPAIGN_MANIFEST_INVALID }),
    );
  });
});
