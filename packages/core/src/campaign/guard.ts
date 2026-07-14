import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { lstatSync, readFileSync } from "node:fs";
import { AdapterError, ErrorCode } from "../errors.js";
import type { Platform } from "../platform.js";
import {
  validateBacklinkPreflight,
  validateArticleCampaign,
  type CampaignFinding,
  type UrlEvidence,
} from "./article-policy.js";
import { ManagedTargetRegistry } from "./registry.js";
import {
  ReceiptLedger,
  issueReceipt,
  parseReceipt,
  verifyReceipt,
  type CampaignPublicAction,
  type ReceiptBinding,
} from "./receipt.js";
import {
  assertWithinRoots,
  canonicalJson,
  loadCampaignManifest,
  sha256,
  type ArticleCampaignManifest,
  type CampaignDestination,
  type LoadedCampaignManifest,
  type ManagedTarget,
} from "./types.js";

export interface CampaignMutationInput {
  platform: Platform;
  profile: string;
  destination?: CampaignDestination | undefined;
  action: CampaignPublicAction;
  campaignTargetId?: string | undefined;
  subjectUrl?: string | undefined;
  subjectIdentity?: string | undefined;
  existingText?: string | undefined;
  manifestPath?: string | undefined;
  receipt?: string | undefined;
  text?: string | undefined;
  mediaPaths: readonly string[];
  dryRun?: boolean | undefined;
}

export interface CampaignAuthorization {
  managed: boolean;
  targetId?: string;
  manifestSha256?: string;
  campaignId?: string;
  platform?: Platform;
  action?: CampaignPublicAction;
  receiptSha256?: string;
}

export interface CampaignGuardOptions {
  policyDir?: string;
  campaignRoots?: readonly string[];
  ledgerPath?: string;
  now?: () => Date;
  loadManifest?: (path: string, roots: readonly string[]) => LoadedCampaignManifest;
  validate?: (
    manifest: ArticleCampaignManifest,
    loaded: LoadedCampaignManifest,
  ) => CampaignFinding[] | Promise<CampaignFinding[]>;
  artifactSha256?: (path: string, loaded: LoadedCampaignManifest) => string;
  fetch?: typeof globalThis.fetch;
  evidenceTimeoutMs?: number;
  maxEvidenceBytes?: number;
}

interface ManagedContext {
  target: ManagedTarget;
  registry: ManagedTargetRegistry;
  loaded: LoadedCampaignManifest;
  manifestTarget: ArticleCampaignManifest["targets"][number];
}

export class CampaignGuard {
  private readonly policyDir: string;
  private readonly campaignRoots: readonly string[];
  private readonly ledgerPath: string;
  private readonly now: () => Date;
  private readonly loadManifest: NonNullable<CampaignGuardOptions["loadManifest"]>;
  private readonly injectedValidate: CampaignGuardOptions["validate"];
  private readonly artifactSha256: NonNullable<CampaignGuardOptions["artifactSha256"]>;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly evidenceTimeoutMs: number;
  private readonly maxEvidenceBytes: number;

  constructor(options: CampaignGuardOptions = {}) {
    const base = join(homedir(), ".arcanada-publisher");
    this.policyDir = options.policyDir ?? join(base, "policy");
    this.campaignRoots = options.campaignRoots ?? configuredCampaignRoots();
    this.ledgerPath = options.ledgerPath ?? join(base, "audit", "campaign-receipts.jsonl");
    this.now = options.now ?? (() => new Date());
    this.loadManifest = options.loadManifest ?? loadCampaignManifest;
    this.injectedValidate = options.validate;
    this.artifactSha256 =
      options.artifactSha256 ?? ((path, loaded) => this.hashArtifact(path, loaded));
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.evidenceTimeoutMs = options.evidenceTimeoutMs ?? 10_000;
    this.maxEvidenceBytes = options.maxEvidenceBytes ?? 16 * 1024 * 1024;
  }

