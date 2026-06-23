import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ErrorCode, ProfileManager } from "@arcanada/publisher-core";
import { publish, publishedTextMatchFragment, type PublishStepRecorder } from "../src/publish.js";
import { typeMultiline } from "../src/input.js";

function makeProfiles(): ProfileManager {
  const root = mkdtempSync(join(tmpdir(), "pub-0017-fb-pub-"));
  mkdirSync(join(root, "facebook", "p1"), { recursive: true });
  return new ProfileManager({ root });
}

function makeImage(ext = ".png"): string {
  const dir = mkdtempSync(join(tmpdir(), "pub-0017-fb-img-"));
  const file = join(dir, `hero${ext}`);
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return file;
}

const FAKE_PROFILE = "p1";

describe("facebook publish — input validation (R1 image-mandatory)", () => {
  it("rejects empty text with MISSING_INPUT", async () => {
    await expect(
      publish({ text: "  ", imagePaths: [makeImage()], profile: FAKE_PROFILE }),
    ).rejects.toMatchObject({ code: ErrorCode.MISSING_INPUT });
  });

  it("R1: rejects a post with NO image (neither imagePath nor imagePaths) with MISSING_INPUT", async () => {
    await expect(
      publish({ text: "hello", profile: FAKE_PROFILE }, { profileManager: makeProfiles() }),
    ).rejects.toMatchObject({ code: ErrorCode.MISSING_INPUT });
  });

  it("R1: rejects an empty imagePaths array with MISSING_INPUT (image-mandatory)", async () => {
    await expect(
      publish(
        { text: "hello", imagePaths: [], profile: FAKE_PROFILE },
        { profileManager: makeProfiles() },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.MISSING_INPUT });
  });

  it("R1: accepts the deprecated single imagePath alias as one image", async () => {
    const rec = makeRecorder();
    const img = makeImage();
    const res = await publish(
      { text: "hello", imagePath: img, profile: FAKE_PROFILE },
      { profileManager: makeProfiles(), page: fakePage(), __recorder: rec },
    );
    expect(res.attachments).toHaveLength(1);
    expect(rec.uploadedImages).toEqual([img]);
  });

  it("R1: validates EVERY element of imagePaths (unsupported ext anywhere → INVALID_ARGS)", async () => {
    const good = makeImage(".png");
    const dir = mkdtempSync(join(tmpdir(), "pub-0017-fb-bad-"));
    const bad = join(dir, "doc.bmp");
    writeFileSync(bad, Buffer.from([0x42, 0x4d]));
    await expect(
      publish(
        { text: "hello", imagePaths: [good, bad], profile: FAKE_PROFILE },
        { profileManager: makeProfiles() },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGS });
  });
});

// --- Call-sequence recorder fake page ------------------------------------

interface FakePage {
  events: string[];
}

function fakePage(): never {
  return { events: [] } as unknown as never;
}

function makeRecorder(): PublishStepRecorder & {
  order: string[];
  uploadedImages: string[];
  submitTextSeen: (string | undefined)[];
} {
  const order: string[] = [];
  const uploadedImages: string[] = [];
  const submitTextSeen: (string | undefined)[] = [];
  return {
    order,
    uploadedImages,
    submitTextSeen,
    openComposer: vi.fn(async () => {
      order.push("openComposer");
    }),
    uploadImages: vi.fn(async (_page, paths: string[]) => {
      order.push("uploadImages");
      uploadedImages.push(...paths);
    }),
    typeBody: vi.fn(async () => {
      order.push("typeBody");
    }),
    preSubmitSnapshot: vi.fn(async () => {
      order.push("preSubmitSnapshot");
      return { hasText: true, hasImage: true };
    }),
    submitAndConfirm: vi.fn(async (_page, publishedText?: string) => {
      order.push("submitAndConfirm");
      submitTextSeen.push(publishedText);
      return "https://www.facebook.com/100012345/posts/777";
    }),
    postVerify: vi.fn(async () => {
      order.push("postVerify");
      return true;
    }),
  };
}

