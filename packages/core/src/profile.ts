import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AdapterError, ErrorCode } from "./errors.js";
import type { Platform } from "./platform.js";

const PROFILE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export interface ProfileManagerOptions {
  root?: string;
}

export class ProfileManager {
  readonly root: string;

  constructor(options: ProfileManagerOptions = {}) {
    this.root =
      options.root ??
      process.env["ARCANADA_PUBLISHER_PROFILES_ROOT"] ??
      join(homedir(), ".arcanada-publisher", "profiles");
  }

  getProfilePath(platform: Platform, name: string): string {
    this.assertValidName(name);
    return join(this.root, platform, name);
  }

  exists(platform: Platform, name: string): boolean {
    return existsSync(this.getProfilePath(platform, name));
  }

  ensureProfileExists(platform: Platform, name: string): string {
    const path = this.getProfilePath(platform, name);
    if (!existsSync(path)) {
      throw new AdapterError(
        ErrorCode.NO_PROFILE,
        `profile '${name}' for platform '${platform}' does not exist; run 'arcanada-publisher login --platform ${platform} --profile ${name}' first`,
        { platform, name, path },
      );
    }
    return path;
  }

  createEmptyProfile(platform: Platform, name: string): string {
    const path = this.getProfilePath(platform, name);
    mkdirSync(path, { recursive: true });
    chmodSync(path, 0o700);
    return path;
  }

  private assertValidName(name: string): void {
    if (!PROFILE_NAME_PATTERN.test(name)) {
      throw new AdapterError(
        ErrorCode.INVALID_ARGS,
        `invalid profile name '${name}'; must match ${PROFILE_NAME_PATTERN.source}`,
        { name },
      );
    }
  }
}
