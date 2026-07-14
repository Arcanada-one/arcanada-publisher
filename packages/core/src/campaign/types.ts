import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { AdapterError, ErrorCode } from "../errors.js";
import { PLATFORMS } from "../platform.js";

export const SHA256_RE = /^[a-f0-9]{64}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROFILE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ISO_DATE = z.string().datetime({ offset: true });
const Sha256Schema = z.string().regex(SHA256_RE);
const HttpsUrlSchema = z
  .string()
  .url()
  .refine((value) => value.startsWith("https://"), {
    message: "URL must use HTTPS",
  });

export const DestinationSchema = z
  .object({
    chatId: z.string().min(1).max(128).optional(),
    subreddit: z.string().min(1).max(128).optional(),
    ownerId: z.number().int().optional(),
    authorProfileUrl: HttpsUrlSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "destination cannot be empty");

export type CampaignDestination = z.infer<typeof DestinationSchema>;

export const AllowedPolicySchema = z
  .object({ contentKind: z.string().regex(SAFE_ID_RE), policy: z.string().regex(SAFE_ID_RE) })
  .strict();

export const ManagedTargetSchema = z
  .object({
    targetId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    platform: z.enum(PLATFORMS),
    profile: z.string().regex(PROFILE_RE),
    destination: DestinationSchema.optional(),
    allowedPolicies: z.array(AllowedPolicySchema).min(1),
    enforced: z.boolean(),
  })
  .strict();

export const ManagedTargetRegistrySchema = z
  .object({ schemaVersion: z.literal(1), targets: z.array(ManagedTargetSchema) })
  .strict();

export type ManagedTarget = z.infer<typeof ManagedTargetSchema>;
export type ManagedTargetFile = z.infer<typeof ManagedTargetRegistrySchema>;

const SiteLocaleSchema = z
  .object({ url: HttpsUrlSchema, titleSha256: Sha256Schema, verifiedAt: ISO_DATE })
  .strict();

const AudioSchema = z
  .object({
    path: z.string().regex(/\.mp3$/i),
    url: HttpsUrlSchema,
    sha256: Sha256Schema,
    contentSha256: Sha256Schema,
    durationSec: z.number().positive(),
    locale: z.enum(["ru", "en"]),
    voice: z.literal("pavel"),
    engine: z.string().min(1).max(128),
    normalization: z.string().min(1).max(128),
    technicalVerifiedAt: ISO_DATE,
    listenedAt: ISO_DATE,
  })
  .strict();

const VideoSchema = z
  .object({
    path: z.string().regex(/\.mp4$/i),
    sha256: Sha256Schema,
    durationSec: z.number().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    locale: z.enum(["ru", "en"]),
    narrationAudioSha256: Sha256Schema,
    preset: z.string().min(1).max(128),
    codec: z.literal("h264+aac"),
    probeVerifiedAt: ISO_DATE,
    viewedAt: ISO_DATE,
  })
  .strict();

const CopySchema = z
  .object({
    path: z.string().min(1),
    sha256: Sha256Schema,
    locale: z.enum(["ru", "en"]),
    title: z.string().min(1),
    titleFirst: z.boolean(),
    canonicalLinks: z.array(HttpsUrlSchema),
    policyCheckedAt: ISO_DATE,
  })
  .strict();

const EvidenceFileSchema = z
  .object({
    path: z.string().min(1),
    sha256: Sha256Schema,
    verifiedAt: ISO_DATE,
  })
  .strict();

const ExistingStateSchema = z
  .object({
    canonicalUrl: HttpsUrlSchema,
    expectedContentSha256: Sha256Schema,
    mediaType: z.enum(["image", "video", "none"]),
    mediaSha256: Sha256Schema.optional(),
    identity: z.string().min(1).max(256),
    readBackAt: ISO_DATE,
    evidence: EvidenceFileSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mediaType !== "none" && !value.mediaSha256) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mediaSha256"],
        message: "existing image/video state requires trusted media evidence hash",
      });
    }
    if (value.mediaType === "none" && value.mediaSha256) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mediaSha256"],
        message: "mediaSha256 is invalid when existing mediaType is none",
      });
    }
  });