  async preflight(input: Omit<CampaignMutationInput, "receipt" | "dryRun">): Promise<string> {
    const context = this.resolveManaged(input, true);
    if (!context) {
      throw new AdapterError(
        ErrorCode.CAMPAIGN_TARGET_MISMATCH,
        "campaign preflight requires a managed target",
      );
    }
    const findings = this.injectedValidate
      ? await this.injectedValidate(context.loaded.manifest, context.loaded)
      : validateArticleCampaign(context.loaded.manifest, await this.buildEvidence(context.loaded));
    if (input.action === "backlink-deploy") {
      findings.push(...validateBacklinkPreflight(context.loaded.manifest, this.now()));
    }
    findings.push(...validateManifestRegistryBindings(context));
    if (findings.length > 0) {
      new ReceiptLedger(this.ledgerPath).recordPreflightDenied(
        {
          manifestSha256: context.loaded.sha256,
          campaignId: context.loaded.manifest.campaignId,
          targetId: context.manifestTarget.targetId,
          platform: context.target.platform,
          profile: context.target.profile,
          action: input.action,
          code: findings[0]!.code,
        },
        this.now(),
      );
      throw findingsError(findings);
    }
    const binding = this.bindingFor(context, input);
    const receipt = issueReceipt(binding, {
      keyPath: join(this.policyDir, "receipt.key"),
      now: this.now(),
    });
    new ReceiptLedger(this.ledgerPath).recordIssued(
      receipt,
      parseReceipt(receipt).payload,
      this.now(),
    );
    return receipt;
  }

  async authorize(input: CampaignMutationInput): Promise<CampaignAuthorization> {
    const registry = ManagedTargetRegistry.load({ policyDir: this.policyDir });
    const target = registry.match(input);
    if (!target) {
      const profileManaged = registry.targets.some(
        (candidate) =>
          candidate.enforced &&
          candidate.platform === input.platform &&
          candidate.profile === input.profile,
      );
      if (profileManaged) {
        throw new AdapterError(
          ErrorCode.CAMPAIGN_TARGET_MISMATCH,
          "managed profile destination does not match the registry",
        );
      }
      return { managed: false };
    }
    if (input.dryRun) {
      await this.preflight(input);
      return { managed: true, targetId: input.campaignTargetId! };
    }
    const context = this.resolveManaged(input, true);
    if (!context)
      throw new AdapterError(ErrorCode.CAMPAIGN_TARGET_MISMATCH, "managed target disappeared");
    if (!input.receipt) {
      throw new AdapterError(
        ErrorCode.CAMPAIGN_RECEIPT_REQUIRED,
        "managed mutation requires a campaign receipt",
      );
    }
    const binding = this.bindingFor(context, input);
    const ledger = new ReceiptLedger(this.ledgerPath);
    try {
      const payload = verifyReceipt(input.receipt, binding, {
        keyPath: join(this.policyDir, "receipt.key"),
        now: this.now(),
      });
      ledger.consume(input.receipt, payload, this.now());
    } catch (error) {
      if (
        error instanceof AdapterError &&
        (error.code === ErrorCode.CAMPAIGN_RECEIPT_INVALID ||
          error.code === ErrorCode.CAMPAIGN_RECEIPT_EXPIRED ||
          error.code === ErrorCode.CAMPAIGN_RECEIPT_REPLAY)
      ) {
        ledger.recordRejected(
          input.receipt,
          {
            manifestSha256: context.loaded.sha256,
            campaignId: context.loaded.manifest.campaignId,
            targetId: context.manifestTarget.targetId,
            platform: context.target.platform,
            profile: context.target.profile,
            action: input.action,
            code: error.code,
          },
          this.now(),
        );
      }
      throw error;
    }
    return {
      managed: true,
      targetId: context.manifestTarget.targetId,
      manifestSha256: context.loaded.sha256,
      campaignId: context.loaded.manifest.campaignId,
      platform: context.target.platform,
      action: input.action,
      receiptSha256: sha256(input.receipt),
    };
  }

  recordResult(authorization: CampaignAuthorization, resultReference: string): void {
    if (!authorization.managed) return;
    if (
      !authorization.targetId ||
      !authorization.manifestSha256 ||
      !authorization.campaignId ||
      !authorization.platform ||
      !authorization.action ||
      !authorization.receiptSha256 ||
      !resultReference
    ) {
      throw new AdapterError(
        ErrorCode.CAMPAIGN_STATE_UNKNOWN,
        "managed adapter result is missing receipt lifecycle context",
        { unknown: true, reconcileRequired: true },
      );
    }
    try {
      new ReceiptLedger(this.ledgerPath).recordAdapterResult(
        {
          receiptSha256: authorization.receiptSha256,
          manifestSha256: authorization.manifestSha256,
          campaignId: authorization.campaignId,
          targetId: authorization.targetId,
          platform: authorization.platform,
          action: authorization.action,
          resultReferenceSha256: sha256(resultReference),
        },
        this.now(),
      );
    } catch {
      throw new AdapterError(
        ErrorCode.CAMPAIGN_STATE_UNKNOWN,
        "public mutation completed but campaign result audit is uncertain",
        { unknown: true, reconcileRequired: true },
      );
    }
  }

