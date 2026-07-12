// Migrated from Arcanada-one/li-publish@7ddadf81a1662abd66d7f04ea2b7acf737d6afe2 on 2026-05-21
// Source: bin/li-publish.sh + bin/li-comment.sh + bin/li-edit-post.sh + lib/playwright-helpers.sh
//
// LinkedIn UI selectors. RU/EN regex variants. Native equivalents of bash
// pw_find_ref{,_exact}. INFRA-0259 bypass — we never query «Add a photo» button
// directly; setInputFiles on the hidden input[type=file] elides the shadow-DOM
// intercept that broke the legacy click path.

// PUB-0031: prefer language-agnostic HTML/CSS hooks over localized text.
// LinkedIn ships its UI in the account's display language (we have seen RU, EN,
// and Finnish), so matching on visible button TEXT is fragile. The stable hooks
// below are class/attribute selectors that do not change with locale; the text
// regexes are kept only as a last-resort fallback and now include Finnish.
export const cssSelectors = {
  // PUB-0033: the 2026 LinkedIn feed obfuscates component class names, so the
  // old `share-box-feed-entry__trigger` class no longer matches and the trigger
  // is now a <div role-less> element, not a <button>. The ONLY stable hook left
  // is the aria-label — but the LinkedIn FEED can be served in a different
  // display language than the account setting (an en-US account still saw a
  // Finnish feed from an edge cache), so we match the aria-label across every
  // locale we have observed (EN/RU/DE/FI). Legacy class selectors stay as a
  // final fallback for older UIs.
  startPostButton:
    "[aria-label='Start a post'], [aria-label='Создать публикацию'], [aria-label='Начать публикацию'], [aria-label='Aloita julkaisu'], [aria-label='Beitrag beginnen'], button.share-box-feed-entry__trigger, .share-box-feed-entry__top-bar button, button.artdeco-button[class*='share-box']",
  // Composer dialog — share-creation modal. data-test-modal is still stable in
  // the 2026 UI.
  composerDialog: "div[data-test-modal], div[role='dialog'] .share-creation-state, div.share-box",
  // Quill rich-text editor inside the composer.
  editor: "div.ql-editor[contenteditable='true'], div[role='textbox'][contenteditable='true']",
  // Primary publish action — `share-actions__primary-action` is still present in
  // the 2026 composer.
  postButton: "button.share-actions__primary-action, button[class*='share-actions__primary']",
  // PUB-0033: the composer media affordance is an aria-labelled «Add media»
  // button. Cross-locale aria-label (EN/RU/DE/FI) for the same feed-language
  // mismatch reason as the start-post trigger.
  addMediaButton:
    "div[data-test-modal] button[aria-label='Add media'], button[aria-label='Add media'], button[aria-label='Добавить медиафайлы'], button[aria-label='Добавить медиа'], button[aria-label='Lisää mediaa'], button[aria-label='Medien hinzufügen']",
  // Hidden native file input(s) for media (image + video share the same input).
  fileInput: "input[type='file']",
  // PUB-0032: comment composer — structural fallback when the localized
  // accessible-name match misses (e.g. DE «Kommentar hinzufügen»). LinkedIn
  // renders the comment box as a Quill contenteditable inside a comments box
  // wrapper; these class/attribute hooks are locale-independent.
  commentTipTapEditor: "div.tiptap.ProseMirror[contenteditable='true']",
  commentLegacyEditor:
    "div.comments-comment-box__form .ql-editor[contenteditable='true'], div[class*='comments-comment-box'] div[role='textbox'][contenteditable='true'], div.ql-editor[contenteditable='true'][data-placeholder]",
  commentEditor:
    "div.tiptap.ProseMirror[contenteditable='true'], div.comments-comment-box__form .ql-editor[contenteditable='true'], div[class*='comments-comment-box'] div[role='textbox'][contenteditable='true'], div.ql-editor[contenteditable='true'][data-placeholder]",
} as const;

