import { describe, it, expect } from "vitest";
import { VKontakteAdapter, VKontakteBrowserAdapter } from "@arcanada/publisher-vkontakte";
import { makeAdapter } from "../src/adapters.js";
import { parseArgs } from "../src/parse-args.js";

function argsFor(argv: string[]) {
  return parseArgs(argv);
}

describe("cli adapter factory — vkontakte browser vs API selection (PUB-0034)", () => {
  it("returns the browser adapter when --browser is set", () => {
    const args = argsFor(["publish", "--platform", "vkontakte", "--browser", "--dry-run"]);
    expect(args.browser).toBe(true);
    const adapter = makeAdapter("vkontakte", args);
    expect(adapter).toBeInstanceOf(VKontakteBrowserAdapter);
  });

  it("returns the token API adapter when --browser is absent (unchanged path)", () => {
    const args = argsFor(["publish", "--platform", "vkontakte", "--dry-run"]);
    expect(args.browser).toBe(false);
    const adapter = makeAdapter("vkontakte", args);
    expect(adapter).toBeInstanceOf(VKontakteAdapter);
    expect(adapter).not.toBeInstanceOf(VKontakteBrowserAdapter);
  });

  it("browser adapter reports the vkontakte platform", () => {
    const args = argsFor(["publish", "--platform", "vkontakte", "--browser", "--dry-run"]);
    expect(makeAdapter("vkontakte", args).platform).toBe("vkontakte");
  });
});
