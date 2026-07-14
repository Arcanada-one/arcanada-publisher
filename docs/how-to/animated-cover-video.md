# How to: animated-cover video for social posts

The house style for a social-post video is **not** a static cover and **not** a
plain cover+audio clip with an audio-waveform visualizer. It is an **animated
screensaver**: the post's cover shown clean for a moment, then a new visual
effect every few seconds, cycling through a large randomly-shuffled pool with
smooth crossfades, for the full length of the article narration.

This is pure ffmpeg — no external plugins.

## Generator

### TypeScript package (canonical entry point — PUB-0027)

The `@arcanada/publisher-video` package is the canonical way to generate post
videos within the monorepo. See
[`packages/video-generator/README.md`](../../packages/video-generator/README.md)
for full usage. Quick reference:

```bash
# Via the CLI:
arcanada-publisher video \
  --cover img/blog/cover.jpg \
  --audio audio/narration.mp3 \
  --out out/post-video.mp4 \
  --preset cycle \
  --seed 42

# List available presets (zoompan / cqt / cycle):
arcanada-publisher video --list-presets

# Attach to an X post via the existing --image path:
arcanada-publisher publish --platform x --text-file post.txt --image out/post-video.mp4
```

### Bash reference engine

The bash script remains as the documented reference for the `cycle` filtergraph
logic. The TypeScript `cycle` preset is a direct port.

```
dev-tools/video/make-cycle-video.sh <cover> <audio> <out.mp4> [intro_sec] [seg_sec] [seed]
```

| Arg         | Meaning                                                                                                                                 | Default  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `cover`     | The post's cover image (the article hero cover — the post-level cover, **not** an in-article inline preview). Always the opening frame. | required |
| `audio`     | The article narration in the post language.                                                                                             | required |
| `out.mp4`   | Output path.                                                                                                                            | required |
| `intro_sec` | Seconds the clean cover is held before effects begin.                                                                                   | `2`      |
| `seg_sec`   | Seconds each effect is on screen.                                                                                                       | `3`      |
| `seed`      | Fixed seed to reproduce one exact effect order. Omit for a fresh random order.                                                          | random   |

Internal constants (edit at the top of the script): `XF=0.6` crossfade seconds,
`W=1280 H=720` frame size, a pool of ~44 distinct effects.

## What it produces

- **0 → intro_sec**: the post cover, held still (narration already playing — this
  is a held frame, not silence).
- **after intro_sec**: a new visual effect every `seg_sec`, drawn from the pool in
  a **randomly-shuffled order** (Fisher-Yates), with a `XF`-second crossfade
  between each. Two runs never produce the same sequence unless you pass `seed`.
- **length** = the narration length exactly; audio plays from `t=0`.
- **no audio supplied** → the script falls back to a ~30 s clip from the cover
  alone, still with cycling effects.

## Bottom amplitude strip (default-on)

When the video has narration audio, the `cycle` preset draws a **bottom audio-
amplitude strip** overlaid on the cover animation: a `showwaves` oscilloscope
filled with a horizontal **gold→crimson** gradient, pinned to the bottom edge.
It shows the narration amplitude in real time without turning the whole frame
into a generic visualizer (rule 3). Operator-approved house style (2026-06-28).

Defaults: enabled, **180 px** tall, left `0xFFD24C` (gold) → right `0xE03B5A`
(crimson). It is drawn in the same final mux pass (no extra pass / temp file),
and is skipped automatically on a cover-only run (no audio = no amplitude).

Control it via CLI flags on the `video` subcommand:

```bash
# Default (strip on, house style) — no flag needed:
arcanada-publisher video --cover c.jpg --audio narration.mp3 --out v.mp4

# Turn the strip off:
arcanada-publisher video --cover c.jpg --audio narration.mp3 --out v.mp4 --no-waveform

# Custom height + gradient colours ("LEFT,RIGHT" hex):
arcanada-publisher video --cover c.jpg --audio narration.mp3 --out v.mp4 \
  --waveform-height 120 --waveform-colors 0x35E0FF,0x4F6BFF
```

