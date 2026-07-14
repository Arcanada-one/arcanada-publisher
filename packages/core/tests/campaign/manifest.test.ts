import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorCode } from "../../src/errors.js";
import { ArticleCampaignManifestSchema, loadCampaignManifest } from "../../src/campaign/types.js";

const roots: string[] = [];
const HASH = "a".repeat(64);
const NOW = "2026-07-13T20:00:00.000Z";

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "publisher-campaign-manifest-"));
  chmodSync(dir, 0o700);
  roots.push(dir);
  return dir;
}

function minimalManifest() {
  return {
    schemaVersion: 1,
    campaignId: "content-0377",
    taskId: "CONTENT-0377",
    contentKind: "article",
    policy: "arcanada-blog-canonical",
    createdAt: NOW,
    updatedAt: NOW,
    website: {
      deploymentCommit: HASH.slice(0, 40),
      deploymentRun: "run-1",
      ru: { url: "https://example.com/ru/article", titleSha256: HASH, verifiedAt: NOW },
      en: { url: "https://example.com/en/article", titleSha256: HASH, verifiedAt: NOW },
    },
    audio: {
      ru: {
        path: "ru.mp3",
        url: "https://cdn.example.com/ru.mp3",
        sha256: HASH,
        durationSec: 120,
        locale: "ru",
        voice: "pavel",
        engine: "openvoice-v2",
        normalization: "ru-v1",
        technicalVerifiedAt: NOW,
        listenedAt: NOW,
      },
      en: {
        path: "en.mp3",
        url: "https://cdn.example.com/en.mp3",
        sha256: HASH,
        durationSec: 120,
        locale: "en",
        voice: "pavel",
        engine: "f5-tts",
        normalization: "en-v1",
        technicalVerifiedAt: NOW,
        listenedAt: NOW,
      },
    },
    hero: {
      path: "hero.jpg",
      sha256: HASH,
      mime: "image/jpeg",
      width: 1280,
      height: 640,
      role: "static-hero",
    },
    videos: {
      telegramRu: {
        path: "telegram-ru.mp4",
        sha256: HASH,
        durationSec: 120,
        locale: "ru",
        narrationAudioSha256: HASH,
        preset: "cycle",
        codec: "h264+aac",
        probeVerifiedAt: NOW,
        viewedAt: NOW,
      },
      xLinkedinEn: {
        path: "x-linkedin-en.mp4",
        sha256: HASH,
        durationSec: 120,
        locale: "en",
        narrationAudioSha256: HASH,
        preset: "cycle",
        codec: "h264+aac",
        probeVerifiedAt: NOW,
        viewedAt: NOW,
      },
    },
    copy: {
      xBody: {
        path: "x.txt",
        sha256: HASH,
        locale: "en",
        title: "Title",
        titleFirst: true,
        canonicalLinks: ["https://example.com/en/article"],
        policyCheckedAt: NOW,
      },
    },
    targets: [
      {
        targetId: "content-0377-x-main",
        managedTargetId: "arcanada-x",
        action: "publish",
        platform: "x",
        profile: "default",
        destination: { authorProfileUrl: "https://example.com/acme" },
        language: "en",
        requiredMediaRole: "full-narration-video",
        assetSha256: HASH,
        copySha256: HASH,
        copyKey: "xBody",
        idempotencyKey: "content-0377-x-v1",
        baseline: { state: "absent", verifiedAt: NOW },
      },
    ],
    authorization: {
      decision: "auto",
      scope: "publish_public",
      decidedAt: NOW,
      evidenceRef: "AUTH-content-0377",
      evidence: { path: "authorization.json", sha256: HASH, verifiedAt: NOW },
    },
  };
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ArticleCampaignManifest", () => {
  it("is strict and selects only the approved article policy pair", () => {
    expect(ArticleCampaignManifestSchema.safeParse(minimalManifest()).success).toBe(true);
    expect(
      ArticleCampaignManifestSchema.safeParse({ ...minimalManifest(), extra: true }).success,
    ).toBe(false);
    expect(
      ArticleCampaignManifestSchema.safeParse({
        ...minimalManifest(),
        contentKind: "post",
      }).success,
    ).toBe(false);
  });

  it("loads an owner-only regular manifest inside an allowed root and hashes canonical bytes", () => {
    const dir = root();
    const manifestPath = join(dir, "campaign.json");
    writeFileSync(manifestPath, JSON.stringify(minimalManifest(), null, 2), { mode: 0o600 });
    const first = loadCampaignManifest(manifestPath, [dir]);
    writeFileSync(manifestPath, JSON.stringify(minimalManifest()), { mode: 0o600 });
    const second = loadCampaignManifest(manifestPath, [dir]);
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(second.sha256).toBe(first.sha256);
  });

  it("supports multiple action targets on one managed destination with explicit parent binding", () => {
    const value = minimalManifest();
    value.targets.push({
      ...value.targets[0],
      targetId: "content-0377-x-comment",
      action: "comment",
      requiredMediaRole: "none",
      assetSha256: undefined,
      copyKey: "xBody",
      parentTargetId: "content-0377-x-main",
      idempotencyKey: "content-0377-x-comment-v1",
    });
    expect(ArticleCampaignManifestSchema.safeParse(value).success).toBe(true);
    delete value.targets[1]!.parentTargetId;
    expect(ArticleCampaignManifestSchema.safeParse(value).success).toBe(false);
  });

  it("models a retained post as verified non-mutating existing state", () => {
    const value = minimalManifest();
    value.targets[0] = {
      ...value.targets[0]!,
      action: "retain",
      baseline: { state: "existing", verifiedAt: NOW },
      existingState: {
        canonicalUrl: "https://example.com/post/1",
        expectedContentSha256: HASH,
        mediaType: "image",
        mediaSha256: HASH,
        identity: "account-1",
        readBackAt: NOW,
        evidence: { path: "retained.json", sha256: HASH, verifiedAt: NOW },
      },
    };
    expect(ArticleCampaignManifestSchema.safeParse(value).success).toBe(true);
    delete value.targets[0]!.existingState;
    expect(ArticleCampaignManifestSchema.safeParse(value).success).toBe(false);
  });

  it("rejects path escapes and permissive manifest files", () => {
    const allowed = root();
    const outside = root();
    const manifestPath = join(outside, "campaign.json");
    writeFileSync(manifestPath, JSON.stringify(minimalManifest()), { mode: 0o600 });
    expect(() => loadCampaignManifest(manifestPath, [allowed])).toThrowError(
      expect.objectContaining({ code: ErrorCode.CAMPAIGN_MANIFEST_INVALID }),
    );
    chmodSync(manifestPath, 0o644);
    expect(() => loadCampaignManifest(manifestPath, [outside])).toThrowError(
      expect.objectContaining({ code: ErrorCode.CAMPAIGN_MANIFEST_INVALID }),
    );
  });

  it("rejects a campaign root accessible by another user", () => {
    const dir = root();
    const manifestPath = join(dir, "campaign.json");
    writeFileSync(manifestPath, JSON.stringify(minimalManifest()), { mode: 0o600 });
    chmodSync(dir, 0o755);
    expect(() => loadCampaignManifest(manifestPath, [dir])).toThrowError(
      expect.objectContaining({ code: ErrorCode.CAMPAIGN_MANIFEST_INVALID }),
    );
  });
});
