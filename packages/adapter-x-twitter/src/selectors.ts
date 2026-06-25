// X (Twitter) UI selectors, verified 2026-05-30/31 (init-task reference).
// Stable data-testid attributes are preferred over text, which is localised.

export const selectors = {
  /** Composer textarea (inline composer on home / reply). */
  tweetTextarea: '[data-testid="tweetTextarea_0"]',
  /** Primary post button (inline); falls back to tweetButton on the modal. */
  tweetButtonInline: '[data-testid="tweetButtonInline"]',
  tweetButton: '[data-testid="tweetButton"]',
  /** Hidden image file input (accept image/jpeg…). */
  fileInput: '[data-testid="fileInput"]',
  /**
   * PUB-0033: media-upload progress indicator. X renders a progressbar while an
   * attachment (image or — slowly — a video) uploads; it disappears once the
   * media is fully attached and the post button re-enables.
   */
  mediaProgress: '[role="progressbar"], [data-testid="progressBar"]',
  /** PUB-0033: attached-media preview (present once a video/image settles). */
  attachedMedia: '[data-testid="attachments"], [data-testid="tweetPhoto"], video',
  /** Per-tweet caret → Delete menu. */
  caret: '[data-testid="caret"]',
  /** Logged-in signal: the compose button in the side nav. */
  loginCheck: '[data-testid="SideNav_NewTweet_Button"]',
} as const;

/**
 * R12: X shows an anti-bot rate-limit notice ("You are temporarily limited…")
 * on automated sign-in / rapid actions. Detecting it is mandatory — the limit
 * MUST NOT be circumvented (no proxy rotation, no auto-retry); the adapter
 * stops gracefully and reports.
 */
export const RATE_LIMIT_INDICATOR =
  /(temporarily limited|you are rate limited|too many requests|временно ограничен)/i;

/** True when a page text blob contains an X rate-limit notice. */
export function isRateLimited(blob: string): boolean {
  return RATE_LIMIT_INDICATOR.test(blob);
}
