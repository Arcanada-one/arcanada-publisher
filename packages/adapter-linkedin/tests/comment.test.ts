import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AdapterError, ErrorCode, ProfileManager } from "@arcanada/publisher-core";
import { comment } from "../src/comment.js";

const FAKE_PROFILE = "vitest-fake-profile";
const PARENT_OK = "https://www.linkedin.com/feed/update/urn:li:activity:7462962260978642944/";
const FOREIGN_HOST = "https://evil.example.com/feed/update/urn:li:activity:123/";
const RECOMMENDED_CARD = "https://www.linkedin.com/company/lazy-programmer/posts/";

describe("comment — parent verify round-trip", () => {
  it("rejects parentPostUrl with non-LinkedIn host (INVALID_ARGS)", async () => {
    await expect(
      comment(
        { parentPostUrl: FOREIGN_HOST, text: "hi", profile: FAKE_PROFILE },
        { verifyParent: async () => true },
      ),
    ).rejects.toBeInstanceOf(AdapterError);
    try {
      await comment(
        { parentPostUrl: FOREIGN_HOST, text: "hi", profile: FAKE_PROFILE },
        { verifyParent: async () => true },
      );
    } catch (err) {
      expect((err as AdapterError).code).toBe(ErrorCode.INVALID_ARGS);
    }
  });

  it("rejects parentPostUrl that is not an activity URN (INFRA-0260 surface)", async () => {
    await expect(
      comment(
        { parentPostUrl: RECOMMENDED_CARD, text: "hi", profile: FAKE_PROFILE },
        { verifyParent: async () => true },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGS });
  });

  it("rejects with VERIFY_FAILED (6) when verifyParent reports unreachable parent", async () => {
    try {
      await comment(
        { parentPostUrl: PARENT_OK, text: "hi", profile: FAKE_PROFILE },
        { verifyParent: async () => false },
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).code).toBe(ErrorCode.VERIFY_FAILED);
      expect((err as AdapterError).code).toBe(6);
      expect((err as AdapterError).details).toMatchObject({
        liErrorType: "verify_mismatch",
      });
    }
  });

  it("rejects with MISSING_INPUT when text is empty / whitespace-only", async () => {
    await expect(
      comment(
        { parentPostUrl: PARENT_OK, text: "   ", profile: FAKE_PROFILE },
        { verifyParent: async () => true },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.MISSING_INPUT });
  });

  it("rejects unparseable parentPostUrl with INVALID_ARGS", async () => {
    await expect(
      comment(
        { parentPostUrl: "not a url", text: "hi", profile: FAKE_PROFILE },
        { verifyParent: async () => true },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGS });
  });
});

