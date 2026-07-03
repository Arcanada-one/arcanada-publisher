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
4. On UNKNOWN, do **not** re-send blindly (duplicate risk). Reconcile: compare
   the channel's current bot-authored messages against the **baseline max
   `message_id` captured BEFORE publishing**, and identify by a unique
   idempotency marker embedded in the caption — then decide retry vs. abort.
5. Capture and thread the real `message_id`: the longread's
   `reply_to_message_id` MUST be the captured id of post 1. If post 1's id is
   UNKNOWN, do **not** send post 2 (no orphaned/mis-linked longread).

### C. Message identity (own vs. foreign)

6. Snapshot a **baseline** before publishing: record the channel's current
   `max(message_id)`. Any message with id ≤ baseline is **foreign** and cannot
   be a result of this session.
7. Identify a message as "mine" **only** by captured `message_id` + bot
   authorship (`from.id == bot_id`, no `forward_origin`). **Never** attribute a
   message to yourself because its caption text matches — that is exactly how
   the foreign forwarded video was misclaimed.
8. Embed a unique idempotency marker (task-id + nonce) in each post's caption;
   it is both the dedup key on retry and the "mine vs. foreign" signal on
   inspection.

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
12. Verify the hidden link's actual `url` (from `entities.text_link` or
    `reply_markup.*.url`) and the reply linkage (`reply_to_message.message_id`
    of post 2 points at post 1, same `chat.id`), and that `chat.id` is the
    intended target (test channel `-1003855619081` on smoke; prod only on go).
13. Inspect the **whole** channel state before declaring smoke, not just "my"
    messages: count messages, flag any foreign video / foreign author /
    `forward_origin` / leftover from prior sessions. Any stray artifact = smoke
    NOT passed → stop and clean.

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

18. Contextual links inside the post body (sources, the prior article, standards
    bodies, inline product mentions) are **allowed** - they are part of the prose.
    Only a standalone CTA "links block" (a `Links / Resources` header + URL list)
    is forbidden in the body; it moves to the first comment.
19. Per-platform first comment (canonical set in `skills/publishing/SKILL.md`
    section "Universal rule"): Telegram = one link, the article in the post's
    language; **X (EN) = the EN article + the canonical Telegram (RU) post**,
    each language-labelled; FB/LI/VK = blog (platform language) + Telegram (RU)
    - X (EN), all in one comment.

### G. Post title + comment parent (added 2026-07-01, X/FB/LI/VK)

20. **Title first line.** The article title (or a title-equivalent headline in
    the post's language) MUST be the first line of the post body on EVERY
    platform (X, FB, LinkedIn, VK, Telegram), then a blank line, then the lead.
    A post opening straight into the lead loses the hook. Telegram: bold first
    line of the video caption. X/FB/LI/VK: plain first line (no `<b>` - those
    flatten HTML). Verify the title is present in the read-back, not just the
    source file.
21. **Comment parent verify.** Before attaching the first comment, confirm the
    target post is the one JUST published this cycle - read its body/media back
    and match it to THIS article. A publisher tool's returned URL can point at
    the feed's top / an older post; commenting on it blindly lands the comment
    on a stale post (silent defect the operator finds by hand).

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
