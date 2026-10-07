# @arcanada/publisher-shotcraft

A cinematic **Remotion** render engine for `arcanada-publisher`. It turns a
social post (text + product screenshot[s]) into a shot-composed 1920×1080
promo MP4, using the vendored [`video-shotcraft`](https://github.com/Vincentwei1021/video-shotcraft)
skill (106 shot recipe cards + the Ink Press template) as authoring data.

It is the **cinematic** counterpart to `@arcanada/publisher-video` (the
lightweight ffmpeg "animated cover" engine). The two engines coexist; the CLI
routes between them by an explicit `--engine` flag. The produced MP4 flows
through Publisher's existing `publish --image` path — no new publishing channel.

## Programmatic API

```ts
import { renderCinematic } from "@arcanada/publisher-shotcraft";

const result = await renderCinematic({
  textFile: "post.txt", // .txt/.md — validated path
  assets: ["dashboard.png"], // product screenshot(s) — validated image paths
  out: "cinematic.mp4", // parent dir must exist
  shots: ["brand-ink-open"], // optional explicit shot cards (else default)
  // template: "ink-press",         // default + only validated template
  // format: LANDSCAPE,             // default 1920x1080@30 h264/aac
  // browserExecutable: "/path",    // optional Chromium override
});
// result: { out, durationSec, hasAudio }
```

## CLI

```bash
arcanada-publisher video --engine shotcraft \
  --text-file post.txt --asset cover.png --shot brand-ink-open \
  --out cinematic.mp4
```

See [`docs/how-to/cinematic-shotcraft-video.md`](../../docs/how-to/cinematic-shotcraft-video.md).

## Runtime dependencies

- **ffmpeg / ffprobe** in `PATH` (pre-existing Publisher dependency).
- A **headless Chromium** for Remotion. Provision once with
  `npx remotion browser ensure`, or point `--browser-executable` /
  `PUBLISHER_SHOTCRAFT_BROWSER` at an existing Chromium.

The preflight fails with a clear `MISSING_INPUT` error + install hint when
either is absent.

## Footprint isolation

`remotion`, `@remotion/*`, `react` and `react-dom` are declared **only** in this
package. `@arcanada/publisher-core`, the platform adapters and the CLI carry no
Remotion/React weight — the CLI reaches this engine through a dynamic import
inside the `--engine shotcraft` branch.

## Supply chain

The `video-shotcraft` assets are a **checked-in, hash-pinned** subtree under
`vendor/video-shotcraft/`, pinned by `vendor/video-shotcraft.lock` (upstream
commit + content hash). `dev-tools/verify-vendor.sh` re-derives the hash in CI.
There is no build-time network fetch. Every post-supplied path is validated
(NUL / existence / extension allowlist) and every subprocess is spawned with an
argument array (`shell: false`) — no shell-string interpolation.

## Licensing

This engine runs under Remotion's **individual / small-team free** terms (not a
paid commercial license). It refuses to render until that disposition is
acknowledged via the committed `LICENSE-REMOTION.ack` marker or the
`PUBLISHER_SHOTCRAFT_LICENSE_ACK` environment variable. A later scale-up to full
company/ecosystem use would require a paid Remotion commercial license. See
<https://www.remotion.dev/docs/license>.

Package code is MIT (see the repository `LICENSE`). The vendored subtree keeps
its upstream license (`vendor/video-shotcraft/LICENSE`).
