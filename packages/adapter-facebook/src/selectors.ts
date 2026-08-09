// Migrated from Arcanada-one/fb-publish@8df49fa51822795075f746ad7389c8bd400b1aa4 on 2026-05-21
// Source: lib/playwright-helpers.sh (pw_find_ref_exact / pw_classify_error patterns)
//
// Pure Playwright selector constants. RU/EN regex variants for FB UI.
// Native equivalents of bash pw_find_ref{,_exact}: getByRole({ name: REGEX, exact: true? }).

export const selectors = {
  composerButton:
    /^(Что у вас нового|Что у Вас нового|What's on your mind|What is on your mind|Создать публикацию|Create post)/,
  composerDialog: /^(Создать публикацию|Create post)$/,
  nextButton: /^(Далее|Next)$/,
  publishButton: /^(Опубликовать|Post|Publish)$/,
  saveButton: /^(Сохранить|Save)$/,
  editPostAction: /^(Действия|Actions).*для этой публикации/,
  editPostActionEn: /^Actions for this post$/,
  editPostMenuItem: /^(Редактировать публикацию|Edit post)$/,
  editPostMenuItemFallback: /^(Редактировать или удалить|Edit or delete)$/,
  editPostMenuItemDelegated: /^(Редактировать|Edit)$/,
  commentEditMenu: /^(Изменить|Edit)$/,
  // First-comment composer textbox. FB labels this textbox differently depending
  // on surface and A/B variant: a feed post shows «Напишите комментарий…» /
  // "Write a comment…", while a profile-post permalink (the surface a fresh
  // publish lands on) shows «Комментировать как <name>» / "Comment as <name>".
  // PUB-0030: the original regex only matched the feed variant, so first-comment
  // posting timed out on profile posts. Cover every observed label variant.
  commentComposer:
    /(Напишите комментарий|Прокомментировать|Комментировать как|Write a comment|Comment as|Add a comment)/,
  // R10: comment-actions kebab — opens the "edit / delete / report" menu on a
  // comment block (FB 2026 aria-label, RU/EN variants).
  //
  // PUB-0039: on an OWN comment Facebook labels this control «Редактировать или
  // удалить» / "Edit or delete" (no "report" — you cannot report yourself). The
  // original pattern only covered the third-party wording, so the kebab of our
  // own comment was invisible and comment deletion failed with "found 0"
  // (observed live 2026-08-02). Both wordings must match.
  commentActionsMenu:
    /(Редактировать, удалить или пожаловаться|Редактировать или удалить|Comment actions|Действия для комментария|Edit or delete)/,
  // The post action menu labels this item "Удалить публикацию" / "Delete post",
  // not a bare "Удалить" — an exact-match on the bare verb finds nothing and the
  // delete dies after the menu is already open (observed live 2026-08-09).
  // The optional noun stays anchored so this cannot drift onto the adjacent
  // "Редактировать публикацию" / "Edit post" item sitting one row above.
  deleteMenuItem: /^(Удалить(\s+публикацию)?|Move to trash|Delete(\s+post)?)$/,
  confirmDelete: /^(Удалить|Переместить|Move|Delete)$/,
  editedMarker: /^(Отредактировано|Edited)$/,
  loginEmail: /^(Эл\. адрес или номер мобильного телефона|Email or phone number)$/,
  captchaIndicator:
    /(captcha|проверк[ауи] безопасности|security check|подтвердите, что вы человек|confirm you are human)/i,
  rateLimitIndicator: /(временно заблокирован|temporarily blocked|too many requests)/i,
} as const;

export type SelectorKey = keyof typeof selectors;

/** Test the literal name string against a selector regex with exact semantics. */
export function matchesExact(key: SelectorKey, candidate: string): boolean {
  const re = selectors[key];
  // Build anchored equivalent: many selectors already include ^ and $; for prefix-only
  // ones (composerButton) we treat the regex as prefix-only and require full-string match.
  return re.test(candidate);
}

/** Detect FB captcha / security-check indicator anywhere in a text blob. */
export function isCaptchaBlob(blob: string): boolean {
  return selectors.captchaIndicator.test(blob);
}
