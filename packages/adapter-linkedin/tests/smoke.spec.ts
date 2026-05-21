// Migrated from Arcanada-one/li-publish@7ddadf81a1662abd66d7f04ea2b7acf737d6afe2 on 2026-05-21 (PUB-0004)
// Source: Projects/LI Publish/code/li-publish/tests/li-publish.bats (live smoke flow).
//
// Live smoke gated by LI_LIVE_SMOKE=1. In CI (var unset) the cases are
// skipped — visible in Vitest reporter. Locally with the gate set, operator
// runs:
//
//   LI_LIVE_SMOKE=1 PUB_PROFILE=pavel-personal \
//     pnpm --filter @arcanada/publisher-linkedin test:smoke
//
// Screenshots land in `artifacts/<timestamp>-<stage>.png` (.gitignored).

import { describe, it, expect } from "vitest";
import { LinkedInAdapter, ACTIVITY_URN_RE } from "../src/index.js";

const LIVE = process.env["LI_LIVE_SMOKE"] === "1";
const PROFILE = process.env["PUB_PROFILE"] ?? "pavel-personal";
const SMOKE_TEXT = `plan-smoke ${new Date().toISOString()} (PUB-0004)`;

describe("smoke — live LinkedIn publish cycle (gated LI_LIVE_SMOKE=1)", () => {
  it.skipIf(!LIVE)(
    "S1: publish text → verify → comment (text-only round-trip)",
    async () => {
      const adapter = new LinkedInAdapter();
      const publishResult = await adapter.publish({
        text: SMOKE_TEXT,
        profile: PROFILE,
      });
      expect(publishResult.ok).toBe(true);
      expect(publishResult.postUrl).toMatch(ACTIVITY_URN_RE);
      expect(publishResult.postUrl).not.toContain('"');

      const verifyResult = await adapter.verify(publishResult.postUrl);
      expect(verifyResult.reachable).toBe(true);

      const commentResult = await adapter.comment({
        parentPostUrl: publishResult.postUrl,
        text: "plan-smoke comment (PUB-0004)",
        profile: PROFILE,
      });
      expect(commentResult.ok).toBe(true);
      expect(commentResult.commentId).toBeTruthy();
    },
    10 * 60 * 1000,
  );

  it.skipIf(!LIVE)(
    "S2: publish text+image (INFRA-0259 shadow-DOM bypass verified live)",
    async () => {
      const imagePath = process.env["PUB_SMOKE_IMAGE"];
      if (!imagePath) {
        throw new Error("S2 requires PUB_SMOKE_IMAGE env (absolute path to ≤5MB jpg/png)");
      }
      const adapter = new LinkedInAdapter();
      const publishResult = await adapter.publish({
        text: `${SMOKE_TEXT} [with image]`,
        imagePath,
        profile: PROFILE,
      });
      expect(publishResult.ok).toBe(true);
      expect(publishResult.postUrl).toMatch(ACTIVITY_URN_RE);
      expect(publishResult.attachments.length).toBe(1);
    },
    15 * 60 * 1000,
  );

  it("smoke gate is visible in Vitest output even when skipped", () => {
    if (!LIVE) {
      // eslint-disable-next-line no-console
      console.log("LI_LIVE_SMOKE not set — live cycle skipped (CI default).");
    }
    expect(typeof LIVE).toBe("boolean");
  });
});
