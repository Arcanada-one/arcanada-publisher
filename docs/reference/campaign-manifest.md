# Managed campaign manifests

Publisher remains a generic OSS publisher by default. Campaign enforcement activates only after an operator explicitly enrolls the installation and registers an enforced target. Once a platform/profile is managed, every matching `publish`, `comment`, `edit`, or `delete` must pass the same core guard before an adapter or browser profile is constructed.

## Enrollment and local security

```bash
arcanada-publisher campaign-setup
```

Enrollment creates the following local-only files:

- `~/.arcanada-publisher/policy/managed-mode` (`0600`)
- `~/.arcanada-publisher/policy/managed-targets.json` (`0600`)
- `~/.arcanada-publisher/policy/receipt.key` (`0600`, random 32 bytes)

The policy directory and audit directories must be owner-only `0700`. Regular-file, owner, permission, and no-symlink checks are fail-closed. Setup is idempotent and never prints or rotates an existing receipt key. A partial enrollment is rejected instead of being repaired with an empty registry.

Explicit de-enrollment archives all three enrollment files under the owner-only policy directory and writes a policy audit event:

```bash
arcanada-publisher campaign-deenroll --confirm-managed-deenroll
```

Deleting or weakening an enrollment file is not de-enrollment; it blocks public mutations.

## Managed-target registry

The registry is strict JSON:

```json
{
  "schemaVersion": 1,
  "targets": [
    {
      "targetId": "example-x",
      "platform": "x",
      "profile": "default",
      "destination": {
        "authorProfileUrl": "https://example.com/example-profile"
      },
      "allowedPolicies": [
        {
          "contentKind": "article",
          "policy": "arcanada-blog-canonical"
        }
      ],
      "enforced": true
    }
  ]
}
```

Match keys are the exact platform, profile, and optional typed destination (`chatId`, `subreddit`, `ownerId`, or `authorProfileUrl`). Duplicate IDs, duplicate match keys, unknown fields, unsafe profile names, and unknown policy pairs are rejected. If a managed platform/profile is addressed without its exact destination, Publisher fails closed rather than treating the call as generic.

## Article manifest contract

`article` + `arcanada-blog-canonical` is a strict, content-addressed policy. Unknown fields are rejected. The manifest contains:

- identity: schema version, campaign/task IDs, content kind, policy, and timestamps;
- website: RU/EN HTTPS URLs, title hashes, deployment commit/run, and live verification timestamps;
- Pavel audio: RU/EN local MP3 paths, CDN URLs, raw hashes, decoded-audio fingerprint hashes, durations, engine/normalization provenance, technical verification, and listening timestamps;
- media: an optimized JPEG static hero (exact byte size, maximum 500,000 bytes) plus Telegram RU and X/LinkedIn EN full-narration MP4 records;
- immutable copy records: local path, hash, locale, title-first rule, canonical links, and policy-check timestamp;
- stage: explicit `launch`, `follow-up`, or `complete` topology; every revision keeps exactly one root Telegram, X, LinkedIn, and Facebook target;
- targets: a unique campaign `targetId`, its `managedTargetId`, action, copy/asset hashes, language, media role, idempotency key, and a content-addressed typed baseline;
- content-addressed write-ahead authorization and current body/media read-back evidence for existing posts;
- optional content-addressed canonical result records for comments, staged actions, and the separate backlink-deploy preflight.

One managed registry destination can own several campaign targets, such as a main post and a parent-bound first comment. The caller must select exactly one with `--campaign-target` or `campaignTargetId`; omitting it cannot downgrade a managed destination to generic mode. A comment target declares `parentTargetId` and is blocked until that parent has a current verified canonical result. A `retain` target represents a verified existing post that must remain unchanged and can never authorize a public mutation.

Campaigns whose comment bytes depend on newly created permalinks use staged manifests. `launch` contains no parent-bound targets. `follow-up` keeps the four root destinations and adds at least one parent-bound target on the same managed destination. `complete` requires verified result evidence for every target. Every revision changes the manifest digest and invalidates older receipts.

