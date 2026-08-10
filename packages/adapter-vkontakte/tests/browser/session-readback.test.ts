import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { readSessionState } from "../../src/browser/index.js";

describe("vk browser — live session readback", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("reads the current VK desktop account name from the profile menu", async () => {
    await page.setContent(`
      <button data-testid="header-profile-menu-button">Настройки профиля</button>
      <div data-testid="header-profile-menu" hidden>
        <span class="UserPlaceholder-module_header__fixture">Павел Валентов</span>
      </div>
      <script>
        document.querySelector('[data-testid="header-profile-menu-button"]')
          .addEventListener('click', () => {
            document.querySelector('[data-testid="header-profile-menu"]').hidden = false;
          });
      </script>
    `);

    await expect(readSessionState(page)).resolves.toMatchObject({
      loggedIn: true,
      accountName: "Павел Валентов",
    });
  });

  it("keeps support for legacy numeric profile links", async () => {
    await page.setContent('<a href="/id123456">Profile</a>');

    await expect(readSessionState(page)).resolves.toMatchObject({
      loggedIn: true,
      accountId: "123456",
    });
  });

  it("derives the numeric account id from a current profile-bound media link", async () => {
    await page.setContent('<div data-testid="leftmenu"><a href="/photos277123371">Фото</a></div>');

    await expect(readSessionState(page)).resolves.toMatchObject({
      loggedIn: true,
      accountId: "277123371",
    });
  });

  it("ignores a recommended user's numeric profile link when the account media link is present", async () => {
    await page.setContent(`
      <div data-testid="leftmenu"><a href="/photos277123371">Фото</a></div>
      <a href="/id719266278">Рекомендованный пользователь</a>
    `);

    await expect(readSessionState(page)).resolves.toMatchObject({
      loggedIn: true,
      accountId: "277123371",
    });
  });
});
