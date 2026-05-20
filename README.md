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

| Package                         | Status      | Purpose                                                                          |
| ------------------------------- | ----------- | -------------------------------------------------------------------------------- |
| `@arcanada/publisher-core`      | foundation  | Adapter contract, result schemas, error taxonomy, profile manager, network guard |
| `@arcanada/publisher-facebook`  | placeholder | Facebook personal-profile publisher                                              |
| `@arcanada/publisher-linkedin`  | placeholder | LinkedIn personal-profile publisher                                              |
| `@arcanada/publisher-x`         | placeholder | X (Twitter) publisher                                                            |
| `@arcanada/publisher-reddit`    | placeholder | Reddit publisher                                                                 |
| `@arcanada/publisher-vkontakte` | placeholder | VKontakte publisher                                                              |
| `@arcanada/publisher`           | placeholder | Unified CLI (`arcanada-publisher`)                                               |
| `@arcanada/publisher-server`    | placeholder | Local HTTP API (Fastify, loopback by default)                                    |

Placeholders intentionally throw at runtime so accidental imports during foundation work fail fast.

## Quick start (foundation only)

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm -r test
pnpm audit --prod --audit-level=high
```

Adapter-level publish flows are implemented in subsequent phases; this commit ships only the contract surface.

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