describe("facebook publish — R8 image-first ordering + R7 pre/post verify", () => {
  it("R8: uploads the image BEFORE typing the body, then re-asserts text", async () => {
    const rec = makeRecorder();
    await publish(
      { text: "line", imagePaths: [makeImage()], profile: FAKE_PROFILE },
      { profileManager: makeProfiles(), page: fakePage(), __recorder: rec },
    );
    // image-first: uploadImages must come before typeBody (R8 — image re-render
    // wipes any pre-typed text, so text is typed AFTER the upload settles).
    const upIdx = rec.order.indexOf("uploadImages");
    const typeIdx = rec.order.indexOf("typeBody");
    expect(upIdx).toBeGreaterThanOrEqual(0);
    expect(typeIdx).toBeGreaterThan(upIdx);
  });

  it("R7: runs the pre-submit snapshot BEFORE submit and post-verify AFTER", async () => {
    const rec = makeRecorder();
    await publish(
      { text: "line", imagePaths: [makeImage()], profile: FAKE_PROFILE },
      { profileManager: makeProfiles(), page: fakePage(), __recorder: rec },
    );
    const pre = rec.order.indexOf("preSubmitSnapshot");
    const submit = rec.order.indexOf("submitAndConfirm");
    const post = rec.order.indexOf("postVerify");
    expect(pre).toBeGreaterThanOrEqual(0);
    expect(submit).toBeGreaterThan(pre);
    expect(post).toBeGreaterThan(submit);
  });

  it("R7: ABORTS before submit when the pre-submit snapshot reports text is gone", async () => {
    const rec = makeRecorder();
    rec.preSubmitSnapshot = vi.fn(async () => {
      rec.order.push("preSubmitSnapshot");
      return { hasText: false, hasImage: true };
    });
    await expect(
      publish(
        { text: "line", imagePaths: [makeImage()], profile: FAKE_PROFILE },
        { profileManager: makeProfiles(), page: fakePage(), __recorder: rec },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.VERIFY_FAILED });
    expect(rec.submitAndConfirm).not.toHaveBeenCalled();
  });

  it("R7: ABORTS before submit when the pre-submit snapshot reports the image is gone", async () => {
    const rec = makeRecorder();
    rec.preSubmitSnapshot = vi.fn(async () => {
      rec.order.push("preSubmitSnapshot");
      return { hasText: true, hasImage: false };
    });
    await expect(
      publish(
        { text: "line", imagePaths: [makeImage()], profile: FAKE_PROFILE },
        { profileManager: makeProfiles(), page: fakePage(), __recorder: rec },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.VERIFY_FAILED });
    expect(rec.submitAndConfirm).not.toHaveBeenCalled();
  });

  it("R7: fails VERIFY_FAILED when post-verify cannot confirm the published post", async () => {
    const rec = makeRecorder();
    rec.postVerify = vi.fn(async () => {
      rec.order.push("postVerify");
      return false;
    });
    await expect(
      publish(
        { text: "line", imagePaths: [makeImage()], profile: FAKE_PROFILE },
        { profileManager: makeProfiles(), page: fakePage(), __recorder: rec },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.VERIFY_FAILED });
  });

  it("R1 multi-image: forwards every validated path to uploadImages in order", async () => {
    const rec = makeRecorder();
    const a = makeImage(".png");
    const b = makeImage(".jpg");
    await publish(
      { text: "line", imagePaths: [a, b], profile: FAKE_PROFILE },
      { profileManager: makeProfiles(), page: fakePage(), __recorder: rec },
    );
    expect(rec.uploadedImages).toEqual([a, b]);
  });

  it("dry-run short-circuits without invoking any destructive step", async () => {
    const rec = makeRecorder();
    const res = await publish(
      { text: "line", imagePaths: [makeImage()], profile: FAKE_PROFILE, dryRun: true },
      { profileManager: makeProfiles(), page: fakePage(), __recorder: rec },
    );
    expect(res.account).toBe("dry-run");
    expect(rec.submitAndConfirm).not.toHaveBeenCalled();
  });
});

