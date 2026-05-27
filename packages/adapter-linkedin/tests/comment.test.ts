import { describe, it, expect } from "vitest";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";
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
