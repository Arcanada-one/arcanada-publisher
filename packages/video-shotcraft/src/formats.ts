// RenderFormat registry (DESIGN §5 / D5).
//
// The baseline ships a single validated descriptor — landscape 1920x1080 @ 30fps
// H.264/AAC — but the render entry, composition dimensions, the ffmpeg mux and
// the ffprobe self-check all read from this record rather than hard-coding the
// numbers. Deferred vertical (1080x1920) / square (1080x1080) formats (D-REQ-07)
// become additive registry entries, not a rewrite.

import { AdapterError, ErrorCode } from "@arcanada/publisher-core";

/** A render output descriptor: dimensions, frame rate and codecs. */
export interface RenderFormat {
  /** Registry id. Future: "vertical" | "square". */
  id: "landscape";
  width: number;
  height: number;
  fps: number;
  videoCodec: "h264";
  audioCodec: "aac";
}

/** The only format validated by the source (Ink Press baseline). */
export const LANDSCAPE: RenderFormat = {
  id: "landscape",
  width: 1920,
  height: 1080,
  fps: 30,
  videoCodec: "h264",
  audioCodec: "aac",
};

/** Registry keyed by format id. Additive: new formats slot in here. */
const REGISTRY: Record<string, RenderFormat> = {
  landscape: LANDSCAPE,
};

/** The default format when a caller does not request one. */
export const DEFAULT_FORMAT: RenderFormat = LANDSCAPE;

/**
 * Resolve a format id to its descriptor.
 * Throws AdapterError(INVALID_ARGS) for an unknown id (fail-closed).
 */
export function resolveFormat(id: string): RenderFormat {
  const fmt = REGISTRY[id];
  if (fmt === undefined) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `shotcraft: unknown --format '${id}' — registered: ${Object.keys(REGISTRY).join(", ")}`,
    );
  }
  return fmt;
}

/** List the registered format ids (for CLI help / diagnostics). */
export function listFormats(): string[] {
  return Object.keys(REGISTRY);
}
