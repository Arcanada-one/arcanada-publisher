# Claude Code bridge — arcanada-publisher

A minimal wrapper that lets a Claude Code agent publish through the
arcanada-publisher loopback HTTP API. The agent starts the server once, then
POSTs a JSON payload per action. Nothing browser-specific lives in the agent;
credentials stay in the environment of the `server` process.

> **AAL status.** The publisher runs at AAL **L1**. The four L2 controls
> (audit log, cost circuit-breaker, drift cron, tool scoping) are implemented
> and tested, but the L1→L2 flip is deferred until the gate criteria hold in
> practice (30-day window + ≥5 audited dogfood publishes). Treat this bridge as
> an internal, supervised surface — not an advertised autonomous L2 capability.

## Prerequisites

- `arcanada-publisher` built and on `PATH` (or invoked via `node dist/index.js`)
- `jq` for pretty-printing the JSON response
- The loopback server running:

  ```bash
  arcanada-publisher server          # 127.0.0.1:8787 by default
  ```

## Usage

```bash
./publish.sh '{"platform":"x","text":"Hello from Claude Code","imagePaths":["/tmp/hero.png"],"dryRun":true}'
```

`X` is image-mandatory, so a dry-run still needs at least one `imagePaths`
entry. `reddit`/`vkontakte` need `subreddit`+`title` / `ownerId` respectively.

## Round-trip verification

```bash
arcanada-publisher server &          # 1. start (background)
sleep 1
./publish.sh '{"platform":"x","text":"Test","imagePaths":["/tmp/hero.png"],"dryRun":true}'  # 2. publish (dry-run)
curl -fsS http://127.0.0.1:8787/health    # 3. health → {ok,version,platforms}
kill %1                              # 4. stop
```

A successful dry-run returns `{"ok":true,"data":{...}}`; a live publish also
carries a `data.auditRef` (`PUB-audit-…`) pointing at the JSONL audit record.
