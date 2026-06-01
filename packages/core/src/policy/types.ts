import { z } from "zod";
import { PLATFORMS } from "../platform.js";
import type { Platform } from "../platform.js";

const platformEnum = z.enum(PLATFORMS);

/**
 * Declarative, neutral content-policy configuration. The engine understands a
 * fixed vocabulary of four rule axes (language-by-platform, link placement,
 * cross-link templates, header separator) but holds ZERO consumer-specific
 * constants — concrete rule-sets are supplied as data via a preset (loadable
 * from `--policy-config`). An empty config is a valid no-op.
 *
 * `.strict()` rejects unknown keys so a malformed preset fails closed rather
 * than silently half-applying. The rule vocabulary is fixed at four axes; new
 * axes are an explicit, data-only schema extension.
 */
export const PolicyConfigSchema = z
  .object({
    /** R2: platform → BCP-47-ish lang tag; the body variant is chosen from PolicyInput.bodyByLang. */
    languageByPlatform: z.record(platformEnum, z.string().min(1)).optional(),
    /** R3: when true, CTA links are stripped from the body and emitted in firstComment. */
    linksInFirstComment: z.boolean().optional(),
    /** R4: cross-link templates appended to firstComment, keyed by the post's resolved language. */
    crossLink: z
      .object({
        url: z.string().min(1),
        skipPlatform: platformEnum.optional(),
        templateByLang: z.record(z.string(), z.string().min(1)),
      })
      .strict()
      .optional(),
    /** R5: platforms whose body must start "{headline}\n\n{rest}". */
    headerSeparatorPlatforms: z.array(platformEnum).optional(),
  })
  .strict();

export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;

/**
 * Input to the policy engine. Translation is the content pipeline's
 * responsibility (out of scope here): the caller supplies pre-translated body
 * variants keyed by language. `links` are the CTA links that R3 may relocate.
 */
export interface PolicyInput {
  platform: Platform;
  bodyByLang: Record<string, string>;
  links: string[];
}

/** The enforced post: a final body string and an optional first comment. */
export interface EnforcedPost {
  body: string;
  firstComment: string | null;
}
