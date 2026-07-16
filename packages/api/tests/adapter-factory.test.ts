import { describe, it, expect, afterEach } from "vitest";
import { VKontakteAdapter, VKontakteBrowserAdapter } from "@arcanada/publisher-vkontakte";
import { makeAdapter } from "../src/adapter-factory.js";

const ORIGINAL = process.env["ARCANADA_VK_BROWSER"];

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env["ARCANADA_VK_BROWSER"];
  else process.env["ARCANADA_VK_BROWSER"] = ORIGINAL;
});

describe("api adapter factory — vkontakte browser vs API env switch (PUB-0034)", () => {
  it("returns the browser adapter when ARCANADA_VK_BROWSER=1", () => {
    process.env["ARCANADA_VK_BROWSER"] = "1";
    const adapter = makeAdapter("vkontakte", true);
    expect(adapter).toBeInstanceOf(VKontakteBrowserAdapter);
  });

  it("returns the token API adapter when the env flag is unset (dry-run token path)", () => {
    delete process.env["ARCANADA_VK_BROWSER"];
    const adapter = makeAdapter("vkontakte", true);
    expect(adapter).toBeInstanceOf(VKontakteAdapter);
    expect(adapter).not.toBeInstanceOf(VKontakteBrowserAdapter);
  });

  it("treats any value other than exactly '1' as the API path", () => {
    process.env["ARCANADA_VK_BROWSER"] = "true";
    const adapter = makeAdapter("vkontakte", true);
    expect(adapter).toBeInstanceOf(VKontakteAdapter);
  });
});
