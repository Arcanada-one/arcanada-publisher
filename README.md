# arcanada-publisher

> Unified open-source browser publisher for Facebook, LinkedIn, X (Twitter), Reddit, and VKontakte. Playwright-driven, persistent-profile authentication, CLI and local HTTP API for agent use.

| Status      | **Experimental** — automate your **own accounts only**; ToS risk on operator.       |
| ----------- | ----------------------------------------------------------------------------------- |
| License     | [MIT](./LICENSE)                                                                    |
| Node / pnpm | Node ≥ 20, pnpm ≥ 10                                                                |
| Foundation  | [Phase 0 plan](https://github.com/Arcanada-one/arcanada-publisher) — contracts only |

## What this is

`arcanada-publisher` is a workspace of small packages that share a single browser-automation runtime (`@arcanada/publisher-core`) and expose one adapter per supported platform. Adapters publish, comment, and edit posts on the account whose persistent browser profile the operator has logged into once.

A unified command-line interface and a localhost HTTP API surface the same operations to local agents (Claude Code, Codex CLI, custom shell tools).

## Why

Operators automating their own social-media posting across several platforms today maintain a separate one-off script per platform. Each script reinvents Playwright launch, profile management, retry/backoff, and result reporting. This project consolidates that boilerplate into one publishable runtime and a small adapter contract.

## Packages

| Package                         | Status     | Purpose                                                                          |
| ------------------------------- | ---------- | -------------------------------------------------------------------------------- |
| `@arcanada/publisher-core`      | foundation | Adapter contract, result schemas, error taxonomy, profile manager, network guard |
| `@arcanada/publisher-facebook`  | live       | Facebook personal-profile publisher                                              |
| `@arcanada/publisher-linkedin`  | live       | LinkedIn personal-profile publisher                                              |
| `@arcanada/publisher-x`         | live       | X (Twitter) publisher                                                            |
| `@arcanada/publisher-reddit`    | live       | Reddit publisher                                                                 |
| `@arcanada/publisher-vkontakte` | live       | VKontakte publisher                                                              |
| `@arcanada/publisher-telegram`  | live       | Telegram Bot API publisher with test-channel-first gating                        |
| `@arcanada/publisher`           | live       | Unified CLI (`arcanada-publisher`)                                               |
| `@arcanada/publisher-server`    | live       | Local HTTP API (Fastify, loopback by default)                                    |

## Quick start

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm -r test
pnpm audit --prod --audit-level=high
```

Telegram publishes require `TELEGRAM_BOT_TOKEN` and `--chat-id`. Live publishing
is restricted to the canonical test channel (`-1003855619081`) by default.
After operator approval, additional channel IDs can be explicitly allowlisted in
the comma-separated `TELEGRAM_ALLOWED_CHAT_IDS` environment variable. Dry runs
never require credentials or contact Telegram:

```bash
arcanada-publisher publish --platform telegram --chat-id -1003855619081 \
  --text-file post.md --dry-run
```

All five platform adapters (Facebook, LinkedIn, X, Reddit, VKontakte), the unified CLI, and the loopback HTTP API are implemented and tested.

## Status disclosure

This project automates **your own** social-media accounts via a browser the operator drives. Each supported platform's terms of service restrict automation, and the risk of account action is borne by the operator. Read [`SECURITY.md`](./SECURITY.md) and [`accepted-risk.yml`](./accepted-risk.yml) before use.

## Documentation

- [`docs/explanation/architecture.md`](./docs/explanation/architecture.md) — how the workspace fits together.
- [`docs/tutorials/`](./docs/tutorials/) — coming with each adapter phase.
- [`docs/how-to/`](./docs/how-to/) — per-platform recipes (login, publish, comment, edit, verify).
- [`docs/reference/`](./docs/reference/) — CLI and HTTP API surface, error codes, profile layout.

## Autonomy

This project declares an explicit autonomy level — see [`aal.yaml`](./aal.yaml). The current level is **L1** (operator-initiated CLI). The next milestone is **L2** (agent-callable HTTP with per-call audit log), planned alongside the unified CLI/API package.

## License

MIT. See [LICENSE](./LICENSE).
