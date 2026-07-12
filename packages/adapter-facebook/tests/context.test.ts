import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveArtifactsDir,
  artifactFilename,
  screenshotOnFail,
  withScreenshotOnFail,
} from "../src/context.js";

describe("context — helpers (Class B pure functions)", () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "pub-0003-context-"));
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
    expect(statSync(target).mode & 0o777).toBe(0o700);
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
    const b = artifactFilename("negative parent_id", "txt");
    expect(b).toMatch(/-negative-parent-id\.txt$/);
  });

  it("stores screenshots as 0600 and exposes only artifact id", async () => {
    const page = {
      isClosed: () => false,
      screenshot: async ({ path }: { path: string }) => writeFileSync(path, "png"),
    } as never;
    const shot = await screenshotOnFail(page, "secret-stage", scratch);
    expect(shot).not.toBeNull();
    expect(statSync(shot!).mode & 0o777).toBe(0o600);

    let error: unknown;
    try {
      await withScreenshotOnFail(
        page,
        "private-stage",
        async () => {
          throw new Error("/private/secret/cause.txt");
        },
        scratch,
      );
    } catch (caught) {
      error = caught;
    }
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain("/private/secret");
    expect(serialized).not.toContain(scratch);
    expect(serialized).toContain("artifactId");
  });
});