export const selectors = {
  // Finnish added (Aloita julkaisu / Luo julkaisu) alongside RU/EN. These are
  // FALLBACK only — cssSelectors above are tried first (see publish.ts/login.ts).
  startPostButton:
    /^(Начать публикацию|Создать публикацию|Start a post|Create a post|Aloita julkaisu|Luo julkaisu)/,
  composerDialog:
    /^(Создать пост|Создать публикацию|Create a post|Create post|Luo julkaisu|Luo postaus)/,
  editor:
    /^(Текстовое поле для написания контента|Редактор для создания текста|Text editor for creating content|What do you want to talk about\?|О чём вы хотите рассказать\?|Mistä haluat puhua\?)/,
  postButton: /^(Опубликовать|Post|Julkaise)$/,
  doneButton: /^(Готово|Done|Далее|Next|Valmis|Seuraava)$/,
  saveButton: /^(Сохранить|Save|Tallenna)$/,
  // PUB-0032: widened with the German label «Kommentar hinzufügen» (the live
  // 2026 composer on a DE-locale account did not match the prior set → comment
  // composer timed out). Finnish «Lisää kommentti» added alongside.
  commentBox:
    /^(Добавить комментарий|Написать комментарий|Add a comment|Write a comment|Kommentar hinzufügen|Kommentar schreiben|Lisää kommentti|Tekstieditori kommentin luomiseen|Текстовое поле комментария|Comment text field)/,
  commentSubmitButton:
    /^(Отправить|Опубликовать|Send|Post|Comment|Senden|Kommentieren|Lähetä|Kommentoi)$/,
  editPostActionRu: /^(Открыть меню|Действия|Параметры|Открыть панель управления|Дополнительно)/,
  // PUB-0032: the post control-menu («...») drifted/localized. Added DE «Mehr
  // Aktionen / Steuerungsmenü öffnen» and FI «Lisää toimintoja» so the delete +
  // comment flows find the kebab regardless of UI language.
  editPostActionEn:
    /^(Open control menu|Open options menu|More actions|More|Mehr Aktionen|Steuerungsmenü öffnen|Avaa hallintavalikko|Lisää toimintoja)/,
  editPostMenuItem: /^(Редактировать публикацию|Редактировать пост|Edit post|Beitrag bearbeiten)$/,
  // R10: LinkedIn tolerates in-place comment edit (unlike Facebook). The kebab
  // on a comment carries a per-author aria-label; `Edit` opens the inline editor
  // and `Save changes` (not `Save`) commits it.
  commentOptionsMenu: /(View more options for|Открыть дополнительные действия|Ещё действия)/,
  commentEditMenuItem: /^(Изменить|Редактировать|Edit)$/,
  commentSaveChanges: /^(Сохранить изменения|Save changes)$/,
  // PUB-0032: DE «Beitrag löschen / Löschen» + FI «Poista» added.
  deleteMenuItem:
    /^(Удалить публикацию|Удалить пост|Удалить|Delete post|Delete|Beitrag löschen|Löschen|Poista julkaisu|Poista)$/,
  confirmDelete: /^(Удалить|Delete|Löschen|Poista)$/,
  showOriginal: /^(Show original|Näytä alkuperäinen|Original anzeigen|Показать оригинал)$/,
  loginEmail: /^(Email or phone|Эл\.? адрес или номер телефона)$/,
  // PUB-0033: the bare token `verifications` was a false-positive magnet — it
  // appears in the ordinary logged-in feed (profile "Verifications" section,
  // verified-account badges in the right-rail recommendations), so a full-page
  // content read classified a healthy feed as a captcha and failed the publish
  // closed. Only real challenge phrases gate now; the verified-badge string was
  // never a genuine security-check indicator.
  captchaIndicator:
    /(captcha|подтвердите,? что вы человек|verify you are (?:a )?human|security check|проверка безопасности|перейдите по ссылке для проверки)/i,
  rateLimitIndicator:
    /(временно (?:заблокирован|приостановлен)|temporarily (?:restricted|blocked)|too many requests)/i,
} as const;

// PUB-0032: JS-regex-literal SOURCE strings for the shadow-walk DOM-click path
// (src/dom-shadow.ts → shadowClickButtonJs). The post control-menu, the Delete
// menu-item, and the Delete confirm button can sit behind the interop-outlet
// shadow root, where a Playwright pointer-click is intercepted — the same reason
// publish.ts clicks via the shadow walker. These mirror the `selectors` regexes
// above but as literal sources embeddable in a `page.evaluate(...)` string. Keep
// the alternations in sync with `selectors.editPostAction*` / `deleteMenuItem` /
// `confirmDelete`.
export const shadowClickPatterns = {
  postControlMenu:
    "/(Open control menu|Open options menu|More actions|More|Mehr Aktionen|Steuerungsmenü öffnen|Avaa hallintavalikko|Lisää toimintoja|Открыть меню|Действия|Параметры|Открыть панель управления|Дополнительно)/i",
  deleteMenuItem:
    "/^(Delete post|Delete|Beitrag löschen|Löschen|Poista julkaisu|Poista|Удалить публикацию|Удалить пост|Удалить)$/i",
  confirmDelete: "/^(Delete|Löschen|Poista|Удалить)$/i",
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
