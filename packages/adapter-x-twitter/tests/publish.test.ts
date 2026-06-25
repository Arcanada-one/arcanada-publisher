import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ErrorCode, ProfileManager } from "@arcanada/publisher-core";
import { publish, collectImagePath, type PublishStepRecorder } from "../src/publish.js";

function makeProfiles(): ProfileManager {
  const root = mkdtempSync(join(tmpdir(), "pub-0017-x-pub-"));
  mkdirSync(join(root, "x", "p1"), { recursive: true });
  return new ProfileManager({ root });
}

function makeImage(ext = ".png"): string {
  const dir = mkdtempSync(join(tmpdir(), "pub-0017-x-img-"));
  const file = join(dir, `hero${ext}`);
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return file;
}

const FAKE_PROFILE = "p1";

function passingRecorder(): PublishStepRecorder {
  return {
    openComposer: vi.fn(async () => {}),
    checkRateLimited: vi.fn(async () => false),
    uploadImage: vi.fn(async () => {}),
    typeTweet: vi.fn(async () => {}),
    submitAndConfirm: vi.fn(async () => "https://x.com/paxbeach/status/123"),
  };
}

describe("x publish — input guards (R1 image-mandatory + 280 limit)", () => {
  it("rejects empty text with MISSING_INPUT", async () => {
    await expect(
      publish({ text: "  ", imagePaths: [makeImage()], profile: FAKE_PROFILE }),
    ).rejects.toMatchObject({ code: ErrorCode.MISSING_INPUT });
  });

  it("rejects a tweet of 281 UTF-16 units with INVALID_ARGS (pre-flight, no browser)", async () => {
    await expect(
      publish({ text: "a".repeat(281), imagePaths: [makeImage()], profile: FAKE_PROFILE }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGS });
  });

  it("PUB-0033: a 1500-unit body is rejected WITHOUT premium (free-tier 280 guard)", async () => {
    await expect(
      publish({ text: "a".repeat(1500), imagePaths: [makeImage()], profile: FAKE_PROFILE }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGS });
  });

  it("PUB-0033: premium=true lets a 1500-unit body through to publish", async () => {
    const rec = passingRecorder();
    const res = await publish(
      { text: "a".repeat(1500), imagePaths: [makeImage()], profile: FAKE_PROFILE, premium: true },
      { profileManager: makeProfiles(), page: { dummy: true } as never, __recorder: rec },
    );
    expect(res.ok).toBe(true);
    expect(rec.submitAndConfirm).toHaveBeenCalledTimes(1);
  });

  it("PUB-0033: premium=true still rejects a body over the 25 000 premium ceiling", async () => {
    await expect(
      publish({
        text: "a".repeat(25_001),
        imagePaths: [makeImage()],
        profile: FAKE_PROFILE,
        premium: true,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGS });
  });

  it("R1: rejects a tweet with NO image with MISSING_INPUT", async () => {
    await expect(
      publish({ text: "ok", profile: FAKE_PROFILE }, { profileManager: makeProfiles() }),
    ).rejects.toMatchObject({ code: ErrorCode.MISSING_INPUT });
  });

  it("R1: rejects an unsupported image extension with INVALID_ARGS", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pub-0017-x-bad-"));
    const bad = join(dir, "x.bmp");
    writeFileSync(bad, Buffer.from([0x42, 0x4d]));
    await expect(
      publish(
        { text: "ok", imagePaths: [bad], profile: FAKE_PROFILE },
        { profileManager: makeProfiles() },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGS });
  });

  it("collectImagePath: imagePaths wins over the imagePath alias", () => {
    expect(
      collectImagePath({ text: "x", imagePaths: ["/a.png"], imagePath: "/b.png", profile: "p" }),
    ).toBe("/a.png");
    expect(collectImagePath({ text: "x", imagePath: "/b.png", profile: "p" })).toBe("/b.png");
    expect(collectImagePath({ text: "x", profile: "p" })).toBeUndefined();
  });
});

describe("x publish — R12 rate-limit (graceful stop, no circumvention)", () => {
  it("R12: stops with ErrorCode.RATE_LIMIT when the composer reports a rate-limit, WITHOUT uploading or submitting", async () => {
    const rec = passingRecorder();
    rec.checkRateLimited = vi.fn(async () => true);
    await expect(
      publish(
        { text: "ok", imagePaths: [makeImage()], profile: FAKE_PROFILE },
        { profileManager: makeProfiles(), page: { dummy: true } as never, __recorder: rec },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.RATE_LIMIT });
    expect(rec.uploadImage).not.toHaveBeenCalled();
    expect(rec.submitAndConfirm).not.toHaveBeenCalled();
  });

  it("R12: does NOT auto-retry — the rate-limit check runs exactly once", async () => {
    const rec = passingRecorder();
    const check = vi.fn(async () => true);
    rec.checkRateLimited = check;
    await publish(
      { text: "ok", imagePaths: [makeImage()], profile: FAKE_PROFILE },
      { profileManager: makeProfiles(), page: { dummy: true } as never, __recorder: rec },
    ).catch(() => {});
    expect(check).toHaveBeenCalledTimes(1);
  });
});

describe("x publish — happy path + dry-run", () => {
  it("uploads the image BEFORE typing the tweet, then submits (ordering)", async () => {
    const order: string[] = [];
    const rec: PublishStepRecorder = {
      openComposer: vi.fn(async () => {
        order.push("open");
      }),
      checkRateLimited: vi.fn(async () => false),
      uploadImage: vi.fn(async () => {
        order.push("upload");
      }),
      typeTweet: vi.fn(async () => {
        order.push("type");
      }),
      submitAndConfirm: vi.fn(async () => {
        order.push("submit");
        return "https://x.com/paxbeach/status/123";
      }),
    };
    const res = await publish(
      { text: "hello", imagePaths: [makeImage()], profile: FAKE_PROFILE },
      { profileManager: makeProfiles(), page: { dummy: true } as never, __recorder: rec },
    );
    expect(order).toEqual(["open", "upload", "type", "submit"]);
    expect(res.account).toBe("paxbeach");
    expect(res.attachments).toHaveLength(1);
  });

  it("dry-run reports the image attachment and never opens the composer", async () => {
    const rec = passingRecorder();
    const res = await publish(
      { text: "hello", imagePaths: [makeImage()], profile: FAKE_PROFILE, dryRun: true },
      { profileManager: makeProfiles(), page: { dummy: true } as never, __recorder: rec },
    );
    expect(res.account).toBe("dry-run");
    expect(rec.openComposer).not.toHaveBeenCalled();
  });
});
