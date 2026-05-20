# Security Policy

## Supported Versions

`arcanada-publisher` is in early development (pre-1.0). Only the `main` branch is supported.

| Version | Supported          |
| ------- | ------------------ |
| main    | :white_check_mark: |
| < 0.1   | :x:                |

## Reporting a Vulnerability

Please **do not** open public GitHub issues for security reports. Instead, email the maintainer at `origin@veritasarcana.ai` with:

- A description of the issue and its impact.
- Steps to reproduce.
- A suggested mitigation if you have one.
- Whether you would like to be credited.

You can expect an acknowledgement within 7 calendar days and a remediation plan within 30 calendar days for high or critical issues.

## Scope

In scope:

- Code in this repository (`packages/*`, `.github/workflows/*`, CLI and HTTP API surface once shipped).
- Dependency vulnerabilities surfaced by the CI `audit` job (`pnpm audit --omit=dev --audit-level=high`).
- Profile-management code paths that touch the local filesystem (`packages/core/src/profile.ts`).

Out of scope:

- Vulnerabilities in third-party platforms (Facebook, LinkedIn, X, Reddit, VKontakte) themselves — report directly to those vendors.
- Account-recovery or social-engineering attacks against the operator's logged-in accounts.
- Issues that require pre-installed malware on the operator's machine.

## Threat Model (summary)

This tool runs locally with operator-owned credentials persisted in a Playwright user data directory. Primary threats:

1. **Credential exfiltration via persistent profile leakage.** Profile directories contain session cookies. The `ProfileManager` creates profile dirs with `0700` permissions and the default storage root lives under `~/.arcanada-publisher/profiles/`, which is gitignored. Operators are responsible for backups and disk encryption.
2. **Agent-callable HTTP surface exposure (Phase 6).** The HTTP API binds to `127.0.0.1` by default. Network guard (`assertLoopback`) refuses non-loopback binds without an explicit Tailscale opt-in flag. Tier-3 (public IP) binding is hard-blocked.
3. **Supply-chain CVEs.** The CI `audit` job fails on any high-or-higher severity advisory in production dependencies. Accepted-risk exceptions, if any, are documented in `accepted-risk.yml` with an expiry date.
4. **Platform ToS violation.** Each adapter automates only the operator's own account through a manually authenticated session. ToS risk is disclosed in `accepted-risk.yml` and accepted by the operator.

## Operator Disclosure

Use of this tool is at your own risk. Automating actions on social-media platforms can result in account restrictions or termination under each platform's terms of service. Read `accepted-risk.yml` before use.