describe("facebook input — R6 Shift+Enter multiline (no raw \\n submit)", () => {
  it("R6: a 4-line body presses Shift+Enter between lines and a final Enter only for comments", async () => {
    const presses: string[] = [];
    const typed: string[] = [];
    const keyboard = {
      type: vi.fn(async (s: string) => {
        typed.push(s);
      }),
      insertText: vi.fn(async (s: string) => {
        typed.push(s);
      }),
      press: vi.fn(async (k: string) => {
        presses.push(k);
      }),
    };
    const page = { keyboard } as unknown as never;

    await typeMultiline(page, "l1\nl2\nl3\nl4", { submit: false });

    // 4 lines typed, never a raw multi-line insert containing "\n"
    expect(typed).toEqual(["l1", "l2", "l3", "l4"]);
    expect(typed.some((t) => t.includes("\n"))).toBe(false);
    // 3 Shift+Enter between the 4 lines, NO trailing Enter (submit:false)
    expect(presses.filter((p) => p === "Shift+Enter")).toHaveLength(3);
    expect(presses).not.toContain("Enter");
  });

  it("R6: with submit:true a trailing plain Enter is pressed to send", async () => {
    const presses: string[] = [];
    const keyboard = {
      type: vi.fn(async () => {}),
      insertText: vi.fn(async () => {}),
      press: vi.fn(async (k: string) => {
        presses.push(k);
      }),
    };
    const page = { keyboard } as unknown as never;
    await typeMultiline(page, "a\nb", { submit: true });
    expect(presses.filter((p) => p === "Shift+Enter")).toHaveLength(1);
    expect(presses[presses.length - 1]).toBe("Enter");
  });

  it("R6: a single-line body types the line and never presses Shift+Enter", async () => {
    const presses: string[] = [];
    const typed: string[] = [];
    const keyboard = {
      type: vi.fn(async (s: string) => typed.push(s)),
      insertText: vi.fn(async (s: string) => typed.push(s)),
      press: vi.fn(async (k: string) => presses.push(k)),
    };
    const page = { keyboard } as unknown as never;
    await typeMultiline(page, "single line", { submit: false });
    expect(typed).toEqual(["single line"]);
    expect(presses).not.toContain("Shift+Enter");
  });
});

describe("PUB-0030 — publishedTextMatchFragment (just-published disambiguation)", () => {
  it("returns the first non-empty (title) line, trimmed and capped at 40, for a title-first body", () => {
    const body = "Angry Robot Deals: как агенты вернули к жизни проект\n\nПервый абзац…";
    const fragment = publishedTextMatchFragment(body);
    expect(fragment).toHaveLength(40);
    expect(fragment).toBe(body.slice(0, 40));
    expect("Angry Robot Deals: как агенты вернули к жизни".startsWith(fragment)).toBe(true);
  });

  it("skips leading blank lines and returns the first real line", () => {
    expect(publishedTextMatchFragment("\n\n  Real title  \nbody")).toBe("Real title");
  });

  it("caps the fragment at 40 chars (cheap, truncation-resilient match)", () => {
    const longTitle = "x".repeat(100);
    expect(publishedTextMatchFragment(longTitle)).toHaveLength(40);
  });

  it("returns empty string for undefined / empty / whitespace-only input", () => {
    expect(publishedTextMatchFragment(undefined)).toBe("");
    expect(publishedTextMatchFragment("")).toBe("");
    expect(publishedTextMatchFragment("   \n  \n ")).toBe("");
  });
});

describe("PUB-0030 — publish forwards the body to submitAndConfirm", () => {
  it("submitAndConfirm receives input.text so it can disambiguate the /me feed", async () => {
    const rec = makeRecorder();
    await publish(
      { text: "Title line\nbody", imagePaths: [makeImage()], profile: FAKE_PROFILE },
      { profileManager: makeProfiles(), page: fakePage(), __recorder: rec },
    );
    expect(rec.submitTextSeen).toEqual(["Title line\nbody"]);
  });
});

// Silence unused-type lint for the FakePage helper interface shape.
export type { FakePage };
