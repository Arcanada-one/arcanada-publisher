import { describe, it, expect } from "vitest";
import { selectors, matchesExact, isCaptchaBlob } from "../src/selectors.js";

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

  it("isCaptchaBlob detects RU/EN security-check signals", () => {
    expect(isCaptchaBlob("Пожалуйста, подтвердите, что вы человек")).toBe(true);
    expect(isCaptchaBlob("Please verify you are human")).toBe(true);
    expect(isCaptchaBlob("Security check required to continue")).toBe(true);
    expect(isCaptchaBlob("Welcome back to LinkedIn")).toBe(false);
  });
});