describe("comment — TipTap submit and exact post verification", () => {
  const text = "Exact first comment\nhttps://example.com/article";

  it("recognizes the live hashed comment body and removes LinkedIn's collapsed suffix", async () => {
    const module = (await import("../src/comment.js")) as unknown as {
      commentContainerSelector?: string;
      normalizeRenderedCommentText?: (value: string) => string;
    };
    expect(module.commentContainerSelector ?? "").toContain(
      "[data-testid='expandable-text-box']",
    );
    expect(module.normalizeRenderedCommentText?.(`${text}\n\n… more`)).toBe(text);
  });

  it("submits the Finnish TipTap composer without requiring an ancestor form", async () => {
    const harness = makeCommentPage({
      mode: "tiptap",
      postMatches: [{ text, id: "9001" }],
    });
    const result = await runComment(text, harness.page);
    expect(result.commentId).toBe("9001");
    expect(harness.submitClick).toHaveBeenCalledTimes(1);
    expect(harness.keyboardPress).not.toHaveBeenCalledWith("Control+Enter");
  });

  it("uses the nearest composer button and ignores farther and global localized decoys", async () => {
    const harness = makeCommentPage({
      mode: "tiptap",
      postMatches: [{ text, id: "9011" }],
    });
    const result = await runComment(text, harness.page);
    expect(result.commentId).toBe("9011");
    expect(harness.submitClick).toHaveBeenCalledTimes(1);
    expect(harness.farSubmitClick).not.toHaveBeenCalled();
    expect(harness.globalSubmitClick).not.toHaveBeenCalled();
  });

  it("uses Ctrl+Enter only for the legacy Quill editor", async () => {
    const harness = makeCommentPage({
      mode: "legacy",
      postMatches: [{ text, id: "9002" }],
    });
    const result = await runComment(text, harness.page);
    expect(result.commentId).toBe("9002");
    expect(harness.submitClick).not.toHaveBeenCalled();
    expect(harness.keyboardPress).toHaveBeenCalledWith("Control+Enter");
  });

  it("fails TipTap closed when no enabled localized submit button exists", async () => {
    const harness = makeCommentPage({ mode: "tiptap", submitEnabled: false });
    await expect(runComment(text, harness.page)).rejects.toMatchObject({
      code: ErrorCode.PUBLISH_BUTTON_ABSENT,
    });
    expect(harness.submitIsEnabled).toHaveBeenCalledTimes(20);
    expect(harness.submitClick).not.toHaveBeenCalled();
    expect(harness.keyboardPress).not.toHaveBeenCalledWith("Control+Enter");
  });

  it("waits for the TipTap submit button to become enabled", async () => {
    const harness = makeCommentPage({
      mode: "tiptap",
      submitEnabled: [false, false, true],
      postMatches: [{ text, id: "9004" }],
    });
    const result = await runComment(text, harness.page);
    expect(result.commentId).toBe("9004");
    expect(harness.submitIsEnabled).toHaveBeenCalledTimes(3);
    expect(harness.submitClick).toHaveBeenCalledTimes(1);
  });

  it("fails when exact submitted text never appears even if a generic comment id exists", async () => {
    const harness = makeCommentPage({
      mode: "legacy",
      legacyExtractedId: "9999",
      postMatches: [{ text: "Different comment", id: "9999" }],
    });
    await expect(runComment(text, harness.page)).rejects.toMatchObject({
      code: ErrorCode.VERIFY_FAILED,
    });
  });

  it("returns an explicit verified evidence id only after exact new text appears without a DOM id", async () => {
    const harness = makeCommentPage({ mode: "tiptap", postMatches: [{ text, id: "" }] });
    const result = await runComment(text, harness.page);
    expect(result.commentId).toMatch(/^verified:7462962260978642944:[a-f0-9]{16}$/);
    expect(harness.submitClick).toHaveBeenCalledTimes(1);
  });

  it("prefers a real comment id over an id-less exact wrapper match", async () => {
    const harness = makeCommentPage({
      mode: "tiptap",
      postMatches: [
        { text, id: "" },
        { text, id: "9010" },
      ],
    });
    const result = await runComment(text, harness.page);
    expect(result.commentId).toBe("9010");
  });

  it("fails before submit when the exact comment text already exists at baseline", async () => {
    const harness = makeCommentPage({
      mode: "legacy",
      baselineMatches: [{ text, id: "8000" }],
      postMatches: [{ text, id: "9003" }],
      legacyExtractedId: "9003",
    });
    await expect(runComment(text, harness.page)).rejects.toMatchObject({
      code: ErrorCode.VERIFY_FAILED,
    });
    expect(harness.keyboardPress).not.toHaveBeenCalled();
    expect(harness.submitClick).not.toHaveBeenCalled();
  });

  it("fails closed when an old exact match loads after baseline but before submit", async () => {
    const harness = makeCommentPage({
      mode: "tiptap",
      preSubmitSnapshots: [[], [{ text, id: "8001" }]],
      postMatches: [{ text, id: "9005" }],
    });
    await expect(runComment(text, harness.page)).rejects.toMatchObject({
      code: ErrorCode.VERIFY_FAILED,
    });
    expect(harness.submitClick).not.toHaveBeenCalled();
    expect(harness.keyboardPress).not.toHaveBeenCalled();
  });
});

interface CommentMatch {
  text: string;
  id: string;
}

interface CommentPageOptions {
  mode: "tiptap" | "legacy";
  submitEnabled?: boolean | boolean[];
  baselineMatches?: CommentMatch[];
  preSubmitSnapshots?: CommentMatch[][];
  postMatches?: CommentMatch[];
  legacyExtractedId?: string;
}

