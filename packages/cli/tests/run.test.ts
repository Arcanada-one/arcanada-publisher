import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/run.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const TEXT_279 = join(HERE, "fixtures", "text-279utf16.txt");
const TEXT_281 = join(HERE, "fixtures", "text-281utf16.txt");

describe("cli run — X dry-run publish (V-AC-11)", () => {
  it("publish --platform x --text-file <279utf16> --dry-run → exit 0", async () => {
    const img = join(HERE, "fixtures", "hero.png");
    // image-mandatory: provide an image path that exists (the fixture below).
    const res = await run([
      "publish",
      "--platform",
      "x",
      "--text-file",
      TEXT_279,
      "--image",
      img,
      "--dry-run",
    ]);
    expect(res.code).toBe(0);
  });

  it("publish --platform x --text-file <281utf16> --dry-run → non-zero (INVALID_ARGS)", async () => {
    const img = join(HERE, "fixtures", "hero.png");
    const res = await run([
      "publish",
      "--platform",
      "x",
      "--text-file",
      TEXT_281,
      "--image",
      img,
      "--dry-run",
    ]);
    expect(res.code).not.toBe(0);
    expect(res.code).toBe(1); // ErrorCode.INVALID_ARGS
  });

  it("an unknown platform exits with INVALID_ARGS", async () => {
    const res = await run([
      "publish",
      "--platform",
      "myspace",
      "--text-file",
      TEXT_279,
      "--dry-run",
    ]);
    expect(res.code).toBe(1);
  });

  it("publish without --text-file exits with MISSING_INPUT", async () => {
    const res = await run(["publish", "--platform", "x", "--dry-run"]);
    expect(res.code).toBe(2); // ErrorCode.MISSING_INPUT
  });

  it("an unknown command exits with INVALID_ARGS and a helpful message", async () => {
    const res = await run(["frobnicate"]);
    expect(res.code).toBe(1);
    expect(res.message).toMatch(/unknown or missing command/);
  });
});