  private resolveManaged(
    input: Pick<
      CampaignMutationInput,
      "platform" | "profile" | "destination" | "manifestPath" | "campaignTargetId" | "action"
    >,
    requireManifest: boolean,
  ): ManagedContext | undefined {
    const registry = ManagedTargetRegistry.load({ policyDir: this.policyDir });
    const target = registry.match(input);
    if (!target) return undefined;
    if (requireManifest && !input.manifestPath) {
      throw new AdapterError(
        ErrorCode.CAMPAIGN_MANIFEST_REQUIRED,
        "managed mutation requires a campaign manifest",
      );
    }
    const loaded = this.loadManifest(input.manifestPath!, this.campaignRoots);
    if (!input.campaignTargetId) {
      throw new AdapterError(
        ErrorCode.CAMPAIGN_TARGET_MISMATCH,
        "managed mutation requires an explicit campaign target ID",
      );
    }
    const pairAllowed = target.allowedPolicies.some(
      (entry) =>
        entry.contentKind === loaded.manifest.contentKind &&
        entry.policy === loaded.manifest.policy,
    );
    if (!pairAllowed) {
      throw new AdapterError(
        ErrorCode.CAMPAIGN_POLICY_UNKNOWN,
        "campaign policy is not allowed for this managed target",
      );
    }
    const manifestTarget = loaded.manifest.targets.find(
      (entry) =>
        entry.targetId === input.campaignTargetId &&
        entry.managedTargetId === target.targetId &&
        entry.platform === input.platform &&
        entry.profile === input.profile &&
        (input.action === "backlink-deploy" || entry.action === input.action) &&
        canonicalJson(entry.destination ?? null) === canonicalJson(input.destination ?? null),
    );
    if (!manifestTarget) {
      throw new AdapterError(
        ErrorCode.CAMPAIGN_TARGET_MISMATCH,
        "manifest target does not match the managed registry",
      );
    }
    return { target, registry, loaded, manifestTarget };
  }

