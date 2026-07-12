import { describe, expect, it } from "vitest";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveArtifactsDir, screenshotOnFail } from "../src/context.js";

describe("X private failure artifacts", () => {
  it("enforces 0700 directory and 0600 screenshot modes", async () => {
    const root = mkdtempSync(join(tmpdir(), "x-artifacts-"));
    const dir = resolveArtifactsDir(join(root, "private"));
    const path = await screenshotOnFail(
      {
        isClosed: () => false,
        screenshot: async ({ path: target }: { path: string }) => writeFileSync(target, "png"),
      } as never,
      "delete",
      dir,
    );
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path!).mode & 0o777).toBe(0o600);
  });
});
