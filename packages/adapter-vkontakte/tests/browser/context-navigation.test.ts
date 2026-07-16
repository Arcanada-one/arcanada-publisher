import { describe, expect, it, vi } from "vitest";
import { type Page } from "playwright";
import { openVkFeed, VK_AUTHED_SELECTOR, VK_FEED_URL } from "../../src/browser/context.js";

describe("vk browser — persistent-session navigation", () => {
  it("opens the VK feed before session readback", async () => {
    const goto = vi.fn().mockResolvedValue(null);
    const waitFor = vi.fn().mockResolvedValue(undefined);
    const first = vi.fn().mockReturnValue({ waitFor });
    const locator = vi.fn().mockReturnValue({ first });
    const page = { goto, locator } as unknown as Page;

    await openVkFeed(page);

    expect(goto).toHaveBeenCalledOnce();
    expect(goto).toHaveBeenCalledWith(VK_FEED_URL, { waitUntil: "domcontentloaded" });
    expect(locator).toHaveBeenCalledWith(VK_AUTHED_SELECTOR);
    expect(waitFor).toHaveBeenCalledWith({ state: "visible", timeout: 15_000 });
  });
});
