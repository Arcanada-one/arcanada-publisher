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

const ACTIVITY_URL = "https://www.linkedin.com/feed/update/urn:li:activity:7462962260978642944/";

/**
 * Fake Playwright page that walks the video publish flow to a successful URL
 * extraction. `scopedVideoCountJs` (composer-side check) returns 1 so the attach
 * passes; `collectVisibleHrefs` returns the activity URL so extraction succeeds.
 * shadow-walk button clicks (ADD_MEDIA / NEXT_DONE / POST) all return true.
 */
function fakeVideoPublishPage(
  pressedKeys: string[] = [],
  options: {
    scopedVideoCount?: number;
    mediaFilename?: string;
    waits?: number[];
    visibleHref?: string;
    expectedHref?: string;
    rolePostClicks?: number[];
  } = {},
): never {
  const visibleLocator = {
    first: () => visibleLocator,
    waitFor: async () => {},
    isVisible: async () => true,
    count: async () => 1,
    click: async () => {},
  };
  const filenameLocator = {
    first: () => filenameLocator,
    waitFor: async () => {},
    isVisible: async () => pressedKeys.length >= 2,
    count: async () => (pressedKeys.length >= 2 ? 1 : 0),
    click: async () => {},
  };
  const emptyLocator = {
    first: () => emptyLocator,
    waitFor: async () => {},
    isVisible: async () => false,
    count: async () => 0,
    click: async () => {},
  };
  const page = {
    goto: async () => {},
    getByRole: (_role: string, roleOptions?: { name?: unknown }) => {
      if (roleOptions?.name instanceof RegExp) {
        const postLocator = {
          first: () => postLocator,
          last: () => postLocator,
          waitFor: async () => {},
          isVisible: async () => true,
          isEnabled: async () => true,
          count: async () => 1,
          click: async () => {
            options.rolePostClicks?.push(1);
          },
        };
        return postLocator;
      }
      return visibleLocator;
    },
    getByText: (text: string) =>
      text === options.mediaFilename ? filenameLocator : emptyLocator,
    locator: () => visibleLocator,
    isClosed: () => false,
    waitForTimeout: async (ms: number) => {
      options.waits?.push(ms);
    },
    keyboard: {
      press: async (key: string) => {
        pressedKeys.push(key);
      },
      insertText: async () => {},
    },
    waitForResponse: async () => null,
    evaluate: async (source: string) => {
      // shadow-walk button clicks return true (control found + clicked).
      if (source.includes("hit.click()")) return true;
      // scoped video count (composer-side) → 1 (attached).
      if (source.includes("scopeSels")) return options.scopedVideoCount ?? 1;
      // visible href collector → the activity URL (extraction succeeds).
      if (source.includes("expectedFragment")) return options.expectedHref ?? ACTIVITY_URL;
      if (source.includes("offsetParent")) return [options.visibleHref ?? ACTIVITY_URL];
      // generic shadow count (post-publish oracle path, if ever reached) → 0.
      return 0;
    },
  };
  return page as unknown as never;
}

