import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AdapterError, ErrorCode } from "../../src/errors.js";
import { ManagedTargetRegistry } from "../../src/campaign/registry.js";

const roots: string[] = [];

function policyDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "publisher-campaign-registry-"));
  chmodSync(dir, 0o700);
  roots.push(dir);
  return dir;
}

function writeRegistry(dir: string, targets: unknown[]): void {
  writeFileSync(join(dir, "managed-targets.json"), JSON.stringify({ schemaVersion: 1, targets }), {
    mode: 0o600,
  });
  writeFileSync(join(dir, "managed-mode"), "enabled\n", { mode: 0o600 });
}

const xTarget = {
  targetId: "arcanada-x",
  platform: "x",
  profile: "default",
  destination: { authorProfileUrl: "https://example.com/acme" },
  allowedPolicies: [{ contentKind: "article", policy: "arcanada-blog-canonical" }],
  enforced: true,
};

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ManagedTargetRegistry", () => {
  it("keeps a fresh OSS installation generic when marker and registry are both absent", () => {
    const registry = ManagedTargetRegistry.load({ policyDir: policyDir() });
    expect(registry.enrolled).toBe(false);
    expect(registry.match({ platform: "x", profile: "default" })).toBeUndefined();
  });

  it("fails closed when managed-mode exists but the registry is missing", () => {
    const dir = policyDir();
    writeFileSync(join(dir, "managed-mode"), "enabled\n", { mode: 0o600 });
    expect(() => ManagedTargetRegistry.load({ policyDir: dir })).toThrowError(
      expect.objectContaining({ code: ErrorCode.CAMPAIGN_MANIFEST_INVALID }),
    );
  });

  it("rejects unknown keys and duplicate match keys", () => {
    const unknownDir = policyDir();
    writeRegistry(unknownDir, [{ ...xTarget, surprise: true }]);
    expect(() => ManagedTargetRegistry.load({ policyDir: unknownDir })).toThrow(AdapterError);

    const duplicateDir = policyDir();
    writeRegistry(duplicateDir, [xTarget, { ...xTarget, targetId: "arcanada-x-two" }]);
    expect(() => ManagedTargetRegistry.load({ policyDir: duplicateDir })).toThrowError(
      expect.objectContaining({ code: ErrorCode.CAMPAIGN_MANIFEST_INVALID }),
    );
  });

  it("matches platform, profile, and the exact destination", () => {
    const dir = policyDir();
    writeRegistry(dir, [xTarget]);
    const registry = ManagedTargetRegistry.load({ policyDir: dir });
    expect(
      registry.match({
        platform: "x",
        profile: "default",
        destination: { authorProfileUrl: "https://example.com/acme" },
      })?.targetId,
    ).toBe("arcanada-x");
    expect(
      registry.match({
        platform: "x",
        profile: "default",
        destination: { authorProfileUrl: "https://example.com/other" },
      }),
    ).toBeUndefined();
  });

  it("rejects symlinks and permissions broader than 0600", () => {
    const permissiveDir = policyDir();
    writeRegistry(permissiveDir, [xTarget]);
    chmodSync(join(permissiveDir, "managed-targets.json"), 0o644);
    expect(() => ManagedTargetRegistry.load({ policyDir: permissiveDir })).toThrow(AdapterError);

    const symlinkDir = policyDir();
    const source = join(symlinkDir, "source.json");
    writeFileSync(source, JSON.stringify({ schemaVersion: 1, targets: [xTarget] }), {
      mode: 0o600,
    });
    symlinkSync(source, join(symlinkDir, "managed-targets.json"));
    writeFileSync(join(symlinkDir, "managed-mode"), "enabled\n", { mode: 0o600 });
    expect(() => ManagedTargetRegistry.load({ policyDir: symlinkDir })).toThrow(AdapterError);
  });

  it("rejects a policy root accessible by another user", () => {
    const dir = policyDir();
    writeRegistry(dir, [xTarget]);
    chmodSync(dir, 0o755);
    expect(() => ManagedTargetRegistry.load({ policyDir: dir })).toThrowError(
      expect.objectContaining({ code: ErrorCode.CAMPAIGN_MANIFEST_INVALID }),
    );
  });
});
