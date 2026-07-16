import { describe, it, expect } from "vitest";
import { ErrorCode } from "@arcanada/publisher-core";
import { runVkComment, type VkCommentSteps } from "../../src/browser/comment.js";
import { type SessionState } from "../../src/browser/session-guard.js";

const OK_SESSION: SessionState = {
  loggedIn: true,
  accountId: "12345",
  accountName: "Pavel Valentov",
  url: "https://vk.com/wall12345_100",
};

const FOUR_LINKS = [
  "https://t.me/valentovtypes/214",
  "https://x.com/VeritasArcanaAI/status/2077684096742858800",
  "https://cubrim.com/ru/addressor",
  "https://arcanada.ai/ru/blog/cubrim-global-addresser",
];

function commentSteps(overrides: Partial<VkCommentSteps> = {}): {
  steps: VkCommentSteps;
  calls: string[];
} {
  const calls: string[] = [];
  const steps: VkCommentSteps = {
    readSession: async () => {
      calls.push("readSession");
      return OK_SESSION;
    },
    postTopLevelComment: async () => {
      calls.push("post");
      return { commentId: "555", replyToCommentId: undefined };
    },
    readBackComment: async () => {
      calls.push("readBack");
      return { text: FOUR_LINKS.join("\n"), isReply: false, links: [...FOUR_LINKS] };
    },
    ...overrides,
  };
  return { steps, calls };
}

const INPUT = {
  parentPostUrl: "https://vk.com/wall12345_100",
  links: FOUR_LINKS,
  profile: "vika",
  expectedAccount: { accountId: "12345" },
};

describe("vk browser — top-level comment binding (no reply)", () => {
  it("posts exactly one top-level comment after asserting identity", async () => {
    const { steps, calls } = commentSteps();
    const res = await runVkComment(INPUT, steps);
    expect(res.commentId).toBe("555");
    expect(calls.indexOf("readSession")).toBeLessThan(calls.indexOf("post"));
  });

  it("STOPs with VERIFY_FAILED if the composer bound the comment as a REPLY (misbinding)", async () => {
    const { steps } = commentSteps({
      postTopLevelComment: async () => ({ commentId: "555", replyToCommentId: "42" }),
    });
    await expect(runVkComment(INPUT, steps)).rejects.toMatchObject({
      code: ErrorCode.VERIFY_FAILED,
    });
  });

  it("STOPs with VERIFY_FAILED if read-back shows the comment is a reply", async () => {
    const { steps } = commentSteps({
      readBackComment: async () => ({ text: FOUR_LINKS.join("\n"), isReply: true, links: [...FOUR_LINKS] }),
    });
    await expect(runVkComment(INPUT, steps)).rejects.toMatchObject({
      code: ErrorCode.VERIFY_FAILED,
    });
  });

  it("rejects a parentPostUrl on the wrong host before posting", async () => {
    const { steps, calls } = commentSteps();
    await expect(
      runVkComment({ ...INPUT, parentPostUrl: "https://evil.example/wall1_2" }, steps),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGS });
    expect(calls).not.toContain("post");
  });
});

describe("vk browser — comment 4-link read-back", () => {
  it("STOPs with VERIFY_FAILED if a link is missing from the read-back", async () => {
    const { steps } = commentSteps({
      readBackComment: async () => ({
        text: FOUR_LINKS.slice(0, 3).join("\n"),
        isReply: false,
        links: FOUR_LINKS.slice(0, 3),
      }),
    });
    await expect(runVkComment(INPUT, steps)).rejects.toMatchObject({
      code: ErrorCode.VERIFY_FAILED,
    });
  });

  it("STOPs with VERIFY_FAILED if the link ORDER differs from the required order", async () => {
    const swapped = [FOUR_LINKS[1], FOUR_LINKS[0], FOUR_LINKS[2], FOUR_LINKS[3]];
    const { steps } = commentSteps({
      readBackComment: async () => ({ text: swapped.join("\n"), isReply: false, links: swapped }),
    });
    await expect(runVkComment(INPUT, steps)).rejects.toMatchObject({
      code: ErrorCode.VERIFY_FAILED,
    });
  });

  it("rejects an input that does not carry exactly 4 links", async () => {
    const { steps } = commentSteps();
    await expect(
      runVkComment({ ...INPUT, links: FOUR_LINKS.slice(0, 3) }, steps),
    ).rejects.toMatchObject({ code: ErrorCode.MISSING_INPUT });
  });
});
