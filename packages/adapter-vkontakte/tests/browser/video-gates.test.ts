import { describe, it, expect } from "vitest";
import { ErrorCode } from "@arcanada/publisher-core";
import { runVkPublish, type VkPublishSteps } from "../../src/browser/publish.js";
import { type SessionState } from "../../src/browser/session-guard.js";

const OK_SESSION: SessionState = {
  loggedIn: true,
  accountId: "12345",
  accountName: "Pavel Valentov",
  url: "https://vk.com/feed",
};

function recorderSteps(overrides: Partial<VkPublishSteps> = {}): {
  steps: VkPublishSteps;
  calls: string[];
} {
  const calls: string[] = [];
  const steps: VkPublishSteps = {
    readSession: async () => {
      calls.push("readSession");
      return OK_SESSION;
    },
    readRecentPosts: async () => {
      calls.push("readRecentPosts");
      return [];
    },
    uploadMediaAndAwaitReady: async () => {
      calls.push("uploadVideo");
    },
    typeText: async () => {
      calls.push("typeText");
    },
    preSubmitSnapshot: async () => {
      calls.push("preSubmitSnapshot");
      return { hasText: true, hasMedia: true };
    },
    submit: async () => {
      calls.push("submit");
      return "https://vk.com/wall12345_100";
    },
    readBack: async () => {
      calls.push("readBack");
      return {
        account: "Pavel Valentov",
        text: "полный текст",
        hasVideo: true,
        hasImage: false,
      };
    },
    ...overrides,
  };
  return { steps, calls };
}

const INPUT = {
  text: "полный текст",
  mediaPath: "/tmp/x.mp4",
  mediaKind: "video" as const,
  profile: "vika",
  expectedAccount: { accountId: "12345" },
};

describe("vk browser — media-first ordering (video before text, gate before submit)", () => {
  it("uploads video and awaits readiness BEFORE typing text and BEFORE submit", async () => {
    const { steps, calls } = recorderSteps();
    await runVkPublish(INPUT, steps);
    const iVideo = calls.indexOf("uploadVideo");
    const iText = calls.indexOf("typeText");
    const iSnap = calls.indexOf("preSubmitSnapshot");
    const iSubmit = calls.indexOf("submit");
    expect(iVideo).toBeGreaterThanOrEqual(0);
    expect(iVideo).toBeLessThan(iText);
    expect(iText).toBeLessThan(iSnap);
    expect(iSnap).toBeLessThan(iSubmit);
  });

  it("asserts identity BEFORE any upload (readSession is first)", async () => {
    const { steps, calls } = recorderSteps();
    await runVkPublish(INPUT, steps);
    expect(calls[0]).toBe("readSession");
    expect(calls.indexOf("readSession")).toBeLessThan(calls.indexOf("uploadVideo"));
  });

  it("ABORTS with VERIFY_FAILED (never submits) if the pre-submit snapshot lacks the video", async () => {
    const { steps, calls } = recorderSteps({
      preSubmitSnapshot: async () => ({ hasText: true, hasMedia: false }),
    });
    await expect(runVkPublish(INPUT, steps)).rejects.toMatchObject({
      code: ErrorCode.VERIFY_FAILED,
    });
    expect(calls).not.toContain("submit");
  });

  it("ABORTS with VERIFY_FAILED if the pre-submit snapshot lacks the text", async () => {
    const { steps } = recorderSteps({
      preSubmitSnapshot: async () => ({ hasText: false, hasMedia: true }),
    });
    await expect(runVkPublish(INPUT, steps)).rejects.toMatchObject({
      code: ErrorCode.VERIFY_FAILED,
    });
  });

  it("STOPs before upload when the wrong account is logged in", async () => {
    const { steps, calls } = recorderSteps({
      readSession: async () => ({ ...OK_SESSION, accountId: "99999" }),
    });
    await expect(runVkPublish(INPUT, steps)).rejects.toMatchObject({
      code: ErrorCode.VERIFY_FAILED,
    });
    expect(calls).not.toContain("uploadVideo");
  });
});
