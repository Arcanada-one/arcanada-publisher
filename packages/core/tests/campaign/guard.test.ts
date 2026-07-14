import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorCode } from "../../src/errors.js";
import { CampaignGuard } from "../../src/campaign/guard.js";
import {
  sha256,
  type ArticleCampaignManifest,
  type LoadedCampaignManifest,
} from "../../src/campaign/types.js";

const roots: string[] = [];
const HASH = "a".repeat(64);
const NOW = new Date("2026-07-13T20:00:00.000Z");

function secureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "publisher-guard-"));
  chmodSync(dir, 0o700);
  roots.push(dir);
  return dir;
}

function registry(dir: string): void {
  writeFileSync(join(dir, "managed-mode"), "enabled\n", { mode: 0o600 });
  writeFileSync(
    join(dir, "managed-targets.json"),
    JSON.stringify({
      schemaVersion: 1,
      targets: [
        {
          targetId: "arcanada-x",
          platform: "x",
          profile: "default",
          destination: { authorProfileUrl: "https://example.com/acme" },
          allowedPolicies: [{ contentKind: "article", policy: "arcanada-blog-canonical" }],
          enforced: true,
        },
      ],
    }),
    { mode: 0o600 },
  );
  writeFileSync(join(dir, "receipt.key"), Buffer.alloc(32, 4), { mode: 0o600 });
}

