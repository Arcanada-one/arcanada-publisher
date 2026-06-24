# Publisher rule — social-post links & first-comment policy

**Status:** active rule for arcanada-publisher and ad-hoc tools (`fb-publish`, `li-publish`).
**Origin:** CONTENT-0053 (2026-06-19) + CONTENT-0054 (2026-06-19), operator decision. Supersedes and
generalizes [`canonical-tg-link-policy.md`](./canonical-tg-link-policy.md) (which covers only the
Telegram canonical link); that file now defers to this one for the full per-platform contract.

This is the single source of truth for **where links go** when a blog article is cross-posted to
social platforms. It governs the post body, the mandatory first comment, the per-platform language,
and the Twitter/X video attachment.

## 1. Post body — no site link (except Telegram and X)

- The **article body MUST NOT contain a link to the site** (`arcanada.ai` / `datarim.club` / any
  ecosystem site domain). All links live in the **first comment** under the post.
- **Exception:** in **Telegram** and **Twitter/X**, a link in the post body is allowed (these
  platforms do not penalize outbound links the way the FB/LinkedIn feed algorithms do).

## 2. First comment — links contract

The author posts a **first comment** immediately after publishing the post. The first comment carries:

1. **Link to the blog version of the article on the site** (language per the platform table below).
2. **If the article is about a product/framework** (e.g. Datarim) — **a link to that product's own
   site is mandatory**, in addition to the blog link. For a Datarim article the first comment
   therefore carries: blog link **and** the Datarim site link (`https://datarim.club`).
3. **Cross-links to the other social channels** per the platform table below.

**Label the language the reader will encounter on every social link and button.** Each cross-link
and each social button MUST carry the destination's content language as an explicit tag — e.g.
`X (EN)`, `Telegram (RU)`, `LinkedIn (EN)`, `Facebook (RU)`, and the blog link as `(EN)` / `(RU)`.
The reader should know, before clicking, which language they will land in. This applies both to the
**first-comment cross-links** and to the **`social` back-link block on the article page** (§7). Per-
platform content languages are fixed by the table in §3 (FB=RU, LinkedIn=EN, X=EN, Telegram=RU); use
those when tagging. Phrasings like "In English on X:" / "In Russian on Telegram:" satisfy the rule in
a comment; a compact `Platform (LANG)` label satisfies it on buttons.

The first comment MUST be **author-owned**, not a random reader's. If `addComment` fails after a
successful publish, treat it as a **partial failure** and surface it — do NOT report success. The
links are part of the contract.

## 3. Per-platform table

| Platform     | Post language | Blog link in comment (lang) | Cross-links in comment        | Body site link |
|--------------|---------------|-----------------------------|-------------------------------|----------------|
| **Facebook** | RU            | RU blog version             | Twitter (EN) + Telegram (RU)  | not allowed    |
| **LinkedIn** | EN            | EN blog version             | Twitter (EN) + Telegram (RU)  | not allowed    |
| **Twitter/X**| EN            | EN blog version             | Telegram (RU)                 | allowed in body|
| **Telegram** | RU            | RU blog version             | —                             | allowed in body|

For a Datarim article, add `https://datarim.club` to every platform's first comment (rule 2).

## 4. Twitter/X — commercial premium account

- The account is **premium**, so the **whole article fits in one post body** (long-form). Cap via
  `ARCANADA_PUBLISHER_X_MAX_UNITS`. Build the X post from the **full EN content**, not a shortened
  draft.
- If the site has an **audio narration for the EN version** of the article, build an **MP4 video**
  from the cover image + that audio (ffmpeg) and attach it to the tweet together with the article.
- The blog link in the X first comment points to the **EN** blog version; also cross-link Telegram (RU).

## 5. Verification checklist (per publish)

- [ ] TG canonical published, URL captured (per `canonical-tg-link-policy.md`)
- [ ] FB body posted, body grep'd for **0** `https://` site links; first comment = RU blog + (Datarim site) + X(EN) + TG(RU)
- [ ] LinkedIn body posted (EN), first comment = EN blog + (Datarim site) + X(EN) + TG(RU)
- [ ] X body = full EN article; MP4 attached when EN audio exists; first comment = EN blog + (Datarim site) + TG(RU)
- [ ] Telegram body (RU) may carry the site link inline
- [ ] First comment is **author-owned** on every platform
- [ ] Real permalink captured for each post — do **not** trust the publisher's returned URL (FB/LinkedIn
      return a non-canonical URL; confirm against the live account before writing it back / commenting)

## 6. Verification gates around irreversible actions (X/Twitter, applies to all platforms)

Publishing, deleting, and commenting are **irreversible, public** actions. Every such
action MUST be wrapped in a verification gate — a probe **before** (to confirm the
target) and a probe **after** (to confirm the result). Never report an outcome you
have not re-verified against the live account.

### 6.1 Before any irreversible action — confirm the target (read-before-write)

