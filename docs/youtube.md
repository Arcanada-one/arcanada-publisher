# YouTube Adapter — Operator Runbook (PUB-0035)

The YouTube adapter publishes EN/RU videos to the **Arcanada** channel
(`UC2zUfwafsM2OxaidE0iNM7w`) via the YouTube Data API v3 — no browser
automation (YouTube ToS forbids it). Two playlists route by language:
**«Arcanada — English»** (primary) and **«Arcanada — Русский»** (additional).
Sign-in identity: the channel-owner Google account (stored as an account
oracle only — never store passwords/cookies/tokens in git or task artefacts).

## 1. Google Cloud project + Production consent screen

1. Create a Google Cloud project; enable **YouTube Data API v3**.
2. OAuth consent screen: External → add the operator account → **publish to
   Production**. While the screen stays in *Testing*, refresh tokens die after
   7 days — unattended publishing will break weekly.
3. Create an **OAuth Desktop app** client. Put the client id/secret into
   `config/credentials/` (gitignored) and export as env:
   `YOUTUBE_OAUTH_CLIENT_ID`, `YOUTUBE_OAUTH_CLIENT_SECRET`.
4. One-time consent: `arcanada-publisher login --platform youtube --profile origin`
   — opens a 127.0.0.1 single-shot listener (PKCE S256 + state), prints the
   consent URL; complete it in your own browser **choosing the Arcanada
   channel identity** at the account chooser. The refresh token lands at
   `~/.arcanada-publisher/profiles/youtube/<profile>/token.json` (0600).

## 2. Compliance audit (quota & compliance)

File the free **audit + quota extension form**
(https://support.google.com/youtube/contact/yt_api_form) at project start.
Until the audit passes, **API uploads are locked to private** regardless of
the requested visibility (official videos.insert restriction for unverified
projects created after 2020-07-28). Quota itself is a non-issue: `videos.insert`
has its own 100-calls/day bucket since 2025-12/2026-06.

## 3. Private-lock interim flow

Until the audit passes: publish with `--privacy private` (the default), then
flip visibility **manually in YouTube Studio** after review. The adapter reads
back the effective `privacyStatus` after processing and reports a divergence in
`warnings` (the private-lock signal) — treat that warning as "manual Studio
flip still required", not as an error.

## 4. Token rotation / loss recovery

- Revoked or expired refresh token → every call fails with `AUTH_EXPIRED`
  (exit 12 / HTTP 401). Re-run the login from § 1 step 4.
- To rotate proactively: revoke the app's access at
  https://myaccount.google.com/permissions, delete
  `~/.arcanada-publisher/profiles/youtube/<profile>/token.json`, re-consent.
- The upload ledger (`ledger.jsonl`, same directory) is the duplicate gate. If
  it is corrupt the adapter fails closed — reconcile against the channel's
  uploads playlist (`channels.list contentDetails` → `playlistItems.list`),
  then repair or remove the broken line. Never delete the ledger to "fix" a
  duplicate error: that removes the protection, not the cause.

## 5. Arming and the hard gate (per-session, mandatory disarm)

Live mutations (upload, playlist create, edit) require the operator-armed
state: `YOUTUBE_LIVE_ARMED=1` in the **publisher process environment**.
Procedure per publishing session:

1. Run the exact command with `--dry-run` and review the emitted mutation plan
   (channel, playlist, metadata, file sha256). Nothing is sent.
2. Arm for this session only: `export YOUTUBE_LIVE_ARMED=1` in the shell that
   runs the publisher (or the single API-server session). **Never** persist it
   in a systemd unit, shell profile, or `.env` — a permanently-armed loopback
   API lets any local agent trigger live public uploads.
3. Publish. Verify the read-back result (watch URL, playlist, warnings).
4. **Disarm immediately**: `unset YOUTUBE_LIVE_ARMED` — verify a repeated
   mutating call now fails with `NOT_ARMED` (exit 15 / HTTP 403).

First-ever upload and any public-playlist creation additionally require an
explicit operator go recorded in the task log.

## 6. Extension points (deliberately NOT implemented in v1)

- **`publishAt` scheduling** — excluded on purpose: the API requires
  `privacyStatus=private` with it, and a `publishAt` in the past publishes
  IMMEDIATELY — an instant-public bypass of the private-lock interim flow.
  If ever added: validate the timestamp is in the future and keep it behind
  the arming gate.
- **Captions (`captions.insert`)** — optional per the official docs; costs 400
  quota units per call; scope `youtube.force-ssl` already suffices.
- **Custom thumbnails (`thumbnails.set`)** — requires a phone-verified
  account; ≤2 MB via API. The preflight probes and reports the capability; it
  never blocks an upload.
