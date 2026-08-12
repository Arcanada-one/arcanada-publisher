// ffprobe self-assertion helpers (DESIGN §2 self-probe). Reads the produced MP4
// and reports dimensions / fps / codecs / duration so renderCinematic can assert
// the output conforms to the RenderFormat (V-AC-4). Spawned as an arg-array
// (shell:false); the path is a validated, engine-produced output.

import { execFileSync } from "node:child_process";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";

export interface ProbeResult {
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  audioCodec: string | undefined;
  hasAudio: boolean;
  durationSec: number;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
}

function parseFps(rate: string | undefined): number {
  if (!rate) return 0;
  const [num, den] = rate.split("/");
  const n = Number.parseFloat(num ?? "0");
  const d = Number.parseFloat(den ?? "1");
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0;
  return n / d;
}

/** Probe a media file with ffprobe (JSON output) and return normalised metadata. */
export function probeVideo(ffprobe: string, filePath: string): ProbeResult {
  let out: string;
  try {
    out = execFileSync(
      ffprobe,
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate:format=duration",
        "-of",
        "json",
        filePath,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      `shotcraft: ffprobe failed on '${filePath}': ${message}`,
    );
  }

  const parsed = JSON.parse(out) as {
    streams?: FfprobeStream[];
    format?: { duration?: string };
  };
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  if (video === undefined) {
    throw new AdapterError(
      ErrorCode.INTERNAL_PANIC,
      `shotcraft: produced file has no video stream: ${filePath}`,
    );
  }

  const fpsRaw =
    video.avg_frame_rate && video.avg_frame_rate !== "0/0"
      ? video.avg_frame_rate
      : video.r_frame_rate;

  return {
    width: video.width ?? 0,
    height: video.height ?? 0,
    fps: parseFps(fpsRaw),
    videoCodec: video.codec_name ?? "",
    audioCodec: audio?.codec_name,
    hasAudio: audio !== undefined,
    durationSec: Number.parseFloat(parsed.format?.duration ?? "0"),
  };
}
