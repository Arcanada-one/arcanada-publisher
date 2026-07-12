import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";
import { type Locator, type Page } from "playwright";
import { validateMediaFile } from "./media-clipboard.js";

export async function dispatchVideoDragDrop(
  page: Page,
  editor: Locator,
  mediaPath: string,
  deps: {
    validate?: typeof validateMediaFile;
    read?: typeof readFileSync;
    stat?: typeof statSync;
  } = {},
): Promise<void> {
  const proof = (deps.validate ?? validateMediaFile)(mediaPath);
  const canonical = proof.canonicalPath;
  try {
    const bytes = (deps.read ?? readFileSync)(canonical) as Buffer;
    const size = (deps.stat ?? statSync)(canonical).size;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (size !== proof.size || sha256 !== proof.sha256) throw new Error("changed");
  } catch {
    throw new AdapterError(ErrorCode.VERIFY_FAILED, "validated drag media changed", {
      stage: "media_drag_preflight",
    });
  }
  const box = await editor.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) {
    throw new AdapterError(ErrorCode.VERIFY_FAILED, "exact editor has no bounded drag target", {
      stage: "media_drag_target",
    });
  }
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  let session: Awaited<ReturnType<ReturnType<Page["context"]>["newCDPSession"]>> | undefined;
  try {
    session = await page.context().newCDPSession(page);
    const dragData = { items: [], files: [canonical], dragOperationsMask: 1 };
    for (const type of ["dragEnter", "dragOver", "drop"] as const) {
      await session.send("Input.dispatchDragEvent", { type, x, y, data: dragData });
    }
  } catch {
    throw new AdapterError(ErrorCode.VERIFY_FAILED, "scoped media drag dispatch failed", {
      stage: "media_drag_dispatch",
    });
  } finally {
    await session?.detach().catch(() => {});
  }
}
