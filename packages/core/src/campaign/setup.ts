import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { AdapterError, ErrorCode } from "../errors.js";
import { ManagedTargetRegistry } from "./registry.js";
import { assertOwnerOnlyRegularFile } from "./types.js";

export interface CampaignPolicySetupOptions {
  policyDir: string;
  auditPath: string;
  now?: Date;
}

export interface CampaignPolicyDeenrollOptions extends CampaignPolicySetupOptions {
  confirmed: boolean;
}

export function setupCampaignPolicy(options: CampaignPolicySetupOptions): { enrolled: true } {
  if (!existsSync(options.policyDir))
    mkdirSync(options.policyDir, { recursive: true, mode: 0o700 });
  assertOwnerOnlyDirectory(options.policyDir, ErrorCode.CAMPAIGN_MANIFEST_INVALID);

  const markerPath = join(options.policyDir, "managed-mode");
  const registryPath = join(options.policyDir, "managed-targets.json");
  const keyPath = join(options.policyDir, "receipt.key");
  const enrollmentExists =
    existsSync(markerPath) || existsSync(registryPath) || existsSync(keyPath);
  if (!enrollmentExists) {
    createExclusive(markerPath, Buffer.from("enabled\n", "utf8"));
    createExclusive(
      registryPath,
      Buffer.from(`${JSON.stringify({ schemaVersion: 1, targets: [] }, null, 2)}\n`, "utf8"),
    );
    createExclusive(keyPath, randomBytes(32));
  } else {
    if (!existsSync(markerPath) || !existsSync(registryPath) || !existsSync(keyPath)) {
      throw new AdapterError(
        ErrorCode.CAMPAIGN_MANIFEST_INVALID,
        "partial managed enrollment must be repaired explicitly; setup will not rotate or erase policy",
      );
    }
    assertOwnerOnlyRegularFile(keyPath, "/receipt.key");
    if (readFileSync(keyPath).length < 32) {
      throw new AdapterError(ErrorCode.CAMPAIGN_MANIFEST_INVALID, "receipt key is too short");
    }
  }
  ManagedTargetRegistry.load({ policyDir: options.policyDir });
  appendPolicyAudit(options.auditPath, {
    event: enrollmentExists ? "enrollment-verified" : "enrolled",
    at: (options.now ?? new Date()).toISOString(),
  });
  return { enrolled: true };
}

export function deEnrollCampaignPolicy(options: CampaignPolicyDeenrollOptions): {
  enrolled: false;
  archiveDir: string;
} {
  if (!options.confirmed) {
    throw new AdapterError(
      ErrorCode.CAMPAIGN_RECEIPT_REQUIRED,
      "managed de-enrollment requires explicit confirmation",
    );
  }
  assertOwnerOnlyDirectory(options.policyDir, ErrorCode.CAMPAIGN_MANIFEST_INVALID);
  const registry = ManagedTargetRegistry.load({ policyDir: options.policyDir });
  if (!registry.enrolled) {
    throw new AdapterError(ErrorCode.CAMPAIGN_STATE_UNKNOWN, "installation is not enrolled");
  }
  const keyPath = join(options.policyDir, "receipt.key");
  assertOwnerOnlyRegularFile(keyPath, "/receipt.key");
  const now = options.now ?? new Date();
  appendPolicyAudit(options.auditPath, { event: "deenroll-started", at: now.toISOString() });
  const archiveParent = join(options.policyDir, "de-enrolled");
  if (!existsSync(archiveParent)) mkdirSync(archiveParent, { mode: 0o700 });
  assertOwnerOnlyDirectory(archiveParent, ErrorCode.CAMPAIGN_STATE_UNKNOWN);
  const archiveDir = join(
    archiveParent,
    `${now.toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`,
  );
  mkdirSync(archiveDir, { mode: 0o700 });
  for (const name of ["managed-mode", "managed-targets.json", "receipt.key"]) {
    renameSync(join(options.policyDir, name), join(archiveDir, name));
  }
  appendPolicyAudit(options.auditPath, {
    event: "de-enrolled",
    at: now.toISOString(),
    archiveId: basename(archiveDir),
  });
  return { enrolled: false, archiveDir };
}

function createExclusive(path: string, bytes: Buffer): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function appendPolicyAudit(path: string, event: Record<string, unknown>): void {
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertOwnerOnlyDirectory(parent, ErrorCode.CAMPAIGN_STATE_UNKNOWN);
  if (existsSync(path)) assertOwnerOnlyRegularFile(path, "/campaign-policy-audit");
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(event)}\n`, undefined, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function assertOwnerOnlyDirectory(path: string, code: ErrorCode): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new AdapterError(code, "campaign policy directory must be owner-only and non-symlink");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new AdapterError(code, "campaign policy directory owner mismatch");
  }
}
