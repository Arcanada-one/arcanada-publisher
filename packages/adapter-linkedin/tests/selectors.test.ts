import { describe, it, expect } from "vitest";
import {
  cssSelectors,
  selectors,
  matchesExact,
  isCaptchaBlob,
  shadowClickPatterns,
} from "../src/selectors.js";

/** Compile a JS-regex-literal source string (e.g. "/^x$/i") to a RegExp. */
function compileSource(src: string): RegExp {
  const m = /^\/(.*)\/([a-z]*)$/s.exec(src);
  if (!m) throw new Error(`not a regex literal source: ${src}`);
  return new RegExp(m[1], m[2]);
}

describe("selectors — RU/EN composer & action regex", () => {
  it("startPostButton matches Russian + English labels", () => {
    expect(selectors.startPostButton.test("Начать публикацию")).toBe(true);
    expect(selectors.startPostButton.test("Start a post")).toBe(true);
    expect(selectors.startPostButton.test("Create a post")).toBe(true);
  });

  it("composerDialog matches Russian + English dialog titles", () => {
    expect(selectors.composerDialog.test("Создать пост")).toBe(true);
    expect(selectors.composerDialog.test("Create a post")).toBe(true);
  });

  it("editor matches LinkedIn editor textbox names (RU+EN)", () => {
    expect(selectors.editor.test("Редактор для создания текста")).toBe(true);
    expect(selectors.editor.test("Text editor for creating content")).toBe(true);
    expect(selectors.editor.test("What do you want to talk about?")).toBe(true);
  });

  it("postButton matches Опубликовать EXACTLY (no substring drift)", () => {
    expect(matchesExact("postButton", "Опубликовать")).toBe(true);
    expect(matchesExact("postButton", "Post")).toBe(true);
    expect(matchesExact("postButton", "Не публиковать")).toBe(false);
    expect(matchesExact("postButton", "Опубликовать позже")).toBe(false);
  });

  it("doneButton matches Готово / Done / Далее / Next exact", () => {
    expect(matchesExact("doneButton", "Готово")).toBe(true);
    expect(matchesExact("doneButton", "Done")).toBe(true);
    expect(matchesExact("doneButton", "Далее")).toBe(true);
    expect(matchesExact("doneButton", "Next")).toBe(true);
    expect(matchesExact("doneButton", "Готово к")).toBe(false);
  });

  it("commentBox matches RU/EN comment textbox names", () => {
    expect(selectors.commentBox.test("Добавить комментарий")).toBe(true);
    expect(selectors.commentBox.test("Add a comment")).toBe(true);
    expect(selectors.commentBox.test("Текстовое поле комментария")).toBe(true);
  });

  // PUB-0032: the live 2026 DE-locale comment composer is «Kommentar hinzufügen»
  // — the prior set missed it and the first-comment never posted.
  it("commentBox matches the German + Finnish comment labels (PUB-0032)", () => {
    expect(selectors.commentBox.test("Kommentar hinzufügen")).toBe(true);
    expect(selectors.commentBox.test("Kommentar schreiben")).toBe(true);
    expect(selectors.commentBox.test("Lisää kommentti")).toBe(true);
  });

  it("commentBox and structural CSS cover the Finnish 2026 TipTap composer", () => {
    expect(selectors.commentBox.test("Tekstieditori kommentin luomiseen")).toBe(true);
    expect(cssSelectors.commentEditor).toContain("div.tiptap.ProseMirror");
  });

  it("post control-menu matches DE/FI labels via editPostAction* (PUB-0032)", () => {
    expect(selectors.editPostActionEn.test("Mehr Aktionen")).toBe(true);
    expect(selectors.editPostActionEn.test("Steuerungsmenü öffnen")).toBe(true);
    expect(selectors.editPostActionEn.test("Lisää toimintoja")).toBe(true);
    expect(
      selectors.editPostActionEn.test("Avaa hallintavalikko tekijän Pavel Valentov julkaisulle"),
    ).toBe(true);
    expect(selectors.editPostActionEn.test("More actions")).toBe(true);
  });

  it("deleteMenuItem + confirmDelete match DE/FI labels (PUB-0032)", () => {
    expect(matchesExact("deleteMenuItem", "Beitrag löschen")).toBe(true);
    expect(matchesExact("deleteMenuItem", "Löschen")).toBe(true);
    expect(matchesExact("deleteMenuItem", "Poista")).toBe(true);
    expect(matchesExact("confirmDelete", "Löschen")).toBe(true);
    expect(matchesExact("confirmDelete", "Poista")).toBe(true);
  });

  // PUB-0032: shadow-walk DOM-click pattern SOURCES must stay in sync with the
  // Playwright-locator regexes and cover the same multi-locale labels.
  it("shadowClickPatterns cover multi-locale control-menu / delete / confirm", () => {
    const ctl = compileSource(shadowClickPatterns.postControlMenu);
    expect(ctl.test("Mehr Aktionen")).toBe(true);
    expect(ctl.test("Open control menu")).toBe(true);
    expect(ctl.test("Avaa hallintavalikko tekijän Pavel Valentov julkaisulle")).toBe(true);
    expect(ctl.test("Открыть меню")).toBe(true);

    const del = compileSource(shadowClickPatterns.deleteMenuItem);
    expect(del.test("Löschen")).toBe(true);
    expect(del.test("Delete post")).toBe(true);
    expect(del.test("Удалить")).toBe(true);
    expect(del.test("Do not delete")).toBe(false);

    const confirm = compileSource(shadowClickPatterns.confirmDelete);
    expect(confirm.test("Löschen")).toBe(true);
    expect(confirm.test("Delete")).toBe(true);
  });

  it("isCaptchaBlob detects RU/EN security-check signals", () => {
    expect(isCaptchaBlob("Пожалуйста, подтвердите, что вы человек")).toBe(true);
    expect(isCaptchaBlob("Please verify you are human")).toBe(true);
    expect(isCaptchaBlob("Security check required to continue")).toBe(true);
    expect(isCaptchaBlob("Welcome back to LinkedIn")).toBe(false);
  });

  it("PUB-0033: does NOT flag the ordinary feed as a captcha (false-positive fix)", () => {
    // The verified-badge / profile "Verifications" strings appear on a healthy
    // logged-in feed — they must not be read as a security check.
    expect(isCaptchaBlob("Verifications")).toBe(false);
    expect(isCaptchaBlob("Pavel Valentov · Verified · Founder and CEO")).toBe(false);
    expect(isCaptchaBlob("Add to your feed — Verifications on your profile")).toBe(false);
    // A genuine challenge still trips it.
    expect(isCaptchaBlob("Please complete this captcha to continue")).toBe(true);
  });
});
