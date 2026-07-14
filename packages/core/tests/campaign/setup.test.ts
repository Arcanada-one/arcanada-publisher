import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorCode } from "../../src/errors.js";
import { ManagedTargetRegistry } from "../../src/campaign/registry.js";
import { deEnrollCampaignPolicy, setupCampaignPolicy } from "../../src/campaign/setup.js";

const roots: string[] = [];

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "publisher-policy-setup-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("campaign policy setup", () => {
  it("creates an owner-only enrollment without returning or auditing the key", () => {
    const base = root();
    const policyDir = join(base, "policy");
    const auditPath = join(base, "audit", "campaign-policy.jsonl");
    expect(setupCampaignPolicy({ policyDir, auditPath })).toEqual({ enrolled: true });
    expect(statSync(policyDir).mode & 0o777).toBe(0o700);
    for (const name of ["managed-mode", "managed-targets.json", "receipt.key"]) {
      expect(statSync(join(policyDir, name)).mode & 0o777).toBe(0o600);
    }
    const key = readFileSync(join(policyDir, "receipt.key"));
    expect(key).toHaveLength(32);
    expect(readFileSync(auditPath, "utf8")).not.toContain(key.toString("hex"));
  });

  it("is idempotent and never rotates an existing key", () => {
    const base = root();
    const options = {
      policyDir: join(base, "policy"),
      auditPath: join(base, "audit", "campaign-policy.jsonl"),
    };
    setupCampaignPolicy(options);
    const before = readFileSync(join(options.policyDir, "receipt.key"));
    setupCampaignPolicy(options);
    expect(readFileSync(join(options.policyDir, "receipt.key"))).toEqual(before);
  });

  it("audits first enrollment correctly when the secure policy directory already exists", () => {
    const base = root();
    const policyDir = join(base, "policy");
    const auditPath = join(base, "audit", "campaign-policy.jsonl");
    mkdirSync(policyDir, { mode: 0o700 });

    setupCampaignPolicy({ policyDir, auditPath });

    expect(JSON.parse(readFileSync(auditPath, "utf8")).event).toBe("enrolled");
  });

  it("rejects a permissive policy root", () => {
    const base = root();
    const policyDir = join(base, "policy");
    setupCampaignPolicy({ policyDir, auditPath: join(base, "audit.jsonl") });
    chmodSync(policyDir, 0o755);
    expect(() =>
      setupCampaignPolicy({ policyDir, auditPath: join(base, "audit.jsonl") }),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.CAMPAIGN_MANIFEST_INVALID }));
  });

  it("requires explicit confirmation and archives enrollment before generic mode resumes", () => {
    const base = root();
    const options = {
      policyDir: join(base, "policy"),
      auditPath: join(base, "audit", "campaign-policy.jsonl"),
    };
    setupCampaignPolicy(options);
    expect(() => deEnrollCampaignPolicy({ ...options, confirmed: false })).toThrowError(
      expect.objectContaining({ code: ErrorCode.CAMPAIGN_RECEIPT_REQUIRED }),
    );
    const result = deEnrollCampaignPolicy({ ...options, confirmed: true });
    expect(result.enrolled).toBe(false);
    expect(existsSync(result.archiveDir)).toBe(true);
    expect(ManagedTargetRegistry.load({ policyDir: options.policyDir }).enrolled).toBe(false);
  });
});
