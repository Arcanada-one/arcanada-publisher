// T4, T5, T6: Real-ffmpeg integration tests.
// Guards: if ffmpeg is absent, tests are skipped (not silently passed).
// Uses the small fixtures in tests/fixtures/.

import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "fixtures");
const COVER = join(FIXTURE_DIR, "cover.jpg");
const AUDIO = join(FIXTURE_DIR, "audio.mp3");

// Detect ffmpeg availability
function findFfmpeg(): string | undefined {
  try {
    const out = execFileSync("which", ["ffmpeg"], { encoding: "utf8" });
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

function findFfprobe(): string | undefined {
  try {
    const out = execFileSync("which", ["ffprobe"], { encoding: "utf8" });
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

const ffmpegBin = findFfmpeg();
const ffprobeBin = findFfprobe();
const FFMPEG_AVAILABLE = ffmpegBin !== undefined && ffprobeBin !== undefined;

function probeFile(filePath: string): { hasVideo: boolean; hasAudio: boolean; duration: number } {
  if (!ffprobeBin) throw new Error("ffprobe not found");
  const out = execFileSync(
    ffprobeBin,
    ["-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "flat", filePath],
    { encoding: "utf8" },
  );
  return {
    // ffprobe -of flat quotes values: codec_type="video"
    hasVideo: out.includes('codec_type="video"'),
    hasAudio: out.includes('codec_type="audio"'),
    duration: parseFloat(/format\.duration="?([0-9.]+)"?/.exec(out)?.[1] ?? "0"),
  };
}

// Skip all integration tests if ffmpeg is not available
const describeIntegration = FFMPEG_AVAILABLE ? describe : describe.skip;

describe("ffmpeg guard", () => {
  it("ffmpeg is present at the expected path (skip message if not)", () => {
    if (!FFMPEG_AVAILABLE) {
      process.stderr.write("SKIP: ffmpeg not found in PATH — integration tests skipped\n");
    }
    // Always passes — the guard is informational
    expect(true).toBe(true);
  });
});

describeIntegration("T4: cover + audio → video + audio stream, duration ≈ audio", () => {
  let outPath: string;

  beforeAll(async () => {
    const { generateVideo } = await import("../src/index.js");
    const outDir = join(tmpdir(), `pub-integ-${Date.now()}`);
    mkdirSync(outDir, { recursive: true });
    outPath = join(outDir, "out-with-audio.mp4");
    await generateVideo({ cover: COVER, audio: AUDIO, out: outPath, preset: "zoompan" });
  }, 120_000);

  it("output file exists and is non-empty", () => {
    expect(existsSync(outPath)).toBe(true);
    expect(statSync(outPath).size).toBeGreaterThan(0);
  });

  it("has video stream", () => {
    const p = probeFile(outPath);
    expect(p.hasVideo).toBe(true);
  });

  it("has audio stream", () => {
    const p = probeFile(outPath);
    expect(p.hasAudio).toBe(true);
  });

  it("duration is within ±1s of audio fixture duration", async () => {
    // Probe audio fixture duration
    const audioDuration = parseFloat(
      execFileSync(
        ffprobeBin!,
        ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", AUDIO],
        { encoding: "utf8" },
      ).trim(),
    );
    const p = probeFile(outPath);
    expect(p.duration).toBeGreaterThan(audioDuration - 1);
    expect(p.duration).toBeLessThan(audioDuration + 1);
  });
});

describeIntegration("T5: cover-only → video only, duration ≈ 30s, no audio stream", () => {
  let outPath: string;

  beforeAll(async () => {
    const { generateVideo } = await import("../src/index.js");
    const outDir = join(tmpdir(), `pub-integ-co-${Date.now()}`);
    mkdirSync(outDir, { recursive: true });
    outPath = join(outDir, "out-cover-only.mp4");
    await generateVideo({ cover: COVER, out: outPath, preset: "zoompan", coverOnlySeconds: 5 });
  }, 60_000);

  it("output file exists and is non-empty", () => {
    expect(existsSync(outPath)).toBe(true);
    expect(statSync(outPath).size).toBeGreaterThan(0);
  });

  it("has video stream", () => {
    const p = probeFile(outPath);
    expect(p.hasVideo).toBe(true);
  });

  it("has NO audio stream", () => {
    const p = probeFile(outPath);
    expect(p.hasAudio).toBe(false);
  });

  it("duration is ≈ 5s (coverOnlySeconds=5, ±2s)", () => {
    const p = probeFile(outPath);
    expect(p.duration).toBeGreaterThan(3);
    expect(p.duration).toBeLessThan(7);
  });
});

describeIntegration("T6: smoke per preset — each renders a valid MP4", () => {
  const presets = ["zoompan", "cqt", "cycle"];

  for (const preset of presets) {
    it(`preset '${preset}' renders exit-0, non-empty MP4`, async () => {
      const { generateVideo } = await import("../src/index.js");
      const outDir = join(tmpdir(), `pub-smoke-${preset}-${Date.now()}`);
      mkdirSync(outDir, { recursive: true });
      const outPath = join(outDir, `${preset}.mp4`);
      const result = await generateVideo({
        cover: COVER,
        audio: AUDIO,
        out: outPath,
        preset,
        seed: 42,
      });
      expect(result.out).toBe(outPath);
      expect(existsSync(outPath)).toBe(true);
      expect(statSync(outPath).size).toBeGreaterThan(0);
      const p = probeFile(outPath);
      expect(p.hasVideo).toBe(true);
    }, 300_000); // cycle can take a while
  }
});
