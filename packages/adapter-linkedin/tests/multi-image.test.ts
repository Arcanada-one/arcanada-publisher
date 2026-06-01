import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ErrorCode, ProfileManager } from "@arcanada/publisher-core";
import { publish } from "../src/publish.js";
import { collectImagePaths } from "../src/publish.js";

function makeProfiles(): ProfileManager {
  const root = mkdtempSync(join(tmpdir(), "pub-0017-li-mi-"));
  mkdirSync(join(root, "linkedin", "p1"), { recursive: true });
  return new ProfileManager({ root });
}

function makeImage(ext = ".png"): string {
  const dir = mkdtempSync(join(tmpdir(), "pub-0017-li-img-"));
  const file = join(dir, `hero${ext}`);
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return file;
}

const FAKE_PROFILE = "p1";

describe("linkedin R1 — multi-image collection + per-element validation", () => {
  it("collectImagePaths: imagePaths takes precedence over the deprecated imagePath alias", () => {
    expect(
      collectImagePaths({ text: "x", imagePaths: ["/a.png", "/b.png"], profile: "p1" }),
    ).toEqual(["/a.png", "/b.png"]);
    expect(collectImagePaths({ text: "x", imagePath: "/only.png", profile: "p1" })).toEqual([
      "/only.png",
    ]);
    expect(collectImagePaths({ text: "x", profile: "p1" })).toEqual([]);
  });

  it("R1: validates EVERY element of imagePaths — a bad extension anywhere → INVALID_ARGS", async () => {
    const good = makeImage(".png");
    const dir = mkdtempSync(join(tmpdir(), "pub-0017-li-bad-"));
    const bad = join(dir, "doc.bmp");
    writeFileSync(bad, Buffer.from([0x42, 0x4d]));
    await expect(
      publish(
        { text: "ok", imagePaths: [good, bad], profile: FAKE_PROFILE },
        { profileManager: makeProfiles() },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGS });
  });

  it("R1: a NUL byte in any imagePaths element → INVALID_ARGS", async () => {
    await expect(
      publish(
        { text: "ok", imagePaths: ["/tmp/evil\0.png"], profile: FAKE_PROFILE },
        { profileManager: makeProfiles() },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGS });
  });

  it("R1: a non-existent imagePaths element → MISSING_INPUT", async () => {
    await expect(
      publish(
        { text: "ok", imagePaths: ["/tmp/does-not-exist-pub-0017.png"], profile: FAKE_PROFILE },
        { profileManager: makeProfiles() },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.MISSING_INPUT });
  });

  it("dry-run with multiple images reports every image as an attachment", async () => {
    const a = makeImage(".png");
    const b = makeImage(".jpg");
    // dry-run still needs a logged-in startPost button; inject a fake page that
    // exposes the dry-run short-circuit path. We assert collectImagePaths feeds
    // the attachment list — validated paths are echoed.
    const res = await publish(
      { text: "ok", imagePaths: [a, b], profile: FAKE_PROFILE, dryRun: true },
      { profileManager: makeProfiles(), page: fakeStartablePage() },
    );
    expect(res.attachments.map((x) => x.src)).toEqual([a, b]);
  });
});

/** Minimal fake page sufficient for the dry-run short-circuit (startPost visible). */
function fakeStartablePage(): never {
  const visibleLocator = {
    first: () => visibleLocator,
    waitFor: async () => {},
  };
  return {
    goto: async () => {},
    getByRole: () => visibleLocator,
    isClosed: () => false,
  } as unknown as never;
}
