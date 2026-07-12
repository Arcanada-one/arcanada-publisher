import { describe, expect, it, vi } from "vitest";
import { prepareMediaClipboard } from "../src/media-clipboard.js";

function deps(source: string, returned: string, bytes = Buffer.from("video")) {
  const payload = returned.trim().startsWith("{")
    ? returned
    : JSON.stringify({
        path: returned.trim(),
        types: ["public.file-url", "NSURLPboardType", "NSFilenamesPboardType"],
        wrote: true,
      });
  return {
    platform: "darwin" as const,
    exec: vi.fn(() => payload) as never,
    realpath: vi.fn((path: string) => path) as never,
    stat: vi.fn(() => ({ size: bytes.length })) as never,
    read: vi.fn(() => bytes) as never,
  };
}

describe("LinkedIn macOS media clipboard preflight", () => {
  it("verifies exact file paths containing spaces and Cyrillic", () => {
    const path = "/tmp/Мои посты/video clip.mp4";
    const d = deps(path, `${path}\n`);
    expect(prepareMediaClipboard(path, d)).toMatchObject({ verified: true, size: 5 });
    expect(d.exec).toHaveBeenCalledWith(
      "osascript",
      expect.arrayContaining(["--", path]),
      expect.anything(),
    );
  });

  it("sets Finder-compatible modern and legacy pasteboard types", () => {
    const path = "/tmp/video.mp4";
    const d = deps(path, path);
    prepareMediaClipboard(path, d);
    const args = d.exec.mock.calls[0]?.[1] as string[];
    const script = args.join(" ");
    expect(script).toContain("public.file-url");
    expect(script).toContain("NSURLPboardType");
    expect(script).toContain("NSFilenamesPboardType");
    expect(script).toContain("NSArray.arrayWithObject");
  });

  it("accepts a symlink input only when clipboard resolves to the same canonical file", () => {
    const link = "/tmp/video-link.mp4";
    const canonical = "/private/tmp/video.mp4";
    const d = deps(link, canonical);
    d.realpath.mockImplementation((path: string) => (path === link ? canonical : path));
    expect(prepareMediaClipboard(link, d)).toMatchObject({ verified: true });
  });

  it("fails closed on stale clipboard path", () => {
    expect(() =>
      prepareMediaClipboard("/tmp/new.mp4", deps("/tmp/new.mp4", "/tmp/old.mp4")),
    ).toThrow(/verification mismatch/);
  });

  it("fails closed on non-file clipboard", () => {
    const d = deps("/tmp/new.mp4", "plain text");
    d.realpath.mockImplementation((path: string) => {
      if (path === "plain text") throw new Error("not a file");
      return path;
    });
    expect(() => prepareMediaClipboard("/tmp/new.mp4", d)).toThrow(/non-file/);
  });

  it("does not expose paths, content, or command output in errors", () => {
    const secret = "/Users/private/token-secret.mp4";
    const d = deps(secret, secret);
    d.read.mockReturnValueOnce(Buffer.from("a")).mockReturnValueOnce(Buffer.from("b"));
    expect(() => prepareMediaClipboard(secret, d)).toThrowError(
      expect.not.objectContaining({ message: expect.stringContaining(secret) }),
    );
  });

  it("preserves the manual-preload contract outside macOS", () => {
    const d = deps("/tmp/x.mp4", "/tmp/x.mp4");
    d.platform = "linux" as never;
    expect(prepareMediaClipboard("/tmp/x.mp4", d)).toBeNull();
    expect(d.exec).not.toHaveBeenCalled();
  });

  it.each(["realpath", "read", "stat"] as const)(
    "sanitizes native %s failures containing a private path",
    (operation) => {
      const secret = "/Users/private/token-secret.mp4";
      const d = deps(secret, secret);
      if (operation === "realpath")
        d.realpath.mockImplementation(() => {
          throw new Error(secret);
        });
      if (operation === "read")
        d.read.mockImplementation(() => {
          throw new Error(secret);
        });
      if (operation === "stat")
        d.stat.mockImplementation(() => {
          throw new Error(secret);
        });
      try {
        prepareMediaClipboard(secret, d);
        throw new Error("expected failure");
      } catch (error) {
        expect(String(error)).not.toContain(secret);
        expect(error).toMatchObject({ code: 6, details: { stage: "media_clipboard_preflight" } });
      }
    },
  );
});
