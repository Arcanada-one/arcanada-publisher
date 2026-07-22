import { describe, expect, it, vi } from "vitest";
import { waitForFinalMediaPreview } from "../../src/browser/final-media-preview.js";

describe("vk browser — final media preview", () => {
  it("scopes the image oracle to the modal that owns the publish button", async () => {
    const previewWait = vi.fn(async () => undefined);
    const preview = { waitFor: previewWait };
    const previewCollection = { first: vi.fn(() => preview) };
    const persistedWait = vi.fn(async () => undefined);
    const persisted = { waitFor: persistedWait };
    const persistedCollection = { first: vi.fn(() => persisted) };
    const modal = {
      waitFor: vi.fn(async () => undefined),
      locator: vi.fn((selector: string) =>
        selector.includes(':not([src^="blob:"])') ? persistedCollection : previewCollection,
      ),
    };
    const modalCollection = { first: vi.fn(() => modal) };
    const publishButton = {
      locator: vi.fn(() => modalCollection),
    } as never;

    await waitForFinalMediaPreview(publishButton, "image", 30_000);

    expect(publishButton.locator).toHaveBeenCalledWith(
      'xpath=ancestor::*[@data-testid="posting_modal_box"]',
    );
    expect(modal.waitFor).toHaveBeenCalledWith({ state: "visible", timeout: 30_000 });
    expect(modal.locator).toHaveBeenCalledWith(
      '[data-testid="primary-attachment-photo"], [data-testid="primary-attachment-image-content"]',
    );
    expect(previewCollection.first).toHaveBeenCalledOnce();
    expect(previewWait).toHaveBeenCalledWith({ state: "visible", timeout: 30_000 });
    expect(modal.locator).toHaveBeenCalledWith(
      '[data-testid="primary-attachment-image-content"]:not([src^="blob:"]):not([src^="data:"]), [data-testid="primary-attachment-photo"] img:not([src^="blob:"]):not([src^="data:"])',
    );
    expect(persistedCollection.first).toHaveBeenCalledOnce();
    expect(persistedWait).toHaveBeenCalledWith({ state: "visible", timeout: 30_000 });
  });
});
