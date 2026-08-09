import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AdapterError, ErrorCode, ProfileManager } from "@arcanada/publisher-core";
import { del, defaultReadContent, extractPermalinkId } from "../src/delete.js";
import { selectors } from "../src/selectors.js";

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

describe("read-before-delete oracle binds to the target post, not the first article (§6.8)", () => {
  const TARGET =
    "https://www.facebook.com/pavelvalentov/posts/pfbid02G8Z5jfY2MPrkGDigVtioTLWmAu6JaipDoWwgm99edGCZvVefBZSGq22o23uAxrKtl";

  it("extracts the pfbid identity from a permalink", () => {
    expect(extractPermalinkId(TARGET)).toBe(
      "pfbid02G8Z5jfY2MPrkGDigVtioTLWmAu6JaipDoWwgm99edGCZvVefBZSGq22o23uAxrKtl",
    );
    expect(extractPermalinkId("https://www.facebook.com/pavelvalentov")).toBeNull();
  });

  it("reads the article carrying the target pfbid, not a neighbouring post", async () => {
    // A permalink page renders several articles. Only one is ours.
    const selectorsSeen: string[] = [];
    const page = {
      goto: () => Promise.resolve(),
      locator: (sel: string) => {
        selectorsSeen.push(sel);
        const isScoped = sel.includes("pfbid02G8Z5jf");
        return {
          first: () => ({
            waitFor: () => Promise.resolve(),
            innerText: () =>
              Promise.resolve(
                isScoped ? "our duplicate post body" : "SOMEONE ELSE'S RECOMMENDED POST",
              ),
          }),
        };
      },
    } as unknown as Parameters<typeof defaultReadContent>[0];

    const seen = await defaultReadContent(page, {
      targetUrl: TARGET,
      expectedContent: "our duplicate post body",
      profile: "default",
    } as unknown as Parameters<typeof defaultReadContent>[1]);

    expect(seen).toBe("our duplicate post body");
    // The unscoped `[role="article"]` selector must never be the one used.
    expect(selectorsSeen.every((s) => s.includes("pfbid02G8Z5jf"))).toBe(true);
  });

  it("falls back to the first article only when the URL carries no pfbid", async () => {
    const page = {
      goto: () => Promise.resolve(),
      locator: (sel: string) => {
        expect(sel).toBe('[role="article"]');
        return {
          first: () => ({
            waitFor: () => Promise.resolve(),
            innerText: () => Promise.resolve("legacy body"),
          }),
        };
      },
    } as unknown as Parameters<typeof defaultReadContent>[0];

    const seen = await defaultReadContent(page, {
      targetUrl: "https://www.facebook.com/pavelvalentov/posts/12345",
      expectedContent: "legacy body",
      profile: "default",
    } as unknown as Parameters<typeof defaultReadContent>[1]);
    expect(seen).toBe("legacy body");
  });
});

describe("deleteMenuItem selector matches the real menu label and nothing adjacent", () => {
  // Facebook labels the item "Удалить публикацию" / "Delete post". An exact
  // match on the bare verb found nothing, so delete died with the menu already
  // open (observed live 2026-08-09). Widening it must not reach the
  // "Редактировать публикацию" row directly above.
  it.each(["Удалить публикацию", "Удалить", "Delete post", "Delete", "Move to trash"])(
    "matches %s",
    (label) => {
      expect(selectors.deleteMenuItem.test(label)).toBe(true);
    },
  );

  it.each([
    "Редактировать публикацию",
    "Редактировать аудиторию",
    "Редактировать дату",
    "Сохранить публикацию",
    "Выключить переводы",
    "Вставить на сайт",
    "Edit post",
    "Delete comment",
  ])("does NOT match %s", (label) => {
    expect(selectors.deleteMenuItem.test(label)).toBe(false);
  });
});