export const CampaignTargetActionSchema = z.enum([
  "publish",
  "comment",
  "edit",
  "delete",
  "retain",
]);

const TargetSchema = z
  .object({
    targetId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    managedTargetId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    action: CampaignTargetActionSchema,
    platform: z.enum(PLATFORMS),
    profile: z.string().regex(PROFILE_RE),
    destination: DestinationSchema.optional(),
    language: z.enum(["ru", "en"]),
    requiredMediaRole: z.enum(["full-narration-video", "static-hero", "none"]),
    assetSha256: Sha256Schema.optional(),
    copySha256: Sha256Schema,
    copyKey: z.string().regex(SAFE_ID_RE),
    parentTargetId: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
      .optional(),
    idempotencyKey: z.string().regex(SAFE_ID_RE),
    baseline: z
      .object({
        state: z.enum(["absent", "existing", "unknown"]),
        verifiedAt: ISO_DATE,
        evidence: EvidenceFileSchema,
      })
      .strict(),
    existingState: ExistingStateSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const mediaAction =
      value.action === "publish" ||
      value.action === "retain" ||
      (value.action === "edit" && !value.parentTargetId);
    if (mediaAction && (value.requiredMediaRole === "none" || !value.assetSha256)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requiredMediaRole"],
        message: `${value.action} target requires a canonical media asset`,
      });
    }
    if (!mediaAction && (value.requiredMediaRole !== "none" || value.assetSha256)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requiredMediaRole"],
        message: `${value.action} target must not carry a media asset`,
      });
    }
    if (value.action === "comment" && !value.parentTargetId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parentTargetId"],
        message: "comment target requires a parent target",
      });
    }
    if (value.action !== "comment" && value.action !== "edit" && value.parentTargetId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parentTargetId"],
        message: "only comment or comment-edit targets can declare a parent target",
      });
    }
    if (
      (value.action === "edit" || value.action === "delete" || value.action === "retain") &&
      !value.existingState
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["existingState"],
        message: `${value.action} target requires current existing-state evidence`,
      });
    }
    if (
      (value.action === "edit" || value.action === "delete" || value.action === "retain") &&
      value.baseline.state !== "existing"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["baseline", "state"],
        message: `${value.action} target requires an existing baseline`,
      });
    }
    if (
      (value.action === "publish" || value.action === "comment") &&
      value.baseline.state !== "absent"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["baseline", "state"],
        message: `${value.action} target requires an evidenced absent baseline`,
      });
    }
  });

const BacklinkSchema = z
  .object({
    targetId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    canonicalUrl: HttpsUrlSchema,
    verifiedAt: ISO_DATE,
    readBackSha256: Sha256Schema,
    duplicateState: z.literal("resolved"),
    evidence: EvidenceFileSchema,
  })
  .strict();

export const ArticleCampaignManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    campaignId: z.string().regex(SAFE_ID_RE),
    taskId: z.string().regex(/^[A-Z]+-[0-9]{4}$/),
    contentKind: z.literal("article"),
    policy: z.literal("arcanada-blog-canonical"),
    createdAt: ISO_DATE,
    updatedAt: ISO_DATE,
    stage: z.enum(["launch", "follow-up", "complete"]),
    website: z
      .object({
        deploymentCommit: z.string().regex(/^[a-f0-9]{40}$/),
        deploymentRun: z.string().regex(SAFE_ID_RE),
        ru: SiteLocaleSchema,
        en: SiteLocaleSchema,
      })
      .strict(),
    audio: z
      .object({
        ru: AudioSchema.extend({ locale: z.literal("ru") }),
        en: AudioSchema.extend({ locale: z.literal("en") }),
      })
      .strict(),
    hero: z
      .object({
        path: z.string().regex(/\.jpe?g$/i),
        sha256: Sha256Schema,
        mime: z.literal("image/jpeg"),
        sizeBytes: z.number().int().positive(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        role: z.literal("static-hero"),
      })
      .strict(),
    videos: z
      .object({
        telegramRu: VideoSchema.extend({ locale: z.literal("ru") }),
        xLinkedinEn: VideoSchema.extend({ locale: z.literal("en") }),
      })
      .strict(),
    copy: z.record(z.string().regex(SAFE_ID_RE), CopySchema),
    targets: z.array(TargetSchema).min(1),
    authorization: z
      .object({
        decision: z.enum(["auto", "approved"]),
        scope: z.literal("publish_public"),
        decidedAt: ISO_DATE,
        evidenceRef: z.string().regex(SAFE_ID_RE),
        evidence: EvidenceFileSchema,
      })
      .strict(),
    backlinks: z.array(BacklinkSchema).optional(),
  })
  .strict();

