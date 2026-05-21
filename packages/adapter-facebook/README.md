# `@arcanada/publisher-facebook`

Facebook adapter for [arcanada-publisher](https://github.com/Arcanada-one/arcanada-publisher).
Published under the unified `Adapter` contract from `@arcanada/publisher-core`.

> **Status:** Phase 1 (alpha). Programmatic API + live Playwright smoke. CLI and
> HTTP surfaces land in Phase 6 (`PUB-0008`). MIT licence.

## Install

```bash
pnpm add @arcanada/publisher-facebook @arcanada/publisher-core playwright
pnpm exec playwright install chromium
```

## Quickstart

The adapter speaks against a persistent Chromium profile stored under
`~/.arcanada-publisher/profiles/facebook/<slug>`. The first authentication
**must be headed and operator-driven** — Facebook does not support automated
credential entry under their ToS, and the adapter refuses headless `login`.

### 1. `login` (one-time, headed)

```ts
import { FacebookAdapter } from "@arcanada/publisher-facebook";

const adapter = new FacebookAdapter();
await adapter.login({ profile: "pavel-personal", headed: true });
// → opens Chromium window; operator signs in; adapter polls until composer
//   is visible (5 s × 60 = 5 minutes budget).
```

### 2. `publish`

```ts
const result = await adapter.publish({
  text: "Hello from arcanada-publisher!",
  imagePath: "/path/to/image.png", // optional; .png|.jpg|.jpeg|.webp
  profile: "pavel-personal",
});
console.log(result.postUrl);
// → https://www.facebook.com/100012345/posts/987654321
```

### 3. `verify`

```ts
const verified = await adapter.verify(result.postUrl);
console.log(verified.reachable, verified.status); // true 200
```

## Comment & edit

```ts
const commentResult = await adapter.comment({
  parentPostUrl: result.postUrl,
  text: "First comment with the canonical link.",
  profile: "pavel-personal",
});

await adapter.edit({
  postUrl: result.postUrl,
  text: "Updated body.",
  profile: "pavel-personal",
});

// Edit a comment instead of the post (Facebook-specific extension):
await adapter.edit({
  postUrl: result.postUrl,
  commentId: commentResult.commentId,
  text: "Updated comment body.",
  profile: "pavel-personal",
});
```

## Error model

All adapter failures throw `AdapterError(code, message, details)` with the
canonical error codes from `@arcanada/publisher-core` (see
[`docs/reference/error-codes.md`](../../docs/reference/error-codes.md)).
`details.fbErrorType` carries the original `fb-publish` taxonomy token for
forensics (`not_logged_in`, `composer_not_found`, `publish_button_disabled`,
`captcha`, `timeout`, `runtime_error`, `verify_mismatch`).

## Live smoke

The live publish cycle is gated behind `FB_LIVE_SMOKE=1`:

```bash
FB_LIVE_SMOKE=1 PUB_PROFILE=pavel-personal \
  pnpm --filter @arcanada/publisher-facebook test:smoke
```

In CI (`FB_LIVE_SMOKE` unset) the cycle is `skip`ped and the skip is visible in
the Vitest reporter. Screenshots from failure-paths land in
`packages/adapter-facebook/artifacts/` (`.gitignored`).

## Security & ToS

This adapter automates Facebook account interaction through a persistent
Playwright session, which conflicts with the literal text of Facebook ToS
§3.2.3. The risk is accepted under `accepted-risk.yml#tos-facebook` of the
monorepo and renewed on the standard 90-day cadence. See
[`SECURITY.md`](../../SECURITY.md).

## Migration notes

Portered from [`Arcanada-one/fb-publish`](https://github.com/Arcanada-one/fb-publish)
(MIT) at commit `8df49fa51822795075f746ad7389c8bd400b1aa4`. INFRA-0190
(`POST_URL` quote-strip) is closed structurally by the migration — see
[`CHANGELOG.md`](CHANGELOG.md).
