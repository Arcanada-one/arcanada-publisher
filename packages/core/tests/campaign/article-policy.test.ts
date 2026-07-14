import { describe, expect, it } from "vitest";
import { ErrorCode } from "../../src/errors.js";
import { validateArticleCampaign } from "../../src/campaign/article-policy.js";
import type { ArticleCampaignManifest } from "../../src/campaign/types.js";

const HASH_RU = "a".repeat(64);
const HASH_EN = "b".repeat(64);
const HASH_HERO = "c".repeat(64);
const HASH_COPY = "d".repeat(64);
const NOW = new Date("2026-07-13T20:00:00.000Z");
const FRESH = NOW.toISOString();

function manifest(): ArticleCampaignManifest {
  const copy = (path: string, locale: "ru" | "en", sha256: string) => ({
    path,
    sha256,
    locale,
    title: "Title",
    titleFirst: true,
    canonicalLinks: [`https://example.com/${locale}/article`],
    policyCheckedAt: FRESH,
  });
  return {
    schemaVersion: 1,
    campaignId: "content-0377",
    taskId: "CONTENT-0377",
    contentKind: "article",
    policy: "arcanada-blog-canonical",
    createdAt: FRESH,
    updatedAt: FRESH,
    website: {
      deploymentCommit: "e".repeat(40),
      deploymentRun: "run-1",
      ru: { url: "https://example.com/ru/article", titleSha256: HASH_RU, verifiedAt: FRESH },
      en: { url: "https://example.com/en/article", titleSha256: HASH_EN, verifiedAt: FRESH },
    },
    audio: {
      ru: {
        path: "/campaign/ru.mp3",
        url: "https://cdn.example.com/ru.mp3",
        sha256: HASH_RU,
        durationSec: 120,
        locale: "ru",
        voice: "pavel",
        engine: "openvoice-v2",
        normalization: "ru-v1",
        technicalVerifiedAt: FRESH,
        listenedAt: FRESH,
      },
      en: {
        path: "/campaign/en.mp3",
        url: "https://cdn.example.com/en.mp3",
        sha256: HASH_EN,
        durationSec: 122,
        locale: "en",
        voice: "pavel",
        engine: "f5-tts",
        normalization: "en-v1",
        technicalVerifiedAt: FRESH,
        listenedAt: FRESH,
      },
    },
    hero: {
      path: "/campaign/hero.jpg",
      sha256: HASH_HERO,
      mime: "image/jpeg",
      sizeBytes: 171_059,
      width: 1280,
      height: 640,
      role: "static-hero",
    },
    videos: {
      telegramRu: {
        path: "/campaign/tg.mp4",
        sha256: HASH_RU,
        durationSec: 121,
        locale: "ru",
        narrationAudioSha256: HASH_RU,
        preset: "cycle",
        codec: "h264+aac",
        probeVerifiedAt: FRESH,
        viewedAt: FRESH,
      },
      xLinkedinEn: {
        path: "/campaign/en.mp4",
        sha256: HASH_EN,
        durationSec: 123,
        locale: "en",
        narrationAudioSha256: HASH_EN,
        preset: "cycle",
        codec: "h264+aac",
        probeVerifiedAt: FRESH,
        viewedAt: FRESH,
      },
    },
    copy: {
      telegramBody: copy("/campaign/tg.txt", "ru", HASH_COPY),
      xBody: copy("/campaign/x.txt", "en", HASH_COPY),
      linkedinBody: copy("/campaign/li.txt", "en", HASH_COPY),
      facebookBody: copy("/campaign/fb.txt", "ru", HASH_COPY),
    },
    targets: [
      target("arcanada-telegram", "telegram", "ru", "telegramBody", HASH_RU, {
        chatId: "-1001",
      }),
      target("arcanada-x", "x", "en", "xBody", HASH_EN, {
        authorProfileUrl: "https://example.com/x",
      }),
      target("arcanada-linkedin", "linkedin", "en", "linkedinBody", HASH_EN, {
        authorProfileUrl: "https://example.com/linkedin",
      }),
      {
        ...target("arcanada-facebook", "facebook", "ru", "facebookBody", HASH_HERO, {
          authorProfileUrl: "https://example.com/facebook",
        }),
        requiredMediaRole: "static-hero",
      },
    ],
    authorization: {
      decision: "auto",
      scope: "publish_public",
      decidedAt: FRESH,
      evidenceRef: "AUTH-content-0377",
      evidence: { path: "/campaign/auth.json", sha256: HASH_COPY, verifiedAt: FRESH },
    },
  };
}

