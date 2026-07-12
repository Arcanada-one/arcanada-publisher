import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ErrorCode, ProfileManager } from "@arcanada/publisher-core";
import { isComposedEditorFocused, publish } from "../src/publish.js";

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
function fakeVideoPublishPage(): never {
  const editorEvaluate = vi.fn(async () => true);
  const visibleLocator = {
    first: () => visibleLocator,
    waitFor: async () => {},
    isVisible: async () => true,
    count: async () => 1,
    click: async () => {},
    focus: async () => {},
    evaluate: editorEvaluate,
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
    waitForResponse: async () => ({ ok: () => true }),
    __editorEvaluate: editorEvaluate,
    evaluate: async (source: string) => {
      // shadow-walk button clicks return true (control found + clicked).
      if (source.includes("hit.click()")) return true;
      // scoped video count (composer-side) → 1 (attached).
      if (source.includes("scopeSel") || source.includes("var expected=")) return 1;
      // visible href collector → the activity URL (extraction succeeds).
      if (source.includes("offsetParent")) return [ACTIVITY_URL];
      // generic shadow count (post-publish oracle path, if ever reached) → 0.
      return 0;
    },
  };
  return page as unknown as never;
}

describe("publish — PUB-0031 fail-closed post-publish video verify", () => {
  it("uses CDP only after clipboard preview exhaustion and requires second scoped preview", async () => {
    const vid = makeVideo();
    const page = fakeVideoPublishPage() as unknown as {
      evaluate(source: string | ((...args: never[]) => unknown)): Promise<unknown>;
      __editorEvaluate: ReturnType<typeof vi.fn>;
    };
    let dragged = false;
    let beforeDragPolls = 0;
    const originalEvaluate = page.evaluate.bind(page);
    page.evaluate = async (source) => {
      if (
        typeof source === "string" &&
        (source.includes("scopeSel") || source.includes("var expected="))
      ) {
        if (!dragged) beforeDragPolls += 1;
        return dragged ? 1 : 0;
      }
      return originalEvaluate(source);
    };
    const result = await publish(
      { text: "never typed", imagePath: vid, profile: "p1" },
      {
        profileManager: makeProfiles(),
        page: page as never,
        abortAfterMedia: true,
        __dispatchVideoDragDrop: async () => {
          dragged = true;
        },
      },
    );
    expect(beforeDragPolls).toBe(360);
    expect(page.__editorEvaluate.mock.calls.length).toBeGreaterThan(1);
    expect(result).toMatchObject({ aborted: true, mediaAttached: true });
  });

  it("fails closed when CDP drop still produces no scoped preview", async () => {
    const vid = makeVideo();
    const stages: string[] = [];
    const page = fakeVideoPublishPage() as unknown as {
      evaluate(source: string | ((...args: never[]) => unknown)): Promise<unknown>;
      keyboard: { insertText: ReturnType<typeof vi.fn> };
    };
    page.keyboard.insertText = vi.fn(async () => {});
    const originalEvaluate = page.evaluate.bind(page);
    page.evaluate = async (source) =>
      typeof source === "string" &&
      (source.includes("scopeSel") || source.includes("var expected="))
        ? 0
        : originalEvaluate(source);
    await expect(
      publish(
        { text: "never typed", imagePath: vid, profile: "p1" },
        {
          profileManager: makeProfiles(),
          page: page as never,
          abortAfterMedia: true,
          __dispatchVideoDragDrop: async () => {},
          __onStage: (stage) => stages.push(stage),
        },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.PUBLISH_BUTTON_ABSENT });
    expect(page.keyboard.insertText).not.toHaveBeenCalled();
    expect(stages).not.toContain("text_insert");
    expect(stages).not.toContain("post_click");
  });

  it("runtime publish surface contains no file-picker or setInputFiles path", () => {
    const source = publish.toString();
    expect(source).not.toContain("setInputFiles");
    expect(source).not.toContain("filechooser");
  });

  it("attachment smoke rejects multiple videos before browser IO", async () => {
    const first = makeVideo();
    const second = makeVideo();
    await expect(
      publish(
        { text: "unused", imagePaths: [first, second], profile: "p1" },
        { profileManager: makeProfiles(), page: fakeVideoPublishPage(), abortAfterMedia: true },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGS });
  });

  it("production focus callback resolves nested shadow activeElement", () => {
    const editor = {
      ownerDocument: { activeElement: null as never },
      contains: (node: unknown) => node === editor,
    };
    const innerHost = { shadowRoot: { activeElement: editor } };
    const outerHost = { shadowRoot: { activeElement: innerHost } };
    editor.ownerDocument.activeElement = outerHost as never;
    expect(isComposedEditorFocused(editor as never)).toBe(true);
    editor.ownerDocument.activeElement = { shadowRoot: { activeElement: null } } as never;
    expect(isComposedEditorFocused(editor as never)).toBe(false);
  });

  it("focus mismatch aborts before clipboard, paste, text, or Post", async () => {
    const vid = makeVideo();
    const prepare = vi.fn();
    const stages: string[] = [];
    const page = fakeVideoPublishPage() as unknown as {
      keyboard: { press: ReturnType<typeof vi.fn>; insertText: ReturnType<typeof vi.fn> };
    };
    page.keyboard.press = vi.fn(async () => {});
    page.keyboard.insertText = vi.fn(async () => {});
    await expect(
      publish(
        { text: "never typed", imagePath: vid, profile: "p1" },
        {
          profileManager: makeProfiles(),
          page: page as never,
          __isEditorFocused: async () => false,
          __prepareMediaClipboard: prepare,
          __onStage: (stage) => stages.push(stage),
        },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.PUBLISH_BUTTON_ABSENT });
    expect(prepare).not.toHaveBeenCalled();
    expect(page.keyboard.press).not.toHaveBeenCalled();
    expect(page.keyboard.insertText).not.toHaveBeenCalled();
    expect(stages).toEqual(["editor_click", "editor_focus"]);
    expect(stages).not.toContain("post_click");
  });

  it("abortAfterMedia rejects a smoke without media before browser IO", async () => {
    await expect(
      publish(
        { text: "unused", profile: "p1" },
        { profileManager: makeProfiles(), page: fakeVideoPublishPage(), abortAfterMedia: true },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.MISSING_INPUT });
  });

  it("abortAfterMedia rejects image smoke until scoped image detection exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "li-image-smoke-"));
    const image = join(dir, "cover.png");
    writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await expect(
      publish(
        { text: "unused", imagePath: image, profile: "p1" },
        { profileManager: makeProfiles(), page: fakeVideoPublishPage(), abortAfterMedia: true },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGS });
  });

  it("abortAfterMedia returns before text insertion or Post", async () => {
    const vid = makeVideo();
    const stages: string[] = [];
    const page = fakeVideoPublishPage() as unknown as {
      keyboard: { press: ReturnType<typeof vi.fn>; insertText: ReturnType<typeof vi.fn> };
    };
    page.keyboard.insertText = vi.fn(async () => {});
    const result = await publish(
      { text: "must not be typed", imagePath: vid, profile: "p1" },
      {
        profileManager: makeProfiles(),
        page: page as never,
        abortAfterMedia: true,
        __onStage: (stage) => stages.push(stage),
      },
    );
    expect(result).toMatchObject({ aborted: true, mediaAttached: true });
    expect(page.keyboard.insertText).not.toHaveBeenCalled();
    expect(stages).not.toContain("text_insert");
    expect(stages).not.toContain("post_click");
  });

  it("orders focus proof, one clipboard prepare, paste, and scoped preview", async () => {
    const vid = makeVideo();
    const events: string[] = [];
    const page = fakeVideoPublishPage() as unknown as {
      keyboard: { press(key: string): Promise<void>; insertText(text: string): Promise<void> };
    };
    page.keyboard.press = async (key: string) => events.push(`key:${key}`);
    await publish(
      { text: "clipboard ordering", imagePath: vid, profile: "p1" },
      {
        profileManager: makeProfiles(),
        page: page as never,
        __prepareMediaClipboard: (path) => events.push(`prepare:${path}`),
        __onStage: (stage) => events.push(`stage:${stage}`),
        __verifyPostVideo: async () => true,
      },
    );
    expect(events.slice(0, 8)).toEqual([
      "stage:editor_click",
      "stage:editor_focus",
      "stage:composed_focus_proof",
      `prepare:${vid}`,
      "stage:clipboard_prepare",
      `key:${process.platform === "darwin" ? "Meta+v" : "Control+v"}`,
      "stage:paste_key",
      "stage:scoped_preview",
    ]);
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

  it("keeps video publish fail-closed until the share API confirms upload completion", async () => {
    const vid = makeVideo();
    const page = fakeVideoPublishPage() as unknown as {
      waitForResponse: ReturnType<typeof vi.fn>;
    };
    page.waitForResponse = vi.fn(async () => null);
    await expect(
      publish(
        { text: "narration video", imagePath: vid, profile: "p1" },
        {
          profileManager: makeProfiles(),
          page: page as never,
          __verifyPostVideo: async () => true,
        },
      ),
    ).rejects.toMatchObject({
      code: ErrorCode.VERIFY_FAILED,
      details: { stage: "video_share_api_unconfirmed" },
    });
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
          focus: async () => {},
          evaluate: async () => true,
        }),
      }),
      locator: () => ({
        first: () => ({
          waitFor: async () => {},
          isVisible: async () => true,
          count: async () => 1,
          click: async () => {},
          focus: async () => {},
          evaluate: async () => true,
        }),
      }),
      isClosed: () => false,
      waitForTimeout: async () => {},
      keyboard: { press: async () => {}, insertText: async () => {} },
      waitForResponse: async () => ({ ok: () => true }),
      evaluate: async (source: string) => {
        if (source.includes("hit.click()")) {
          // Distinguish the POST click from add-media / next-done by the POST regex.
          if (source.includes("Veröffentlichen") || source.includes("Опубликовать")) {
            postClicked = true;
          }
          return true;
        }
        if (source.includes("scopeSel") || source.includes("var expected=")) return 1;
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
