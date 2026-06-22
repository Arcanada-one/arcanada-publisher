// Shared image-path validation: NUL-byte reject, existence, regular-file, and
// extension allowlist. Mirrors the FB/LI adapters' validateImagePath guard.
//
// PUB-0027: .mp4 and .mov added to allow the generated cover video to attach via
// the existing --image path on X. This is an additive, guarded extension —
// no existing image behavior changes. See docs/how-to/animated-cover-video.md.

import { statSync, existsSync } from "node:fs";
import { extname, resolve as resolvePath } from "node:path";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";

// X accepts both images and video through the same composer file input; on a
// Premium account a long-form post can carry a video (e.g. a cover+audio MP4).
const IMAGE_EXT_ALLOWLIST = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".mov"]);

export function validateImagePath(rawPath: string): string {
  if (rawPath.includes("\0")) {
    throw new AdapterError(ErrorCode.INVALID_ARGS, "publish: imagePath contains NUL byte");
  }
  const abs = resolvePath(rawPath);
  if (!existsSync(abs)) {
    throw new AdapterError(ErrorCode.MISSING_INPUT, `publish: image not found: ${abs}`, {
      imagePath: abs,
    });
  }
  const stat = statSync(abs);
  if (!stat.isFile()) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `publish: imagePath is not a regular file: ${abs}`,
    );
  }
  const ext = extname(abs).toLowerCase();
  if (!IMAGE_EXT_ALLOWLIST.has(ext)) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `publish: unsupported image extension '${ext}'`,
      {
        imagePath: abs,
        allowed: Array.from(IMAGE_EXT_ALLOWLIST),
      },
    );
  }
  return abs;
}
