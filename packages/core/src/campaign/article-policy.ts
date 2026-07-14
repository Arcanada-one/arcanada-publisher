import { ErrorCode } from "../errors.js";
import { PLATFORM_TEXT_LIMITS } from "../tool-scoping.js";
import type { ArticleCampaignManifest } from "./types.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface CampaignFinding {
  code: ErrorCode;
  pointer: string;
  message: string;
}

export interface ArtifactEvidence {
  sha256: string;
  size?: number;
  text?: string;
}

export interface UrlEvidence {
  status: number;
  sha256?: string;
  titleSha256?: string;
}

export interface ArticleValidationEvidence {
  now: Date;
  statFile: (path: string) => ArtifactEvidence | undefined;
  probeUrl: (url: string) => UrlEvidence | undefined;
}

export function validateArticleCampaign(
  manifest: ArticleCampaignManifest,
  evidence: ArticleValidationEvidence,
): CampaignFinding[] {
  const findings: CampaignFinding[] = [];
  const add = (code: ErrorCode, pointer: string, message: string): void => {
    findings.push({ code, pointer, message });
  };

  for (const locale of ["ru", "en"] as const) {
    const site = manifest.website[locale];
    fresh(site.verifiedAt, 30 * MINUTE, evidence.now, `/website/${locale}/verifiedAt`, add);
    const live = evidence.probeUrl(site.url);
    if (!live || live.status !== 200) {
      add(
        ErrorCode.CAMPAIGN_EVIDENCE_MISSING,
        `/website/${locale}/url`,
        "live URL did not return HTTP 200",
      );
    } else if (live.titleSha256 && live.titleSha256 !== site.titleSha256) {
      add(
        ErrorCode.CAMPAIGN_ASSET_MISMATCH,
        `/website/${locale}/titleSha256`,
        "live title hash differs",
      );
    }

    const audio = manifest.audio[locale];
    fresh(
      audio.technicalVerifiedAt,
      24 * HOUR,
      evidence.now,
      `/audio/${locale}/technicalVerifiedAt`,
      add,
    );
    fresh(audio.listenedAt, 24 * HOUR, evidence.now, `/audio/${locale}/listenedAt`, add);
    fileHash(audio.path, audio.sha256, `/audio/${locale}/path`, evidence, add);
    const remoteAudio = evidence.probeUrl(audio.url);
    if (!remoteAudio || remoteAudio.status !== 200) {
      add(
        ErrorCode.CAMPAIGN_EVIDENCE_MISSING,
        `/audio/${locale}/url`,
        "CDN audio is not reachable",
      );
    } else if (remoteAudio.sha256 && remoteAudio.sha256 !== audio.sha256) {
      add(ErrorCode.CAMPAIGN_ASSET_MISMATCH, `/audio/${locale}/url`, "CDN audio hash differs");
    }
  }

  const heroEvidence = fileHash(
    manifest.hero.path,
    manifest.hero.sha256,
    "/hero/path",
    evidence,
    add,
  );
  if (manifest.hero.sizeBytes > 500_000) {
    add(
      ErrorCode.CAMPAIGN_MEDIA_POLICY,
      "/hero/sizeBytes",
      "canonical JPEG hero exceeds the 500000-byte publication ceiling",
    );
  }
  if (heroEvidence?.size !== manifest.hero.sizeBytes) {
    add(
      ErrorCode.CAMPAIGN_ASSET_MISMATCH,
      "/hero/sizeBytes",
      "hero byte size differs from the canonical JPEG record",
    );
  }
  checkVideo(
    manifest.videos.telegramRu,
    manifest.audio.ru.sha256,
    manifest.audio.ru.durationSec,
    "/videos/telegramRu",
    evidence,
    add,
  );
  checkVideo(
    manifest.videos.xLinkedinEn,
    manifest.audio.en.sha256,
    manifest.audio.en.durationSec,
    "/videos/xLinkedinEn",
    evidence,
    add,
  );

  const copyText = new Map<string, string>();
  for (const [key, copy] of Object.entries(manifest.copy)) {
    const artifact = fileHash(copy.path, copy.sha256, `/copy/${key}/path`, evidence, add);
    if (artifact?.text === undefined) {
      add(
        ErrorCode.CAMPAIGN_EVIDENCE_MISSING,
        `/copy/${key}/path`,
        "copy text could not be read for policy validation",
      );
    } else {
      copyText.set(key, artifact.text);
      const firstLine = artifact.text
        .split(/\r?\n/)
        .find((line) => line.trim().length > 0)
        ?.trim();
      if (copy.titleFirst && firstLine !== copy.title.trim()) {
        add(
          ErrorCode.CAMPAIGN_MEDIA_POLICY,
          `/copy/${key}/title`,
          "copy does not start with its declared title",
        );
      }
      for (const link of copy.canonicalLinks) {
        if (!artifact.text.includes(link)) {
          add(
            ErrorCode.CAMPAIGN_EVIDENCE_MISSING,
            `/copy/${key}/canonicalLinks`,
            "declared canonical link is absent from copy bytes",
          );
        }
      }
    }
    fresh(copy.policyCheckedAt, 24 * HOUR, evidence.now, `/copy/${key}/policyCheckedAt`, add);
    const expectedSite = manifest.website[copy.locale].url;
    if (!copy.canonicalLinks.includes(expectedSite)) {
      add(
        ErrorCode.CAMPAIGN_EVIDENCE_MISSING,
        `/copy/${key}/canonicalLinks`,
        "locale canonical site URL is missing",
      );
    }
  }

  fresh(
    manifest.authorization.decidedAt,
    30 * MINUTE,
    evidence.now,
    "/authorization/decidedAt",
    add,
  );
  fileHash(
    manifest.authorization.evidence.path,
    manifest.authorization.evidence.sha256,
    "/authorization/evidence/path",
    evidence,
    add,
  );
  fresh(
    manifest.authorization.evidence.verifiedAt,
    30 * MINUTE,
    evidence.now,
    "/authorization/evidence/verifiedAt",
    add,
  );

  const targetIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  for (let index = 0; index < manifest.targets.length; index++) {
    const target = manifest.targets[index]!;
    const pointer = `/targets/${index}`;
    if (targetIds.has(target.targetId)) {
      add(ErrorCode.CAMPAIGN_TARGET_MISMATCH, `${pointer}/targetId`, "duplicate target ID");
    }
    targetIds.add(target.targetId);
    if (idempotencyKeys.has(target.idempotencyKey)) {
      add(
        ErrorCode.CAMPAIGN_STATE_UNKNOWN,
        `${pointer}/idempotencyKey`,
        "idempotency key is not unique",
      );
    }
    idempotencyKeys.add(target.idempotencyKey);

    const copy = manifest.copy[target.copyKey];
    if (!copy) {
      add(ErrorCode.CAMPAIGN_EVIDENCE_MISSING, `${pointer}/copyKey`, "copy record is missing");
    } else {
      if (copy.sha256 !== target.copySha256) {
        add(ErrorCode.CAMPAIGN_ASSET_MISMATCH, `${pointer}/copySha256`, "target copy hash differs");
      }
      if (copy.locale !== target.language) {
        add(
          ErrorCode.CAMPAIGN_MEDIA_POLICY,
          `${pointer}/language`,
          "target and copy locales differ",
        );
      }
      const text = copyText.get(target.copyKey);
      if (text !== undefined) {
        const limit =
          target.platform === "telegram" && target.action === "publish"
            ? 900
            : PLATFORM_TEXT_LIMITS[target.platform];
        if (text.length > limit) {
          add(
            ErrorCode.CAMPAIGN_MEDIA_POLICY,
            `${pointer}/copyKey`,
            `copy exceeds ${target.platform} limit of ${limit} UTF-16 units`,
          );
        }
        const commentLike =
          target.action === "comment" || (target.action === "edit" && target.parentTargetId);
        if (target.platform !== "telegram" && commentLike) {
          const telegramTarget = manifest.targets.find(
            (candidate) => candidate.platform === "telegram" && !candidate.parentTargetId,
          );
          const telegramCanonical = manifest.backlinks?.find(
            (backlink) => backlink.targetId === telegramTarget?.targetId,
          )?.canonicalUrl;
          if (!telegramCanonical) {
            add(
              ErrorCode.CAMPAIGN_BACKLINKS_NOT_READY,
              `${pointer}/copyKey`,
              "comment copy requires a verified canonical Telegram result",
            );
          } else if (!copy.canonicalLinks.includes(telegramCanonical)) {
            add(
              ErrorCode.CAMPAIGN_EVIDENCE_MISSING,
              `${pointer}/copyKey`,
              "copy is missing the verified canonical Telegram link",
            );
          }
        }
      }
    }

    const mediaAction =
      target.action === "publish" ||
      target.action === "retain" ||
      (target.action === "edit" && !target.parentTargetId);
    const expected = mediaAction ? expectedTargetMedia(manifest, target.platform) : undefined;
    if (mediaAction) {
      if (!expected) {
        add(
          ErrorCode.CAMPAIGN_POLICY_UNKNOWN,
          `${pointer}/platform`,
          "platform is not registered by article policy",
        );
      } else if (
        target.requiredMediaRole !== expected.role ||
        target.language !== expected.locale
      ) {
        add(ErrorCode.CAMPAIGN_MEDIA_POLICY, `${pointer}/requiredMediaRole`, expected.message);
      } else if (target.assetSha256 !== expected.sha256) {
        add(
          ErrorCode.CAMPAIGN_ASSET_MISMATCH,
          `${pointer}/assetSha256`,
          "target is not bound to the canonical asset",
        );
      }
    } else if (target.requiredMediaRole !== "none" || target.assetSha256) {
      add(
        ErrorCode.CAMPAIGN_MEDIA_POLICY,
        `${pointer}/requiredMediaRole`,
        `${target.action} target must not carry media`,
      );
    }

    if (target.action === "comment" || (target.action === "edit" && target.parentTargetId)) {
      const parent = manifest.targets.find(
        (candidate) => candidate.targetId === target.parentTargetId,
      );
      const parentResult = manifest.backlinks?.find(
        (candidate) => candidate.targetId === target.parentTargetId,
      );
      if (!parent) {
        add(
          ErrorCode.CAMPAIGN_TARGET_MISMATCH,
          `${pointer}/parentTargetId`,
          "comment parent target is not present in this staged manifest",
        );
      }
      if (!parentResult) {
        add(
          ErrorCode.CAMPAIGN_BACKLINKS_NOT_READY,
          `${pointer}/parentTargetId`,
          "comment parent does not have a verified canonical result",
        );
      } else {
        if (parent && parentResult.readBackSha256 !== parent.copySha256) {
          add(
            ErrorCode.CAMPAIGN_BACKLINKS_NOT_READY,
            `${pointer}/parentTargetId`,
            "comment parent read-back does not match its immutable copy",
          );
        }
        fresh(parentResult.verifiedAt, 30 * MINUTE, evidence.now, `${pointer}/parentTargetId`, add);
      }
    }

    if (target.baseline.state === "unknown") {
      add(
        ErrorCode.CAMPAIGN_STATE_UNKNOWN,
        `${pointer}/baseline/state`,
        "idempotency baseline is unknown",
      );
    }
    fresh(
      target.baseline.verifiedAt,
      30 * MINUTE,
      evidence.now,
      `${pointer}/baseline/verifiedAt`,
      add,
    );
    if (target.baseline.state === "existing") {
      if (!target.existingState) {
        add(
          ErrorCode.CAMPAIGN_EVIDENCE_MISSING,
          `${pointer}/existingState`,
          "existing post readback is required",
        );
      } else {
        fresh(
          target.existingState.readBackAt,
          30 * MINUTE,
          evidence.now,
          `${pointer}/existingState/readBackAt`,
          add,
        );
        fileHash(
          target.existingState.evidence.path,
          target.existingState.evidence.sha256,
          `${pointer}/existingState/evidence/path`,
          evidence,
          add,
        );
        fresh(
          target.existingState.evidence.verifiedAt,
          30 * MINUTE,
          evidence.now,
          `${pointer}/existingState/evidence/verifiedAt`,
          add,
        );
        if (target.action === "retain" && target.existingState.mediaSha256 !== target.assetSha256) {
          add(
            ErrorCode.CAMPAIGN_ASSET_MISMATCH,
            `${pointer}/existingState/mediaSha256`,
            "retained post media does not match the canonical campaign asset",
          );
        }
      }
    }
  }

  for (let index = 0; index < (manifest.backlinks?.length ?? 0); index++) {
    const backlink = manifest.backlinks![index]!;
    fileHash(
      backlink.evidence.path,
      backlink.evidence.sha256,
      `/backlinks/${index}/evidence/path`,
      evidence,
      add,
    );
    fresh(
      backlink.evidence.verifiedAt,
      30 * MINUTE,
      evidence.now,
      `/backlinks/${index}/evidence/verifiedAt`,
      add,
    );
  }

  return findings;
}

