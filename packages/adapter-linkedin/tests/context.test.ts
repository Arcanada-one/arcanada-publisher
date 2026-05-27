import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveArtifactsDir, artifactFilename } from "../src/context.js";

describe("context — helpers (pure functions)", () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "pub-0004-context-"));
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("resolveArtifactsDir creates the directory when missing", () => {
    const target = join(scratch, "nested", "artifacts");
    expect(existsSync(target)).toBe(false);
    const out = resolveArtifactsDir(target);
    expect(out).toBe(target);
    expect(existsSync(target)).toBe(true);
    expect(statSync(target).isDirectory()).toBe(true);
  });

  it("resolveArtifactsDir is idempotent on an existing directory", () => {
    const target = join(scratch, "preexisting");
    resolveArtifactsDir(target);
    const second = resolveArtifactsDir(target);
    expect(second).toBe(target);
    expect(existsSync(target)).toBe(true);
  });

  it("artifactFilename composes a sortable timestamp + stage + extension", () => {
    const a = artifactFilename("publish-step", "png");
    expect(a).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-publish-step\.png$/);
    const b = artifactFilename("INFRA-0259 shadow intercept", "txt");
    expect(b).toMatch(/-INFRA-0259-shadow-intercept\.txt$/);
  });
});