function makeCommentPage(options: CommentPageOptions): {
  page: never;
  submitClick: ReturnType<typeof vi.fn>;
  submitIsEnabled: ReturnType<typeof vi.fn>;
  farSubmitClick: ReturnType<typeof vi.fn>;
  globalSubmitClick: ReturnType<typeof vi.fn>;
  keyboardPress: ReturnType<typeof vi.fn>;
} {
  let submitted = false;
  let preSubmitRead = 0;
  let enabledRead = 0;
  const submitClick = vi.fn(async () => {
    submitted = true;
  });
  const farSubmitClick = vi.fn(async () => {
    submitted = true;
  });
  const globalSubmitClick = vi.fn(async () => {
    submitted = true;
  });
  const keyboardPress = vi.fn(async (key: string) => {
    if (options.mode === "legacy" && key === "Control+Enter") submitted = true;
  });
  const submitIsEnabled = vi.fn(async () => {
    if (!Array.isArray(options.submitEnabled)) return options.submitEnabled ?? true;
    const value = options.submitEnabled[Math.min(enabledRead, options.submitEnabled.length - 1)];
    enabledRead += 1;
    return value;
  });
  const failing = makeLocator(false);
  const submit = makeLocator(true, {
    click: submitClick,
    isEnabled: submitIsEnabled,
  });
  const farSubmit = makeLocator(true, { click: farSubmitClick });
  const globalSubmit = makeLocator(true, { click: globalSubmitClick });
  const topParent = makeLocator(true, {
    getByRole: () => farSubmit,
  });
  const nearestComposer = makeLocator(true, {
    getByRole: () => submit,
    locator: (selector: string) => (selector === "xpath=.." ? topParent : failing),
  });
  let editorParent = nearestComposer;
  for (let depth = 1; depth < 6; depth += 1) {
    const parent = editorParent;
    editorParent = makeLocator(true, {
      getByRole: () => failing,
      locator: (selector: string) => (selector === "xpath=.." ? parent : failing),
    });
  }
  const tiptap = makeLocator(options.mode === "tiptap", {
    locator: (selector: string) => (selector === "xpath=.." ? editorParent : failing),
  });
  const legacy = makeLocator(options.mode === "legacy", {
    locator: () => nearestComposer,
  });
  const page = {
    goto: vi.fn(async () => {}),
    getByRole: (role: string) => {
      if (role === "textbox") return options.mode === "legacy" ? legacy : tiptap;
      if (role === "button") return globalSubmit;
      return failing;
    },
    locator: (selector: string) => {
      if (selector.includes("tiptap")) return tiptap;
      if (selector.includes("ql-editor") || selector.includes("comments-comment-box"))
        return legacy;
      return failing;
    },
    keyboard: { insertText: vi.fn(async () => {}), press: keyboardPress },
    waitForTimeout: vi.fn(async () => {}),
    evaluate: vi.fn(
      async (source: unknown, expectedArg?: string | { expected: string }) => {
      if (typeof source === "string") {
        return submitted ? (options.legacyExtractedId ?? options.postMatches?.[0]?.id ?? "") : "";
      }
      const expected =
        typeof expectedArg === "string" ? expectedArg : (expectedArg?.expected ?? "");
      const matches = submitted
        ? (options.postMatches ?? [])
        : (options.preSubmitSnapshots?.[preSubmitRead++] ?? options.baselineMatches ?? []);
      return matches.filter((match) => match.text === expected);
      },
    ),
    isClosed: vi.fn(() => true),
  };
  return {
    page: page as never,
    submitClick,
    submitIsEnabled,
    farSubmitClick,
    globalSubmitClick,
    keyboardPress,
  };
}

function makeLocator(
  visible: boolean,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const locator: Record<string, unknown> = {
    first: () => locator,
    count: async () => (visible ? 1 : 0),
    waitFor: async () => {
      if (!visible) throw new Error("locator not visible");
    },
    click: vi.fn(async () => {}),
    isEnabled: async () => true,
    locator: () => locator,
    getByRole: () => locator,
    ...overrides,
  };
  return locator;
}

async function runComment(text: string, page: never) {
  const root = mkdtempSync(join(tmpdir(), "content-0377-li-comment-"));
  mkdirSync(join(root, "linkedin", "p1"), { recursive: true });
  return comment(
    { parentPostUrl: PARENT_OK, text, profile: "p1" },
    {
      profileManager: new ProfileManager({ root }),
      page,
      verifyParent: async () => true,
    },
  );
}
