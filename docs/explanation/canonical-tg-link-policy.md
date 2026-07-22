# Publisher rule — canonical Telegram link in first comment

**Status:** active rule for arcanada-publisher and ad-hoc tools (`fb-publish`, `li-publish`).
**Origin:** CONTENT-0051 (2026-05-21), operator decision: «в соцсетях (кроме сайта) среди прочих ссылок всегда делать ссылку на пост в Телеграме».

## Rule

Every social post (Facebook, LinkedIn, X/Twitter, VKontakte, Reddit — everything except `arcanada.one` / `datarim.club` / other site domains in the ecosystem) **MUST** include a link to the canonical Telegram-channel post in the **first comment under the post** (not in the post body).

The canonical TG post lives in `@valentovtypes` (`Valentov Types Letters`, public channel, ID `-1003819390976`). URL pattern: `https://t.me/valentovtypes/<msg_id>`.

## TG post structure (canonical two-message shape)

A Telegram channel post for a blog article is **two messages**, modelled on the
reference post (article A6, `@valentovtypes` msg 166/167). Reproduce this shape
exactly — do not improvise from memory. Before publishing, `forwardMessage` the
previous cycle post into the test channel and copy its structure.

### Operator-approved text-only exception

When the operator explicitly requests one post without an uploaded image or video, Publisher may use `--single-article`. This sends the complete article as one HTML text message (maximum 4096 UTF-16 units) and lets Telegram build the visual card from the final embedded arcanada.ai link. The post contains no Publisher marker, attachment, reply, thread, or comment. This exception changes only the message shape; test-channel read-back and separate production approval remain mandatory.

**Message 1 — video + caption teaser:**

- Animated-cover video (`dev-tools/video/make-cycle-video.sh`, length = the
  article narration, channel-language voice).
- Caption (≤1024 UTF-16 units): the **article title** + ~3 SHORT summary
  paragraphs + a closing line of the form "Narration is in this video; full text
  below 👇". This is a teaser, not the full body.

**Message 2 — long-read text (article retold inside Telegram):**

- A self-contained retelling of the article (~2000 chars) so the reader does not
  have to leave the channel — 4 sense-blocks, each opening with a micro-heading
  (the first phrase of the paragraph acts as a mini-title).
- It is a **retelling**, neither a verbatim copy of the article nor a short teaser.
- Ends with the article link **as an embedded hyperlink at the very end** — a
  Telegram `text_link` entity (send with `parse_mode=HTML` and
  `<a href="https://arcanada.ai/<lang>/blog/<slug>">…</a>`): the visible anchor
  phrase reads "Read the full article on arcanada.ai" and the URL is hidden
  behind it, resolving to the channel-language article (RU channel → `/ru/blog/...`).
  NOT a bare text line, NOT a visible URL in the body.

**TG link placement — exception to the first-comment rule.** The "links go in the
first comment" convention (§ below) is for FB / LinkedIn / X. For a self-contained
TG long-read post, the article link lives **at the end of Message 2**, NOT in a
separate first comment. The TG post is itself the canonical full version, so its
own link does not need a comment.

## Why

- Telegram channel is the only platform where the post is published **in full** — no 3000-utf16 truncation (LinkedIn), no platform-specific compression. Hero + body parts + finale + reply-thread.
- Readers who arrived from a compressed FB/LI adapter and want the full piece should reach the canonical version in **one click**.
- The link belongs in the first comment per existing convention (see `feedback_social_links_first_comment` in operator memory): body must stay clean; CTAs accumulate in the first comment.

## How the publishing pipeline applies it

**The platform order is fixed (see § Publishing order below): site → TG → X → FB / LI / VK.**

