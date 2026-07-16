import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { ErrorCode } from "@arcanada/publisher-core";
import { resolveSavedDraft } from "../../src/browser/index.js";

describe("vk browser — explicit saved-draft resolution", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("fails closed when a saved draft exists and reset is not armed", async () => {
    await page.setContent('<button aria-label="Открыть черновик">Открыть черновик</button>');

    await expect(resolveSavedDraft(page, false)).rejects.toMatchObject({
      code: ErrorCode.VERIFY_FAILED,
    });
  });

  it("resets an explicitly armed draft and verifies a clean composer", async () => {
    await page.setContent(`
      <button id="saved">Открыть черновик</button>
      <button id="restart">Начать заново</button>
      <script>
        document.querySelector('#restart').addEventListener('click', () => {
          document.body.innerHTML = [
            '<h1 data-testid="modalheader-title">Новый пост</h1>',
            '<div data-testid="posting_base_screen_input_message" contenteditable="true"></div>'
          ].join('');
        });
      </script>
    `);

    await expect(resolveSavedDraft(page, true)).resolves.toBeUndefined();
  });

  it("fails if reset does not produce a clean composer", async () => {
    await page.setContent(`
      <button>Открыть черновик</button>
      <button id="restart">Начать заново</button>
      <script>
        document.querySelector('#restart').addEventListener('click', () => {
          document.body.innerHTML = [
            '<h1 data-testid="modalheader-title">Новый пост</h1>',
            '<div data-testid="posting_attachment_item">video</div>',
            '<div data-testid="posting_base_screen_input_message" contenteditable="true"></div>'
          ].join('');
        });
      </script>
    `);

    await expect(resolveSavedDraft(page, true)).rejects.toMatchObject({
      code: ErrorCode.VERIFY_FAILED,
    });
  });
});
