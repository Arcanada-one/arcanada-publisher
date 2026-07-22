import { AdapterError, ErrorCode } from "@arcanada/publisher-core";
import { type Locator, type Page } from "playwright";

const COMPOSER_TEXT_SETTLE_MS = 500;

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Enter text, commit the contenteditable state with blur, then verify it. */
export async function enterAndSettleComposerText(
  page: Page,
  box: Locator,
  blurTarget: Locator,
  text: string,
): Promise<void> {
  await box.click();
  await page.keyboard.insertText(text);
  await blurTarget.click();
  await page.waitForTimeout(COMPOSER_TEXT_SETTLE_MS);

  const settled = await box.innerText().catch(() => "");
  if (normalize(settled) !== normalize(text)) {
    throw textError("vk composer text did not settle exactly — STOP", "composer_text_settle");
  }
}

/** Require the full expected body in VK's active final preview before submit. */
export async function waitForFinalTextPreview(
  publishButton: Locator,
  expectedText: string,
  timeout: number,
): Promise<void> {
  const modal = publishButton
    .locator('xpath=ancestor::*[@data-testid="posting_modal_box"]')
    .first();
  const preview = modal.locator('[data-testid="showmoretext-in"]').first();
  await preview.waitFor({ state: "visible", timeout });
  const rendered = await preview.innerText().catch(() => "");
  if (!normalize(rendered).includes(normalize(expectedText))) {
    throw textError(
      "vk final preview does not contain the full expected body — STOP",
      "final_text_preview",
    );
  }
}

function textError(message: string, stage: string): AdapterError {
  return new AdapterError(ErrorCode.VERIFY_FAILED, message, { stage });
}
