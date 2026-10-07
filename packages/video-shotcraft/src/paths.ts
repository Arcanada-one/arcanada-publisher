// Resolve stable paths inside the @arcanada/publisher-shotcraft package,
// regardless of whether the code runs from `src/` (vitest, ts-node) or the
// compiled `dist/`. Walks up from this module's directory until it finds the
// package.json that declares this package, then anchors sibling directories
// (vendor/, LICENSE-REMOTION.ack, the composition entry) off that root.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let _root: string | undefined;

/** Absolute path to the package root (the dir containing this package's package.json). */
export function packageRoot(): string {
  if (_root !== undefined) return _root;
  let dir = dirname(fileURLToPath(import.meta.url));
  // Walk up looking for the package.json that names this package.
  for (let i = 0; i < 8; i++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, "utf8")) as { name?: string };
        if (parsed.name === "@arcanada/publisher-shotcraft") {
          _root = dir;
          return dir;
        }
      } catch {
        // Not our package.json — keep walking.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("shotcraft: could not locate @arcanada/publisher-shotcraft package root");
}

/** Absolute path to the checked-in vendored video-shotcraft subtree. */
export function vendorRoot(): string {
  return join(packageRoot(), "vendor", "video-shotcraft");
}

/** Absolute path to the Remotion composition bundle entry (TSX source). */
export function compositionEntry(): string {
  return join(packageRoot(), "src", "compose", "entry.tsx");
}

/** Absolute path to the Remotion `public/` dir served during a render (static assets). */
export function publicDir(): string {
  return join(vendorRoot(), "template", "public");
}
