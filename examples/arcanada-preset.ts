// Arcanada content-policy preset (D-1), typed form.
//
// This file is an EXAMPLE consumer configuration. It is intentionally NOT part
// of any published @arcanada/publisher-* package — the neutral policy engine in
// @arcanada/publisher-core understands the rule vocabulary but ships none of the
// concrete constants below (channel URL, language map, "(in Russian)" marker).
// Concrete rule-sets are data, supplied at runtime (CLI --policy-config or the
// programmatic `enforce(input, config)` call).
//
// Usage:
//   import { enforce } from "@arcanada/publisher-core";
//   import { arcanadaPolicy } from "./arcanada-preset";
//   const post = enforce({ platform: "linkedin", bodyByLang, links }, arcanadaPolicy);

import type { PolicyConfig } from "@arcanada/publisher-core";

export const arcanadaPolicy: PolicyConfig = {
  // R2: RU for TG/FB/VK; EN for LinkedIn/X.
  languageByPlatform: {
    facebook: "ru",
    vkontakte: "ru",
    linkedin: "en",
    x: "en",
  },
  // R3: CTA links go to the first comment, not the body.
  linksInFirstComment: true,
  // R4: every post cross-links the canonical Telegram channel; EN platforms get
  // the "(in Russian)" marker so an English reader knows the link is RU content.
  crossLink: {
    url: "https://t.me/valentovtypes",
    templateByLang: {
      ru: "Telegram: {url}",
      en: "Telegram (in Russian): {url}",
    },
  },
  // R5: FB and LinkedIn show only the first line in-feed → separate it as a
  // headline with a blank line.
  headerSeparatorPlatforms: ["facebook", "linkedin"],
};
