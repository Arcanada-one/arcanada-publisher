import { describe, it, expect } from "vitest";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";
import { comment } from "../src/comment.js";

const FAKE_PROFILE = "vitest-fake-profile";
const PARENT_OK = "https://www.facebook.com/100012345/posts/987654321";
const FOREIGN_HOST = "https://evil.example.com/posts/123";

describe("comment — parent-id verify round-trip (AC-6)", () => {
  it("rejects parentPostUrl with non-Facebook host (AdapterError INVALID_ARGS)", async () => {
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

  it("rejects with code 6 (VERIFY_FAILED) when verifyParent reports unreachable parent (negative parent_id)", async () => {
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
        fbErrorType: "verify_mismatch",
      });
    }
  });

  it("rejects with MISSING_INPUT when text is empty", async () => {
    await expect(
      comment(
        { parentPostUrl: PARENT_OK, text: "   ", profile: FAKE_PROFILE },
        { verifyParent: async () => true },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.MISSING_INPUT });
  });
});
