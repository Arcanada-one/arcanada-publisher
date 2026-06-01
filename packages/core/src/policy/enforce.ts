import type { PolicyConfig, PolicyInput, EnforcedPost } from "./types.js";

/**
 * Apply a declarative content policy to a post. Pure and immutable — never
 * mutates its arguments and performs no IO. With an empty config it is the
 * identity transform (no hard-wired consumer fallback): the body is the single
 * available language variant, links stay in the body, and there is no first
 * comment.
 *
 * Rule order: R2 language → R3 link relocation → R4 cross-link → R5 separator.
 */
export function enforce(input: PolicyInput, config: PolicyConfig = {}): EnforcedPost {
  const lang = resolveLanguage(input, config);
  let body = selectBody(input, lang);

  const commentParts: string[] = [];

  // R3: relocate CTA links from body to the first comment.
  if (config.linksInFirstComment) {
    body = stripLinks(body, input.links);
    commentParts.push(...input.links);
  }

  // R4: append the cross-link with the per-language template.
  const crossLink = renderCrossLink(input.platform, lang, config);
  if (crossLink) {
    commentParts.push(crossLink);
  }

  // R5: separate the headline from the rest with a blank line.
  if (config.headerSeparatorPlatforms?.includes(input.platform)) {
    body = applyHeaderSeparator(body);
  }

  return {
    body,
    firstComment: commentParts.length > 0 ? commentParts.join("\n") : null,
  };
}

/** R2: the platform's configured language, or the sole input language as fallback. */
function resolveLanguage(input: PolicyInput, config: PolicyConfig): string {
  const mapped = config.languageByPlatform?.[input.platform];
  if (mapped) {
    return mapped;
  }
  return Object.keys(input.bodyByLang)[0] ?? "";
}

function selectBody(input: PolicyInput, lang: string): string {
  return input.bodyByLang[lang] ?? Object.values(input.bodyByLang)[0] ?? "";
}

/** Remove each known CTA link and tidy the whitespace it leaves behind. */
function stripLinks(body: string, links: string[]): string {
  let out = body;
  for (const link of links) {
    out = out.split(link).join("");
  }
  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]+$/g, "")
    .trimEnd();
}

/** R4: render "<template with {url}>" for the resolved language, or null. */
function renderCrossLink(
  platform: PolicyInput["platform"],
  lang: string,
  config: PolicyConfig,
): string | null {
  const cl = config.crossLink;
  if (!cl || cl.skipPlatform === platform) {
    return null;
  }
  const template = cl.templateByLang[lang];
  if (!template) {
    return null;
  }
  return template.split("{url}").join(cl.url);
}

/** R5: ensure the first line is separated from the body by a blank line. */
function applyHeaderSeparator(body: string): string {
  const nl = body.indexOf("\n");
  if (nl === -1) {
    return body;
  }
  const headline = body.slice(0, nl);
  const rest = body.slice(nl + 1).replace(/^\n+/, "");
  return `${headline}\n\n${rest}`;
}