1. Publish **site first** (RU + EN where applicable). Capture URLs.
2. Publish **TG** as canonical: hero photo + multipart text (`[1/N]` per `feedback_telegram_split_policy`) + finale photo. **For articles that have a blog-audio (TTS) version, also attach the audio file to the same TG post** — Telegram accepts image + audio together in one post (a `sendMediaGroup` with a photo `InputMediaPhoto` and an audio `InputMediaAudio`, or `sendPhoto` followed by `sendAudio` in the same thread). This is NOT a problem and MUST be done so the reader gets the listenable version without leaving Telegram. Capture `t.me/valentovtypes/<msg_id>` of the hero (first message of the thread) → this is the **canonical URL**.
3. Publish **X** (premium full-article EN post) next, **before** FB / LI / VK. Capture `x.com/<handle>/status/<id>` → this is the **canonical EN URL**. X is published before FB/LI/VK precisely so that the X(EN) link already exists when the FB/LI/VK first comments are written (their first comments cross-link both TG(RU) and X(EN) — see § Publishing order).
4. Publish **FB / LI / VK** with compressed/full text in the body.
5. **Immediately after each social publish**, add a first comment with at minimum:
   ```
   Канонический пост (полная версия с картинками): https://t.me/valentovtypes/<msg_id>
   Статья на сайте: https://arcanada.one/<lang>/blog/<slug>
   [+ optional ecosystem project links per post topic]
   ```
6. If the post body declares «no links» as a rhetorical move (sci-fi posts, manifesto-style), the first comment **still** contains the TG canonical — treat it as attribution / sourcing, not as «links reinforcing claims».

## Publishing order (fixed)

The platforms are published in a **fixed sequence**, not in parallel and not in an
arbitrary order:

1. **Site** (RU + EN) — capture both blog URLs.
2. **Telegram** (RU canonical) — capture `t.me/valentovtypes/<msg_id>`.
3. **X / Twitter** (EN premium full-article) — capture `x.com/<handle>/status/<id>`.
4. **Facebook / LinkedIn / VKontakte** — in any order among themselves.

**Why this exact order.** The FB / LinkedIn / VK first comments MUST cross-link
**both** the canonical Telegram (RU) post **and** the X (EN) post (per
[`social-links-and-comments-policy.md`](./social-links-and-comments-policy.md) §3).
Those two URLs only exist once TG and X are already live — so TG and X are
published **first**, and X is published **before** FB/LI/VK, not alongside them.
Publishing FB/LI/VK before X would force a second pass to back-fill the X link into
their comments (the recurring "missing X link in the FB/LI comment" regression).

## Adapter implementation

When `arcanada-publisher` adapters publish to FB / LI / X / VK / Reddit, the orchestrator MUST:

1. Receive `canonicalTgUrl: string` as input parameter (or accept `tgPostId` and resolve).
2. After successful publish on the social platform, call the adapter's `addComment(postUrl, commentBody)` method with `commentBody` containing the canonical TG URL.
3. If `addComment` fails after publish, treat as **partial failure** and surface — do NOT report success. The TG link is part of the contract.

For legacy `fb-publish` / `li-publish` shell scripts: the operator chains `fb-publish.sh` → `fb-add-comment.sh` (added 2026-05-21) / `li-publish.sh` → `li-comment.sh`.

## Exceptions

- **Pure site cross-post** between arcanada.one and datarim.club: no TG link needed (the audience overlaps with TG subscribers; cross-link is between sites only).
- **TG-channel reply / quote**: obviously no self-link needed.
- **First comment fails to post** for technical reasons (bot blocked / DOM drift / rate limit): retry up to 3× with backoff. If still fails — log as `tg_canonical_link_missing` warning and surface to operator. Do not auto-delete the social post — operator decides whether to fix or accept gap.

## Verification

Per-publish smoke checklist (run in publishing order — TG, then X, then FB/LI/VK):

- [ ] TG canonical published **first**, URL captured
- [ ] If the article has a blog-audio version, the audio file is attached to the TG post (image + audio in one post — allowed and required)
- [ ] X (EN premium full-article) published **before** FB/LI/VK, URL captured
- [ ] FB body posted, body grep'd for 0 `https://` links
- [ ] FB first comment grep'd for **both** `t.me/valentovtypes/` (TG/RU) **and** `x.com/.../status/` (X/EN)
- [ ] Repeat for LI / VK (LinkedIn + VK first comments also carry both TG(RU) + X(EN))
- [ ] First comment is **author-owned**, not a random reader's