function target(
  targetId: string,
  platform: "telegram" | "x" | "linkedin" | "facebook",
  language: "ru" | "en",
  copyKey: string,
  assetSha256: string,
  destination: { chatId: string } | { authorProfileUrl: string },
) {
  return {
    targetId,
    managedTargetId: targetId,
    action: "publish" as const,
    platform,
    profile: "default",
    destination,
    language,
    requiredMediaRole: "full-narration-video" as const,
    assetSha256,
    copySha256: HASH_COPY,
    copyKey,
    idempotencyKey: `${targetId}-v1`,
    baseline: { state: "absent" as const, verifiedAt: FRESH },
  };
}

const evidence = {
  now: NOW,
  statFile: (path: string) => {
    const hashes: Record<string, string> = {
      "/campaign/ru.mp3": HASH_RU,
      "/campaign/en.mp3": HASH_EN,
      "/campaign/hero.jpg": HASH_HERO,
      "/campaign/tg.mp4": HASH_RU,
      "/campaign/en.mp4": HASH_EN,
      "/campaign/tg.txt": HASH_COPY,
      "/campaign/x.txt": HASH_COPY,
      "/campaign/li.txt": HASH_COPY,
      "/campaign/fb.txt": HASH_COPY,
      "/campaign/auth.json": HASH_COPY,
    };
    const texts: Record<string, string> = {
      "/campaign/tg.txt": "Title\nhttps://example.com/ru/article",
      "/campaign/x.txt": "Title\nhttps://example.com/en/article",
      "/campaign/li.txt": "Title\nhttps://example.com/en/article",
      "/campaign/fb.txt": "Title\nhttps://example.com/ru/article",
    };
    return hashes[path]
      ? {
          sha256: hashes[path],
          ...(path === "/campaign/hero.jpg" ? { size: 171_059 } : {}),
          ...(texts[path] ? { text: texts[path] } : {}),
        }
      : undefined;
  },
  probeUrl: (url: string) => ({
    status: 200,
    ...(url.endsWith("ru.mp3") ? { sha256: HASH_RU } : {}),
    ...(url.endsWith("en.mp3") ? { sha256: HASH_EN } : {}),
  }),
};

