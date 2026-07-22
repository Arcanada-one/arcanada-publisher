# `@arcanada/publisher-telegram`

Telegram Bot API adapter for Arcanada Publisher. It captures a pre-publish
message baseline, adds an idempotency marker, requires a valid returned
`message_id`, and validates the returned artifact's target, bot authorship,
content boundaries, media type, and filename. Empty, malformed, or ambiguous
responses fail as `UNKNOWN` and must never be retried blindly.

For an operator-approved text-only blog post, pass `singleArticle: true` (CLI:
`--single-article`). Publisher sends exactly one HTML `sendMessage` with link
previews enabled, no service marker, no attachment, and no reply/thread
linkage. The complete message must fit Telegram's 4096 UTF-16-unit limit;
`title` and images are rejected in this mode.

Live publishing defaults to test channel `-1003855619081`. Production channels
remain blocked unless the operator explicitly adds their IDs to
`TELEGRAM_ALLOWED_CHAT_IDS`. See
[`telegram-bot-api-publish-safety.md`](../../docs/reference/telegram-bot-api-publish-safety.md).