export function validateBacklinkPreflight(
  manifest: ArticleCampaignManifest,
  now: Date,
): CampaignFinding[] {
  const findings: CampaignFinding[] = [];
  const backlinks = manifest.backlinks ?? [];
  const byTarget = new Map(backlinks.map((item) => [item.targetId, item]));
  for (const target of manifest.targets) {
    const backlink = byTarget.get(target.targetId);
    if (!backlink) {
      findings.push({
        code: ErrorCode.CAMPAIGN_BACKLINKS_NOT_READY,
        pointer: `/backlinks/${target.targetId}`,
        message: "verified canonical permalink is missing",
      });
      continue;
    }
    if (backlink.readBackSha256 !== target.copySha256) {
      findings.push({
        code: ErrorCode.CAMPAIGN_BACKLINKS_NOT_READY,
        pointer: `/backlinks/${target.targetId}/readBackSha256`,
        message: "canonical result read-back does not match target copy",
      });
    }
    fresh(
      backlink.verifiedAt,
      30 * MINUTE,
      now,
      `/backlinks/${target.targetId}/verifiedAt`,
      (code, pointer, message) => {
        findings.push({
          code:
            code === ErrorCode.CAMPAIGN_EVIDENCE_STALE
              ? ErrorCode.CAMPAIGN_BACKLINKS_NOT_READY
              : code,
          pointer,
          message,
        });
      },
    );
  }
  return findings;
}

