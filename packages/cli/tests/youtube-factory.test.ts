// PUB-0035: the CLI factory's youtube case constructs the REAL adapter class
// (unmocked — youtube-registration.test.ts mocks the module, so this lives in
// its own file to keep vi.mock scoping honest).

import { describe, expect, it } from "vitest";
import { YouTubeAdapter } from "@arcanada/publisher-youtube";
import { makeAdapter } from "../src/adapters.js";
import { parseArgs } from "../src/parse-args.js";

describe("CLI adapter factory — youtube", () => {
  it("makeAdapter('youtube') returns a YouTubeAdapter instance", () => {
    const args = parseArgs(["publish", "--platform", "youtube", "--text-file", "t.md"]);
    expect(makeAdapter("youtube", args)).toBeInstanceOf(YouTubeAdapter);
  });
});
