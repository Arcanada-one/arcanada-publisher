import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

  it("Telegram Pattern A dry-run with an attachment exits 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "publisher-cli-telegram-"));
    const text = join(dir, "longread.txt");
    const image = join(dir, "hero.png");
    writeFileSync(text, `${"hero words ".repeat(100)}\n\n${"body words ".repeat(200)}`);
    writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const res = await run([
      "publish",
      "--platform",
      "telegram",
      "--chat-id",
      "-1003855619081",
      "--text-file",
      text,
      "--image",
      image,
      "--dry-run",
    ]);
    expect(res.code).toBe(0);
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

  it("edit without --target-url/--text-file exits with MISSING_INPUT", async () => {
    const res = await run(["edit", "--platform", "facebook"]);
    expect(res.code).toBe(2); // ErrorCode.MISSING_INPUT
  });

  it("server with a non-loopback bind fails closed (NETWORK_GUARD, never daemonises)", async () => {
    const res = await run(["server", "--bind", "0.0.0.0"]);
    expect(res.code).toBe(7); // ErrorCode.NETWORK_GUARD
    expect(res.message).toMatch(/server failed to start/);
  });

  // V-AC-9: the full dry-run publish matrix is GREEN for all five platforms once
  // the reddit/vk platform-specific flags are supplied (operator decision, Q&A 6).
  it("dry-run publish matrix → exit 0 for all five platforms (V-AC-9)", async () => {
    const img = join(HERE, "fixtures", "hero.png");
    const cases: Array<[string, string[]]> = [
      ["facebook", []],
      ["linkedin", []],
      ["x", []],
      ["reddit", ["--subreddit", "test", "--title", "Hello"]],
      ["vkontakte", ["--owner-id", "-1"]],
    ];
    for (const [platform, extra] of cases) {
      const res = await run([
        "publish",
        "--platform",
        platform,
        "--text-file",
        TEXT_279,
        "--image",
        img,
        "--dry-run",
        "--profile",
        "default",
        ...extra,
      ]);
      expect(res.code, `${platform} dry-run should exit 0`).toBe(0);
    }
  });
});
