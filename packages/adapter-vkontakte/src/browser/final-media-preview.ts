import { type Locator } from "playwright";

/** Verify final media only inside the active VK publishing modal. */
export async function waitForFinalMediaPreview(
  publishButton: Locator,
  kind: "image" | "video",
  timeout: number,
): Promise<void> {
  const modal = publishButton
    .locator('xpath=ancestor::*[@data-testid="posting_modal_box"]')
    .first();
  await modal.waitFor({ state: "visible", timeout });

  const selector =
    kind === "video"
      ? '[data-testid="primary-attachment-video"]'
      : '[data-testid="primary-attachment-photo"], [data-testid="primary-attachment-image-content"]';
  await modal.locator(selector).first().waitFor({ state: "visible", timeout });

  if (kind === "image") {
    // VK displays a local blob preview before its upload finishes. Clicking
    // Publish during that window briefly loads, then silently returns to the
    // enabled button without creating a wall post. Require the server-backed
    // image URL before allowing submit.
    const persistedImage = modal
      .locator(
        '[data-testid="primary-attachment-image-content"]:not([src^="blob:"]):not([src^="data:"]), [data-testid="primary-attachment-photo"] img:not([src^="blob:"]):not([src^="data:"])',
      )
      .first();
    await persistedImage.waitFor({ state: "visible", timeout });
  }
}