  private bindingFor(
    context: ManagedContext,
    input: Pick<
      CampaignMutationInput,
      "action" | "subjectUrl" | "subjectIdentity" | "existingText" | "text" | "mediaPaths"
    >,
  ): ReceiptBinding {
    const { manifestTarget } = context;
    const textSha256 = input.text === undefined ? undefined : sha256(input.text);
    if (manifestTarget.action === "retain" && input.action !== "backlink-deploy") {
      throw new AdapterError(
        ErrorCode.CAMPAIGN_TARGET_MISMATCH,
        "retained campaign state cannot authorize a public mutation",
      );
    }
    const expectedTextSha256 =
      input.action === "backlink-deploy"
        ? undefined
        : input.action === "delete"
          ? manifestTarget.existingState?.expectedContentSha256
          : manifestTarget.copySha256;
    if (expectedTextSha256 && textSha256 !== expectedTextSha256) {
      throw new AdapterError(
        ErrorCode.CAMPAIGN_ASSET_MISMATCH,
        "mutation text hash differs from the campaign manifest",
      );
    }
    if (expectedTextSha256 && !textSha256) {
      throw new AdapterError(ErrorCode.CAMPAIGN_EVIDENCE_MISSING, "mutation text is missing");
    }
    const subjectUrlSha256 = this.subjectBinding(context, input);
    let subjectIdentitySha256: string | undefined;
    if (input.action === "edit" && manifestTarget.parentTargetId) {
      if (
        typeof input.subjectIdentity !== "string" ||
        input.subjectIdentity !== manifestTarget.existingState?.identity
      ) {
        throw new AdapterError(
          ErrorCode.CAMPAIGN_TARGET_MISMATCH,
          "comment identity does not match current campaign evidence",
        );
      }
      subjectIdentitySha256 = sha256(input.subjectIdentity);
    } else if (input.subjectIdentity !== undefined) {
      throw new AdapterError(
        ErrorCode.CAMPAIGN_TARGET_MISMATCH,
        "this campaign action does not accept a subject identity",
      );
    }
    const existingTextSha256 =
      input.existingText === undefined ? undefined : sha256(input.existingText);
    if (input.action === "edit") {
      const expectedExisting = manifestTarget.existingState?.expectedContentSha256;
      if (!expectedExisting || existingTextSha256 !== expectedExisting) {
        throw new AdapterError(
          ErrorCode.CAMPAIGN_ASSET_MISMATCH,
          "edit existing-content oracle differs from campaign evidence",
        );
      }
    } else if (input.existingText !== undefined) {
      throw new AdapterError(
        ErrorCode.CAMPAIGN_TARGET_MISMATCH,
        "this campaign action does not accept an existing-content oracle",
      );
    }
    const needsMedia =
      input.action === "publish" ||
      (input.action === "edit" && manifestTarget.requiredMediaRole !== "none");
    let mediaSha256: string | undefined;
    if (needsMedia) {
      if (input.mediaPaths.length !== 1) {
        throw new AdapterError(
          ErrorCode.CAMPAIGN_MEDIA_POLICY,
          "canonical article mutation requires exactly one media asset",
        );
      }
      mediaSha256 = this.artifactSha256(input.mediaPaths[0]!, context.loaded);
      if (mediaSha256 !== manifestTarget.assetSha256) {
        throw new AdapterError(
          ErrorCode.CAMPAIGN_ASSET_MISMATCH,
          "mutation media hash differs from the campaign manifest",
        );
      }
    } else if (input.mediaPaths.length > 0) {
      throw new AdapterError(
        ErrorCode.CAMPAIGN_MEDIA_POLICY,
        "this campaign action does not accept media",
      );
    }
    return {
      manifestSha256: context.loaded.sha256,
      campaignId: context.loaded.manifest.campaignId,
      targetId: manifestTarget.targetId,
      platform: context.target.platform,
      profile: context.target.profile,
      ...(context.target.destination ? { destination: context.target.destination } : {}),
      action: input.action,
      ...(subjectUrlSha256 ? { subjectUrlSha256 } : {}),
      ...(subjectIdentitySha256 ? { subjectIdentitySha256 } : {}),
      ...(existingTextSha256 ? { existingTextSha256 } : {}),
      ...(textSha256 ? { textSha256 } : {}),
      ...(mediaSha256 ? { mediaSha256 } : {}),
      policy: context.loaded.manifest.policy,
      policyVersion: 1,
    };
  }

  private subjectBinding(
    context: ManagedContext,
    input: Pick<CampaignMutationInput, "action" | "subjectUrl">,
  ): string | undefined {
    const { manifestTarget, loaded } = context;
    let expected: string | undefined;
    if (input.action === "comment" || (input.action === "edit" && manifestTarget.parentTargetId)) {
      const parent = loaded.manifest.backlinks?.find(
        (entry) => entry.targetId === manifestTarget.parentTargetId,
      );
      if (!parent || Date.parse(parent.verifiedAt) < this.now().getTime() - 30 * 60_000) {
        throw new AdapterError(
          ErrorCode.CAMPAIGN_BACKLINKS_NOT_READY,
          "comment parent does not have current verified result evidence",
        );
      }
      expected = parent.canonicalUrl;
    } else if (input.action === "edit" || input.action === "delete") {
      expected = manifestTarget.existingState?.canonicalUrl;
      if (!expected) {
        throw new AdapterError(
          ErrorCode.CAMPAIGN_EVIDENCE_MISSING,
          "existing-state canonical URL is required for this mutation",
        );
      }
    }
    if (expected !== input.subjectUrl) {
      throw new AdapterError(
        ErrorCode.CAMPAIGN_TARGET_MISMATCH,
        "mutation subject URL does not match campaign evidence",
      );
    }
    if (!expected && input.subjectUrl) {
      throw new AdapterError(
        ErrorCode.CAMPAIGN_TARGET_MISMATCH,
        "this campaign action does not accept a subject URL",
      );
    }
    return expected ? sha256(expected) : undefined;
  }

