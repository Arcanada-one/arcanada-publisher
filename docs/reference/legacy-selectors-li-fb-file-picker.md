# Legacy fallback — LinkedIn/Facebook file-picker media attach (preserved from li-publish / fb-publish)

> Knowledge salvaged before the retired `li-publish` and `fb-publish` bash/Playwright
> CLIs were deleted from the ecosystem (2026-07-03). The current adapters attach
> media by **clipboard paste** (media-before-text, policy §6.4 in
> `docs/explanation/social-links-and-comments-policy.md`) — the reliable path today.
> This note keeps the *old* file-chooser + multi-image orchestration on record in
> case a LinkedIn/Facebook UI revert ever makes the clipboard path stop working and
> the file-picker path has to be re-engineered. It is NOT the current contract.

## Why the current adapters use clipboard paste, not the file picker

Clicking LinkedIn's `aria-label="Add media"` (or Facebook's photo/video button)
opens a **native OS file chooser**. Driving that from automation is brittle
(the native dialog is out-of-page) and the media-editor sub-modal it spawns has
to be dismissed with a `Next`/`Done` click per image. The clipboard-paste path
(`ControlOrMeta+V` into the focused composer, with the POSIX-file already on the
OS clipboard) avoids both problems and is what the adapters do now.

## Legacy LinkedIn multi-image loop (from `li-publish.sh`, retired)

LinkedIn's 2026 composer lives inside `<div id="interop-outlet">` **open shadow
DOM**. The old CLI walked the shadow tree to click buttons and looped one file
per Playwright `upload` call (multi-arg upload was unsupported):

- First image trigger — `aria-label`/text matches `^(Add media|Добавить медиа)$`.
- Each subsequent image — the image-editor sidebar's `^(Add|Добавить)$` button.
- After all uploads — a `^(Next|Далее|Done|Готово|Save|Сохранить)$` button
  (retried up to 8×) returns from the media editor to the composer.
- Then a VERIFY-BEFORE-PUBLISH gate confirmed an image preview was actually
  present before clicking Post — refusing rather than shipping a text-only post.

The shadow-walk helper: `page.evaluate` recursing through every element's
`shadowRoot`, collecting visible non-disabled `button,[role=button]`, matching on
`aria-label` OR `innerText` against an inlined case-insensitive regex, then
`.click()` from inside the shadow root. The modern equivalent lives in
`packages/adapter-linkedin/src/dom-shadow.ts` (`shadowClickButtonJs`), which is
multi-locale (RU/EN/DE/FI) and shared across publish/comment/delete — prefer it.

## Legacy Facebook composer invariants (from `fb-publish.sh`, retired)

- **Image upload re-renders the composer and wipes typed text** → always type the
  body AFTER the image is attached (R8 invariant in the current adapter).
- **A media-editor textbox overlays the composer after an image attach** → focus
  the `.last()` textbox, not the first.
- **In-place comment edit is broken on Facebook** (contenteditable collapses to
  the first line on focus/clear; keystrokes don't print) → the current adapter
  fails closed on edit-comment and uses `replaceComment()` (delete old + add new).
  This is R10; do not try to "fix" in-place edit.
- **Text-only posts are forbidden** (R1 image-mandatory): a bare-text FB post gets
  external-link downranked and tanks reach. The current adapter requires ≥1 image.

## Locale coverage note

The retired CLIs handled RU + EN only and failed silently in DE/FI. The current
adapters' `selectors.ts` cover Finnish and German as well (a LinkedIn account can
be served a Finnish feed from an edge cache even with an en-US display language —
PUB-0033). Any re-engineering off this legacy note must re-add DE/FI selectors.
