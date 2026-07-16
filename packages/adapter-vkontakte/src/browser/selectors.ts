// Pure Playwright selector constants for the VK web composer (2026 VKUI SPA).
//
// VK's web UI is a React SPA (VKUI) whose CSS classes are hashed at build time,
// so selectors are built on role / aria-label / visible text (RU + EN variants),
// never on class names. Every selector here MUST be re-verified on the first
// headed run and captured into datarim/tasks/PUB-0034-fixtures.md — until then
// these are best-effort forms from the research (INSIGHTS § live-UI).

export const selectors = {
  /** Wall composer entry ("What's new?"). */
  composerButton: /^(Что у вас нового|Что нового|What's new|What is new|Напишите что-нибудь)/i,
  /** Composer text area. */
  composerTextbox: /^(Напишите что-нибудь|Текст записи|Write something|Post text)/i,
  /** Attach-video control in the composer. */
  attachVideo: /^(Видеозапись|Видео|Video)$/i,
  /** Publish button. */
  publishButton: /^(Опубликовать|Отправить|Publish|Post)$/i,
  /** Comment composer on a wall post. */
  commentComposer: /(Написать комментарий|Комментировать|Write a comment|Add a comment)/i,
  /** Comment submit. */
  commentSubmit: /^(Отправить|Send|Comment)$/i,
  /** Attached-media preview (present once a video settles). */
  attachedVideoPreview: '[data-testid="video_preview"], video, .VideoPreview, .MediaGrid__interactive',
  /** Captcha / bot-check indicator. */
  captchaIndicator: /(captcha|введите код|подтвердите, что вы не робот|security check|confirm you are (not a robot|human))/i,
  /** Platform "links are forbidden" refusal (VK error 222 analogue in UI). */
  linksForbiddenIndicator: /(ссылки запрещены|нельзя добавлять ссылки|hyperlinks are forbidden|links are not allowed)/i,
} as const;

export type SelectorKey = keyof typeof selectors;

/** Detect a captcha / bot-check indicator anywhere in a text blob. */
export function isCaptchaBlob(blob: string): boolean {
  return selectors.captchaIndicator.test(blob);
}

/** Detect a "links forbidden" platform refusal anywhere in a text blob. */
export function isLinksForbiddenBlob(blob: string): boolean {
  return selectors.linksForbiddenIndicator.test(blob);
}
