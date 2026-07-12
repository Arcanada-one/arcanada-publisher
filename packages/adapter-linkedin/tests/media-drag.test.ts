import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { dispatchVideoDragDrop } from "../src/media-drag.js";

describe("LinkedIn CDP video drag fallback", () => {
  it("dispatches enter, over, drop at exact editor center", async () => {
    const send = vi.fn(async () => ({}));
    const detach = vi.fn(async () => {});
    const page = {
      context: () => ({ newCDPSession: async () => ({ send, detach }) }),
    };
    const editor = { boundingBox: async () => ({ x: 10, y: 20, width: 200, height: 100 }) };
    const path = "/tmp/Мои посты/video clip.mp4";
    await dispatchVideoDragDrop(page as never, editor as never, path, {
      validate: vi.fn(() => ({
        verified: true,
        size: 5,
        sha256: createHash("sha256").update("video").digest("hex"),
        canonicalPath: path,
      })) as never,
      read: vi.fn(() => Buffer.from("video")) as never,
      stat: vi.fn(() => ({ size: 5 })) as never,
    });
    expect(send.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({
        type: "dragEnter",
        x: 110,
        y: 70,
        data: { items: [], files: [path], dragOperationsMask: 1 },
      }),
      expect.objectContaining({
        type: "dragOver",
        x: 110,
        y: 70,
        data: { items: [], files: [path], dragOperationsMask: 1 },
      }),
      expect.objectContaining({
        type: "drop",
        x: 110,
        y: 70,
        data: { items: [], files: [path], dragOperationsMask: 1 },
      }),
    ]);
    expect(detach).toHaveBeenCalledOnce();
  });
});
