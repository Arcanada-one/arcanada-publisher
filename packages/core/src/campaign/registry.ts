import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AdapterError, ErrorCode } from "../errors.js";
import type { Platform } from "../platform.js";
import {
  ManagedTargetRegistrySchema,
  assertOwnerOnlyRegularFile,
  assertOwnerOnlyDirectory,
  canonicalJson,
  type CampaignDestination,
  type ManagedTarget,
} from "./types.js";

export interface RegistryLoadOptions {
  policyDir: string;
}

export interface ManagedTargetRequest {
  platform: Platform;
  profile: string;
  destination?: CampaignDestination | undefined;
}

export class ManagedTargetRegistry {
  readonly enrolled: boolean;
  readonly targets: readonly ManagedTarget[];

  private constructor(enrolled: boolean, targets: readonly ManagedTarget[]) {
    this.enrolled = enrolled;
    this.targets = targets;
  }

  static load(options: RegistryLoadOptions): ManagedTargetRegistry {
    const markerPath = join(options.policyDir, "managed-mode");
    const registryPath = join(options.policyDir, "managed-targets.json");
    const markerExists = existsSync(markerPath);
    const registryExists = existsSync(registryPath);
    if (!markerExists && !registryExists) return new ManagedTargetRegistry(false, []);
    if (!markerExists || !registryExists) {
      throw invalidRegistry("managed enrollment requires both marker and registry");
    }
    assertOwnerOnlyDirectory(options.policyDir, "/policy");
    assertOwnerOnlyRegularFile(markerPath, "/managed-mode");
    assertOwnerOnlyRegularFile(registryPath, "/managed-targets.json");
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(registryPath, "utf8"));
    } catch {
      throw invalidRegistry("registry is not valid JSON");
    }
    const parsed = ManagedTargetRegistrySchema.safeParse(raw);
    if (!parsed.success)
      throw invalidRegistry(parsed.error.issues[0]?.message ?? "invalid registry");
    const matchKeys = new Set<string>();
    const targetIds = new Set<string>();
    for (const target of parsed.data.targets) {
      if (targetIds.has(target.targetId)) throw invalidRegistry("duplicate targetId");
      targetIds.add(target.targetId);
      const key = matchKey(target);
      if (matchKeys.has(key)) throw invalidRegistry("duplicate managed target match key");
      matchKeys.add(key);
    }
    return new ManagedTargetRegistry(true, parsed.data.targets);
  }

  match(request: ManagedTargetRequest): ManagedTarget | undefined {
    const key = matchKey(request);
    return this.targets.find((target) => target.enforced && matchKey(target) === key);
  }
}

function matchKey(value: ManagedTargetRequest): string {
  return `${value.platform}\0${value.profile}\0${canonicalJson(value.destination ?? null)}`;
}

function invalidRegistry(reason: string): AdapterError {
  return new AdapterError(
    ErrorCode.CAMPAIGN_MANIFEST_INVALID,
    `managed target registry invalid: ${reason}`,
    {
      pointer: "/managed-targets.json",
      reason,
    },
  );
}
