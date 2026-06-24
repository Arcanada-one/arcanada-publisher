import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ErrorCode, ProfileManager } from "@arcanada/publisher-core";
import { publish } from "../src/publish.js";

// PUB-0031: fail-closed post-publish video re-verify.
//
// The open bug that kept PUB-0031 from done: a "video" publish that silently
// dropped the attachment reported SUCCESS on a text-only post. The fix adds a
// post-publish oracle (`__verifyPostVideo`) that re-fetches the live post and
// asserts a <video> player; when it returns false, publish() MUST throw
// VERIFY_FAILED instead of returning ok. These tests drive the full publish flow
// with a fake page (logged-in, media attaches, post button clicks, URL extracts)
// and toggle ONLY the oracle to prove the fail-closed decision.

function makeProfiles(): ProfileManager {
  const root = mkdtempSync(join(tmpdir(), "pub-0031-vid-"));
  mkdirSync(join(root, "linkedin", "p1"), { recursive: true });
  return new ProfileManager({ root });
}

function makeVideo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pub-0031-mp4-"));
  const file = join(dir, "cover.mp4");
  writeFileSync(file, Buffer.from([0x00, 0x00, 0x00, 0x18]));
  return file;
}

const ACTIVITY_URL =
  "https://www.linkedin.com/feed/update/urn:li:activity:7462962260978642944/";

/**
 * Fake Playwright page that walks the video publish flow to a successful URL
 * extraction. `scopedVideoCountJs` (composer-side check) returns 1 so the attach
 * passes; `collectVisibleHrefs` returns the activity URL so extraction succeeds.
 * shadow-walk button clicks (ADD_MEDIA / NEXT_DONE / POST) all return true.
 */
function fakeVideoPublishPage(): never {
  const visibleLocator = {
    first: () => visibleLocator,
    waitFor: async () => {},
    isVisible: async () => true,
    count: async () => 1,
    click: async () => {},
  };
  const page = {
    goto: async () => {},
    getByRole: () => visibleLocator,
    locator: () => visibleLocator,
    isClosed: () => false,
    waitForTimeout: async () => {},
    keyboard: {
      press: async () => {},
      insertText: async () => {},
    },
    waitForResponse: async () => null,
    evaluate: async (source: string) => {
      // shadow-walk button clicks return true (control found + clicked).
      if (source.includes("hit.click()")) return true;
      // scoped video count (composer-side) → 1 (attached).
      if (source.includes("scopeSels")) return 1;
      // visible href collector → the activity URL (extraction succeeds).
      if (source.includes("offsetParent")) return [ACTIVITY_URL];
      // generic shadow count (post-publish oracle path, if ever reached) → 0.
      return 0;
    },
  };
  return page as unknown as never;
}

describe("publish — PUB-0031 fail-closed post-publish video verify", () => {
  it("throws VERIFY_FAILED when the published post carries NO video (oracle=false)", async () => {
    const verify = vi.fn(async () => false);
    const vid = makeVideo();
    await expect(
      publish(
        { text: "narration video", imagePath: vid, profile: "p1" },
        {
          profileManager: makeProfiles(),
          page: fakeVideoPublishPage(),
          __verifyPostVideo: verify,
        },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.VERIFY_FAILED });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith(expect.anything(), ACTIVITY_URL);
  });

  it("succeeds and reports a video attachment when the post DOES carry a video (oracle=true)", async () => {
    const verify = vi.fn(async () => true);
    const vid = makeVideo();
    const res = await publish(
      { text: "narration video", imagePath: vid, profile: "p1" },
      {
        profileManager: makeProfiles(),
        page: fakeVideoPublishPage(),
        __verifyPostVideo: verify,
      },
    );
    expect(res.ok).toBe(true);
    expect(res.postUrl).toBe(ACTIVITY_URL);
    expect(res.attachments).toEqual([{ kind: "video", src: vid }]);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("does NOT run the video oracle for an image-only publish", async () => {
    const verify = vi.fn(async () => false);
    const dir = mkdtempSync(join(tmpdir(), "pub-0031-img-"));
    const img = join(dir, "hero.png");
    writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const res = await publish(
      { text: "still image", imagePath: img, profile: "p1" },
      {
        profileManager: makeProfiles(),
        page: fakeVideoPublishPage(),
        __verifyPostVideo: verify,
      },
    );
    expect(res.ok).toBe(true);
    expect(res.attachments).toEqual([{ kind: "image", src: img }]);
    expect(verify).not.toHaveBeenCalled();
  });
});
