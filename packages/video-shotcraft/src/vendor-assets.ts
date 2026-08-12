// Read-only resolver over the checked-in, hash-pinned vendored video-shotcraft
// subtree (DESIGN §3 / D3). Indexes the 106 shot recipe cards by designation and
// exposes the Ink Press template directory. Shot cards and the template are
// treated as READ-ONLY DATA: the render never executes a vendored script as a
// build step. A missing card raises a typed "card not found" error (V-AC-2).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";
import { vendorRoot } from "./paths.js";

export interface ShotCard {
  /** Card designation (the `name:` frontmatter field, falling back to the file stem). */
  name: string;
  /** Absolute path to the card markdown file. */
  file: string;
  /** Recommended shot length in frames, parsed from the card when available. */
  durationFrames: number | undefined;
  /** Recommended shot length in seconds, parsed from the card when available. */
  durationSec: number | undefined;
}

function shotsDir(): string {
  return join(vendorRoot(), "references", "shots");
}

/** Absolute path to the Ink Press template directory; throws if the subtree is absent. */
export function inkPressTemplateDir(): string {
  const dir = join(vendorRoot(), "template");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      `shotcraft: Ink Press template directory missing from the vendored subtree: ${dir}`,
    );
  }
  return dir;
}

/** Parse a card's `name:` designation and recommended duration from its frontmatter. */
function parseCard(file: string): ShotCard {
  const stem = basename(file, extname(file));
  let name = stem;
  let durationFrames: number | undefined;
  let durationSec: number | undefined;
  try {
    const text = readFileSync(file, "utf8");
    const nameMatch = /^name:\s*(\S+)\s*$/m.exec(text);
    if (nameMatch?.[1]) name = nameMatch[1];
    // The card's duration line carries a frame count (e.g. "83f") and a seconds
    // value (e.g. "2.8s"); extract whichever are present. The card body is
    // upstream (non-English) prose, so match on the numeric tokens only.
    const framesMatch = /(\d+)\s*f\b/.exec(text);
    if (framesMatch?.[1]) durationFrames = Number.parseInt(framesMatch[1], 10);
    const secMatch = /([\d.]+)\s*s\b/.exec(text);
    if (secMatch?.[1]) durationSec = Number.parseFloat(secMatch[1]);
  } catch {
    // Unparseable card — index it by stem with no timing (defaults apply downstream).
  }
  return { name, file, durationFrames, durationSec };
}

let _index: Map<string, ShotCard> | undefined;

function index(): Map<string, ShotCard> {
  if (_index !== undefined) return _index;
  const dir = shotsDir();
  if (!existsSync(dir)) {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      `shotcraft: vendored shot-card directory missing: ${dir}`,
    );
  }
  const map = new Map<string, ShotCard>();
  for (const entry of readdirSync(dir)) {
    if (extname(entry).toLowerCase() !== ".md") continue;
    const card = parseCard(join(dir, entry));
    map.set(card.name, card);
    // Also index by file stem so either designation or filename resolves.
    map.set(basename(entry, extname(entry)), card);
  }
  _index = map;
  return map;
}

/** Number of shot recipe cards in the vendored subtree (expected: 106). */
export function shotCardCount(): number {
  const dir = shotsDir();
  return readdirSync(dir).filter((f) => extname(f).toLowerCase() === ".md").length;
}

/** List every shot-card designation (unique names). */
export function listShotCards(): string[] {
  const seen = new Set<string>();
  for (const card of index().values()) seen.add(card.name);
  return [...seen].sort();
}

/**
 * Resolve a shot card by designation. Throws AdapterError(MISSING_INPUT) with a
 * clear "card not found" message when the designation is unknown (V-AC-2 / F9).
 */
export function resolveShotCard(designation: string): ShotCard {
  const card = index().get(designation);
  if (card === undefined) {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      `shotcraft: shot card not found: '${designation}'. Run with a known card designation ` +
        `(there are ${shotCardCount()} vendored cards).`,
    );
  }
  return card;
}

/** Visible for testing: drop the cached card index. */
export function _resetVendorIndex(): void {
  _index = undefined;
}
