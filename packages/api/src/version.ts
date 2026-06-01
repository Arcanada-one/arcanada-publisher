// Server version surfaced on GET /health. Kept as a hand-synced constant rather
// than a package.json JSON-import so the compiled output has no rootDir/asset
// coupling — bump this in lockstep with packages/api/package.json on release.
export const VERSION = "0.1.0-pre.0";
