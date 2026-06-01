# Examples

Consumer-specific configuration and usage samples. **Nothing here is published
to npm** — each `@arcanada/publisher-*` package ships only its `dist/` (see each
package's `files` allowlist), so these files are tracked in git for reference but
never land in a published tarball.

## `arcanada-preset.{json,ts}`

The Arcanada content-policy rule-set (D-1). The neutral policy engine in
`@arcanada/publisher-core` understands a fixed vocabulary of rule axes
(language-by-platform, link placement, cross-link templates, header separator)
but holds **zero** consumer constants. The concrete Arcanada rules — the
Telegram channel URL, the RU/EN language map, the `(in Russian)` marker — live
here as data and are supplied at runtime:

```bash
# CLI: load the preset and publish
arcanada-publisher publish \
  --platform linkedin \
  --text-file post.txt \
  --image hero.png \
  --policy-config examples/arcanada-preset.json
```

```ts
// Programmatic
import { enforce } from "@arcanada/publisher-core";
import { arcanadaPolicy } from "./arcanada-preset";

const post = enforce(
  { platform: "linkedin", bodyByLang: { en: "..." }, links: ["https://..."] },
  arcanadaPolicy,
);
```

An **empty** preset (`{}`) makes the engine a no-op: the body is the single
available language variant, links stay in the body, no first comment. There is
no hard-wired fallback — neutrality is the default.
