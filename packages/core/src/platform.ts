export const PLATFORMS = ["facebook", "linkedin", "x", "reddit", "vkontakte"] as const;

export type Platform = (typeof PLATFORMS)[number];

export function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && (PLATFORMS as readonly string[]).includes(value);
}
