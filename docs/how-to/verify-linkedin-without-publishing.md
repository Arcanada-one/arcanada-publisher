# How to verify the LinkedIn adapter without publishing

Three layers of verification, in increasing fidelity, none of which post, delete,
or comment anything on your real account. Use them to gain confidence in the
PUB-0031 (video) and PUB-0032 (delete/comment selector) fixes before — or instead
of — a real live round-trip.

## Layer 1 — Unit tests (offline, zero risk, runs in CI)

Drives the **real adapter code** with a fake page. Proves the logic: fail-closed
video verify (PUB-0031), scoped-vs-page-wide `<video>` detection, the
delete/comment selector-drift fallbacks, and the multi-locale regexes.

```bash
pnpm --filter @arcanada/publisher-linkedin test
```

What it cannot prove: that the fake DOM matches the live 2026 LinkedIn DOM. That
gap is what Layers 2 and 3 close.

## Layer 2 — Label fixtures (offline, runs in CI)

Asserts the control **labels** LinkedIn actually ships match the production
selector regexes. When LinkedIn localizes or renames a control, the recorded
label fails its regex here — the same break the live flow would hit, caught with
no browser.

```bash
pnpm --filter @arcanada/publisher-linkedin test -- dom-fixtures
```

Keep it honest: the shipped fixtures are `"source": "synthetic"` stand-ins. To
make this a real regression guard, capture the live labels (≈1 min, no posting)
per [`tests/fixtures/README.md`](../../packages/adapter-linkedin/tests/fixtures/README.md)
and commit a `"source": "real"` fixture. A new label that fails its regex is
exactly the drift CI should catch.

## Layer 3 — Abort-before-post dry-run (live UI, still no publishing)

The highest-fidelity check short of posting. A **headed** browser opens your real
LinkedIn, runs the FULL composer flow — opens the composer, attaches the video,
waits for the scoped `<video>` preview, types the text — then **aborts before
clicking «Post»**. Nothing is published. You can watch the composer populate.

```bash
# 1. (video case) copy a ≤~35MB .mp4 onto the OS clipboard as a POSIX-file (§6.4)
#    e.g. on macOS, in Finder: select the file → Edit → Copy.
export PUB_SMOKE_VIDEO=/absolute/path/to/cover-narration.mp4

# 2. run the gated dry-run probes (LI_DRYRUN_PROBE=1 — does NOT post)
LI_DRYRUN_PROBE=1 PUB_PROFILE=default \
  pnpm --filter @arcanada/publisher-linkedin test:smoke
```

- **P1** asserts the video attaches (`mediaAttached: true` ⇒ a `<video>` rendered
  _inside the composer_, proving the scoped detection works on the live DOM) and
  returns `aborted: true` — never posted.
- **P2** does the same text-only.

`LI_DRYRUN_PROBE` is a separate, safer gate than `LI_LIVE_SMOKE`: the dry-run
probes never post, while `LI_LIVE_SMOKE=1` (S1–S4) publishes real content and is
the operator-gated final DoD check.

### Programmatic use

```ts
import { LinkedInAdapter } from "@arcanada/publisher-linkedin";

const adapter = new LinkedInAdapter({ publishOptions: { headed: true } });
const res = await adapter.publishDryRunNoPost({
  text: "dry run — will not post",
  imagePath: "/abs/path/cover.mp4",
  profile: "default",
});
// res.aborted === true, res.mediaAttached === true, nothing published.
```
