import { describe, it, expect } from "vitest";
import { selectors, matchesExact, isCaptchaBlob } from "../src/selectors.js";

describe("selectors — RU/EN composer & action regex", () => {
  it("composerButton matches Russian composer label", () => {
    expect(selectors.composerButton.test("Что у вас нового, Pavel?")).toBe(true);
  });

  it("composerButton matches English composer label", () => {
    expect(selectors.composerButton.test("What's on your mind?")).toBe(true);
  });

  it("publishButton matches Опубликовать EXACTLY (no substring drift)", () => {
    expect(matchesExact("publishButton", "Опубликовать")).toBe(true);
    // pw_find_ref_exact contract: "Настройки планирования Опубликовать сейчас"
    // must NOT match the publish button (exact-name regex anchored)
    expect(matchesExact("publishButton", "Настройки планирования Опубликовать сейчас")).toBe(false);
  });

  it("nextButton matches Далее exact", () => {
    expect(matchesExact("nextButton", "Далее")).toBe(true);
    expect(matchesExact("nextButton", "Next")).toBe(true);
    expect(matchesExact("nextButton", "Далее за")).toBe(false);
  });

  it("editedMarker matches Отредактировано / Edited exact", () => {
    expect(matchesExact("editedMarker", "Отредактировано")).toBe(true);
    expect(matchesExact("editedMarker", "Edited")).toBe(true);
    expect(matchesExact("editedMarker", "Не отредактировано")).toBe(false);
  });

  it("commentComposer matches every observed first-comment textbox label (PUB-0030)", () => {
    // Feed-post variant (original, was already covered)
    expect(selectors.commentComposer.test("Напишите комментарий…")).toBe(true);
    expect(selectors.commentComposer.test("Write a comment…")).toBe(true);
    // Profile-post permalink variant — the regression: a fresh publish lands on
    // the profile post whose composer is labelled «Комментировать как <name>».
    expect(selectors.commentComposer.test("Комментировать как Pavel Valentov")).toBe(true);
    expect(selectors.commentComposer.test("Comment as Pavel Valentov")).toBe(true);
    expect(selectors.commentComposer.test("Прокомментировать")).toBe(true);
    expect(selectors.commentComposer.test("Add a comment…")).toBe(true);
    // Must NOT match unrelated UI
    expect(selectors.commentComposer.test("Опубликовать")).toBe(false);
    expect(selectors.commentComposer.test("Что у вас нового, Pavel?")).toBe(false);
  });

  it("isCaptchaBlob detects RU/EN security-check signals", () => {
    expect(isCaptchaBlob("Пройдите проверку безопасности, чтобы продолжить")).toBe(true);
    expect(isCaptchaBlob("Please complete the security check")).toBe(true);
    expect(isCaptchaBlob("All quiet, no captcha here yet… wait — captcha!")).toBe(true);
    expect(isCaptchaBlob("Welcome back to Facebook")).toBe(false);
  });
});
