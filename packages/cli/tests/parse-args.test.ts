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

  it("PUB-0033: --premium defaults to false and flips to true when present", () => {
    const off = parseArgs(["publish", "--platform", "x", "--text-file", "f"]);
    expect(off.premium).toBe(false);
    const on = parseArgs(["publish", "--platform", "x", "--text-file", "f", "--premium"]);
    expect(on.premium).toBe(true);
  });

  it("PUB-0033: --headed defaults to false and flips to true when present", () => {
    const off = parseArgs(["publish", "--platform", "x", "--text-file", "f"]);
    expect(off.headed).toBe(false);
    const on = parseArgs(["publish", "--platform", "x", "--text-file", "f", "--headed"]);
    expect(on.headed).toBe(true);
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

  it("parses safe Facebook replace-comment binding flags", () => {
    const a = parseArgs([
      "replace-comment",
      "--platform",
      "facebook",
      "--parent-url",
      "https://www.facebook.com/100/posts/1",
      "--comment-id",
      "1326931196274132",
      "--expected-author-profile-url",
      "https://www.facebook.com/pavelvalentov",
      "--expected-content-file",
      "old.txt",
      "--text-file",
      "new.txt",
    ]);
    expect(a.command).toBe("replace-comment");
    expect(a.commentId).toBe("1326931196274132");
    expect(a.expectedAuthorProfileUrl).toBe("https://www.facebook.com/pavelvalentov");
    expect(a.expectedContentFile).toBe("old.txt");
  });

  it("parses Telegram read-before-edit media and parent oracles", () => {
    const a = parseArgs([
      "edit",
      "--platform",
      "telegram",
      "--target-url",
      "https://t.me/valentovtypes/208",
      "--text-file",
      "caption.txt",
      "--image",
      "video.mp4",
      "--expected-content",
      "#PUB_0029_unique",
      "--expected-media-kind",
      "image",
      "--parent-url",
      "https://t.me/valentovtypes/207",
    ]);
    expect(a.expectedContent).toBe("#PUB_0029_unique");
    expect(a.expectedMediaKind).toBe("image");
    expect(a.parentUrl).toBe("https://t.me/valentovtypes/207");
  });

  it("rejects an invalid --expected-media-kind", () => {
    expect(() =>
      parseArgs(["edit", "--platform", "telegram", "--expected-media-kind", "audio"]),
    ).toThrow(CliParseError);
  });

  it("parses Telegram inspect and explicit video metadata", () => {
    const inspect = parseArgs([
      "inspect",
      "--platform",
      "telegram",
      "--target-url",
      "https://t.me/valentovtypes/208",
    ]);
    expect(inspect.command).toBe("inspect");
    const edit = parseArgs([
      "edit",
      "--platform",
      "telegram",
      "--expected-content-file",
      "caption.txt",
      "--video-width",
      "1280",
      "--video-height",
      "720",
      "--video-duration",
      "245",
    ]);
    expect(edit.expectedContentFile).toBe("caption.txt");
    expect([edit.videoWidth, edit.videoHeight, edit.videoDuration]).toEqual([1280, 720, 245]);
  });

  it.each(["1280px", "1.5", "12junk"])("rejects malformed video metadata %s", (value) => {
    expect(() => parseArgs(["edit", "--video-width", value])).toThrow(CliParseError);
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

  it("video: --no-waveform defaults false and flips true when present", () => {
    const off = parseArgs(["video", "--cover", "c.jpg", "--out", "o.mp4"]);
    expect(off.noWaveform).toBe(false);
    const on = parseArgs(["video", "--cover", "c.jpg", "--out", "o.mp4", "--no-waveform"]);
    expect(on.noWaveform).toBe(true);
  });

  it("video: --waveform-height parses a positive integer", () => {
    const a = parseArgs([
      "video",
      "--cover",
      "c.jpg",
      "--out",
      "o.mp4",
      "--waveform-height",
      "100",
    ]);
    expect(a.waveformHeight).toBe(100);
  });

  it("video: --waveform-height rejects zero / non-numeric", () => {
    expect(() =>
      parseArgs(["video", "--cover", "c.jpg", "--out", "o.mp4", "--waveform-height", "0"]),
    ).toThrow(CliParseError);
    expect(() =>
      parseArgs(["video", "--cover", "c.jpg", "--out", "o.mp4", "--waveform-height", "tall"]),
    ).toThrow(CliParseError);
  });

  it("video: --waveform-colors accepts a LEFT,RIGHT hex pair", () => {
    const a = parseArgs([
      "video",
      "--cover",
      "c.jpg",
      "--out",
      "o.mp4",
      "--waveform-colors",
      "0xFFD24C,0xE03B5A",
    ]);
    expect(a.waveformColors).toBe("0xFFD24C,0xE03B5A");
  });

  it("video: --waveform-colors rejects non-hex / single colour", () => {
    expect(() =>
      parseArgs(["video", "--cover", "c.jpg", "--out", "o.mp4", "--waveform-colors", "red,blue"]),
    ).toThrow(CliParseError);
    expect(() =>
      parseArgs(["video", "--cover", "c.jpg", "--out", "o.mp4", "--waveform-colors", "0xFFD24C"]),
    ).toThrow(CliParseError);
  });
});
