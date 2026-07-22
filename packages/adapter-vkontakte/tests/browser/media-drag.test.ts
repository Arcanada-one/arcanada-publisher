import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { uploadMediaAfterComposerSettles } from "../../src/browser/media-upload.js";

describe("vk browser — composer media upload", () => {
  it("waits for VK callbacks before selecting the validated file once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vk-drag-"));
    const media = join(dir, "hero.jpg");
    writeFileSync(media, Buffer.from("jpeg"));
    const order: string[] = [];
    const page = {
      waitForTimeout: vi.fn(async () => {
        order.push("settled");
      }),
    } as never;
    const input = {
      setInputFiles: vi.fn(async () => {
        order.push("selected");
      }),
    } as never;

    await uploadMediaAfterComposerSettles(page, input, media);

    expect(order).toEqual(["settled", "selected"]);
    expect(page.waitForTimeout).toHaveBeenCalledWith(500);
    expect(input.setInputFiles).toHaveBeenCalledOnce();
    expect(input.setInputFiles).toHaveBeenCalledWith(realpathSync(media));
  });

  it("fails closed before selecting an unreadable file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vk-drag-"));
    const media = join(dir, "missing.jpg");
    const setInputFiles = vi.fn();
    await expect(
      uploadMediaAfterComposerSettles(
        { waitForTimeout: vi.fn() } as never,
        { setInputFiles } as never,
        media,
      ),
    ).rejects.toMatchObject({ details: { stage: "media_upload_preflight" } });
    expect(setInputFiles).not.toHaveBeenCalled();
  });
});
