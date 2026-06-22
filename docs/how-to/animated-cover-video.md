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

## Rules

1. **Inputs come from the post itself** — the cover is the post's hero cover, the
   audio is the article's own narration in the post language. The intro frame is
   always that cover.
2. **Re-shuffle every run** — do not hard-code an order; let each post get a
   different sequence. Use `seed` only to reproduce a specific result for debugging.
3. **Never ship a bare audio-waveform visualizer** (`showwaves` / `showcqt` /
   `showspectrum`) as the post video — it looks generic. The animated-cover cycle
   is the house style.
4. **Per-platform attach** is unchanged:
   - **X (long-form)** and **LinkedIn** take the MP4.
   - **Facebook** feed forces any video into Reels, so on FB use the **static
     cover image** instead — keep the video for X and LinkedIn.
   - **Telegram** can take the MP4 (`sendVideo`).

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
