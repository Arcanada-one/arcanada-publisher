import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "../src/profile.js";
import { AdapterError, ErrorCode } from "../src/errors.js";

describe("ProfileManager", () => {
  let root: string;
  let mgr: ProfileManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "arc-pub-profile-"));
    mgr = new ProfileManager({ root });
  });

  it("computes deterministic path under platform/name", () => {
    const p = mgr.getProfilePath("facebook", "pavel-personal");
    expect(p).toBe(join(root, "facebook", "pavel-personal"));
  });

  it("falls back to env override when no root option provided", () => {
    const prev = process.env["ARCANADA_PUBLISHER_PROFILES_ROOT"];
    process.env["ARCANADA_PUBLISHER_PROFILES_ROOT"] = "/tmp/custom-root";
    try {
      const m = new ProfileManager();
      expect(m.root).toBe("/tmp/custom-root");
    } finally {
      if (prev === undefined) delete process.env["ARCANADA_PUBLISHER_PROFILES_ROOT"];
      else process.env["ARCANADA_PUBLISHER_PROFILES_ROOT"] = prev;
    }
  });

  it("throws NO_PROFILE when ensureProfileExists called on missing dir", () => {
    let caught: unknown;
    try {
      mgr.ensureProfileExists("linkedin", "absent");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AdapterError);
    expect((caught as AdapterError).code).toBe(ErrorCode.NO_PROFILE);
  });

  it("createEmptyProfile makes dir with 0700 perms", () => {
    const path = mgr.createEmptyProfile("x", "pavel");
    expect(existsSync(path)).toBe(true);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it("rejects invalid profile name with INVALID_ARGS", () => {
    let caught: unknown;
    try {
      mgr.getProfilePath("reddit", "../escape");
    } catch (err) {
      caught = err;
    }
    expect((caught as AdapterError).code).toBe(ErrorCode.INVALID_ARGS);
  });

  it("ensureProfileExists returns path when dir present", () => {
    const created = mgr.createEmptyProfile("vkontakte", "pavel");
    const returned = mgr.ensureProfileExists("vkontakte", "pavel");
    expect(returned).toBe(created);
  });
});
