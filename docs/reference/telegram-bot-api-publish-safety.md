# Telegram Bot API — publish safety & verify-after-publish

> Canonical hardening rules derived from the CONTENT-0376 test-channel incident
> (2026-07-01). A blog post was published to the Telegram test channel via
> `curl` + Bot API; the first `sendVideo` returned an empty body, the real
> `message_id` was lost, and the agent then **misattributed a pre-existing
> foreign message** (a forwarded video from an earlier session) to itself by
> matching caption text. It reported "smoke passed, publishing to prod" on the
> strength of structural metrics and the _local source file_ — never having
> read back what was actually in the channel. A consilium (DevOps + QA +
> reliability roles) produced the rules below. They apply to every agent that
> posts to Telegram via the Bot API, and the spirit applies to all platforms.

## Root cause (what actually happened)

- A malformed `sendVideo` **cannot** attach the correct caption to a foreign
  video — the Bot API does not reuse a random `file_id`. The "right text on the
  wrong video" was **not** a hybrid message the agent created; it was a foreign,
  pre-existing forwarded message (`forward_origin.type=channel`, not
  bot-authored, hence undeletable by the bot) that the agent **wrongly claimed
  as its own** because it had no captured `message_id` to identify by.
- The lost `message_id` came from an **empty API response** on a 47 MB upload:
  `curl -F caption="<file"` (the `<` makes `-F` read the value from a file and
  silently mangles the field), combined with treating the empty/non-JSON body
  as parseable. Once the id was gone, every subsequent check fell back to
  matching by content — unreliable, and the source of the misattribution.

## Rules

### A. Request construction

1. Pass caption/text **only** via `--form-string "caption=$VALUE"` (multipart)
   or `-d`/`--data-urlencode "caption@file"`; **never** `-F caption="<file"` —
   the `<` triggers read-from-file in `-F` and silently corrupts the field.
2. For large media (tens of MB) set an explicit generous `--max-time`; treat a
   timeout as **UNKNOWN → reconcile**, never as success or as blind-retry.

### B. Response handling & idempotency

3. After every `send*` call, require `ok==true` **and** a present
   `result.message_id`. An empty / non-JSON / `ok!=true` body is **UNKNOWN**,
   never success and never a retryable failure.
4. On UNKNOWN, do **not** re-send blindly. Generic single-post flows reconcile against the pre-publish baseline and idempotency marker. Article bundles reconcile against the baseline and any ordered IDs already returned, then stop for inspection; never invent the missing half of the pair.
5. For a Telegram article bundle, capture both ordered `message_id` values from exactly two sequential ordinary posts in the same `chat_id`. Post 1 is media plus bold title; post 2 is title plus complete RU text plus the final linked RU CTA. Neither request may contain `reply_to_message_id`, `message_thread_id`, discussion-group, or comment fields. If either state is UNKNOWN, stop without blind retry.

### C. Message identity (own vs. foreign)

6. Snapshot a **baseline** before publishing: record the channel's current
   `max(message_id)`. Any message with id ≤ baseline is **foreign** and cannot
   be a result of this session.
7. Identify a message as "mine" only by its captured `message_id` plus either bot authorship (`from.id == bot_id`) or real channel authorship (`sender_chat.id == chat_id`), with no `forward_origin`. Never attribute a message by matching caption text.
8. Generic single-post flows may embed a unique idempotency marker (task-id plus nonce). The operator-approved article bundle must preserve the exact title and article text instead: rely on the pre-publish baseline, both ordered returned IDs, target identity, and exact read-back boundaries.

### D. Verify-after-publish (read back the ARTIFACT, not the source)

9. After each publish, **read the message back from Telegram** (forward to an
   inspector chat / parse the returned `Message`). Without a successful
   read-back the post's status is UNKNOWN and the word "verified" is forbidden.
10. Verify by **content, not metrics**: compare the actual media type
    (`video`/`photo`/`text`) and the first & last ~120 chars of the
    caption/text read from the platform against the expected text,
    character-for-character. Length, bold-count and link-presence are necessary
    but never sufficient.
11. Prove the video is **our freshly generated file**: `file_size`, `duration`,
    `width`×`height`, `file_name` read from the platform MUST match the file
    actually sent this cycle. A mismatch = "possibly foreign/old video" = FAIL.
12. For an article bundle, verify the final CTA hidden-link `url` in post 2, verify both posts use the intended `chat.id` (test channel `-1003855619081` on smoke; prod only on go), and verify both responses have no reply/thread linkage.
13. Compare the channel state with the captured baseline and both returned IDs. Pre-existing messages remain foreign to this run and are not deleted by guessed IDs. Any unexpected new message after the baseline is an ambiguity: stop and inspect.

### E. Reporting & gates (source ≠ result)

14. Never say "done / verified / published / smoke passed" without platform
    read-back. Reporting published content from the local source file, the
    spec, the request code, structural metrics, or a bare HTTP 200 is
    **fabricated verification** — forbidden.