function expectedTargetMedia(manifest: ArticleCampaignManifest, platform: string) {
  switch (platform) {
    case "telegram":
      return {
        role: "full-narration-video" as const,
        locale: "ru" as const,
        sha256: manifest.videos.telegramRu.sha256,
        message: "Telegram requires the RU full-narration video",
      };
    case "x":
    case "linkedin":
      return {
        role: "full-narration-video" as const,
        locale: "en" as const,
        sha256: manifest.videos.xLinkedinEn.sha256,
        message: `${platform} requires the EN full-narration video`,
      };
    case "facebook":
      return {
        role: "static-hero" as const,
        locale: "ru" as const,
        sha256: manifest.hero.sha256,
        message: "Facebook requires the static hero and rejects video",
      };
    default:
      return undefined;
  }
}

function checkVideo(
  video: ArticleCampaignManifest["videos"]["telegramRu" | "xLinkedinEn"],
  audioSha256: string,
  audioDurationSec: number,
  pointer: string,
  evidence: ArticleValidationEvidence,
  add: AddFinding,
): void {
  fileHash(video.path, video.sha256, `${pointer}/path`, evidence, add);
  fresh(video.probeVerifiedAt, 24 * HOUR, evidence.now, `${pointer}/probeVerifiedAt`, add);
  fresh(video.viewedAt, 24 * HOUR, evidence.now, `${pointer}/viewedAt`, add);
  if (video.narrationAudioSha256 !== audioSha256) {
    add(
      ErrorCode.CAMPAIGN_ASSET_MISMATCH,
      `${pointer}/narrationAudioSha256`,
      "video narration hash differs",
    );
  }
  if (Math.abs(video.durationSec - audioDurationSec) > 2) {
    add(
      ErrorCode.CAMPAIGN_MEDIA_POLICY,
      `${pointer}/durationSec`,
      "video duration differs from narration by more than two seconds",
    );
  }
}

type AddFinding = (code: ErrorCode, pointer: string, message: string) => void;

function fileHash(
  path: string,
  expected: string,
  pointer: string,
  evidence: ArticleValidationEvidence,
  add: AddFinding,
): ArtifactEvidence | undefined {
  const actual = evidence.statFile(path);
  if (!actual) {
    add(ErrorCode.CAMPAIGN_EVIDENCE_MISSING, pointer, "local artifact is missing");
  } else if (actual.sha256 !== expected) {
    add(ErrorCode.CAMPAIGN_ASSET_MISMATCH, pointer, "local artifact hash differs");
  }
  return actual;
}

function fresh(
  timestamp: string,
  maxAgeMs: number,
  now: Date,
  pointer: string,
  add: AddFinding,
): void {
  const age = now.getTime() - Date.parse(timestamp);
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) {
    add(ErrorCode.CAMPAIGN_EVIDENCE_STALE, pointer, "evidence is stale or from the future");
  }
}
