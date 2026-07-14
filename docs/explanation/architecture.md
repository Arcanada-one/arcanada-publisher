# Architecture

This document describes the layered design of `arcanada-publisher`. The full requirements that motivate this layout are captured in the project's product requirements document (`PRD-PUB-0001`) maintained in the Arcanada Datarim workspace; this page summarizes what the code base itself reflects.

## Layers

1. **Core (`@arcanada/publisher-core`)** — pure TypeScript with no Playwright. Defines the `Adapter` interface, result schemas, error taxonomy, profile manager, network guard, and the optional managed-campaign policy boundary. Its filesystem I/O is limited to owner-only local profiles, policy files, campaign evidence, and audit ledgers. Every adapter and every consumer (CLI, HTTP API) depends on these contracts and nothing else from this workspace.

2. **Adapters (`@arcanada/publisher-{facebook,linkedin,x,reddit,vkontakte}`)** — one package per platform. Each implements the `Adapter` interface, owns its DOM selectors, and is independently versionable. An adapter cannot be required to share state with another adapter.

3. **Consumer surfaces (`@arcanada/publisher`, `@arcanada/publisher-server`)** — the unified CLI and the loopback HTTP server. They dispatch to adapters by `platform` and return adapter results as-is to the caller. The CLI is operator-facing; the HTTP server is the agent-callable surface and is bound to loopback by default through the network guard exported by core.

## Managed campaign boundary

Generic OSS publishing is unchanged when the installation has no managed enrollment. An enrolled installation loads a strict local target registry and dispatches requirements by the explicit content-kind/policy pair.

For every managed public mutation, both consumer surfaces invoke the same `CampaignGuard` after input validation and before rate-limit consumption, adapter construction, browser-profile access, or network mutation. Preflight validates a content-addressed manifest and live/local evidence, then issues one 15-minute target/action receipt. Campaign targets are explicit action records layered over a stable managed destination, so a main post, parent-bound comment, and retained existing post cannot be confused. Staged manifest revisions materialize permalink-dependent copy without weakening immutable receipt binding. The mutation path verifies the exact subject URL, content, and media and atomically consumes that receipt in a shared ledger. Adapters remain policy-free executors and cannot become a second enforcement implementation.

See [Managed campaign manifests](../reference/campaign-manifest.md) for enrollment, schema, media policy, receipt, and API contracts.

## Authentication model

Each adapter is bound to a **persistent browser profile**, not to a credential set:

- The first time a profile is used, the operator runs an explicit `login` command in headed mode and signs in by hand.
- Cookies and `localStorage` are stored in the Playwright user data directory under `~/.arcanada-publisher/profiles/<platform>/<profile>/` (overridable via `ARCANADA_PUBLISHER_PROFILES_ROOT`).
- Subsequent publish, comment, edit, and verify calls reuse that profile directly. No credentials are read by adapter code, ever.

## Error model

`@arcanada/publisher-core` defines a small, stable error taxonomy (`ErrorCode` 0–99). Adapters throw `AdapterError` with a specific code; the CLI translates that code to a process exit, and the HTTP server translates it to a status-aware JSON response. Adapters do not introduce ad-hoc error shapes.

## Network exposure

The HTTP API ships with `assertLoopback` as a guard around the bind argument. Default bind is `127.0.0.1`. Tailscale (Tier 2) is opt-in through an explicit flag. Public (Tier 3) bind is hard-blocked at the guard level.

## What is **not** in this workspace

- Content generation (LLM calls authoring the post text) — adapters publish text given to them.
- Cross-platform fan-out (one command, many platforms) — out of scope for the initial release.
- Business-page automation (Facebook Pages, LinkedIn Pages) — would require admin-role handling and is tracked separately.

See also the [`docs/reference/`](../reference/) section for the CLI, HTTP API, and error-code references as those surfaces land.
