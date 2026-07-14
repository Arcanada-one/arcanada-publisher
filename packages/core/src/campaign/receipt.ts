import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { AdapterError, ErrorCode } from "../errors.js";
import { PLATFORMS } from "../platform.js";
import {
  DestinationSchema,
  SHA256_RE,
  assertOwnerOnlyRegularFile,
  canonicalJson,
  sha256,
  type CampaignDestination,
} from "./types.js";

const RECEIPT_TTL_MS = 15 * 60_000;
const PublicActionSchema = z.enum(["publish", "comment", "edit", "delete", "backlink-deploy"]);
export type CampaignPublicAction = z.infer<typeof PublicActionSchema>;

const ReceiptPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    nonce: z.string().regex(/^[a-f0-9]{32}$/),
    manifestSha256: z.string().regex(SHA256_RE),
    campaignId: z.string().min(1).max(128),
    targetId: z.string().min(1).max(128),
    platform: z.enum(PLATFORMS),
    profile: z.string().min(1).max(64),
    destination: DestinationSchema.optional(),
    action: PublicActionSchema,
    subjectUrlSha256: z.string().regex(SHA256_RE).optional(),
    subjectIdentitySha256: z.string().regex(SHA256_RE).optional(),
    existingTextSha256: z.string().regex(SHA256_RE).optional(),
    textSha256: z.string().regex(SHA256_RE).optional(),
    mediaSha256: z.string().regex(SHA256_RE).optional(),
    issuedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    policy: z.string().min(1).max(128),
    policyVersion: z.number().int().positive(),
  })
  .strict();

const ReceiptEnvelopeSchema = z
  .object({ payload: ReceiptPayloadSchema, signature: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();

export type CampaignReceiptPayload = z.infer<typeof ReceiptPayloadSchema>;
export type CampaignReceiptEnvelope = z.infer<typeof ReceiptEnvelopeSchema>;

export interface ReceiptBinding {
  manifestSha256: string;
  campaignId: string;
  targetId: string;
  platform: CampaignReceiptPayload["platform"];
  profile: string;
  destination?: CampaignDestination | undefined;
  action: CampaignPublicAction;
  subjectUrlSha256?: string | undefined;
  subjectIdentitySha256?: string | undefined;
  existingTextSha256?: string | undefined;
  textSha256?: string | undefined;
  mediaSha256?: string | undefined;
  policy: string;
  policyVersion: number;
}

export interface ReceiptCryptoOptions {
  keyPath: string;
  now?: Date;
  ttlMs?: number;
}

export function issueReceipt(binding: ReceiptBinding, options: ReceiptCryptoOptions): string {
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? RECEIPT_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > RECEIPT_TTL_MS) {
    throw receiptError(ErrorCode.CAMPAIGN_RECEIPT_INVALID, "receipt TTL is invalid");
  }
  const payload = ReceiptPayloadSchema.parse({
    schemaVersion: 1,
    nonce: randomBytes(16).toString("hex"),
    ...binding,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  });
  const signature = sign(payload, readKey(options.keyPath));
  return Buffer.from(JSON.stringify({ payload, signature }), "utf8").toString("base64url");
}

export function parseReceipt(receipt: string): CampaignReceiptEnvelope {
  try {
    const raw = JSON.parse(Buffer.from(receipt, "base64url").toString("utf8"));
    return ReceiptEnvelopeSchema.parse(raw);
  } catch {
    throw receiptError(ErrorCode.CAMPAIGN_RECEIPT_INVALID, "receipt envelope is malformed");
  }
}

export function verifyReceipt(
  receipt: string,
  expected: ReceiptBinding,
  options: ReceiptCryptoOptions,
): CampaignReceiptPayload {
  const envelope = parseReceipt(receipt);
  const expectedSignature = sign(envelope.payload, readKey(options.keyPath));
  const actualBytes = Buffer.from(envelope.signature, "hex");
  const expectedBytes = Buffer.from(expectedSignature, "hex");
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw receiptError(ErrorCode.CAMPAIGN_RECEIPT_INVALID, "receipt signature is invalid");
  }
  const now = (options.now ?? new Date()).getTime();
  const issuedAt = Date.parse(envelope.payload.issuedAt);
  const expiresAt = Date.parse(envelope.payload.expiresAt);
  if (issuedAt > now || now > expiresAt) {
    throw receiptError(ErrorCode.CAMPAIGN_RECEIPT_EXPIRED, "receipt is expired or not yet valid");
  }
  const actualBinding = pickBinding(envelope.payload);
  if (canonicalJson(actualBinding) !== canonicalJson(expected)) {
    throw receiptError(
      ErrorCode.CAMPAIGN_RECEIPT_INVALID,
      "receipt binding does not match the mutation",
    );
  }
  return envelope.payload;
}

export class ReceiptLedger {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  recordIssued(receipt: string, payload: CampaignReceiptPayload, now = new Date()): void {
    this.withLock(() => {
      this.append({
        event: "issued",
        receiptSha256: sha256(receipt),
        manifestSha256: payload.manifestSha256,
        campaignId: payload.campaignId,
        targetId: payload.targetId,
        platform: payload.platform,
        profile: payload.profile,
        action: payload.action,
        issuedAt: now.toISOString(),
        expiresAt: payload.expiresAt,
      });
    });
  }

  recordRejected(
    receipt: string,
    context: {
      manifestSha256: string;
      campaignId: string;
      targetId: string;
      platform: string;
      profile: string;
      action: string;
      code: ErrorCode;
    },
    now = new Date(),
  ): void {
    this.withLock(() => {
      this.append({
        event: "rejected",
        receiptSha256: sha256(receipt),
        ...context,
        rejectedAt: now.toISOString(),
      });
    });
  }