describe("validateArticleCampaign", () => {
  it("accepts the complete canonical media matrix", () => {
    expect(validateArticleCampaign(manifest(), evidence)).toEqual([]);
  });

  it.each([
    [
      "stale site",
      (m: ArticleCampaignManifest) => (m.website.ru.verifiedAt = "2026-07-13T19:29:59.000Z"),
      ErrorCode.CAMPAIGN_EVIDENCE_STALE,
    ],
    [
      "stale audio",
      (m: ArticleCampaignManifest) => (m.audio.en.listenedAt = "2026-07-12T19:59:59.000Z"),
      ErrorCode.CAMPAIGN_EVIDENCE_STALE,
    ],
    [
      "stale video",
      (m: ArticleCampaignManifest) => (m.videos.telegramRu.viewedAt = "2026-07-12T19:59:59.000Z"),
      ErrorCode.CAMPAIGN_EVIDENCE_STALE,
    ],
    [
      "stale authorization",
      (m: ArticleCampaignManifest) => (m.authorization.decidedAt = "2026-07-13T19:29:59.000Z"),
      ErrorCode.CAMPAIGN_EVIDENCE_STALE,
    ],
    [
      "image-only Telegram",
      (m: ArticleCampaignManifest) => (m.targets[0]!.requiredMediaRole = "static-hero"),
      ErrorCode.CAMPAIGN_MEDIA_POLICY,
    ],
    [
      "wrong Telegram locale",
      (m: ArticleCampaignManifest) => (m.targets[0]!.language = "en"),
      ErrorCode.CAMPAIGN_MEDIA_POLICY,
    ],
    [
      "wrong audio hash",
      (m: ArticleCampaignManifest) => (m.videos.xLinkedinEn.narrationAudioSha256 = HASH_RU),
      ErrorCode.CAMPAIGN_ASSET_MISMATCH,
    ],
    [
      "wrong duration",
      (m: ArticleCampaignManifest) => (m.videos.xLinkedinEn.durationSec = 130),
      ErrorCode.CAMPAIGN_MEDIA_POLICY,
    ],
    [
      "Facebook video",
      (m: ArticleCampaignManifest) => (m.targets[3]!.requiredMediaRole = "full-narration-video"),
      ErrorCode.CAMPAIGN_MEDIA_POLICY,
    ],
    [
      "changed copy",
      (m: ArticleCampaignManifest) => (m.targets[1]!.copySha256 = HASH_RU),
      ErrorCode.CAMPAIGN_ASSET_MISMATCH,
    ],
    [
      "unknown baseline",
      (m: ArticleCampaignManifest) => (m.targets[1]!.baseline.state = "unknown"),
      ErrorCode.CAMPAIGN_STATE_UNKNOWN,
    ],
  ])("rejects %s", (_name, mutate, expectedCode) => {
    const value = manifest();
    mutate(value);
    expect(validateArticleCampaign(value, evidence)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: expectedCode })]),
    );
  });

  it("reports every independent missing/mismatched prerequisite in one preflight", () => {
    const value = manifest();
    value.targets[0]!.requiredMediaRole = "static-hero";
    value.targets[1]!.baseline.state = "unknown";
    value.authorization.decidedAt = "2026-07-13T19:00:00.000Z";
    const findings = validateArticleCampaign(value, evidence);
    expect(new Set(findings.map((finding) => finding.code))).toEqual(
      expect.objectContaining(
        new Set([
          ErrorCode.CAMPAIGN_MEDIA_POLICY,
          ErrorCode.CAMPAIGN_STATE_UNKNOWN,
          ErrorCode.CAMPAIGN_EVIDENCE_STALE,
        ]),
      ),
    );
    expect(findings.length).toBeGreaterThanOrEqual(3);
  });

  it("requires current existing-state readback for a known live post", () => {
    const value = manifest();
    value.targets[1]!.baseline.state = "existing";
    expect(validateArticleCampaign(value, evidence)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: ErrorCode.CAMPAIGN_EVIDENCE_MISSING }),
      ]),
    );
  });

  it("rejects an over-limit target copy before adapter access", () => {
    const value = manifest();
    const overLimitEvidence = {
      ...evidence,
      statFile: (path: string) => {
        const found = evidence.statFile(path);
        return path === "/campaign/x.txt"
          ? { sha256: HASH_COPY, text: `Title\n${"x".repeat(281)}` }
          : found;
      },
    };
    expect(validateArticleCampaign(value, overLimitEvidence)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: ErrorCode.CAMPAIGN_MEDIA_POLICY })]),
    );
  });

  it("requires a current verified parent result for a staged comment target", () => {
    const value = manifest();
    value.targets[1] = {
      ...value.targets[1]!,
      action: "comment",
      requiredMediaRole: "none",
      assetSha256: undefined,
      parentTargetId: value.targets[0]!.targetId,
    };
    expect(validateArticleCampaign(value, evidence)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: ErrorCode.CAMPAIGN_BACKLINKS_NOT_READY }),
      ]),
    );
  });

  it("requires content-addressed authorization evidence", () => {
    const value = manifest();
    const withoutAuthorizationEvidence = {
      ...evidence,
      statFile: (path: string) =>
        path === value.authorization.evidence.path ? undefined : evidence.statFile(path),
    };
    expect(validateArticleCampaign(value, withoutAuthorizationEvidence)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: ErrorCode.CAMPAIGN_EVIDENCE_MISSING }),
      ]),
    );
  });

  it("rejects an oversized hero even when its hash is correct", () => {
    const value = manifest();
    value.hero.sizeBytes = 500_001;
    expect(validateArticleCampaign(value, evidence)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: ErrorCode.CAMPAIGN_MEDIA_POLICY })]),
    );
  });
});
