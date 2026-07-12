# Facebook read-only profile inspection

## Purpose

`inspect-profile-post` locates one existing Facebook profile post without exposing any mutation control. It is intended for recovery and reconciliation workflows where a stored permalink may be stale or wrong.

## Command contract

The command is Facebook-only and requires:

- `--profile-url`: the profile surface to scan;
- `--expected-author-profile-url`: the stable profile identity required on the matched post header;
- either `--expected-content-file` for an exact normalized full-body match, or an explicitly supplied `--content-excerpt` for a unique normalized excerpt match;
- `--evidence-dir`: a caller-owned private directory for raw bodies and screenshots;
- `--max-scrolls`: a positive bounded pagination limit.

Exact normalized full-body matching is the primary oracle. Excerpt matching is opt-in and succeeds only when exactly one post matches. Zero or multiple matches fail closed.

## Read-only boundary

The inspection path launches the existing persistent Facebook browser profile and may only navigate, scroll, read DOM state, and capture evidence. It must not locate or click action menus, composer controls, delete/edit controls, or submit buttons. It has no dependency on the mutation helpers used by publish, edit, delete, comment, or replace-comment.

## Match and evidence model

For each owned profile post encountered within the scroll budget, Publisher reads the terminal post body, the actual header profile anchor, and the canonical permalink anchor copied verbatim from the DOM. A candidate matches only when:

1. the header profile anchor normalizes to `--expected-author-profile-url`;
2. the terminal body matches the exact normalized body, or uniquely contains the explicit normalized excerpt;
3. the canonical permalink is a stable post permalink on Facebook.

After a unique match, Publisher enumerates direct comments owned by that post. Each comment summary contains its numeric comment ID, normalized body SHA-256, normalized body length, and stable header profile identity. Nested replies must not be reported as direct comments.

Stdout contains only the canonical parent permalink, hashes, lengths, identities, comment IDs, and search coverage. Raw post and comment bodies are written only below `--evidence-dir` with file mode `0600`; the directory itself is `0700`. A screenshot is stored there as read-back evidence.

## Failure model

The command returns a verification failure for zero matches, multiple matches, missing or unstable header identity, missing canonical permalink, ambiguous comment ownership, or exhausted scroll budget. Errors and logs must not contain raw bodies. The result records the number of scrolls and candidates inspected so an unsuccessful bounded search is auditable.

## Verification

Tests cover exact-body matching, explicit unique-excerpt fallback, zero and multiple matches, wrong header identity, bounded scrolling, canonical DOM permalink extraction, direct-comment scoping, normalized hashes and lengths, private evidence permissions, raw-body log denial, and CLI routing. A live invocation is permitted only after build, typecheck, lint, and tests pass on the merged Publisher implementation.