- **Before deleting a post**, fetch the post and confirm it is the intended one by a
  stable, machine-checkable identifier — not by feed position or visual guess. Confirm
  the **author handle is ours**, the **text/permalink/`t.co` hash** match the target,
  and the post is **not someone else's content** that merely surfaced in a recommendation
  feed. (Real incident: a session recorded a foreign influencer's tweet URL as "ours".)
- **Before publishing**, confirm **which account is logged in** (post the correct premium
  account, not a personal one), and that the body meets §4 (full EN long-form, MP4 when EN
  audio exists, starts with the article title).
- **Before commenting**, confirm the parent post URL is the **real permalink** of our just-
  published post (§5), not the publisher's returned URL.

### 6.2 After every action — verify the result against the live account

- **After publishing**, re-fetch the live post and assert: correct text length (full
  article, not a truncated draft), correct language, **media attached** (video/image when
  required), and author = our account. A timeout or a returned URL is **not** proof the
  post landed — and is **not** proof it failed either; re-fetch before concluding.
- **After deleting**, re-fetch the URL and assert it is gone (404 / not-found).
- **After commenting**, assert the post's reply count increased and the comment is
  **author-owned**.

### 6.3 Duplicate guard (timeout / retry / aborted-but-already-sent)

- An X publish whose response timed out **may still have landed**. Before re-publishing,
  **list the account's recent posts and check for an existing copy** (same title + media).
  Re-publishing blindly creates a duplicate.
- Stopping a background publish process (kill / cancel) does **not** un-send a request that
  already reached X. After any aborted publish, **re-check the account for an already-sent
  post** before retrying by another path.
- When a duplicate is suspected, identify the keeper vs. the duplicate **deterministically**
  (e.g. the keeper has its first comment → reply count ≥ 1; the duplicate has none), then
  delete only the confirmed duplicate via the §6.1 read-before-delete gate.

### 6.4 Composer media+text order — video first, then text, then verify (all browser composers)

When attaching media to a post through a browser composer (X, Facebook, LinkedIn), follow
this fixed order. It is the operator-confirmed sequence and avoids the failure modes below:

1. **Paste the video from the clipboard first.** Put the file on the clipboard
   (`osascript -e 'set the clipboard to (POSIX file "/path/video.mp4")'` on macOS), click
   the composer field, paste (`Cmd+V`), and **wait for the upload to finish**
   (the composer shows a progress indicator that ends in a "done/ready" state, typically
   8–16 s for a multi-MB clip). Do **not** type text while the upload is still running.
   Prefer pasting over the file-picker: the in-app file-upload path may reject host
   filesystem paths, and pasting has no small per-file size cap.
2. **Then paste the text** into the same composer field. Use video, not a static image,
   when a video deliverable exists for the article (cover + narration MP4).

   > **Do not special-case the order away.** This sequence holds on **every** clipboard-media
   > platform (X / LinkedIn / Facebook) — it is NOT X-only. A recurring regression is to reason
   > "I will attach the video later via the media button / file picker, so the text can go in
   > first" and paste the body into a media-less composer. The picker path is unreliable
   > (host paths rejected, invisible to automation); the clipboard is the only reliable attach
   > path and it requires media-before-text. Decide the method (always: clipboard) and the order
   > (always: video → wait → text) BEFORE touching the composer. If text was already pasted into
   > an empty composer, **close/clear it and restart media-first** rather than retrofitting the
   > video around the text.
3. **Then verify before the irreversible click** (§6.1): scroll the composer top-to-bottom
   and confirm both the **media is still attached** (preview present, upload "done") **and**
   the **full text is present** (starts with the article title; not truncated; within the
   platform/premium character limit). Only then click publish. **The clipboard is shared
   and can be overwritten by an unrelated background process between copy and paste** — after
   pasting body or comment text, READ BACK what actually landed in the field before
   submitting. (Real incident: a comment field received a stray task-id "TUNE-0443" because
   another process replaced the clipboard; it was caught on read-back, cleared, and re-pasted.)
4. **After publishing, re-verify against the live account** (§6.2): the post carries the
   **video** (play control / duration, not a still image), the text is complete, and the
   author is our account.

### 6.5 One tab per platform — close when done, focus the new one

When driving multiple platforms in a browser session, keep tab handling clean:

- **Finish one platform fully** (publish + verify + first comment + verify) before moving on.
- **Close that platform's tab** once its work is verified done.
- **Open a fresh tab for the next platform and act on that tab's id explicitly** — every
  click/type/paste/navigate must target the new tab. Do not leave the previous platform's
  tab open and do not issue actions against a stale tab id; mixing tabs is a common cause of
  actions silently landing in the wrong place or failing.

## 7. Article ↔ social back-link block (the blog page links out to the posts)

Cross-posting is **bidirectional**. After the social posts exist, the blog article page itself MUST
link out to them — otherwise the published article shows no path to its own social posts.

- The article source carries a `social` block with the real permalinks:
  `social: { telegram, x, linkedin, facebook }` (strip tracking params — keep the canonical
  `.../activity-<id>` for LinkedIn, `/status/<id>` for X, `pfbid...` for Facebook, `t.me/<chan>/<id>`
  for Telegram). The block is language-independent (shared by all language variants of the article),
  so adding it lights up the links on **every** language version at once.
- **Each social button/link is language-tagged** per §2: render `X (EN)`, `Telegram (RU)`,
  `LinkedIn (EN)`, `Facebook (RU)` (content language fixed by §3), so the reader knows the language
  before clicking.
- An article that is live with social posts but **without** the `social` block is an **incomplete
  publish** — treat it the same as a missing first comment. After adding the block, redeploy and
  verify the links render on every language version.
