import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dispatchMediaDragDrop } from "../../src/browser/media-drag.js";

describe("vk browser — scoped media drag", () => {
  it("dispatches enter, over, and drop to the exact bounded composer target", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vk-drag-"));
    const media = join(dir, "hero.jpg");
    writeFileSync(media, Buffer.from("jpeg"));
    const send = vi.fn(async () => undefined);
    const detach = vi.fn(async () => undefined);
    const page = {
      context: () => ({ newCDPSession: async () => ({ send, detach }) }),
    } as never;
    const target = {
      boundingBox: async () => ({ x: 10, y: 20, width: 100, height: 50 }),
    } as never;

    await dispatchMediaDragDrop(page, target, media);

    expect(send.mock.calls.map((call) => call[1]?.type)).toEqual(["dragEnter", "dragOver", "drop"]);
    expect(detach).toHaveBeenCalledOnce();
  });

  it("fails closed before dispatch when the target is not bounded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vk-drag-"));
    const media = join(dir, "hero.jpg");
    writeFileSync(media, Buffer.from("jpeg"));
    await expect(
      dispatchMediaDragDrop(
        { context: vi.fn() } as never,
        { boundingBox: async () => null } as never,
        media,
      ),
    ).rejects.toMatchObject({ details: { stage: "media_drag_target" } });
  });
});
