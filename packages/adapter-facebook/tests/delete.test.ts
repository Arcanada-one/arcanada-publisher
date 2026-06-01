import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AdapterError, ErrorCode, ProfileManager } from "@arcanada/publisher-core";
import { del } from "../src/delete.js";

function makeProfiles(): ProfileManager {
  const root = mkdtempSync(join(tmpdir(), "pub-0017-fb-del-"));
  mkdirSync(join(root, "facebook", "p1"), { recursive: true });
  return new ProfileManager({ root });
}

const TARGET = "https://www.facebook.com/100012345/posts/777";

describe("facebook delete — read-before-delete (R13 / V-AC-9)", () => {
  it("delete: content mismatch THROWS VERIFY_FAILED and performs NO delete click", async () => {
    const performDelete = vi.fn(async () => {});
    await expect(
      del(
        { targetUrl: TARGET, kind: "post", expectedContent: "the real post text", profile: "p1" },
        {
          profileManager: makeProfiles(),
          page: { dummy: true } as never,
          __readContent: async () => "a COMPLETELY different post that is not the target",
          __performDelete: performDelete as never,
        },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.VERIFY_FAILED });
    expect(performDelete).not.toHaveBeenCalled();
  });

  it("delete: content match performs the delete and returns deleted=true", async () => {
    const performDelete = vi.fn(async () => {});
    const res = await del(
      { targetUrl: TARGET, kind: "post", expectedContent: "hello world", profile: "p1" },
      {
        profileManager: makeProfiles(),
        page: { dummy: true } as never,
        __readContent: async () => "hello world — full rendered post body",
        __performDelete: performDelete as never,
      },
    );
    expect(performDelete).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
    expect(res.deleted).toBe(true);
    expect(res.targetUrl).toBe(TARGET);
  });

  it("delete: rejects empty expectedContent with MISSING_INPUT (cannot verify a blank oracle)", async () => {
    await expect(
      del(
        { targetUrl: TARGET, kind: "post", expectedContent: "", profile: "p1" },
        { profileManager: makeProfiles(), page: { dummy: true } as never },
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it("delete: rejects a non-facebook targetUrl with INVALID_ARGS", async () => {
    await expect(
      del(
        {
          targetUrl: "https://evil.example.com/posts/1",
          kind: "post",
          expectedContent: "x",
          profile: "p1",
        },
        { profileManager: makeProfiles(), page: { dummy: true } as never },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGS });
  });
});
