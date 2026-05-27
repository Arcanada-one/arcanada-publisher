// Migrated from Arcanada-one/li-publish@7ddadf81a1662abd66d7f04ea2b7acf737d6afe2 on 2026-05-21 (PUB-0004)
// Source: bin/li-publish.sh + bin/li-comment.sh + bin/li-edit-post.sh + lib/playwright-helpers.sh
//
// LinkedIn UI selectors. RU/EN regex variants. Native equivalents of bash
// pw_find_ref{,_exact}. INFRA-0259 bypass — we never query «Add a photo» button
// directly; setInputFiles on the hidden input[type=file] elides the shadow-DOM
// intercept that broke the legacy click path.

export const selectors = {
  startPostButton: /^(Начать публикацию|Создать публикацию|Start a post|Create a post)/,
  composerDialog: /^(Создать пост|Создать публикацию|Create a post|Create post)/,
  editor:
    /^(Текстовое поле для написания контента|Редактор для создания текста|Text editor for creating content|What do you want to talk about\?|О чём вы хотите рассказать\?)/,
  postButton: /^(Опубликовать|Post)$/,
  doneButton: /^(Готово|Done|Далее|Next)$/,
  saveButton: /^(Сохранить|Save)$/,
  commentBox:
    /^(Добавить комментарий|Написать комментарий|Add a comment|Write a comment|Текстовое поле комментария|Comment text field)/,
  editPostActionRu: /^(Открыть меню|Действия|Параметры)/,
  editPostActionEn: /^(Open control menu|Open options menu|More)/,
  editPostMenuItem: /^(Редактировать публикацию|Редактировать пост|Edit post)$/,
  loginEmail: /^(Email or phone|Эл\.? адрес или номер телефона)$/,
  captchaIndicator:
    /(captcha|verifications|подтвердите, что вы человек|verify you are human|security check|проверка безопасности)/i,
  rateLimitIndicator:
    /(временно (?:заблокирован|приостановлен)|temporarily (?:restricted|blocked)|too many requests)/i,
} as const;

export type SelectorKey = keyof typeof selectors;

/** Test the literal name string against a selector regex. */
export function matchesExact(key: SelectorKey, candidate: string): boolean {
  const re = selectors[key];
  return re.test(candidate);
}

/** Detect captcha / security-check indicator anywhere in a text blob. */
export function isCaptchaBlob(blob: string): boolean {
  return selectors.captchaIndicator.test(blob);
}