  private hashArtifact(path: string, loaded: LoadedCampaignManifest): string {
    const candidate = resolve(dirname(loaded.path), path);
    const info = lstatSync(candidate);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new AdapterError(
        ErrorCode.CAMPAIGN_MANIFEST_INVALID,
        "campaign artifact must be a regular non-symlink file",
      );
    }
    const actual = assertWithinRoots(candidate, this.campaignRoots, "/artifact");
    return sha256(readFileSync(actual));
  }

  private async buildEvidence(loaded: LoadedCampaignManifest) {
    const manifest = loaded.manifest;
    const urls = [
      manifest.website.ru.url,
      manifest.website.en.url,
      manifest.audio.ru.url,
      manifest.audio.en.url,
    ];
    const evidence = new Map<string, UrlEvidence>();
    await Promise.all(
      urls.map(async (url) => {
        try {
          const response = await this.fetchImpl(url, {
            redirect: "follow",
            signal: AbortSignal.timeout(this.evidenceTimeoutMs),
          });
          const bytes = await readLimitedResponse(response, this.maxEvidenceBytes);
          const item: UrlEvidence = { status: response.status };
          if (url === manifest.audio.ru.url || url === manifest.audio.en.url) {
            item.sha256 = sha256(bytes);
          } else {
            const html = bytes.toString("utf8");
            const expected =
              url === manifest.website.ru.url
                ? manifest.website.ru.titleSha256
                : manifest.website.en.titleSha256;
            item.titleSha256 = titleDigest(html, expected);
          }
          evidence.set(url, item);
        } catch {
          evidence.set(url, { status: 0 });
        }
      }),
    );
    return {
      now: this.now(),
      statFile: (path: string) => {
        try {
          const candidate = resolve(dirname(loaded.path), path);
          const info = lstatSync(candidate);
          if (!info.isFile() || info.isSymbolicLink()) return undefined;
          const actual = assertWithinRoots(candidate, this.campaignRoots, "/artifact");
          const bytes = readFileSync(actual);
          return {
            sha256: sha256(bytes),
            size: bytes.length,
            ...(bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
              ? { mime: "image/jpeg" }
              : {}),
            text: bytes.toString("utf8"),
          };
        } catch {
          return undefined;
        }
      },
      probeUrl: (url: string) => evidence.get(url),
    };
  }
}

function validateManifestRegistryBindings(context: ManagedContext): CampaignFinding[] {
  const findings: CampaignFinding[] = [];
  for (let index = 0; index < context.loaded.manifest.targets.length; index++) {
    const campaignTarget = context.loaded.manifest.targets[index]!;
    const managed = context.registry.targets.find(
      (candidate) => candidate.targetId === campaignTarget.managedTargetId,
    );
    const policyAllowed = managed?.allowedPolicies.some(
      (entry) =>
        entry.contentKind === context.loaded.manifest.contentKind &&
        entry.policy === context.loaded.manifest.policy,
    );
    if (
      !managed?.enforced ||
      !policyAllowed ||
      managed.platform !== campaignTarget.platform ||
      managed.profile !== campaignTarget.profile ||
      canonicalJson(managed.destination ?? null) !==
        canonicalJson(campaignTarget.destination ?? null)
    ) {
      findings.push({
        code: ErrorCode.CAMPAIGN_TARGET_MISMATCH,
        pointer: `/targets/${index}/managedTargetId`,
        message: "campaign target is not bound to an enforced managed registry destination",
      });
    }
  }
  return findings;
}

async function readLimitedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("campaign evidence response exceeds size limit");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("campaign evidence response exceeds size limit");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function configuredCampaignRoots(): string[] {
  const value = process.env["ARCANADA_PUBLISHER_CAMPAIGN_ROOTS"];
  return value ? value.split(delimiter).filter(Boolean) : [];
}

function titleDigest(html: string, expected: string): string {
  const candidates = [/<h1\b[^>]*>([\s\S]*?)<\/h1>/i, /<title\b[^>]*>([\s\S]*?)<\/title>/i]
    .map((pattern) => pattern.exec(html)?.[1])
    .filter((value): value is string => value !== undefined)
    .map((value) =>
      sha256(
        decodeHtml(value.replace(/<[^>]+>/g, " "))
          .replace(/\s+/g, " ")
          .trim(),
      ),
    );
  return candidates.find((digest) => digest === expected) ?? candidates[0] ?? sha256("");
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function findingsError(findings: CampaignFinding[]): AdapterError {
  const first = findings[0]!;
  return new AdapterError(
    first.code,
    `campaign preflight failed at ${first.pointer}: ${first.message}`,
    {
      findings: findings.map(({ code, pointer, message }) => ({ code, pointer, message })),
    },
  );
}
