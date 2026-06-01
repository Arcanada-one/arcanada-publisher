import { describe, it, expect } from "vitest";
import { enforce, PolicyConfigSchema } from "../src/policy/index.js";
import type { PolicyConfig, PolicyInput } from "../src/policy/index.js";

// Arcanada-shaped preset used ONLY in tests — the engine itself holds no such
// constants (D-1). The cross-link URL + "(in Russian)" marker live here, never
// in src/. See creative-PUB-0017-architecture-content-policy-engine.md (Option B).
const ARCANADA_PRESET: PolicyConfig = {
  languageByPlatform: { facebook: "ru", vkontakte: "ru", linkedin: "en", x: "en" },
  linksInFirstComment: true,
  crossLink: {
    url: "https://t.me/example/123",
    skipPlatform: undefined,
    templateByLang: {
      en: "Telegram (in Russian): {url}",
      ru: "Telegram: {url}",
    },
  },
  headerSeparatorPlatforms: ["facebook", "linkedin"],
};

const bodyByLang = {
  ru: "Заголовок\nТело поста на русском https://cta.example.com/buy",
  en: "Headline\nEnglish post body https://cta.example.com/buy",
};

function input(platform: PolicyInput["platform"]): PolicyInput {
  return {
    platform,
    bodyByLang,
    links: ["https://cta.example.com/buy"],
  };
}

describe("policy — generic content-policy engine (R2–R5)", () => {
  it("policy R2 language: selects body variant by platform language map", () => {
    const fb = enforce(input("facebook"), ARCANADA_PRESET);
    expect(fb.body).toContain("Тело поста на русском");
    const li = enforce(input("linkedin"), ARCANADA_PRESET);
    expect(li.body).toContain("English post body");
  });

  it("policy R3 links: CTA links removed from body, present in firstComment", () => {
    const li = enforce(input("linkedin"), ARCANADA_PRESET);
    expect(li.body).not.toContain("https://cta.example.com/buy");
    expect(li.firstComment).toContain("https://cta.example.com/buy");
  });

  it("policy R4 cross-link: appends TG cross-link with per-lang template", () => {
    const li = enforce(input("linkedin"), ARCANADA_PRESET); // en → "(in Russian)" marker
    expect(li.firstComment).toContain("Telegram (in Russian): https://t.me/example/123");
    const fb = enforce(input("facebook"), ARCANADA_PRESET); // ru → no marker
    expect(fb.firstComment).toContain("Telegram: https://t.me/example/123");
    expect(fb.firstComment).not.toContain("(in Russian)");
  });

  it("policy R4 cross-link: skipPlatform receives no cross-link", () => {
    const cfg: PolicyConfig = {
      ...ARCANADA_PRESET,
      crossLink: { ...ARCANADA_PRESET.crossLink!, skipPlatform: "facebook" },
    };
    const fb = enforce(input("facebook"), cfg);
    expect(fb.firstComment ?? "").not.toContain("t.me/example");
  });

  it("policy R5 separator: FB/LinkedIn body starts '<headline>\\n\\n<rest>'", () => {
    const fb = enforce(input("facebook"), ARCANADA_PRESET);
    expect(fb.body.startsWith("Заголовок\n\n")).toBe(true);
    const li = enforce(input("linkedin"), ARCANADA_PRESET);
    expect(li.body.startsWith("Headline\n\n")).toBe(true);
  });

  it("policy R5 separator: platforms outside the list keep single-newline headline", () => {
    // x is not in headerSeparatorPlatforms → no blank line injected.
    const x = enforce(input("x"), ARCANADA_PRESET);
    expect(x.body.startsWith("Headline\n\n")).toBe(false);
  });

  it("policy empty-config no-op: empty config returns body unchanged, links in body, no firstComment", () => {
    // Neutrality proof: no hard-wired Arcanada fallback. With {} the engine is identity.
    const singleLang: PolicyInput = {
      platform: "facebook",
      bodyByLang: { en: "Only body https://cta.example.com/buy" },
      links: ["https://cta.example.com/buy"],
    };
    const out = enforce(singleLang, {});
    expect(out.body).toBe("Only body https://cta.example.com/buy");
    expect(out.firstComment).toBeNull();
  });

  it("policy purity: enforce does not mutate its input", () => {
    const inp = input("facebook");
    const before = JSON.stringify(inp);
    enforce(inp, ARCANADA_PRESET);
    expect(JSON.stringify(inp)).toBe(before);
  });
});

describe("policy — PolicyConfigSchema validation", () => {
  it("policy schema: rejects unknown keys (.strict fail-closed)", () => {
    const r = PolicyConfigSchema.safeParse({ unknownAxis: true });
    expect(r.success).toBe(false);
  });

  it("policy schema: accepts empty config (all fields optional)", () => {
    const r = PolicyConfigSchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it("policy schema: accepts a full Arcanada-shaped config", () => {
    const r = PolicyConfigSchema.safeParse(ARCANADA_PRESET);
    expect(r.success).toBe(true);
  });
});