export type ArticleCampaignManifest = z.infer<typeof ArticleCampaignManifestSchema>;

export interface LoadedCampaignManifest {
  manifest: ArticleCampaignManifest;
  sha256: string;
  path: string;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function assertOwnerOnlyRegularFile(path: string, pointer: string): void {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    throw campaignInvalid(pointer, "required file is missing or unreadable");
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw campaignInvalid(pointer, "must be a regular non-symlink file");
  }
  if ((info.mode & 0o077) !== 0) {
    throw campaignInvalid(pointer, "permissions must be 0600 or stricter");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw campaignInvalid(pointer, "file must be owned by the current user");
  }
}

export function assertOwnerOnlyDirectory(path: string, pointer: string): void {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    throw campaignInvalid(pointer, "required directory is missing or unreadable");
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw campaignInvalid(pointer, "must be a regular non-symlink directory");
  }
  if ((info.mode & 0o077) !== 0) {
    throw campaignInvalid(pointer, "directory permissions must be 0700 or stricter");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw campaignInvalid(pointer, "directory must be owned by the current user");
  }
}

export function assertWithinRoots(path: string, roots: readonly string[], pointer: string): string {
  if (roots.length === 0) throw campaignInvalid(pointer, "no campaign roots configured");
  let actual: string;
  try {
    actual = realpathSync(path);
  } catch {
    throw campaignInvalid(pointer, "path is missing or unreadable");
  }
  const inside = roots.some((root) => {
    assertOwnerOnlyDirectory(root, pointer);
    let canonicalRoot: string;
    try {
      canonicalRoot = realpathSync(root);
    } catch {
      throw campaignInvalid(pointer, "configured campaign root is unreadable");
    }
    const child = relative(canonicalRoot, actual);
    return child === "" || (!child.startsWith("..") && !isAbsolute(child));
  });
  if (!inside) throw campaignInvalid(pointer, "path escapes configured campaign roots");
  return actual;
}

export function resolveArtifactPath(manifestPath: string, artifactPath: string): string {
  return resolve(manifestPath, "..", artifactPath);
}

export function loadCampaignManifest(
  path: string,
  roots: readonly string[],
): LoadedCampaignManifest {
  assertOwnerOnlyRegularFile(path, "/manifest");
  const actual = assertWithinRoots(path, roots, "/manifest");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(actual, "utf8"));
  } catch {
    throw campaignInvalid("/manifest", "invalid JSON");
  }
  const parsed = ArticleCampaignManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const pointer = `/${issue?.path.join("/") ?? "manifest"}`;
    throw campaignInvalid(pointer, issue?.message ?? "invalid manifest");
  }
  return { manifest: parsed.data, sha256: sha256(canonicalJson(parsed.data)), path: actual };
}

export function statRegularFile(path: string): { size: number } {
  const info = statSync(path);
  if (!info.isFile()) throw campaignInvalid("/artifact", "artifact is not a regular file");
  return { size: info.size };
}

export function campaignInvalid(pointer: string, reason: string): AdapterError {
  return new AdapterError(
    ErrorCode.CAMPAIGN_MANIFEST_INVALID,
    `campaign manifest invalid at ${pointer}: ${reason}`,
    {
      pointer,
      reason,
    },
  );
}