  recordPreflightDenied(
    context: {
      manifestSha256: string;
      campaignId: string;
      targetId: string;
      platform: string;
      profile: string;
      action: string;
      code: ErrorCode;
    },
    now = new Date(),
  ): void {
    this.withLock(() => {
      this.append({ event: "preflight-denied", ...context, deniedAt: now.toISOString() });
    });
  }

  recordAdapterResult(
    context: {
      receiptSha256: string;
      manifestSha256: string;
      campaignId: string;
      targetId: string;
      platform: string;
      action: string;
      resultReferenceSha256: string;
      readBackUrlSha256: string;
      readBackStatus: number;
      readBackReachable: boolean;
    },
    now = new Date(),
  ): void {
    this.withLock(() => {
      this.append({ event: "verified-result", ...context, recordedAt: now.toISOString() });
    });
  }

  consume(receipt: string, payload: CampaignReceiptPayload, now = new Date()): void {
    this.withLock(() => {
      const receiptSha256 = sha256(receipt);
      const entries = existsSync(this.path)
        ? readFileSync(this.path, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => parseLedgerLine(line))
        : [];
      if (
        entries.some((entry) => entry.event === "consumed" && entry.receiptSha256 === receiptSha256)
      ) {
        throw receiptError(ErrorCode.CAMPAIGN_RECEIPT_REPLAY, "receipt has already been consumed");
      }
      this.append({
        event: "consumed",
        receiptSha256,
        manifestSha256: payload.manifestSha256,
        campaignId: payload.campaignId,
        targetId: payload.targetId,
        platform: payload.platform,
        profile: payload.profile,
        action: payload.action,
        consumedAt: now.toISOString(),
      });
    });
  }

  private withLock(work: () => void): void {
    const parent = dirname(this.path);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    assertOwnerOnlyDirectory(parent);
    const lockPath = `${this.path}.lock`;
    let lockFd: number | undefined;
    try {
      lockFd = openSync(lockPath, "wx", 0o600);
    } catch {
      throw new AdapterError(ErrorCode.CAMPAIGN_STATE_UNKNOWN, "campaign receipt ledger is locked");
    }
    let workError: unknown;
    try {
      work();
    } catch (error) {
      workError = error;
    } finally {
      if (lockFd !== undefined) closeSync(lockFd);
      try {
        unlinkSync(lockPath);
      } catch {
        throw new AdapterError(
          ErrorCode.CAMPAIGN_STATE_UNKNOWN,
          "campaign receipt ledger lock cleanup failed",
        );
      }
    }
    if (workError) throw workError;
  }

  private append(event: Record<string, unknown>): void {
    if (existsSync(this.path)) assertOwnerOnlyRegularFile(this.path, "/receipt-ledger");
    const fd = openSync(this.path, "a", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(event)}\n`, undefined, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

function pickBinding(payload: CampaignReceiptPayload): ReceiptBinding {
  return {
    manifestSha256: payload.manifestSha256,
    campaignId: payload.campaignId,
    targetId: payload.targetId,
    platform: payload.platform,
    profile: payload.profile,
    ...(payload.destination ? { destination: payload.destination } : {}),
    action: payload.action,
    ...(payload.subjectUrlSha256 ? { subjectUrlSha256: payload.subjectUrlSha256 } : {}),
    ...(payload.subjectIdentitySha256
      ? { subjectIdentitySha256: payload.subjectIdentitySha256 }
      : {}),
    ...(payload.existingTextSha256 ? { existingTextSha256: payload.existingTextSha256 } : {}),
    ...(payload.textSha256 ? { textSha256: payload.textSha256 } : {}),
    ...(payload.mediaSha256 ? { mediaSha256: payload.mediaSha256 } : {}),
    policy: payload.policy,
    policyVersion: payload.policyVersion,
  };
}

function readKey(path: string): Buffer {
  assertOwnerOnlyRegularFile(path, "/receipt.key");
  const key = readFileSync(path);
  if (key.length < 32) {
    throw receiptError(ErrorCode.CAMPAIGN_RECEIPT_INVALID, "receipt signing key is too short");
  }
  return key;
}

function sign(payload: CampaignReceiptPayload, key: Buffer): string {
  return createHmac("sha256", key).update(canonicalJson(payload)).digest("hex");
}

function parseLedgerLine(line: string): { event: string; receiptSha256?: string } {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    const receiptEvent =
      value.event === "issued" ||
      value.event === "consumed" ||
      value.event === "rejected" ||
      value.event === "verified-result";
    if (
      (!receiptEvent && value.event !== "preflight-denied") ||
      (receiptEvent &&
        (typeof value.receiptSha256 !== "string" || !SHA256_RE.test(value.receiptSha256)))
    ) {
      throw new Error("invalid digest");
    }
    return {
      event: value.event as string,
      ...(typeof value.receiptSha256 === "string" ? { receiptSha256: value.receiptSha256 } : {}),
    };
  } catch {
    throw new AdapterError(ErrorCode.CAMPAIGN_STATE_UNKNOWN, "campaign receipt ledger is invalid");
  }
}

function assertOwnerOnlyDirectory(path: string): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new AdapterError(
      ErrorCode.CAMPAIGN_STATE_UNKNOWN,
      "campaign audit directory must be owner-only",
    );
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new AdapterError(
      ErrorCode.CAMPAIGN_STATE_UNKNOWN,
      "campaign audit directory owner mismatch",
    );
  }
}

function receiptError(code: ErrorCode, message: string): AdapterError {
  return new AdapterError(code, message);
}