function loadedManifest() {
  const target = {
    targetId: "content-0377-x-main",
    managedTargetId: "arcanada-x",
    action: "publish" as const,
    platform: "x" as const,
    profile: "default",
    destination: { authorProfileUrl: "https://example.com/acme" },
    language: "en" as const,
    requiredMediaRole: "full-narration-video" as const,
    assetSha256: HASH,
    copySha256: sha256("managed"),
    copyKey: "xBody",
    idempotencyKey: "content-0377-x",
    baseline: { state: "absent" as const, verifiedAt: NOW.toISOString() },
  };
  const manifest = {
    campaignId: "content-0377",
    contentKind: "article",
    policy: "arcanada-blog-canonical",
    targets: [target],
  } as unknown as ArticleCampaignManifest;
  return { manifest, sha256: HASH, path: "/secure/campaign.json" };
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("CampaignGuard", () => {
  it("preserves generic OSS publishing when no installation is enrolled", async () => {
    const guard = new CampaignGuard({ policyDir: secureDir(), campaignRoots: [] });
    await expect(
      guard.authorize({
        platform: "x",
        profile: "default",
        action: "publish",
        text: "generic",
        mediaPaths: [],
        dryRun: false,
      }),
    ).resolves.toEqual({ managed: false });
  });

  it("fails a managed mutation before any receipt or adapter-side work", async () => {
    const dir = secureDir();
    registry(dir);
    const guard = new CampaignGuard({ policyDir: dir, campaignRoots: [dir] });
    await expect(
      guard.authorize({
        platform: "x",
        profile: "default",
        destination: { authorProfileUrl: "https://example.com/acme" },
        action: "publish",
        text: "managed",
        mediaPaths: [],
        dryRun: false,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.CAMPAIGN_MANIFEST_REQUIRED });
  });

  it("issues and consumes one target/action receipt, then rejects cross-surface replay", async () => {
    const dir = secureDir();
    registry(dir);
    const loadManifest = vi.fn(() => loadedManifest());
    const validate = vi.fn(() => []);
    const artifactSha256 = vi.fn(() => HASH);
    const guard = new CampaignGuard({
      policyDir: dir,
      campaignRoots: [dir],
      now: () => NOW,
      loadManifest,
      validate,
      artifactSha256,
      ledgerPath: join(dir, "audit", "receipts.jsonl"),
    });
    const common = {
      platform: "x" as const,
      profile: "default",
      destination: { authorProfileUrl: "https://example.com/acme" },
      action: "publish" as const,
      campaignTargetId: "content-0377-x-main",
      manifestPath: join(dir, "campaign.json"),
      text: "managed",
      mediaPaths: [join(dir, "video.mp4")],
    };
    const receipt = await guard.preflight(common);
    expect(
      JSON.parse(readFileSync(join(dir, "audit", "receipts.jsonl"), "utf8").trim()).event,
    ).toBe("issued");
    const authorization = await guard.authorize({ ...common, receipt, dryRun: false });
    expect(authorization).toMatchObject({
      managed: true,
      targetId: "content-0377-x-main",
    });
    guard.recordResult(authorization, "https://example.com/post/1", {
      ok: true,
      platform: "x",
      postUrl: "https://example.com/post/1",
      reachable: true,
      status: 200,
    });
    await expect(guard.authorize({ ...common, receipt, dryRun: false })).rejects.toMatchObject({
      code: ErrorCode.CAMPAIGN_RECEIPT_REPLAY,
    });
    expect(
      readFileSync(join(dir, "audit", "receipts.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).event),
    ).toEqual(["issued", "consumed", "verified-result", "rejected"]);
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it("fails reconciliation closed when a managed result lacks verified read-back", () => {
    const guard = new CampaignGuard();
    expect(() =>
      guard.recordResult(
        {
          managed: true,
          targetId: "x-main",
          manifestSha256: HASH,
          campaignId: "content-0377",
          platform: "x",
          action: "publish",
          receiptSha256: HASH,
        },
        "https://example.com/post/1",
      ),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.CAMPAIGN_STATE_UNKNOWN }));
  });

  it("rejects unknown policy pairs for managed targets", async () => {
    const dir = secureDir();
    registry(dir);
    const loaded = loadedManifest();
    loaded.manifest.policy = "downgrade" as "arcanada-blog-canonical";
    const guard = new CampaignGuard({
      policyDir: dir,
      campaignRoots: [dir],
      loadManifest: () => loaded,
    });
    await expect(
      guard.preflight({
        platform: "x",
        profile: "default",
        destination: { authorProfileUrl: "https://example.com/acme" },
        action: "publish",
        campaignTargetId: "content-0377-x-main",
        manifestPath: join(dir, "campaign.json"),
        text: "managed",
        mediaPaths: [],
      }),
    ).rejects.toMatchObject({ code: ErrorCode.CAMPAIGN_POLICY_UNKNOWN });
  });

  it("audits a policy denial without storing mutation text", async () => {
    const dir = secureDir();
    registry(dir);
    const guard = new CampaignGuard({
      policyDir: dir,
      campaignRoots: [dir],
      now: () => NOW,
      loadManifest: () => loadedManifest(),
      validate: () => [
        {
          code: ErrorCode.CAMPAIGN_EVIDENCE_STALE,
          pointer: "/website/en/verifiedAt",
          message: "stale",
        },
      ],
      ledgerPath: join(dir, "audit", "receipts.jsonl"),
    });
    await expect(
      guard.preflight({
        platform: "x",
        profile: "default",
        destination: { authorProfileUrl: "https://example.com/acme" },
        action: "publish",
        campaignTargetId: "content-0377-x-main",
        manifestPath: join(dir, "campaign.json"),
        text: "managed secret body",
        mediaPaths: [],
      }),
    ).rejects.toMatchObject({ code: ErrorCode.CAMPAIGN_EVIDENCE_STALE });
    const audit = readFileSync(join(dir, "audit", "receipts.jsonl"), "utf8");
    expect(audit).toContain('"event":"preflight-denied"');
    expect(audit).not.toContain("managed secret body");
  });

  it("fails closed when live evidence exceeds the configured response limit", async () => {
    const url = "https://example.com/article";
    const loaded = {
      manifest: {
        website: {
          ru: { url, titleSha256: sha256("title") },
          en: { url: `${url}/en`, titleSha256: sha256("title") },
        },
        audio: {
          ru: { url: `${url}/ru.mp3` },
          en: { url: `${url}/en.mp3` },
        },
      },
      path: "/secure/campaign.json",
      sha256: HASH,
    } as unknown as LoadedCampaignManifest;
    const guard = new CampaignGuard({
      fetch: vi.fn(async () => new Response("oversized")),
      maxEvidenceBytes: 4,
    });

    const evidence = await (
      guard as unknown as {
        buildEvidence(manifest: LoadedCampaignManifest): Promise<{
          probeUrl(url: string): { status: number } | undefined;
        }>;
      }
    ).buildEvidence(loaded);

    expect(evidence.probeUrl(url)).toEqual({ status: 0 });
  });

  it("derives MP3 codec, duration, and narration fingerprint from actual bytes", async () => {
    const dir = secureDir();
    copyFileSync(
      resolve(import.meta.dirname, "../../../video-generator/tests/fixtures/audio.mp3"),
      join(dir, "audio.mp3"),
    );
    const loaded = {
      manifest: {
        website: {
          ru: { url: "https://example.com/ru", titleSha256: HASH },
          en: { url: "https://example.com/en", titleSha256: HASH },
        },
        audio: {
          ru: { path: "audio.mp3", url: "https://example.com/ru.mp3" },
          en: { path: "audio.mp3", url: "https://example.com/en.mp3" },
        },
      },
      path: join(dir, "campaign.json"),
      sha256: HASH,
    } as unknown as LoadedCampaignManifest;
    const guard = new CampaignGuard({
      campaignRoots: [dir],
      fetch: vi.fn(async () => new Response("ok", { status: 200 })),
    });
    const built = await (
      guard as unknown as {
        buildEvidence(manifest: LoadedCampaignManifest): Promise<{
          statFile(path: string):
            | {
                media?: {
                  container: string;
                  audioCodec: string;
                  durationSec: number;
                  audioFingerprint: readonly number[];
                };
              }
            | undefined;
        }>;
      }
    ).buildEvidence(loaded);

    expect(built.statFile("audio.mp3")?.media).toMatchObject({
      container: "mp3",
      audioCodec: "mp3",
      durationSec: expect.any(Number),
      audioFingerprint: expect.arrayContaining([expect.any(Number)]),
    });
  });

  it("blocks backlink deployment until every target has a verified canonical permalink", async () => {
    const dir = secureDir();
    registry(dir);
    const guard = new CampaignGuard({
      policyDir: dir,
      campaignRoots: [dir],
      now: () => NOW,
      loadManifest: () => loadedManifest(),
      validate: () => [],
      ledgerPath: join(dir, "audit", "receipts.jsonl"),
    });

    await expect(
      guard.preflight({
        platform: "x",
        profile: "default",
        destination: { authorProfileUrl: "https://example.com/acme" },
        action: "backlink-deploy",
        campaignTargetId: "content-0377-x-main",
        manifestPath: join(dir, "campaign.json"),
        mediaPaths: [],
      }),
    ).rejects.toMatchObject({ code: ErrorCode.CAMPAIGN_BACKLINKS_NOT_READY });
  });

  it("issues a content-bound backlink receipt without mutation text or media", async () => {
    const dir = secureDir();
    registry(dir);
    const loaded = loadedManifest();
    loaded.manifest.backlinks = [
      {
        targetId: "content-0377-x-main",
        canonicalUrl: "https://example.com/post/1",
        verifiedAt: NOW.toISOString(),
        readBackSha256: sha256("managed"),
        duplicateState: "resolved",
        evidence: { path: "x-main.json", sha256: HASH, verifiedAt: NOW.toISOString() },
      },
    ];
    const guard = new CampaignGuard({
      policyDir: dir,
      campaignRoots: [dir],
      now: () => NOW,
      loadManifest: () => loaded,
      validate: () => [],
      ledgerPath: join(dir, "audit", "receipts.jsonl"),
    });

    await expect(
      guard.preflight({
        platform: "x",
        profile: "default",
        destination: { authorProfileUrl: "https://example.com/acme" },
        action: "backlink-deploy",
        campaignTargetId: "content-0377-x-main",
        manifestPath: join(dir, "campaign.json"),
        mediaPaths: [],
      }),
    ).resolves.toEqual(expect.any(String));
  });

  it("requires an explicit campaign target for every managed mutation", async () => {
    const dir = secureDir();
    registry(dir);
    const guard = new CampaignGuard({
      policyDir: dir,
      campaignRoots: [dir],
      loadManifest: () => loadedManifest(),
    });

    await expect(
      guard.authorize({
        platform: "x",
        profile: "default",
        destination: { authorProfileUrl: "https://example.com/acme" },
        action: "publish",
        manifestPath: join(dir, "campaign.json"),
        text: "managed",
        mediaPaths: [],
      }),
    ).rejects.toMatchObject({ code: ErrorCode.CAMPAIGN_TARGET_MISMATCH });
  });

  it("binds a comment target to its managed destination and verified parent result", async () => {
    const dir = secureDir();
    registry(dir);
    const loaded = loadedManifest();
    loaded.manifest.targets.push({
      ...loaded.manifest.targets[0]!,
      targetId: "content-0377-x-comment",
      action: "comment",
      requiredMediaRole: "none",
      assetSha256: undefined,
      copyKey: "xComment",
      copySha256: sha256("comment"),
      parentTargetId: "content-0377-x-main",
      idempotencyKey: "content-0377-x-comment",
    } as unknown as ArticleCampaignManifest["targets"][number]);
    loaded.manifest.backlinks = [
      {
        targetId: "content-0377-x-main",
        canonicalUrl: "https://example.com/post/1",
        verifiedAt: NOW.toISOString(),
        readBackSha256: sha256("managed"),
        duplicateState: "resolved",
        evidence: { path: "x-main.json", sha256: HASH, verifiedAt: NOW.toISOString() },
      },
    ];
    const guard = new CampaignGuard({
      policyDir: dir,
      campaignRoots: [dir],
      now: () => NOW,
      loadManifest: () => loaded,
      validate: () => [],
      ledgerPath: join(dir, "audit", "receipts.jsonl"),
    });

    const input = {
      platform: "x" as const,
      profile: "default",
      destination: { authorProfileUrl: "https://example.com/acme" },
      action: "comment" as const,
      campaignTargetId: "content-0377-x-comment",
      subjectUrl: "https://example.com/post/1",
      manifestPath: join(dir, "campaign.json"),
      text: "comment",
      mediaPaths: [],
    };
    await expect(guard.preflight(input)).resolves.toEqual(expect.any(String));
    await expect(
      guard.preflight({ ...input, subjectUrl: "https://example.com/post/wrong" }),
    ).rejects.toMatchObject({ code: ErrorCode.CAMPAIGN_TARGET_MISMATCH });
  });

  it("binds comment replacement to the verified parent and exact existing-content oracle", async () => {
    const dir = secureDir();
    registry(dir);
    const loaded = loadedManifest();
    loaded.manifest.targets.push({
      ...loaded.manifest.targets[0]!,
      targetId: "content-0377-x-comment-edit",
      action: "edit",
      requiredMediaRole: "none",
      assetSha256: undefined,
      copySha256: sha256("replacement"),
      parentTargetId: "content-0377-x-main",
      idempotencyKey: "content-0377-x-comment-edit",
      baseline: { state: "existing", verifiedAt: NOW.toISOString() },
      existingState: {
        canonicalUrl: "https://example.com/post/1#comment-1",
        expectedContentSha256: sha256("old comment"),
        mediaType: "none",
        identity: "comment-1",
        readBackAt: NOW.toISOString(),
        evidence: {
          path: "comment-readback.json",
          sha256: HASH,
          verifiedAt: NOW.toISOString(),
        },
      },
    } as unknown as ArticleCampaignManifest["targets"][number]);
    loaded.manifest.backlinks = [
      {
        targetId: "content-0377-x-main",
        canonicalUrl: "https://example.com/post/1",
        verifiedAt: NOW.toISOString(),
        readBackSha256: sha256("managed"),
        duplicateState: "resolved",
        evidence: { path: "x-main.json", sha256: HASH, verifiedAt: NOW.toISOString() },
      },
    ];
    const guard = new CampaignGuard({
      policyDir: dir,
      campaignRoots: [dir],
      now: () => NOW,
      loadManifest: () => loaded,
      validate: () => [],
      ledgerPath: join(dir, "audit", "receipts.jsonl"),
    });
    const input = {
      platform: "x" as const,
      profile: "default",
      destination: { authorProfileUrl: "https://example.com/acme" },
      action: "edit" as const,
      campaignTargetId: "content-0377-x-comment-edit",
      subjectUrl: "https://example.com/post/1",
      subjectIdentity: "comment-1",
      existingText: "old comment",
      manifestPath: join(dir, "campaign.json"),
      text: "replacement",
      mediaPaths: [],
    };

    await expect(guard.preflight(input)).resolves.toEqual(expect.any(String));
    await expect(guard.preflight({ ...input, existingText: "wrong" })).rejects.toMatchObject({
      code: ErrorCode.CAMPAIGN_ASSET_MISMATCH,
    });
  });
});
