// Live X publish smoke — operator-gated and PLATFORM-LIMITED (D-3 / V-AC-19).
//
// X anti-bot rate-limits automated sign-in ("temporarily limited"), and that
// limit MUST NOT be circumvented. So this live publish runs ONLY when the
// operator sets X_LIVE_SMOKE=1 from a warm, already-logged-in profile while the
// limit is clear. Its ABSENCE does not fail the build or block archive — the
// adapter is otherwise verified by dry-run + unit (counter, rate-limit,
// selectors). The operator runs:
//
//   X_LIVE_SMOKE=1 PUB_PROFILE=pavel-personal PUB_IMAGE=/abs/hero.png \
//     pnpm --filter @arcanada/publisher-x test:smoke

import { describe, it, expect } from "vitest";
import { XAdapter } from "../src/index.js";

const LIVE = process.env["X_LIVE_SMOKE"] === "1";
const PROFILE = process.env["PUB_PROFILE"] ?? "pavel-personal";
const IMAGE = process.env["PUB_IMAGE"] ?? "";
const SMOKE_TEXT = `plan-smoke ${new Date().toISOString()}`;

describe("smoke — live X publish cycle (gated X_LIVE_SMOKE=1, platform-limited)", () => {
  it.skipIf(!LIVE || !IMAGE)(
    "publish (image-mandatory) → captures status URL",
    async () => {
      const adapter = new XAdapter();
      const result = await adapter.publish({
        text: SMOKE_TEXT,
        imagePaths: [IMAGE],
        profile: PROFILE,
      });
      expect(result.ok).toBe(true);
      expect(result.postUrl).toMatch(/\/status\/\d+/);
      // eslint-disable-next-line no-console
      console.log(`X live POST_URL: ${result.postUrl}`);
    },
    10 * 60 * 1000,
  );

  it("smoke gate is visible in Vitest output even when skipped", () => {
    if (!LIVE) {
      // eslint-disable-next-line no-console
      console.log("X_LIVE_SMOKE not set — live cycle skipped (platform-limited, D-3).");
    }
    expect(typeof LIVE).toBe("boolean");
  });
});
