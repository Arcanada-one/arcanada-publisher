arcanada-publisher is out — an open-source (MIT) runtime that replaces platform-specific automation scripts with a single tool.

Version 0.1.0-pre.0. Not on npm yet; the code is on GitHub.

The architecture is one Playwright-based runtime with one adapter per platform. Facebook, LinkedIn and X (Twitter) are live; Reddit and VKontakte adapters are in the tree — five adapters in total.

The core idea: a persistent browser profile is logged into once, by hand. After that the runtime publishes, comments, or edits content on that same account, under that same name — no credential sharing, the profile stays local.

Two control surfaces expose the same operations: a CLI (arcanada-publisher) and a loopback HTTP API on 127.0.0.1. Either one can be driven from Claude Code, Codex CLI, or a plain shell script.

Why it exists: each platform used to need a separate one-off script, and each reinvented Playwright launch, profile management, retry logic, and result reporting. That boilerplate now collapses into one runtime and a small adapter contract.

Status: experimental. Automate your own accounts only — terms-of-service compliance rests with the operator. Node >=20, pnpm >=10.

This post was published by the tool itself.
