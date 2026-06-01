import { describe, it, expect } from "vitest";
import { parseArgs, CliParseError } from "../src/parse-args.js";

describe("cli parse-args (V-AC-11 flag contract)", () => {
  it("parses publish --platform x --text-file f --dry-run", () => {
    const a = parseArgs(["publish", "--platform", "x", "--text-file", "f.txt", "--dry-run"]);
    expect(a.command).toBe("publish");
    expect(a.platform).toBe("x");
    expect(a.textFile).toBe("f.txt");
    expect(a.dryRun).toBe(true);
  });

  it("--image is repeatable and accumulates into images[]", () => {
    const a = parseArgs([
      "publish",
      "--platform",
      "facebook",
      "--text-file",
      "f",
      "--image",
      "a.png",
      "--image",
      "b.png",
    ]);
    expect(a.images).toEqual(["a.png", "b.png"]);
  });

  it("parses --policy-config and --profile", () => {
    const a = parseArgs([
      "publish",
      "--platform",
      "x",
      "--text-file",
      "f",
      "--policy-config",
      "preset.json",
      "--profile",
      "pavel-personal",
    ]);
    expect(a.policyConfig).toBe("preset.json");
    expect(a.profile).toBe("pavel-personal");
  });

  it("rejects an unknown command", () => {
    expect(() => parseArgs(["frobnicate", "--platform", "x"])).toThrow(CliParseError);
  });

  it("rejects an unknown flag (typo is loud, not dropped)", () => {
    expect(() => parseArgs(["publish", "--platfrom", "x"])).toThrow(CliParseError);
  });

  it("rejects a value flag with no value", () => {
    expect(() => parseArgs(["publish", "--platform"])).toThrow(CliParseError);
  });

  it("parses the net-new edit command with --target-url + --text-file", () => {
    const a = parseArgs([
      "edit",
      "--platform",
      "facebook",
      "--target-url",
      "https://www.facebook.com/100/posts/1",
      "--text-file",
      "fixed.txt",
    ]);
    expect(a.command).toBe("edit");
    expect(a.targetUrl).toBe("https://www.facebook.com/100/posts/1");
    expect(a.textFile).toBe("fixed.txt");
  });

  it("parses the net-new server command with --bind + --port", () => {
    const a = parseArgs(["server", "--bind", "127.0.0.1", "--port", "8787"]);
    expect(a.command).toBe("server");
    expect(a.bind).toBe("127.0.0.1");
    expect(a.port).toBe(8787);
  });

  it("server command defaults bind/port to undefined when omitted", () => {
    const a = parseArgs(["server"]);
    expect(a.command).toBe("server");
    expect(a.bind).toBeUndefined();
    expect(a.port).toBeUndefined();
  });

  it("rejects a non-numeric --port", () => {
    expect(() => parseArgs(["server", "--port", "notanumber"])).toThrow(CliParseError);
  });

  it("parses reddit-specific --subreddit + --title", () => {
    const a = parseArgs([
      "publish",
      "--platform",
      "reddit",
      "--text-file",
      "f",
      "--subreddit",
      "test",
      "--title",
      "Hello",
    ]);
    expect(a.subreddit).toBe("test");
    expect(a.title).toBe("Hello");
  });

  it("parses vk-specific --owner-id (negative ids allowed for communities)", () => {
    const a = parseArgs([
      "publish",
      "--platform",
      "vkontakte",
      "--text-file",
      "f",
      "--owner-id",
      "-1",
    ]);
    expect(a.ownerId).toBe(-1);
  });

  it("rejects a non-numeric --owner-id", () => {
    expect(() =>
      parseArgs(["publish", "--platform", "vkontakte", "--text-file", "f", "--owner-id", "abc"]),
    ).toThrow(CliParseError);
  });
});
