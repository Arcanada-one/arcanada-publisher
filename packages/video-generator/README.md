# @arcanada/publisher-video

Animated-cover video generator for `arcanada-publisher`. Turns a cover image
and an optional audio track into a polished MP4 for social posts, using only
ffmpeg built-in filters (no plugins).

## Prerequisites

ffmpeg must be in `PATH`:

```bash
brew install ffmpeg   # macOS
apt install ffmpeg    # Debian / Ubuntu
```

## Usage

### Via the CLI

```bash
# Generate a video (cover + audio):
arcanada-publisher video \
  --cover /path/to/cover.jpg \
  --audio /path/to/narration.mp3 \
  --out out.mp4 \
  --preset cycle \
  --seed 42

# Cover-only (~30s by default):
arcanada-publisher video \
  --cover /path/to/cover.jpg \
  --out out-cover-only.mp4 \
  --cover-seconds 30

# List available presets:
arcanada-publisher video --list-presets

# Then attach to a post (X accepts .mp4 via the existing --image path):
arcanada-publisher publish \
  --platform x \
  --text-file post.txt \
  --image out.mp4
```

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--cover <path>` | required | Cover image (.png/.jpg/.jpeg/.webp/.gif) |
| `--audio <path>` | — | Audio file (.mp3/.m4a/.aac/.wav/.ogg). When omitted, produces cover-only clip. |
| `--out <path>` | required | Output .mp4 path. Parent directory must exist. |
| `--preset <name>` | `cycle` | Visual preset (see `--list-presets`). |
| `--cover-seconds <n>` | `30` | Duration in seconds for cover-only clips. |
| `--seed <n>` | — | Integer seed for reproducible effect shuffle (cycle preset). |
| `--max-bitrate <kbps>` | `600` | Max output bitrate ceiling in kbit/s (VBV cap on final encode). Default 600 kbps (~35 MB for a 7–8 min clip). |
| `--list-presets` | — | Print available presets and exit. |

### Programmatic API

```ts
import { generateVideo, listPresets } from "@arcanada/publisher-video";

// List presets:
console.log(listPresets());
// [{ name: "zoompan", description: "...", timelineChanging: false }, ...]

// Generate:
const result = await generateVideo({
  cover: "/path/to/cover.jpg",
  audio: "/path/to/audio.mp3", // optional
  out: "/path/to/out.mp4",
  preset: "cycle",       // optional, default: "cycle"
  seed: 42,              // optional: reproducible shuffle
  coverOnlySeconds: 30,  // optional: ignored when audio is provided
  maxBitrateKbps: 600,   // optional: VBV ceiling (default 600 kbps)
});
// result: { out, durationSec, hasAudio }
```

## Presets

| Name | Timeline-changing | Description |
|------|-------------------|-------------|
| `zoompan` | no | Calm slow zoom-in on the cover image. Works with or without audio. |
| `cqt` | no | showcqt music visualizer overlaid on a blurred cover. Requires audio; falls back to zoompan for cover-only. |
| `cycle` | **yes** | House-style: clean cover intro (~2s), then a new visual effect every 3s from a shuffled pool of 44 effects with smooth crossfades. Default preset. |

For house-style rules and platform-specific attach instructions, see
[`docs/how-to/animated-cover-video.md`](../../docs/how-to/animated-cover-video.md).

## Security

- ffmpeg is spawned with an **argument array** (`execFileSync`, never `exec`/shell-string interpolation).
- Filtergraph strings come only from the fixed preset registry. No user path or free-form string enters `-filter_complex`.
- All inputs are validated before any spawn: NUL-byte reject, existence, regular-file, extension allowlist.
- No plugin loading (no Frei0r / LADSPA / LV2 / projectM).
