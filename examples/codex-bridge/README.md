# Codex CLI bridge — arcanada-publisher

Lets a Codex CLI agent publish through the arcanada-publisher loopback HTTP API.
The wire contract is identical to the Claude Code bridge — start the server
once, POST a JSON payload per action — so a single `server` process can back
both agents. Credentials stay in the `server` process environment, never in the
payload.

> **AAL status.** The publisher runs at AAL **L1**. The four L2 controls
> (audit log, cost circuit-breaker, drift cron, tool scoping) are implemented
> and tested, but the L1→L2 flip is deferred until the gate criteria hold in
> practice. Treat this bridge as an internal, supervised surface — not an
> advertised autonomous L2 capability.

## Prerequisites

- `arcanada-publisher` built and on `PATH`
- `jq` for the JSON response
- The loopback server running:

  ```bash
  arcanada-publisher server          # 127.0.0.1:8787 by default
  ```

## Usage

Reference the wrapper from a Codex `command` step or call it directly:

```bash
./publish.sh '{"platform":"x","text":"Hello from Codex","imagePaths":["/tmp/hero.png"],"dryRun":true}'
```

`X` is image-mandatory; `reddit`/`vkontakte` need `subreddit`+`title` /
`ownerId`. Set `ARCANADA_PUBLISHER_PORT` if the server is on a non-default port.

## Round-trip verification

```bash
arcanada-publisher server &          # 1. start (background)
sleep 1
./publish.sh '{"platform":"x","text":"Test","imagePaths":["/tmp/hero.png"],"dryRun":true}'  # 2. publish (dry-run)
curl -fsS http://127.0.0.1:8787/health    # 3. health → {ok,version,platforms}
kill %1                              # 4. stop
```
