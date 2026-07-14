import { describe, expect, it } from "vitest";
import { ErrorCode } from "../../src/errors.js";
import { validateArticleCampaign } from "../../src/campaign/article-policy.js";
import { canonicalJson, sha256, type ArticleCampaignManifest } from "../../src/campaign/types.js";

const HASH_RU = "a".repeat(64);
const HASH_EN = "b".repeat(64);
const HASH_HERO = "c".repeat(64);
const HASH_COPY = "d".repeat(64);
const NOW = new Date("2026-07-13T20:00:00.000Z");
const FRESH = NOW.toISOString();
const FINGERPRINT = Array.from({ length: 20 }, (_, index) => index % 8);

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
    stage: "launch",
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
        contentSha256: HASH_RU,
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
        contentSha256: HASH_EN,
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
        width: 1920,
        height: 1080,
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
        width: 1920,
        height: 1080,
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
    baseline: {
      state: "absent" as const,
      verifiedAt: FRESH,
      evidence: {
        path: `/campaign/${targetId}-baseline.json`,
        sha256: HASH_COPY,
        verifiedAt: FRESH,
      },
    },
  };
}

const canonicalManifest = manifest();
const authorizationEvidence = JSON.stringify({
  schemaVersion: 1,
  resolver: "publisher-adapter",
  kind: "authorization",
  campaignId: canonicalManifest.campaignId,
  taskId: canonicalManifest.taskId,
  decision: canonicalManifest.authorization.decision,
  scope: canonicalManifest.authorization.scope,
  evidenceRef: canonicalManifest.authorization.evidenceRef,
  decidedAt: canonicalManifest.authorization.decidedAt,
  targetsSha256: sha256(canonicalJson(canonicalManifest.targets)),
});
const baselineEvidence = new Map(
  canonicalManifest.targets.map((item) => [
    item.baseline.evidence.path,
    JSON.stringify({
      schemaVersion: 1,
      resolver: "publisher-adapter",
      kind: "baseline",
      campaignId: canonicalManifest.campaignId,
      targetId: item.targetId,
      managedTargetId: item.managedTargetId,
      platform: item.platform,
      profile: item.profile,
      ...(item.destination ? { destination: item.destination } : {}),
      action: item.action,
      idempotencyKey: item.idempotencyKey,
      state: item.baseline.state,
      checkedAt: item.baseline.verifiedAt,
    }),
  ]),
);

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
      ...Object.fromEntries([...baselineEvidence.keys()].map((path) => [path, HASH_COPY])),
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
          ...(path === "/campaign/hero.jpg" ? { size: 171_059, mime: "image/jpeg" } : {}),
          ...(texts[path] ? { text: texts[path] } : {}),
          ...(path === "/campaign/auth.json" ? { text: authorizationEvidence } : {}),
          ...(baselineEvidence.has(path) ? { text: baselineEvidence.get(path)! } : {}),
          ...(path === "/campaign/ru.mp3"
            ? {
                media: {
                  container: "mp3" as const,
                  audioCodec: "mp3" as const,
                  durationSec: 120,
                  audioDurationSec: 120,
                  audioContentSha256: HASH_RU,
                  audioFingerprint: FINGERPRINT,
                },
              }
            : {}),
          ...(path === "/campaign/en.mp3"
            ? {
                media: {
                  container: "mp3" as const,
                  audioCodec: "mp3" as const,
                  durationSec: 122,
                  audioDurationSec: 122,
                  audioContentSha256: HASH_EN,
                  audioFingerprint: FINGERPRINT,
                },
              }
            : {}),
          ...(path === "/campaign/tg.mp4"
            ? {
                media: {
                  container: "mp4" as const,
                  audioCodec: "aac" as const,
                  videoCodec: "h264" as const,
                  durationSec: 121,
                  audioDurationSec: 120,
                  width: 1920,
                  height: 1080,
                  audioContentSha256: HASH_RU,
                  audioFingerprint: FINGERPRINT,
                },
              }
            : {}),
          ...(path === "/campaign/en.mp4"
            ? {
                media: {
                  container: "mp4" as const,
                  audioCodec: "aac" as const,
                  videoCodec: "h264" as const,
                  durationSec: 123,
                  audioDurationSec: 122,
                  width: 1920,
                  height: 1080,
                  audioContentSha256: HASH_EN,
                  audioFingerprint: FINGERPRINT,
                },
              }
            : {}),
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

  it("rejects a partial X-only canonical stage", () => {
    const value = manifest();
    value.targets = value.targets.filter((target) => target.platform === "x");
    expect(validateArticleCampaign(value, evidence)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: ErrorCode.CAMPAIGN_TARGET_MISMATCH,
          message: expect.stringContaining("root telegram target"),
        }),
      ]),
    );
  });

  it("rejects self-asserted video metadata when probed bytes use the wrong codec", () => {
    const value = manifest();
    const wrongProbe = {
      ...evidence,
      statFile: (path: string) => {
        const found = evidence.statFile(path);
        return path === value.videos.telegramRu.path && found
          ? { ...found, media: { ...found.media!, videoCodec: undefined } }
          : found;
      },
    };
    expect(validateArticleCampaign(value, wrongProbe)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: ErrorCode.CAMPAIGN_MEDIA_POLICY })]),
    );
  });

  it("rejects a video whose probed audio fingerprint is not the declared narration", () => {
    const value = manifest();
    const wrongNarration = {
      ...evidence,
      statFile: (path: string) => {
        const found = evidence.statFile(path);
        return path === value.videos.xLinkedinEn.path && found
          ? {
              ...found,
              media: {
                ...found.media!,
                audioFingerprint: Array.from({ length: 20 }, () => 20),
              },
            }
          : found;
      },
    };
    expect(validateArticleCampaign(value, wrongNarration)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: ErrorCode.CAMPAIGN_ASSET_MISMATCH }),
      ]),
    );
  });

  it("rejects authorization evidence not bound to the exact target topology", () => {
    const value = manifest();
    const wrongAuthorization = {
      ...evidence,
      statFile: (path: string) => {
        const found = evidence.statFile(path);
        const parsed = JSON.parse(authorizationEvidence) as Record<string, unknown>;
        parsed.targetsSha256 = HASH_RU;
        return path === value.authorization.evidence.path && found
          ? { ...found, text: JSON.stringify(parsed) }
          : found;
      },
    };
    expect(validateArticleCampaign(value, wrongAuthorization)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: ErrorCode.CAMPAIGN_TARGET_MISMATCH }),
      ]),
    );
  });

  it("rejects a comment parent on a different managed destination", () => {
    const value = manifest();
    value.stage = "follow-up";
    value.targets.push({
      ...value.targets[2]!,
      targetId: "linkedin-comment",
      action: "comment",
      requiredMediaRole: "none",
      assetSha256: undefined,
      parentTargetId: value.targets[1]!.targetId,
      idempotencyKey: "linkedin-comment-v1",
    });
    expect(validateArticleCampaign(value, evidence)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: ErrorCode.CAMPAIGN_TARGET_MISMATCH,
          message: expect.stringContaining("same managed destination"),
        }),
      ]),
    );
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

  it("rejects non-JPEG hero bytes even when the manifest labels them JPEG", () => {
    const value = manifest();
    const wrongMimeEvidence = {
      ...evidence,
      statFile: (path: string) => {
        const found = evidence.statFile(path);
        return path === value.hero.path && found ? { ...found, mime: "image/png" } : found;
      },
    };
    expect(validateArticleCampaign(value, wrongMimeEvidence)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: ErrorCode.CAMPAIGN_MEDIA_POLICY })]),
    );
  });
});
