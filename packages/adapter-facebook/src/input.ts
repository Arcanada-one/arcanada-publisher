// R6: Facebook treats a raw newline (a multi-line string handed to
// keyboard.type / insertText) as SUBMIT — it sends the field on the first
// "\n", keeping only the first line. The fix: type each line separately and
// press Shift+Enter between lines for a soft line-break.
// A trailing plain Enter (submit:true) is what actually sends a comment.

import { type Page } from "playwright";

export interface TypeMultilineOptions {
  /** Press a final plain Enter after the last line to submit (comments). */
  submit?: boolean;
}

/**
 * Type `text` line-by-line into the focused field, inserting a Shift+Enter soft
 * break between lines so Facebook does not submit early. With `submit:true` a
 * final plain Enter sends the field. The text is split on "\n"; a single-line
 * body never presses Shift+Enter.
 */
export async function typeMultiline(
  page: Page,
  text: string,
  options: TypeMultilineOptions = {},
): Promise<void> {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== "") {
      // insertText is faster and more reliable than per-char type for our text.
      await page.keyboard.insertText(lines[i]);
    }
    if (i < lines.length - 1) {
      await page.keyboard.press("Shift+Enter");
    }
  }
  if (options.submit) {
    await page.keyboard.press("Enter");
  }
}