Authorization, absent/existing baselines, current state, and result read-backs are strict `publisher-adapter` evidence records. Their JSON bodies are parsed and compared with the exact campaign, target, destination, action, idempotency key, state, and timestamps; a matching filename/hash alone is insufficient.

The manifest itself and every local artifact must be regular, non-symlink files under a root configured in `ARCANADA_PUBLISHER_CAMPAIGN_ROOTS`. The variable is a platform path-delimiter-separated allowlist. Manifest and policy files must be owner-only.

## Canonical article preflight

Preflight evaluates the entire launch, reports all policy findings, and contacts no adapter:

```bash
ARCANADA_PUBLISHER_CAMPAIGN_ROOTS=/secure/campaigns \
  arcanada-publisher campaign-preflight \
  --platform x \
  --profile default \
  --expected-author-profile-url https://example.com/example-profile \
  --campaign-manifest /secure/campaigns/example/campaign.json \
  --campaign-action publish \
  --campaign-target example-x-main \
  --text-file /secure/campaigns/example/x.txt \
  --image /secure/campaigns/example/x-en.mp4
```

The policy requires:

| Evidence                                                       | Maximum age / rule                               |
| -------------------------------------------------------------- | ------------------------------------------------ |
| RU and EN site HTTP/title verification                         | 30 minutes                                       |
| RU and EN Pavel audio technical/listening verification         | 24 hours                                         |
| Telegram RU and X/LinkedIn EN video probe/viewing verification | 24 hours; ffprobe + ffmpeg fingerprint required  |
| Video duration                                                 | within two seconds of its bound narration        |
| Write-ahead authorization                                      | 30 minutes                                       |
| Idempotency baseline and existing-state read-back              | 30 minutes                                       |
| Facebook attachment                                            | static hero only; video rejected                 |
| Telegram/X/LinkedIn attachment                                 | exact full-narration video; image-only rejected  |
| Telegram narrated-video caption                                | at most 900 UTF-16 units                         |
| Target copy                                                    | title/link bytes and platform limit verified     |
| Comment parent                                                 | current canonical parent result, exact URL bound |

Any campaign-wide prerequisite failure blocks receipt issuance for every launch target. The command returns one signed receipt for one target and one action. Treat this short-lived value as sensitive process data: do not persist it in content files, command history, screenshots, or logs.

## Receipt use

Pass the receipt and unchanged manifest immediately to the live mutation:

```bash
arcanada-publisher publish \
  --platform x \
  --profile default \
  --expected-author-profile-url https://example.com/example-profile \
  --campaign-manifest /secure/campaigns/example/campaign.json \
  --campaign-receipt '<RECEIPT>' \
  --campaign-target example-x-main \
  --text-file /secure/campaigns/example/x.txt \
  --image /secure/campaigns/example/x-en.mp4
```

Receipts use HMAC-SHA-256, expire after 15 minutes, and bind the canonical manifest digest, campaign target, platform, profile, destination, action, mutation subject/parent URL and identity hashes, existing-content oracle, exact replacement text/media hashes, and policy version. The shared ledger atomically consumes a receipt once, so a receipt used through the CLI cannot be replayed through the localhost API. After a live adapter returns, Publisher calls the adapter's read-only verifier. The same ledger records the result-reference hash plus verified URL, reachability, and HTTP status. Missing, mismatched, or unpersisted read-back is reported as reconciliation-required unknown state rather than a safe retry.

The API accepts `campaignManifestPath`, `campaignTargetId`, and `campaignReceipt` on mutation bodies. `POST /campaign/preflight` accepts the same platform/profile/destination, target ID, `action`, `text`, and `imagePaths`, and returns `{ "receipt": "..." }`. Setup and de-enrollment are CLI-only.

Unregistered targets keep the existing Publisher behavior and do not require campaign files. Managed non-article content must select an explicitly registered policy; it never silently inherits or bypasses article rules.