describe("publish — PUB-0031 fail-closed post-publish video verify", () => {
  it("clicks the exact role Post button in the normal trigger-opened composer", async () => {
    const vid = makeVideo();
    const rolePostClicks: number[] = [];
    await publish(
      { text: "narration video", imagePath: vid, profile: "p1" },
      {
        profileManager: makeProfiles(),
        page: fakeVideoPublishPage([], { rolePostClicks }),
        __verifyPostVideo: vi.fn(async () => true),
        __prepareMediaClipboard: vi.fn(),
      },
    );

    expect(rolePostClicks).toHaveLength(1);
  });

  it("does not accept a stale visible activity URL when the published title differs", async () => {
    const oldUrl = "https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000000/";
    const vid = makeVideo();
    const res = await publish(
      { text: "Cubrim-2: The Global Addresser\n\nBody", imagePath: vid, profile: "p1" },
      {
        profileManager: makeProfiles(),
        page: fakeVideoPublishPage([], {
          visibleHref: oldUrl,
          expectedHref: ACTIVITY_URL,
        }),
        __verifyPostVideo: vi.fn(async () => true),
        __prepareMediaClipboard: vi.fn(),
      },
    );

    expect(res.postUrl).toBe(ACTIVITY_URL);
  });

  it("keeps the Publisher page open for the post-submit video upload window", async () => {
    const vid = makeVideo();
    const waits: number[] = [];
    await publish(
      { text: "narration video", imagePath: vid, profile: "p1" },
      {
        profileManager: makeProfiles(),
        page: fakeVideoPublishPage([], { waits }),
        __verifyPostVideo: vi.fn(async () => true),
        __prepareMediaClipboard: vi.fn(),
      },
    );

    expect(Math.max(...waits)).toBeGreaterThanOrEqual(120_000);
  });

  it("accepts LinkedIn's exact filename attachment card when no video element renders", async () => {
    const vid = makeVideo();
    const pressedKeys: string[] = [];
    const res = await publish(
      { text: "narration video", imagePath: vid, profile: "p1" },
      {
        profileManager: makeProfiles(),
        page: fakeVideoPublishPage(pressedKeys, {
          scopedVideoCount: 0,
          mediaFilename: "cover.mp4",
        }),
        __verifyPostVideo: vi.fn(async () => true),
        __prepareMediaClipboard: vi.fn(),
      },
    );

    expect(res.ok).toBe(true);
    expect(pressedKeys).toHaveLength(2);
  });

  it("re-prepares the media clipboard at paste time and uses the concrete OS shortcut", async () => {
    const vid = makeVideo();
    const pressedKeys: string[] = [];
    const prepareClipboard = vi.fn();
    const focusBrowser = vi.fn(() => true);
    const pasteClipboard = vi.fn(() => true);

    await publish(
      { text: "narration video", imagePath: vid, profile: "p1" },
      {
        profileManager: makeProfiles(),
        page: fakeVideoPublishPage(pressedKeys),
        __verifyPostVideo: vi.fn(async () => true),
        __prepareMediaClipboard: prepareClipboard,
        __focusPublisherBrowser: focusBrowser,
        __pasteMediaClipboard: pasteClipboard,
      } as never,
    );

    expect(prepareClipboard).toHaveBeenCalledWith(vid);
    expect(focusBrowser).toHaveBeenCalled();
    expect(pasteClipboard).toHaveBeenCalled();
    expect(pressedKeys).toHaveLength(0);
  });

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

  it("abortBeforePost: runs the full flow, attaches media, returns aborted WITHOUT posting", async () => {
    // No-publish dry-run. The fake page records whether the POST_RE shadow-click
    // ever fired; it must NOT (the flow aborts after text-fill). __verifyPostVideo
    // must also never run (no publish → no post to verify).
    const verify = vi.fn(async () => true);
    let postClicked = false;
    const vid = makeVideo();
    const page = {
      goto: async () => {},
      getByRole: () => ({
        first: () => ({
          waitFor: async () => {},
          isVisible: async () => true,
          count: async () => 1,
          click: async () => {},
        }),
      }),
      getByText: () => ({
        first: () => ({ isVisible: async () => false }),
      }),
      locator: () => ({
        first: () => ({
          waitFor: async () => {},
          isVisible: async () => true,
          count: async () => 1,
          click: async () => {},
        }),
      }),
      isClosed: () => false,
      waitForTimeout: async () => {},
      keyboard: { press: async () => {}, insertText: async () => {} },
      waitForResponse: async () => null,
      evaluate: async (source: string) => {
        if (source.includes("hit.click()")) {
          // Distinguish the POST click from add-media / next-done by the POST regex.
          if (source.includes("Veröffentlichen") || source.includes("Опубликовать")) {
            postClicked = true;
          }
          return true;
        }
        if (source.includes("scopeSels")) return 1; // scoped video attached
        if (source.includes("offsetParent")) return [ACTIVITY_URL];
        return 0;
      },
    } as unknown as never;

    const res = await publish(
      { text: "dry-run no post", imagePath: vid, profile: "p1" },
      {
        profileManager: makeProfiles(),
        page,
        abortBeforePost: true,
        __verifyPostVideo: verify,
      },
    );
    expect(res).toMatchObject({ aborted: true, mediaAttached: true });
    expect(res.attachments).toEqual([{ kind: "video", src: vid }]);
    expect(postClicked).toBe(false); // never clicked Post
    expect(verify).not.toHaveBeenCalled(); // no post → no verify
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
