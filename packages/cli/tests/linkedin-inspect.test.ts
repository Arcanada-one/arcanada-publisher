import { beforeEach, describe, expect, it, vi } from "vitest";

const inspectComposer = vi.fn(async () => ({
  editorAncestors: [],
  postControls: [],
  candidates: [],
}));

vi.mock("../src/adapters.js", () => ({
  makeAdapter: () => ({ inspectComposer }),
}));

describe("CLI LinkedIn composer inspect", () => {
  beforeEach(() => inspectComposer.mockClear());

  it("routes inspect without target-url to the read-only composer probe", async () => {
    const { run } = await import("../src/run.js");
    const result = await run(["inspect", "--platform", "linkedin", "--profile", "p1"]);
    expect(result.code).toBe(0);
    expect(inspectComposer).toHaveBeenCalledWith("p1");
    expect(JSON.parse(result.message)).toEqual({
      editorAncestors: [],
      postControls: [],
      candidates: [],
    });
  });

  it("rejects LinkedIn inspect with a target-url before adapter IO", async () => {
    const { run } = await import("../src/run.js");
    const result = await run([
      "inspect",
      "--platform",
      "linkedin",
      "--target-url",
      "https://www.linkedin.com/posts/example",
    ]);
    expect(result.code).not.toBe(0);
    expect(inspectComposer).not.toHaveBeenCalled();
  });
});