15. The smoke→prod gate presents the operator the **actually read-back
    artifacts** (links + `message_id` + read-back content incl. media type,
    author, `forward_origin`), not the agent's own summary. No prod publish
    before an explicit operator "go" on those artifacts.
16. On any doubt / unknown state / unparseable response: **stop and inspect**,
    never report success. State uncertainty plainly ("request sent, state
    unconfirmed"), never mask it with a confident tone.
17. An operator "read it / I don't believe you" **immediately** voids all prior
    status claims and forces an API read-back — do not restate the old report
    in new words.

### F. Body links vs. first-comment CTA (clarified 2026-07-01)

18. Contextual links inside prose are allowed. On FB, LinkedIn, VK, and X, a standalone CTA links block moves to the first comment or reply for that platform. Telegram article publication is the explicit exception: no comment or reply is created, and its only article URL is the final CTA in ordinary channel post 2.
19. Per-platform comment/reply policy is canonical in `skills/publishing/SKILL.md`: X (EN) carries the EN article plus canonical Telegram (RU) post; FB/LI/VK carry blog plus Telegram (RU) plus X (EN), all in one comment. Telegram uses no first comment.

### G. Post title + comment parent (added 2026-07-01, X/FB/LI/VK)

20. **Title first line.** The article title must be the first line on every platform. For Telegram, post 1 contains only media plus the bold title; post 2 starts with the title, continues with the complete RU text, and ends with the linked RU CTA. X/FB/LI/VK use a plain title first line. Verify both Telegram titles in returned content, not only the source file.
21. **Comment parent verify (X/FB/LI/VK only).** Before attaching a first comment/reply, read the target post back and confirm it is the post just published. Telegram article publication has no comment, reply, discussion group, or thread.

### H. Browser-adapter session conflict (LinkedIn/FB, added 2026-07-01)

22. **No parallel session on the same platform during a browser-adapter run.**
    A LinkedIn/Facebook publish via the Playwright adapter can fail with
    `Composer / Post button not found - UI drift` (exit 5) when another
    logged-in session for the same platform is open in a separate browser
    (shared cookies / composer lock). Before a browser-adapter publish, close
    any other tab/window logged into that platform. On exit 5, first read the
    platform feed back to confirm NOTHING was created (no partial post), then
    retry - never assume the failure means 'not posted' without read-back.
23. **Browser-adapter media = OS clipboard (POSIX-file), set right before
    publish and NOT touched until it finishes.** The LinkedIn/Facebook adapters
    ingest media by clipboard paste (publish.ts contract 6.4, media-before-text),
    NOT a file picker - they expect the video/image already on the OS clipboard
    as a POSIX-file reference. `--image <file.mp4>` only sets the hasVideo flag;
    the bytes come from the clipboard. If anything overwrites the clipboard
    between set and publish (copying post text, another file), the paste ingests
    the wrong content, no `<video>` preview appears, and the run fails with
    `composer_not_found` (exit 5) - which reads as 'UI drift' but is really a
    clipboard race. Set the clipboard (`osascript -e 'set the clipboard to
(POSIX file "...")'`) immediately before launch and copy nothing else until
    the publish returns.

### I. Site back-link block — verify each permalink in a browser (added 2026-07-03, X/FB/LI/VK/TG)

24. **Open every back-link URL in a browser and confirm it renders OUR post of
    THIS cycle before writing it into the article's `social` block.** Match the
    post's title/lead against the article, the author account, and the publish
    date. Do NOT trust a URL carried over from a prepared `*-parent-url.txt`, from
    memory, from a `curl` HTTP 200 (Facebook/LinkedIn/X return 200 for a wrong or
    deleted post / a "not found" stub too), or from a first-line-of-file match.
    CONTENT-0376 shipped a `social` block where the Facebook URL (`pfbid0cRG…`)
    pointed at an unrelated older post — the same stale-top-of-feed URL that had
    already mis-landed the first comment — because it was reused from the prepared
    parent-url file without opening it. The operator caught it live: "the FB link
    goes to a different post — you must verify this after publishing."
25. **Do NOT reconstruct FB `pfbid` or LinkedIn share URLs; copy the working URL
    verbatim.** LinkedIn: use the canonical share form
    `linkedin.com/posts/<vanity>_<slug>-share-<activity-id>-<code>/` from the
    post's own "Copy link", NOT a hand-built `feed/update/urn:li:activity:<id>/`
    (that form returned "Post not found" in CONTENT-0376 and even rewrote to a
    different activity id). Facebook: take the post's permalink and strip the
    tracking tail (`?__cft__[0]=…&__tn__=…`), keeping only
    `…/posts/pfbid<...>`. Telegram: the public `t.me/<channel>/<message_id>` form
    is fine; verify the `message_id` via Bot API read-back rather than a web
    screenshot when the web view needs login.
    Only after all links are browser-verified: deploy, then re-`curl`-grep the
    live RU+EN pages to confirm the hrefs shipped.
