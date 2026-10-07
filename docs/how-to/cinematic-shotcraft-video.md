# How to: cinematic promo video from a social post (shotcraft engine)

Publisher has **two** video engines. Pick by intent:

| Engine              | Package                         | When to use                                                                                                                                                         | Runtime cost                                |
| ------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **cycle** (default) | `@arcanada/publisher-video`     | An _animated cover_ — the post's cover image with cycling effects + optional audio waveform. Lightweight, ffmpeg-only, no browser.                                  | ffmpeg only                                 |
| **shotcraft**       | `@arcanada/publisher-shotcraft` | A _cinematic, shot-composed promo_ — a title/kicker from the post text, product screenshot showcase shots and an outro, in the Ink Press paper-ink-amber aesthetic. | ffmpeg **+** a headless Chromium (Remotion) |

Use the **cycle** engine for the everyday "animated screensaver" house style
(see [animated-cover-video.md](animated-cover-video.md)). Reach for the
**shotcraft** engine when you want a higher-production, cinematic promo built
from a post plus one or more product screenshots.

## Prerequisites

- `ffmpeg` / `ffprobe` in `PATH` (already required by the cycle engine).
- A headless Chromium for Remotion. Provision it once:

  ```bash
  npx remotion browser ensure
  ```

  Or reuse an existing Chromium with `--browser-executable <path>` /
  `PUBLISHER_SHOTCRAFT_BROWSER=<path>`.

- The Remotion licensing acknowledgement (see **Licensing** below).

## Render

```bash
# post.txt: first line becomes the title, the rest the kicker.
arcanada-publisher video --engine shotcraft \
  --text-file post.txt \
  --asset screenshots/dashboard.png \
  --asset screenshots/detail.png \
  --shot brand-ink-open \
  --out out/cinematic.mp4
```

- `--engine shotcraft` selects this engine (default is `cycle`, unchanged).
- `--asset` is repeatable — each product screenshot becomes a showcase shot.
- `--shot` is repeatable — an explicit shot-card designation from the vendored
  106-card library (omit to use the default selection). An unknown designation
  fails with a clear "card not found" error.
- `--template ink-press` is the default and only validated template.
- `--format landscape` is the default and only validated format (1920×1080 @
  30 fps, H.264/AAC).
- `--browser-executable <path>` overrides the managed Chromium.

## Publish

The output MP4 attaches through the **existing** publish path — there is no new
publishing channel:

```bash
arcanada-publisher publish --platform x \
  --text-file post.txt \
  --image out/cinematic.mp4
```

## Licensing

The shotcraft engine drives **Remotion**. This package is wired to run under
Remotion's **individual / small-team FREE** terms (not a paid commercial
license). The engine refuses to render until that disposition is acknowledged,
either by the committed `packages/video-shotcraft/LICENSE-REMOTION.ack` marker
or the `PUBLISHER_SHOTCRAFT_LICENSE_ACK` environment variable. A later scale-up
to full company/ecosystem use would require a paid Remotion commercial license.
See <https://www.remotion.dev/docs/license>.

## Deferred

Vertical (1080×1920) and square (1080×1080) formats, and a loopback HTTP render
route, are deferred (D-REQ-07). Only landscape and the CLI trigger ship today.
