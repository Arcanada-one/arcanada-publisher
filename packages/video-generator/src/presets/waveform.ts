// Bottom audio-amplitude strip — a showwaves oscilloscope filled with a
// horizontal colour gradient, overlaid onto the bottom of the assembled video.
//
// This is NOT a standalone "bare waveform" video (which the publishing policy
// forbids as the whole post). It is an ADDITIONAL strip drawn on top of the
// cycle animation, so the cover animation stays the hero and the strip just
// shows the narration amplitude. Operator-approved style (2026-06-28):
//   showwaves mode=cline + horizontal gradient gold→crimson, 180px tall,
//   pinned to the bottom edge.
//
// Security: all values arrive as TypeScript numbers / fixed hex strings; the
// hex colours are validated against a strict regex before they reach the
// arg-array, so no user string is ever interpolated raw into filter_complex.

/** Waveform-strip configuration. Defaults encode the operator-approved house style. */
export interface WaveformConfig {
  /** Master switch. When false, no strip is drawn. */
  enabled: boolean;
  /** Strip height in pixels (at the 720p canvas). Default 180. */
  heightPx: number;
  /** Gradient start colour (left edge), 0xRRGGBB. Default gold 0xFFD24C. */
  colorLeft: string;
  /** Gradient end colour (right edge), 0xRRGGBB. Default crimson 0xE03B5A. */
  colorRight: string;
}

/** Operator-approved defaults (PUB waveform, 2026-06-28). */
export const DEFAULT_WAVEFORM: WaveformConfig = {
  enabled: true,
  heightPx: 180,
  colorLeft: "0xFFD24C", // gold
  colorRight: "0xE03B5A", // crimson
};

/** Accepts 0xRRGGBB / 0xRRGGBBAA / #RRGGBB — the forms ffmpeg's color/gradients take. */
const HEX_COLOR = /^(0x|#)[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/;

/** Throw INVALID_ARGS-style error if a colour is not a strict hex literal. */
function assertHexColor(value: string, label: string): void {
  if (!HEX_COLOR.test(value)) {
    throw new Error(`waveform: ${label} must be a hex colour (0xRRGGBB), got '${value}'`);
  }
}

/**
 * Validate + normalise a partial config into a full WaveformConfig.
 * Pure — no I/O. Rejects non-positive height and malformed colours.
 */
export function resolveWaveformConfig(partial?: Partial<WaveformConfig>): WaveformConfig {
  const cfg: WaveformConfig = { ...DEFAULT_WAVEFORM, ...(partial ?? {}) };
  if (!Number.isInteger(cfg.heightPx) || cfg.heightPx <= 0) {
    throw new Error(`waveform: heightPx must be a positive integer, got '${cfg.heightPx}'`);
  }
  assertHexColor(cfg.colorLeft, "colorLeft");
  assertHexColor(cfg.colorRight, "colorRight");
  return cfg;
}

/**
 * Build the filter_complex fragment that overlays the gradient waveform strip
 * onto an input video labelled `[0:v]` using audio `[1:a]`, producing `[vout]`.
 *
 * Pipeline:
 *   [1:a] showwaves (white, cline)              → grey amplitude mask
 *   gradients (left→right gold→crimson)         → coloured strip
 *   [grad][mask] alphamerge                     → coloured waveform with alpha
 *   [0:v][wave] overlay at y = H - stripH       → final frame
 *
 * Strip height is clamped to the frame height so the overlay never exceeds the
 * canvas. The strip is pinned to the bottom edge.
 */
export function buildWaveformFilter(
  cfg: WaveformConfig,
  width: number,
  height: number,
  fps: number,
): string {
  const stripH = Math.min(cfg.heightPx, height);
  const y = height - stripH;
  return [
    `[1:a]showwaves=s=${width}x${stripH}:mode=cline:colors=white:draw=full:rate=${fps},format=gray[wfmask]`,
    `gradients=s=${width}x${stripH}:c0=${cfg.colorLeft}:c1=${cfg.colorRight}:x0=0:y0=0:x1=${width}:y1=0:d=1:n=2:rate=${fps}[wfgrad]`,
    `[wfgrad][wfmask]alphamerge[wfwave]`,
    `[0:v][wfwave]overlay=0:${y}:format=auto,format=yuv420p[vout]`,
  ].join(";");
}
