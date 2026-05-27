# Publisher rule — canonical Telegram link in first comment

**Status:** active rule for arcanada-publisher and ad-hoc tools (`fb-publish`, `li-publish`).
**Origin:** CONTENT-0051 (2026-05-21), operator decision: «в соцсетях (кроме сайта) среди прочих ссылок всегда делать ссылку на пост в Телеграме».

## Rule

Every social post (Facebook, LinkedIn, X/Twitter, VKontakte, Reddit — everything except `arcanada.one` / `datarim.club` / other site domains in the ecosystem) **MUST** include a link to the canonical Telegram-channel post in the **first comment under the post** (not in the post body).

The canonical TG post lives in `@valentovtypes` (`Valentov Types Letters`, public channel, ID `-1003819390976`). URL pattern: `https://t.me/valentovtypes/<msg_id>`.

## Why

- Telegram channel is the only platform where the post is published **in full** — no 3000-utf16 truncation (LinkedIn), no platform-specific compression. Hero + body parts + finale + reply-thread.
- Readers who arrived from a compressed FB/LI adapter and want the full piece should reach the canonical version in **one click**.
- The link belongs in the first comment per existing convention (see `feedback_social_links_first_comment` in operator memory): body must stay clean; CTAs accumulate in the first comment.

## How the publishing pipeline applies it

1. Publish **site first** (RU + EN where applicable). Capture URLs.
2. Publish **TG** as canonical: hero photo + multipart text (`[1/N]` per `feedback_telegram_split_policy`) + finale photo. Capture `t.me/valentovtypes/<msg_id>` of the hero (first message of the thread) → this is the **canonical URL**.
3. Publish **FB / LI / X / VK** with compressed/full text in the body.
4. **Immediately after each social publish**, add a first comment with at minimum:
   ```
   Канонический пост (полная версия с картинками): https://t.me/valentovtypes/<msg_id>
   Статья на сайте: https://arcanada.one/<lang>/blog/<slug>
   [+ optional ecosystem project links per post topic]
   ```
5. If the post body declares «no links» as a rhetorical move (sci-fi posts, manifesto-style), the first comment **still** contains the TG canonical — treat it as attribution / sourcing, not as «links reinforcing claims».

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

Per-publish smoke checklist:

- [ ] TG canonical published, URL captured
- [ ] FB body posted, body grep'd for 0 `https://` links
- [ ] FB first comment grep'd for `t.me/valentovtypes/`
- [ ] Repeat for LI / X / VK
- [ ] First comment is **author-owned**, not a random reader's