Programmatic (`generateVideo`): pass `waveform: { enabled?, heightPx?, colorLeft?,
colorRight? }` — a partial object merged over the house-style default; omit it for
the default. The bash reference engine mirrors this via env vars: `WAVEFORM=0`
(off), `WAVEFORM_HEIGHT`, `WAVEFORM_C0`, `WAVEFORM_C1`.

## Rules

1. **Inputs come from the post itself** — the cover is the post's hero cover, the
   audio is the article's own narration in the post language. The intro frame is
   always that cover.
2. **Re-shuffle every run** — do not hard-code an order; let each post get a
   different sequence. Use `seed` only to reproduce a specific result for debugging.
3. **Never ship a _bare_ audio-waveform visualizer as the WHOLE post video** —
   a full-frame `showwaves` / `showcqt` / `showspectrum` clip looks generic. The
   animated-cover cycle stays the hero. A **bottom amplitude strip drawn ON TOP of
   the cycle** is allowed and is now the default (see § Bottom amplitude strip) —
   the distinction is overlay-strip (good) vs. whole-frame-visualizer (forbidden).
4. **Per-platform attach** is unchanged:
   - **X (long-form)** and **LinkedIn** take the MP4.
   - **Facebook** feed forces any video into Reels, so on FB use the **static
     cover image** instead — keep the video for X and LinkedIn.
   - **Telegram** can take the MP4 (`sendVideo`).
5. **Use only approved narration audio.** The source MP3 must already have passed
   the semantic fidelity gate in
   [`blog-audio-narration.md`](./blog-audio-narration.md), including independent
   ASR comparison and complete proof-listening. Record the approved MP3 SHA-256 in
   the campaign's `verification.json` receipt. “The MP3 decodes” is not approval.
6. **Verify the final MP4 audio, not only the source MP3.** After muxing, extract
   and transcribe the MP4 audio in the post language. Confirm that it preserves the
   approved narration in order, has no unexpected repeated or inserted phrase, and
   matches the expected duration. Codec, dimensions, bitrate, waveform, and
   non-silence checks remain necessary, but none of them prove spoken content.
7. **A changed input invalidates the video.** Regenerating or replacing the MP3,
   cover, or MP4 requires a new bound receipt and a new verification result. Until
   Publisher has a code-level receipt validator, this is a manual fail-closed gate:
   the operator or agent must not pass the MP4 to `publish` without the required
   PASS evidence. See the evidence contract in `blog-audio-narration.md`.

CONTENT-0377 is the failure precedent: one semantically corrupted EN MP3 passed
technical probes and propagated unchanged into both X and LinkedIn videos. The
video gate must therefore consume the audio approval evidence, not infer approval
from successful rendering.

## Example

```bash
dev-tools/video/make-cycle-video.sh \
  img/blog/arcanada-month-two-hardware.jpg \
  img/blog/audio/arcanada-month-two-vm-to-bare-metal-ru-xenia.mp3 \
  out/post-video.mp4
# → out/post-video.mp4, length = narration, cover → cycling effects with crossfades
```

## Tuning

- **Calmer / faster effect changes** — raise / lower `seg_sec`.
- **Longer / shorter intro** — change `intro_sec` (operator preference was ~2 s;
  a 5 s hold reads as a "pause / frozen" start).
- **Softer / harder transitions** — change `XF` at the top of the script.
- **Frame format** — `W`/`H` at the top of the script (default 1280×720; set a
  square or 9:16 for a specific platform if needed).

> This document is the canonical reference for the post-video house style. The
> ecosystem publishing skill (`~/.claude/skills/publishing/SKILL.md` § Video
> standard for social posts) mirrors these rules — keep the two in sync.
