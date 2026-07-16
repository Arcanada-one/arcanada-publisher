import { describe, expect, it, vi } from "vitest";
import { type Page } from "playwright";
import { targetPost } from "../../src/browser/index.js";

describe("vk browser — direct wall post binding", () => {
  it("binds the sole post container when the current page is the exact parent permalink", () => {
    const first = vi.fn().mockReturnValue({ marker: "post" });
    const locator = vi.fn().mockReturnValue({ first });
    const page = {
      url: () => "https://vk.ru/wall277123371_464",
      locator,
    } as unknown as Page;

    targetPost(page, "https://vk.ru/wall277123371_464");

    expect(locator).toHaveBeenCalledWith('[data-testid="post"]');
    expect(first).toHaveBeenCalledOnce();
  });

  it("keeps the wall-id anchor binding outside the exact permalink page", () => {
    const first = vi.fn().mockReturnValue({ marker: "post" });
    const locator = vi.fn().mockReturnValue({ first });
    const page = {
      url: () => "https://vk.ru/pavelvalentov",
      locator,
    } as unknown as Page;

    targetPost(page, "https://vk.ru/wall277123371_464");

    expect(locator).toHaveBeenCalledWith('[data-testid="post"]:has(a[href*="/wall277123371_464"])');
    expect(first).toHaveBeenCalledOnce();
  });
});
