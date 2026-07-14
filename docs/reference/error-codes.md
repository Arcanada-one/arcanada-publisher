# Error codes — reference

> **Diátaxis category:** Reference (information-oriented). This document lists
> the canonical `ErrorCode` enum values exposed by `@arcanada/publisher-core`,
> the semantics of each code, and the per-adapter triggers that map to it.
> The stub is seeded by PUB-0003 (Phase 1, Facebook adapter); per-adapter
> trigger sections are extended as each adapter lands (PUB-0004 — LinkedIn,
> PUB-0005 — X/Twitter, PUB-0006 — Reddit, PUB-0007 — VK).

## Enum

| Code | Name                           | Exit code | Meaning                                                                                                                                                                                        |
| ---- | ------------------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | `SUCCESS`                      | 0         | Operation completed; result schema validated.                                                                                                                                                  |
| 1    | `INVALID_ARGS`                 | 1         | Caller supplied input that failed schema/host/extension validation (e.g. non-Facebook host in `comment.parentPostUrl`, unsupported image extension).                                           |
| 2    | `MISSING_INPUT`                | 2         | Required field was empty or missing (`publish.text`, `edit.{text\|imagePath}`).                                                                                                                |
| 3    | `NO_PROFILE`                   | 3         | Persistent profile does not exist on disk or the FB session inside it has expired (`fb-publish` `not_logged_in`).                                                                              |
| 4    | `SELECTOR_TIMEOUT`             | 4         | Playwright locator never reached the expected state within the configured timeout (`fb-publish` `timeout`).                                                                                    |
| 5    | `PUBLISH_BUTTON_ABSENT`        | 5         | Composer / `Опубликовать` button missing or disabled — guideline-violation suspected or FB UI drift (`fb-publish` `composer_not_found` and `publish_button_disabled`).                         |
| 6    | `VERIFY_FAILED`                | 6         | Post-publish verification did not match — parent post unreachable, mismatched URL, residual quote-wrap, or `Отредактировано` marker not visible after `edit` (`fb-publish` `verify_mismatch`). |
| 7    | `NETWORK_GUARD`                | 7         | Outbound network guard (`assertLoopback`) blocked the call — reserved for upcoming HTTP API surface (`PUB-0008`).                                                                              |
| 8    | `RATE_LIMIT`                   | 8         | Facebook security-check / captcha / temporarily-blocked indicator detected — operator headed re-login required (`fb-publish` `captcha`).                                                       |
| 20   | `CAMPAIGN_MANIFEST_REQUIRED`   | 20        | A managed mutation omitted its canonical manifest.                                                                                                                                             |
| 21   | `CAMPAIGN_MANIFEST_INVALID`    | 21        | Strict schema, path-root, ownership, permission, or regular-file validation failed.                                                                                                            |
| 22   | `CAMPAIGN_TARGET_MISMATCH`     | 22        | Platform/profile/destination, explicit campaign target, action, or mutation subject/parent differs from the managed registry and manifest.                                                     |
| 23   | `CAMPAIGN_POLICY_UNKNOWN`      | 23        | The managed target does not allow the requested content-kind/policy pair.                                                                                                                      |
| 24   | `CAMPAIGN_EVIDENCE_MISSING`    | 24        | Required site, media, copy, authorization, identity, or read-back evidence is absent.                                                                                                          |
| 25   | `CAMPAIGN_EVIDENCE_STALE`      | 25        | Required evidence is older than its policy window or dated in the future.                                                                                                                      |
| 26   | `CAMPAIGN_ASSET_MISMATCH`      | 26        | Manifest, copy, media, CDN, or mutation bytes do not match the bound SHA-256.                                                                                                                  |
| 27   | `CAMPAIGN_MEDIA_POLICY`        | 27        | The attachment role, locale, duration, or platform media matrix is invalid.                                                                                                                    |
| 28   | `CAMPAIGN_RECEIPT_REQUIRED`    | 28        | A managed live mutation omitted its receipt or explicit de-enrollment confirmation.                                                                                                            |
| 29   | `CAMPAIGN_RECEIPT_INVALID`     | 29        | Signature, manifest, target, action, destination, subject URL, text, media, or policy binding is invalid.                                                                                      |
| 30   | `CAMPAIGN_RECEIPT_EXPIRED`     | 30        | The receipt exceeded its 15-minute validity or is not yet valid.                                                                                                                               |
| 31   | `CAMPAIGN_RECEIPT_REPLAY`      | 31        | The shared ledger already consumed the receipt.                                                                                                                                                |
| 32   | `CAMPAIGN_STATE_UNKNOWN`       | 32        | Idempotency, ledger locking, audit, or current public state is ambiguous.                                                                                                                      |
| 33   | `CAMPAIGN_BACKLINKS_NOT_READY` | 33        | A backlink is missing, stale, unresolved, or lacks current canonical read-back.                                                                                                                |
| 99   | `INTERNAL_PANIC`               | 99        | Unhandled Playwright/Chromium runtime error, unknown classification, or assertion that cannot recover (`fb-publish` `runtime_error`).                                                          |

## Per-adapter triggers

### Facebook (`@arcanada/publisher-facebook`, PUB-0003)

| `fbErrorType`             | Code                        | Detected by                                                                                                                   |
| ------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `not_logged_in`           | `NO_PROFILE` (3)            | Page content matches `Войти в Facebook` / `Log into Facebook` / `Email or phone`                                              |
| `composer_not_found`      | `PUBLISH_BUTTON_ABSENT` (5) | Composer button absent or zero matches under `getByRole("button", { name: composerButton })`                                  |
| `publish_button_disabled` | `PUBLISH_BUTTON_ABSENT` (5) | `Опубликовать` / `Post` / `Publish` button matched but disabled at click time                                                 |
| `captcha`                 | `RATE_LIMIT` (8)            | Text blob matches `проверк[ауи] безопасности` / `security check` / `подтвердите, что вы человек` / `confirm you are human`    |
| `timeout`                 | `SELECTOR_TIMEOUT` (4)      | Playwright `TimeoutError` (locator wait deadline exceeded)                                                                    |
| `runtime_error`           | `INTERNAL_PANIC` (99)       | Playwright daemon / connection refused / target closed                                                                        |
| `verify_mismatch`         | `VERIFY_FAILED` (6)         | `comment.verifyParent` returned `false`, residual `"` after `extractPostUrlFromHref`, or commentId missing from rendered href |

### LinkedIn (`@arcanada/publisher-linkedin`, PUB-0004) — TBD

Filled in by PUB-0004.

### X / Reddit / VK — TBD (PUB-0005..PUB-0007)
