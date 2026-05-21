// Migrated from Arcanada-one/fb-publish@8df49fa51822795075f746ad7389c8bd400b1aa4 on 2026-05-21 (PUB-0003)
// Source: Projects/FB Publish/code/fb-publish/tests/fb-publish.bats (live smoke flow).
//
// Live smoke gated by FB_LIVE_SMOKE=1. In CI (var unset) the case is `skip`ped
// and the skip is visible in Vitest reporter (AC-5). Locally with the gate
// set, the operator runs:
//
//   FB_LIVE_SMOKE=1 PUB_PROFILE=pavel-personal \
//     pnpm --filter @arcanada/publisher-facebook test:smoke
//
// Screenshots land in `artifacts/<timestamp>-<stage>.png` (.gitignored).

import { describe, it, expect } from "vitest";
import { FacebookAdapter } from "../src/index.js";

const LIVE = process.env["FB_LIVE_SMOKE"] === "1";
const PROFILE = process.env["PUB_PROFILE"] ?? "pavel-personal";
const SMOKE_TEXT = `plan-smoke ${new Date().toISOString()} (PUB-0003)`;

describe("smoke — live FB publish cycle (gated FB_LIVE_SMOKE=1)", () => {
  it.skipIf(!LIVE)(
    "publish → verify → comment → verifyCommentParent",
    async () => {
      const adapter = new FacebookAdapter();
      const publishResult = await adapter.publish({
        text: SMOKE_TEXT,
        profile: PROFILE,
      });
      expect(publishResult.ok).toBe(true);
      expect(publishResult.postUrl).toMatch(/^https:\/\/www\.facebook\.com\/[^"]+\/posts\/[0-9]+$/);
      expect(publishResult.postUrl).not.toContain('"');

      const verifyResult = await adapter.verify(publishResult.postUrl);
      expect(verifyResult.reachable).toBe(true);

      const commentResult = await adapter.comment({
        parentPostUrl: publishResult.postUrl,
        text: "plan-smoke comment (PUB-0003)",
        profile: PROFILE,
      });
      expect(commentResult.ok).toBe(true);
      expect(commentResult.commentId).toBeTruthy();
    },
    10 * 60 * 1000,
  );

  it.skipIf(!LIVE)(
    "negative parent_id → throws AdapterError(code=6) and writes negative screenshot",
    async () => {
      const adapter = new FacebookAdapter();
      await expect(
        adapter.comment({
          parentPostUrl: "https://www.facebook.com/100000000000000/posts/00000000000",
          text: "should-never-land (PUB-0003 negative)",
          profile: PROFILE,
        }),
      ).rejects.toMatchObject({ code: 6 });
    },
    5 * 60 * 1000,
  );

  it("smoke gate is visible in Vitest output even when skipped", () => {
    // Sentinel test to make AC-5 visibility explicit when FB_LIVE_SMOKE is unset.
    if (!LIVE) {
      // eslint-disable-next-line no-console
      console.log("FB_LIVE_SMOKE not set — live cycle skipped (CI default).");
    }
    expect(typeof LIVE).toBe("boolean");
  });
});
