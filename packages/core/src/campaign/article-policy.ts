import { ErrorCode } from "../errors.js";
import { PLATFORM_TEXT_LIMITS } from "../tool-scoping.js";
import { z } from "zod";
import { DestinationSchema, canonicalJson, sha256, type ArticleCampaignManifest } from "./types.js";

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
  mime?: string;
  text?: string;
  media?: {
    container: "mp3" | "mp4";
    audioCodec: "mp3" | "aac";
    videoCodec?: "h264";
    durationSec: number;
    audioDurationSec: number;
    width?: number;
    height?: number;
    audioContentSha256: string;
    audioFingerprint: readonly number[];
  };
}

const EvidenceBaseSchema = z
  .object({ schemaVersion: z.literal(1), resolver: z.literal("publisher-adapter") })
  .strict();
const AuthorizationEvidenceSchema = EvidenceBaseSchema.extend({
  kind: z.literal("authorization"),
  campaignId: z.string(),
  taskId: z.string(),
  decision: z.enum(["auto", "approved"]),
  scope: z.literal("publish_public"),
  evidenceRef: z.string(),
  decidedAt: z.string(),
  targetsSha256: z.string(),
}).strict();
const BaselineEvidenceSchema = EvidenceBaseSchema.extend({
  kind: z.literal("baseline"),
  campaignId: z.string(),
  targetId: z.string(),
  managedTargetId: z.string(),
  platform: z.string(),
  profile: z.string(),
  destination: DestinationSchema.optional(),
  action: z.string(),
  idempotencyKey: z.string(),
  state: z.enum(["absent", "existing", "unknown"]),
  checkedAt: z.string(),
}).strict();
const CurrentStateEvidenceSchema = EvidenceBaseSchema.extend({
  kind: z.literal("current-state"),
  campaignId: z.string(),
  targetId: z.string(),
  canonicalUrl: z.string(),
  expectedContentSha256: z.string(),
  mediaType: z.enum(["image", "video", "none"]),
  mediaSha256: z.string().optional(),
  identity: z.string(),
  readBackAt: z.string(),
}).strict();
const ResultReadbackEvidenceSchema = EvidenceBaseSchema.extend({
  kind: z.literal("result-readback"),
  campaignId: z.string(),
  targetId: z.string(),
  canonicalUrl: z.string(),
  readBackSha256: z.string(),
  duplicateState: z.literal("resolved"),
  verifiedAt: z.string(),
}).strict();

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
    const audioArtifact = fileHash(
      audio.path,
      audio.sha256,
      `/audio/${locale}/path`,
      evidence,
      add,
    );
    if (
      !audioArtifact?.media ||
      audioArtifact.media.container !== "mp3" ||
      audioArtifact.media.audioCodec !== "mp3" ||
      audioArtifact.media.videoCodec !== undefined
    ) {
      add(
        ErrorCode.CAMPAIGN_MEDIA_POLICY,
        `/audio/${locale}/path`,
        "audio bytes are not a probed MP3 audio-only asset",
      );
    } else {
      if (Math.abs(audioArtifact.media.durationSec - audio.durationSec) > 0.25) {
        add(
          ErrorCode.CAMPAIGN_MEDIA_POLICY,
          `/audio/${locale}/durationSec`,
          "declared audio duration differs from the probed bytes",
        );
      }
      if (audioArtifact.media.audioContentSha256 !== audio.contentSha256) {
        add(
          ErrorCode.CAMPAIGN_ASSET_MISMATCH,
          `/audio/${locale}/contentSha256`,
          "decoded audio content hash differs",
        );
      }
    }
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
  if (heroEvidence?.mime !== "image/jpeg") {
    add(ErrorCode.CAMPAIGN_MEDIA_POLICY, "/hero/mime", "hero bytes are not a JPEG image");
  }
  checkVideo(
    manifest.videos.telegramRu,
    manifest.audio.ru.path,
    manifest.audio.ru.contentSha256,
    manifest.audio.ru.durationSec,
    "/videos/telegramRu",
    evidence,
    add,
  );
  checkVideo(
    manifest.videos.xLinkedinEn,
    manifest.audio.en.path,
    manifest.audio.en.contentSha256,
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
  const authorizationArtifact = fileHash(
    manifest.authorization.evidence.path,
    manifest.authorization.evidence.sha256,
    "/authorization/evidence/path",
    evidence,
    add,
  );
  typedEvidence(
    authorizationArtifact,
    AuthorizationEvidenceSchema,
    {
      schemaVersion: 1,
      resolver: "publisher-adapter",
      kind: "authorization",
      campaignId: manifest.campaignId,
      taskId: manifest.taskId,
      decision: manifest.authorization.decision,
      scope: manifest.authorization.scope,
      evidenceRef: manifest.authorization.evidenceRef,
      decidedAt: manifest.authorization.decidedAt,
      targetsSha256: sha256(canonicalJson(manifest.targets)),
    },
    "/authorization/evidence/path",
    add,
  );
  fresh(
    manifest.authorization.evidence.verifiedAt,
    30 * MINUTE,
    evidence.now,
    "/authorization/evidence/verifiedAt",
    add,
  );

  const rootTargets = manifest.targets.filter((target) => !target.parentTargetId);
  for (const platform of ["telegram", "x", "linkedin", "facebook"] as const) {
    const rootsForPlatform = rootTargets.filter((target) => target.platform === platform);
    if (rootsForPlatform.length !== 1) {
      add(
        ErrorCode.CAMPAIGN_TARGET_MISMATCH,
        "/targets",
        `canonical article stage requires exactly one root ${platform} target`,
      );
    }
    if (rootsForPlatform.some((target) => !["publish", "edit", "retain"].includes(target.action))) {
      add(
        ErrorCode.CAMPAIGN_TARGET_MISMATCH,
        "/targets",
        `canonical root ${platform} target must publish, edit, or retain the article post`,
      );
    }
  }
  const dependentTargets = manifest.targets.filter((target) => target.parentTargetId);
  if (manifest.stage === "launch" && dependentTargets.length > 0) {
    add(
      ErrorCode.CAMPAIGN_TARGET_MISMATCH,
      "/stage",
      "launch stage cannot contain permalink-dependent targets",
    );
  }
  if (manifest.stage === "follow-up" && dependentTargets.length === 0) {
    add(
      ErrorCode.CAMPAIGN_TARGET_MISMATCH,
      "/stage",
      "follow-up stage requires at least one parent-bound target",
    );
  }

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
      if (
        parent &&
        (parent.parentTargetId !== undefined ||
          !["publish", "edit", "retain"].includes(parent.action) ||
          parent.managedTargetId !== target.managedTargetId ||
          parent.platform !== target.platform ||
          parent.profile !== target.profile ||
          canonicalJson(parent.destination ?? null) !== canonicalJson(target.destination ?? null))
      ) {
        add(
          ErrorCode.CAMPAIGN_TARGET_MISMATCH,
          `${pointer}/parentTargetId`,
          "comment parent must be a root post on the same managed destination",
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
    const baselineArtifact = fileHash(
      target.baseline.evidence.path,
      target.baseline.evidence.sha256,
      `${pointer}/baseline/evidence/path`,
      evidence,
      add,
    );
    typedEvidence(
      baselineArtifact,
      BaselineEvidenceSchema,
      {
        schemaVersion: 1,
        resolver: "publisher-adapter",
        kind: "baseline",
        campaignId: manifest.campaignId,
        targetId: target.targetId,
        managedTargetId: target.managedTargetId,
        platform: target.platform,
        profile: target.profile,
        ...(target.destination ? { destination: target.destination } : {}),
        action: target.action,
        idempotencyKey: target.idempotencyKey,
        state: target.baseline.state,
        checkedAt: target.baseline.verifiedAt,
      },
      `${pointer}/baseline/evidence/path`,
      add,
    );
    fresh(
      target.baseline.evidence.verifiedAt,
      30 * MINUTE,
      evidence.now,
      `${pointer}/baseline/evidence/verifiedAt`,
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
        const currentStateArtifact = fileHash(
          target.existingState.evidence.path,
          target.existingState.evidence.sha256,
          `${pointer}/existingState/evidence/path`,
          evidence,
          add,
        );
        typedEvidence(
          currentStateArtifact,
          CurrentStateEvidenceSchema,
          {
            schemaVersion: 1,
            resolver: "publisher-adapter",
            kind: "current-state",
            campaignId: manifest.campaignId,
            targetId: target.targetId,
            canonicalUrl: target.existingState.canonicalUrl,
            expectedContentSha256: target.existingState.expectedContentSha256,
            mediaType: target.existingState.mediaType,
            ...(target.existingState.mediaSha256
              ? { mediaSha256: target.existingState.mediaSha256 }
              : {}),
            identity: target.existingState.identity,
            readBackAt: target.existingState.readBackAt,
          },
          `${pointer}/existingState/evidence/path`,
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
    const backlinkArtifact = fileHash(
      backlink.evidence.path,
      backlink.evidence.sha256,
      `/backlinks/${index}/evidence/path`,
      evidence,
      add,
    );
    typedEvidence(
      backlinkArtifact,
      ResultReadbackEvidenceSchema,
      {
        schemaVersion: 1,
        resolver: "publisher-adapter",
        kind: "result-readback",
        campaignId: manifest.campaignId,
        targetId: backlink.targetId,
        canonicalUrl: backlink.canonicalUrl,
        readBackSha256: backlink.readBackSha256,
        duplicateState: backlink.duplicateState,
        verifiedAt: backlink.verifiedAt,
      },
      `/backlinks/${index}/evidence/path`,
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

  if (
    manifest.stage === "complete" &&
    manifest.targets.some(
      (target) => !manifest.backlinks?.some((backlink) => backlink.targetId === target.targetId),
    )
  ) {
    add(
      ErrorCode.CAMPAIGN_BACKLINKS_NOT_READY,
      "/stage",
      "complete stage requires verified result read-back for every target",
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
  audioPath: string,
  audioSha256: string,
  audioDurationSec: number,
  pointer: string,
  evidence: ArticleValidationEvidence,
  add: AddFinding,
): void {
  const videoArtifact = fileHash(video.path, video.sha256, `${pointer}/path`, evidence, add);
  const audioArtifact = evidence.statFile(audioPath);
  fresh(video.probeVerifiedAt, 24 * HOUR, evidence.now, `${pointer}/probeVerifiedAt`, add);
  fresh(video.viewedAt, 24 * HOUR, evidence.now, `${pointer}/viewedAt`, add);
  if (video.narrationAudioSha256 !== audioSha256) {
    add(
      ErrorCode.CAMPAIGN_ASSET_MISMATCH,
      `${pointer}/narrationAudioSha256`,
      "video narration hash differs",
    );
  }
  if (
    !videoArtifact?.media ||
    videoArtifact.media.container !== "mp4" ||
    videoArtifact.media.videoCodec !== "h264" ||
    videoArtifact.media.audioCodec !== "aac" ||
    !videoArtifact.media.width ||
    !videoArtifact.media.height ||
    videoArtifact.media.width !== video.width ||
    videoArtifact.media.height !== video.height
  ) {
    add(
      ErrorCode.CAMPAIGN_MEDIA_POLICY,
      `${pointer}/path`,
      "video bytes are not a probed H.264/AAC MP4 with positive dimensions",
    );
  } else {
    if (Math.abs(videoArtifact.media.durationSec - video.durationSec) > 0.25) {
      add(
        ErrorCode.CAMPAIGN_MEDIA_POLICY,
        `${pointer}/durationSec`,
        "declared video duration differs from the probed bytes",
      );
    }
    if (Math.abs(videoArtifact.media.audioDurationSec - audioDurationSec) > 2) {
      add(
        ErrorCode.CAMPAIGN_MEDIA_POLICY,
        `${pointer}/durationSec`,
        "probed video audio track differs from narration by more than two seconds",
      );
    }
    if (
      !audioArtifact?.media?.audioFingerprint ||
      !audioFingerprintsMatch(
        audioArtifact.media.audioFingerprint,
        videoArtifact.media.audioFingerprint,
      )
    ) {
      add(
        ErrorCode.CAMPAIGN_ASSET_MISMATCH,
        `${pointer}/narrationAudioSha256`,
        "probed video audio track does not match the narration fingerprint",
      );
    }
  }
  if (Math.abs(video.durationSec - audioDurationSec) > 2) {
    add(
      ErrorCode.CAMPAIGN_MEDIA_POLICY,
      `${pointer}/durationSec`,
      "video duration differs from narration by more than two seconds",
    );
  }
}

function audioFingerprintsMatch(expected: readonly number[], actual: readonly number[]): boolean {
  if (
    expected.length < 10 ||
    actual.length < 10 ||
    Math.abs(expected.length - actual.length) > 20
  ) {
    return false;
  }
  let best = Number.POSITIVE_INFINITY;
  for (let shift = -5; shift <= 5; shift++) {
    let total = 0;
    let compared = 0;
    for (let index = 0; index < expected.length; index++) {
      const candidate = index + shift;
      if (candidate < 0 || candidate >= actual.length) continue;
      total += Math.abs(expected[index]! - actual[candidate]!);
      compared++;
    }
    if (compared >= Math.min(expected.length, actual.length) * 0.9) {
      best = Math.min(best, total / compared);
    }
  }
  return best <= 1;
}

function typedEvidence<T extends z.ZodTypeAny>(
  artifact: ArtifactEvidence | undefined,
  schema: T,
  expected: z.infer<T>,
  pointer: string,
  add: AddFinding,
): void {
  if (artifact?.text === undefined) {
    add(ErrorCode.CAMPAIGN_EVIDENCE_MISSING, pointer, "typed evidence body is missing");
    return;
  }
  try {
    const parsed = schema.parse(JSON.parse(artifact.text));
    if (canonicalJson(parsed) !== canonicalJson(expected)) {
      add(
        ErrorCode.CAMPAIGN_TARGET_MISMATCH,
        pointer,
        "typed evidence is not bound to the canonical campaign state",
      );
    }
  } catch {
    add(ErrorCode.CAMPAIGN_EVIDENCE_MISSING, pointer, "typed evidence is malformed");
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
