import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { ErrorCode } from "@arcanada/publisher-core";
import { guardPlatformRefusals } from "../../src/browser/index.js";

describe("vk browser — visible platform refusal guard", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("ignores dormant captcha strings inside the VK application bundle", async () => {
    await page.setContent(`
      <main>Обычная авторизованная страница</main>
      <script>window.__messages = { captcha: "security check" };</script>
    `);

    await expect(guardPlatformRefusals(page)).resolves.toBeUndefined();
  });

  it("stops on a visible bot challenge", async () => {
    await page.setContent("<main>Подтвердите, что вы не робот</main>");

    await expect(guardPlatformRefusals(page)).rejects.toMatchObject({ code: ErrorCode.RATE_LIMIT });
  });
});
