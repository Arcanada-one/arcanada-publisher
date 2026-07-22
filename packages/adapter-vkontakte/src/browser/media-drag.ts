import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";
import { type Locator, type Page } from "playwright";

/** Dispatch a validated native-file drop onto VK's exact composer drop zone. */
export async function dispatchMediaDragDrop(
  page: Page,
  target: Locator,
  mediaPath: string,
): Promise<void> {
  let canonical: string;
  let size: number;
  let sha256: string;
  try {
    canonical = realpathSync(mediaPath);
    const bytes = readFileSync(canonical);
    size = statSync(canonical).size;
    sha256 = createHash("sha256").update(bytes).digest("hex");
  } catch {
    throw dragError("vk media drag preflight failed", "media_drag_preflight");
  }

  const box = await target.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) {
    throw dragError("vk composer has no bounded media drop zone", "media_drag_target");
  }

  try {
    const bytes = readFileSync(canonical);
    if (
      statSync(canonical).size !== size ||
      createHash("sha256").update(bytes).digest("hex") !== sha256
    ) {
      throw new Error("changed");
    }
  } catch {
    throw dragError("vk media changed after validation", "media_drag_preflight");
  }

  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  let session: Awaited<ReturnType<ReturnType<Page["context"]>["newCDPSession"]>> | undefined;
  try {
    session = await page.context().newCDPSession(page);
    const data = { items: [], files: [canonical], dragOperationsMask: 1 };
    for (const type of ["dragEnter", "dragOver", "drop"] as const) {
      await session.send("Input.dispatchDragEvent", { type, x, y, data });
    }
  } catch {
    throw dragError("vk media drag dispatch failed", "media_drag_dispatch");
  } finally {
    await session?.detach().catch(() => {});
  }
}

function dragError(message: string, stage: string): AdapterError {
  return new AdapterError(ErrorCode.VERIFY_FAILED, message, { stage });
}
