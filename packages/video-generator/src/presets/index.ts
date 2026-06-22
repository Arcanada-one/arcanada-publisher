// Preset registry — the single source of truth for preset names, descriptions,
// and builder functions. No user-controlled string enters the registry lookup.

import type { PresetDef } from "./types.js";
import { zoompanPreset } from "./cover-zoompan.js";
import { cqtPreset } from "./audio-cqt.js";
import { cyclePreset } from "./cycle.js";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";

export type { PresetDef };

/** Immutable registry of all available presets. */
export const PRESET_REGISTRY: ReadonlyMap<string, PresetDef> = new Map([
  [zoompanPreset.name, zoompanPreset],
  [cqtPreset.name, cqtPreset],
  [cyclePreset.name, cyclePreset],
]);

/**
 * Resolve a preset by name.
 * Throws AdapterError(INVALID_ARGS) with the valid names listed when unknown.
 */
export function resolve(name: string): PresetDef {
  const preset = PRESET_REGISTRY.get(name);
  if (preset === undefined) {
    const valid = [...PRESET_REGISTRY.keys()].join(", ");
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `unknown preset '${name}' — valid presets: ${valid}`,
      { requested: name, valid: [...PRESET_REGISTRY.keys()] },
    );
  }
  return preset;
}

/** Return all registered preset names in insertion order. */
export function names(): string[] {
  return [...PRESET_REGISTRY.keys()];
}

/** Return metadata for all presets (for --list-presets output). */
export function describe(): { name: string; description: string; timelineChanging: boolean }[] {
  return [...PRESET_REGISTRY.values()].map(({ name, description, timelineChanging }) => ({
    name,
    description,
    timelineChanging,
  }));
}
