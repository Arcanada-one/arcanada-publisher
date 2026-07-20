import { describe, expect, it, vi } from "vitest";
import {
  focusPublisherBrowserNative,
  pasteMediaClipboardNative,
  prepareMediaClipboard,
} from "../src/media-clipboard.js";

function deps(source: string, returned: string, bytes = Buffer.from("video")) {
  return {
    platform: "darwin" as const,
    exec: vi.fn(() => returned) as never,
    realpath: vi.fn((path: string) => path) as never,
    stat: vi.fn(() => ({ size: bytes.length })) as never,
    read: vi.fn(() => bytes) as never,
  };
}

describe("LinkedIn macOS media clipboard preflight", () => {
  it("verifies the exact file path round-trip", () => {
    const path = "/tmp/Мои посты/video clip.mp4";
    const d = deps(path, `${path}\n`);
    expect(prepareMediaClipboard(path, d)).toMatchObject({ verified: true, size: 5 });
    expect(d.exec).toHaveBeenCalledWith(
      "osascript",
      expect.arrayContaining(["--", path]),
      expect.anything(),
    );
  });

  it("accepts a symlink only when the clipboard resolves to the same canonical file", () => {
    const link = "/tmp/video-link.mp4";
    const canonical = "/private/tmp/video.mp4";
    const d = deps(link, canonical);
    d.realpath.mockImplementation((path: string) => (path === link ? canonical : path));
    expect(prepareMediaClipboard(link, d)).toMatchObject({ verified: true });
  });

  it("fails closed on a stale clipboard path", () => {
    expect(() =>
      prepareMediaClipboard("/tmp/new.mp4", deps("/tmp/new.mp4", "/tmp/old.mp4")),
    ).toThrow(/verification mismatch/);
  });

  it("fails closed when the clipboard does not contain a file", () => {
    const d = deps("/tmp/new.mp4", "plain text");
    d.realpath.mockImplementation((path: string) => {
      if (path === "plain text") throw new Error("not a file");
      return path;
    });
    expect(() => prepareMediaClipboard("/tmp/new.mp4", d)).toThrow(/non-file/);
  });

  it("preserves the manual-preload contract outside macOS", () => {
    const d = deps("/tmp/x.mp4", "/tmp/x.mp4");
    d.platform = "linux" as never;
    expect(prepareMediaClipboard("/tmp/x.mp4", d)).toBeNull();
    expect(d.exec).not.toHaveBeenCalled();
  });
});

describe("LinkedIn macOS native paste", () => {
  it("focuses the Publisher browser in a separate OS step", () => {
    const exec = vi.fn(() => "ok") as never;
    expect(focusPublisherBrowserNative({ platform: "darwin", exec })).toBe(true);
    const script = String((exec.mock.calls[0] as unknown[])[1]);
    expect(script).toContain("Google Chrome for Testing");
    expect(script).toContain("set frontmost");
    expect(script).not.toContain('keystroke "v"');
  });

  it("targets the Publisher browser and sends a real Command-V", () => {
    const exec = vi.fn(() => "ok") as never;
    expect(pasteMediaClipboardNative({ platform: "darwin", exec })).toBe(true);
    expect(exec).toHaveBeenCalledWith(
      "osascript",
      expect.arrayContaining([
        "-e",
        expect.stringContaining('keystroke "v" using command down'),
      ]),
      expect.anything(),
    );
    const script = String((exec.mock.calls[0] as unknown[])[1]);
    expect(script).not.toContain("set frontmost");
  });

  it("falls back to Playwright outside macOS", () => {
    const exec = vi.fn() as never;
    expect(pasteMediaClipboardNative({ platform: "linux", exec })).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
});
