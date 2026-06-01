# Self-publish announce (Phase 7 dogfood)

`arcanada-publisher` announcing itself, published by itself. This directory holds
the per-platform announce bodies, the first-comment bodies, and a runner that
drives all three platforms through the tool's own CLI.

## Files

| File                | Platform | Language | Notes                                    |
| ------------------- | -------- | -------- | ---------------------------------------- |
| `announce.fb.ru.md` | Facebook | Russian  | image-mandatory (R1)                     |
| `announce.li.en.md` | LinkedIn | English  | image optional                           |
| `announce.x.en.md`  | X        | English  | image-mandatory (R1); ≤ 280 UTF-16 units |
| `comment.fb.ru.md`  | Facebook | Russian  | first comment — canonical TG + links     |
| `comment.li.en.md`  | LinkedIn | English  | first comment — canonical TG + links     |
| `comment.x.en.md`   | X        | English  | first comment — canonical TG + links     |
| `run.sh`            | —        | —        | dry-run by default; `--commit` for live  |

Per-platform language follows the operator convention: LinkedIn and X are
English-only; Facebook is Russian.

## Dry-run (no login, no IO)

```bash
ANNOUNCE_IMAGE=/path/to/announce.png ./run.sh
```

Each platform prints a `published: <dry-run-url>` line and exits 0. The X body is
checked against the 280 UTF-16 limit before anything else; an over-limit body is
rejected here, not at publish time.

## Live publish (operator-gated, irreversible)

Live publishing posts to **your own** Facebook, LinkedIn, and X accounts. Log in
once per platform first:

```bash
arcanada-publisher login --platform facebook
arcanada-publisher login --platform linkedin
arcanada-publisher login --platform x
```

Then, with operator confirmation:

```bash
ANNOUNCE_IMAGE=/path/to/announce.png ./run.sh --commit
```

After each post lands, add the canonical first comment (substitute the real
`t.me/valentovtypes/<msg_id>` into the comment file first), per
`docs/explanation/canonical-tg-link-policy.md`:

```bash
arcanada-publisher comment --platform facebook \
  --parent-url <facebook-post-url> --text-file comment.fb.ru.md
```

Capture the three live post URLs and archive them in the task's archive document.
