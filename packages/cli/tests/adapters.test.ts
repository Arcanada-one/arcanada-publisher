import { describe, expect, it } from "vitest";
import { makeAdapter } from "../src/adapters.js";
import { parseArgs } from "../src/parse-args.js";

describe("browser adapter factory", () => {
  it.each(["facebook", "linkedin", "x"] as const)(
    "passes --headed through to %s publish and comment options",
    (platform) => {
      const args = parseArgs([
        "publish",
        "--platform",
        platform,
        "--text-file",
        "post.txt",
        "--headed",
      ]);
      const adapter = makeAdapter(platform, args) as unknown as {
        opts: {
          publishOptions?: { headed?: boolean };
          commentOptions?: { headed?: boolean };
        };
      };

      expect(adapter.opts.publishOptions?.headed).toBe(true);
      expect(adapter.opts.commentOptions?.headed).toBe(true);
    },
  );
});
