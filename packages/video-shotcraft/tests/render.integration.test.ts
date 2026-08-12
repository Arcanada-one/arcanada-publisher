// Render integration (V-AC-1 / V-AC-3 / V-AC-4): a real headless Ink Press render
// → non-empty MP4 → ffprobe self-assertion 1920x1080 / ~30fps / h264.
//
// HARNESS-FIRST: this test spawns a Remotion headless-Chromium render + ffmpeg,
// so it is opt-in — gated behind SHOTCRAFT_RENDER_TEST=1 AND ffmpeg present. A
// normal `pnpm test` (and CI without the render runtime) skips it rather than
// silently passing. Provision the runtime, then:
//   SHOTCRAFT_RENDER_TEST=1 pnpm --filter @arcanada/publisher-shotcraft test

import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, "fixtures");

function ffprobeBin(): string | undefined {
  try {
    return execFileSync("which", ["ffprobe"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

const RENDER_ENABLED = process.env.SHOTCRAFT_RENDER_TEST === "1" && ffprobeBin() !== undefined;
const describeRender = RENDER_ENABLED ? describe : describe.skip;

describe("render harness guard", () => {
  it("is opt-in (SHOTCRAFT_RENDER_TEST=1 + ffprobe present)", () => {
    if (!RENDER_ENABLED) {
      process.stderr.write(
        "SKIP: shotcraft render integration — set SHOTCRAFT_RENDER_TEST=1 with ffmpeg in PATH\n",
      );
    }
    expect(true).toBe(true);
  });
});

describeRender("renderCinematic → 1920x1080/~30/h264 MP4", () => {
  let outPath: string;
  let result: { out: string; durationSec: number; hasAudio: boolean };

  beforeAll(async () => {
    const { renderCinematic } = await import("../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "sc-render-"));
    outPath = join(dir, "cinematic.mp4");
    result = await renderCinematic({
      textFile: join(FIX, "post.txt"),
      assets: [join(FIX, "cover.png")],
      out: outPath,
      shots: ["brand-ink-open"],
    });
  }, 600_000);

  it("produces a non-empty MP4", () => {
    expect(existsSync(outPath)).toBe(true);
    expect(statSync(outPath).size).toBeGreaterThan(0);
    expect(result.out).toBe(outPath);
  });

  it("output is 1920x1080 / ~30fps / h264 (ffprobe)", () => {
    const bin = ffprobeBin()!;
    const out = execFileSync(
      bin,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,codec_name,avg_frame_rate",
        "-of",
        "json",
        outPath,
      ],
      { encoding: "utf8" },
    );
    const s = JSON.parse(out).streams[0];
    expect(s.width).toBe(1920);
    expect(s.height).toBe(1080);
    expect(String(s.codec_name)).toContain("264");
    const [n, d] = String(s.avg_frame_rate).split("/").map(Number);
    expect(Math.abs(n / d - 30)).toBeLessThanOrEqual(1);
  });
});
