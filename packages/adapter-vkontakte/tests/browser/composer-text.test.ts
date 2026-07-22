import { describe, expect, it, vi } from "vitest";
import {
  enterAndSettleComposerText,
  waitForFinalTextPreview,
} from "../../src/browser/composer-text.js";

describe("vk browser — composer text persistence", () => {
  it("blurs, settles, and verifies the exact body after insertion", async () => {
    const order: string[] = [];
    const page = {
      keyboard: {
        insertText: vi.fn(async () => {
          order.push("insert");
        }),
      },
      waitForTimeout: vi.fn(async () => {
        order.push("settle");
      }),
    } as never;
    const box = {
      click: vi.fn(async () => order.push("focus")),
      innerText: vi.fn(async () => "Title\n\nBody"),
    } as never;
    const blurTarget = {
      click: vi.fn(async () => order.push("blur")),
    } as never;

    await enterAndSettleComposerText(page, box, blurTarget, "Title\n\nBody");

    expect(order).toEqual(["focus", "insert", "blur", "settle"]);
    expect(page.waitForTimeout).toHaveBeenCalledWith(500);
  });

  it("fails closed when the settled composer body differs", async () => {
    await expect(
      enterAndSettleComposerText(
        { keyboard: { insertText: vi.fn() }, waitForTimeout: vi.fn() } as never,
        { click: vi.fn(), innerText: vi.fn(async () => "Title only") } as never,
        { click: vi.fn() } as never,
        "Title\n\nFull body",
      ),
    ).rejects.toMatchObject({ details: { stage: "composer_text_settle" } });
  });

  it("requires the exact body in the active final preview", async () => {
    const preview = {
      waitFor: vi.fn(async () => undefined),
      innerText: vi.fn(async () => "Title\n\nFull body"),
    };
    const modal = { locator: vi.fn(() => ({ first: () => preview })) };
    const publishButton = {
      locator: vi.fn(() => ({ first: () => modal })),
    } as never;

    await waitForFinalTextPreview(publishButton, "Title\n\nFull body", 30_000);

    expect(publishButton.locator).toHaveBeenCalledWith(
      'xpath=ancestor::*[@data-testid="posting_modal_box"]',
    );
    expect(modal.locator).toHaveBeenCalledWith('[data-testid="showmoretext-in"]');
    expect(preview.waitFor).toHaveBeenCalledWith({ state: "visible", timeout: 30_000 });
  });
});
