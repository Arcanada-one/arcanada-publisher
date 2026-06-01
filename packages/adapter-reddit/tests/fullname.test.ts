import { describe, it, expect } from "vitest";
import { fullname, commentParent, isCommentFullname, isPostFullname } from "../src/fullname.js";

describe("reddit fullname helpers (V-AC-12 oracle)", () => {
  it("comment id → t1_ fullname", () => {
    expect(fullname("comment", "abc")).toBe("t1_abc");
  });

  it("post id → t3_ fullname", () => {
    expect(fullname("post", "xyz")).toBe("t3_xyz");
  });

  it("is idempotent — an already-prefixed id is returned unchanged", () => {
    expect(fullname("comment", "t1_abc")).toBe("t1_abc");
    expect(fullname("post", "t3_xyz")).toBe("t3_xyz");
  });

  it("commentParent: a reply to a comment is t1_<id>", () => {
    expect(commentParent("comment", "l9abc12")).toBe("t1_l9abc12");
  });

  it("commentParent: a top-level comment on a post is t3_<id>", () => {
    expect(commentParent("post", "p0st99")).toBe("t3_p0st99");
  });

  it("classifiers distinguish t1_ from t3_", () => {
    expect(isCommentFullname("t1_abc")).toBe(true);
    expect(isCommentFullname("t3_abc")).toBe(false);
    expect(isPostFullname("t3_abc")).toBe(true);
    expect(isPostFullname("t1_abc")).toBe(false);
  });

  it("throws on an empty id", () => {
    expect(() => fullname("comment", "")).toThrow();
  });
});
