#!/usr/bin/env node
// Demo-clip harness (Step 8, T9).
// Renders one MP4 per preset from a real cover + audio into datarim/qa/PUB-0027/.
// Run: node --import tsx/esm scripts/make-demos.ts <cover> <audio> <outDir>
//   or: ts-node scripts/make-demos.ts <cover> <audio> <outDir>
//
// Example:
//   node --loader ts-node/esm scripts/make-demos.ts \
//     tests/fixtures/cover.jpg tests/fixtures/audio.mp3 \
//     ../../../../datarim/qa/PUB-0027

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { generateVideo, listPresets } from "../src/index.js";

const [, , rawCover, rawAudio, rawOut] = process.argv;

if (!rawCover || !rawAudio || !rawOut) {
  process.stderr.write("Usage: make-demos.ts <cover> <audio> <outDir>\n");
  process.exit(1);
}

const cover = resolve(rawCover);
const audio = resolve(rawAudio);
const outDir = resolve(rawOut);

mkdirSync(outDir, { recursive: true });

const presets = listPresets();
process.stdout.write(`Rendering ${presets.length} demo clips to ${outDir}\n`);

for (const preset of presets) {
  const out = `${outDir}/demo-${preset.name}.mp4`;
  process.stdout.write(`[${preset.name}] → ${out} ...\n`);
  const result = await generateVideo({
    cover,
    audio,
    out,
    preset: preset.name,
    seed: 42,
  });
  process.stdout.write(
    `[${preset.name}] done: ${result.durationSec.toFixed(1)}s, audio=${result.hasAudio}\n`,
  );
}

process.stdout.write("All demos rendered.\n");
