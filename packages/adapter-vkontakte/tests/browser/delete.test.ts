import { describe, expect, it } from "vitest";
import { ErrorCode } from "@arcanada/publisher-core";
import { runVkDelete, type VkDeleteSteps } from "../../src/browser/delete.js";

const INPUT = {
  targetUrl: "https://vk.ru/wall277123371_468",
  expectedContent: "Павел Валентов",
  profile: "default",
  expectedAccount: { accountName: "Павел Валентов" },
};

function makeSteps(overrides: Partial<VkDeleteSteps> = {}): {
  steps: VkDeleteSteps;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    steps: {
      readSession: async () => {
        calls.push("session");
        return {
          loggedIn: true,
          accountName: "Павел Валентов",
          url: INPUT.targetUrl,
        };
      },
      readTarget: async () => {
        calls.push("read-before");
        return {
          wallId: "277123371_468",
          author: "Павел Валентов",
          renderedContent: "Павел Валентов\nДействия",
          deleted: false,
        };
      },
      performDelete: async () => {
        calls.push("delete");
      },
      readAfter: async () => {
        calls.push("read-after");
        return { wallId: "277123371_468", deleted: true };
      },
      ...overrides,
    },
  };
}

describe("vk browser delete", () => {
  it("binds the exact wall id, verifies identity/content, deletes once, and reads back", async () => {
    const { steps, calls } = makeSteps();
    const result = await runVkDelete(INPUT, steps);

    expect(result).toMatchObject({
      deleted: true,
      targetUrl: INPUT.targetUrl,
      account: "277123371",
    });
    expect(calls).toEqual(["session", "read-before", "delete", "read-after"]);
  });

  it("rejects a foreign host before any mutation", async () => {
    const { steps, calls } = makeSteps();
    await expect(
      runVkDelete({ ...INPUT, targetUrl: "https://example.com/wall277123371_468" }, steps),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGS });
    expect(calls).not.toContain("delete");
  });

  it("fails closed when the rendered wall id differs", async () => {
    const { steps, calls } = makeSteps({
      readTarget: async () => ({
        wallId: "277123371_467",
        author: "Павел Валентов",
        renderedContent: "Павел Валентов",
        deleted: false,
      }),
    });
    await expect(runVkDelete(INPUT, steps)).rejects.toMatchObject({
      code: ErrorCode.VERIFY_FAILED,
    });
    expect(calls).not.toContain("delete");
  });

  it("fails closed when the rendered content oracle does not match", async () => {
    const { steps, calls } = makeSteps({
      readTarget: async () => ({
        wallId: "277123371_468",
        author: "Павел Валентов",
        renderedContent: "Другая запись",
        deleted: false,
      }),
    });
    await expect(runVkDelete(INPUT, steps)).rejects.toMatchObject({
      code: ErrorCode.VERIFY_FAILED,
    });
    expect(calls).not.toContain("delete");
  });

  it("reports an unknown destructive outcome when read-after cannot prove deletion", async () => {
    const { steps } = makeSteps({
      readAfter: async () => ({ wallId: "277123371_468", deleted: false }),
    });
    await expect(runVkDelete(INPUT, steps)).rejects.toMatchObject({
      code: ErrorCode.VERIFY_FAILED,
      details: { reconcileRequired: true },
    });
  });
});
