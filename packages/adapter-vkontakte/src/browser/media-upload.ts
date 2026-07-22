import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";
import { type Locator, type Page } from "playwright";

const COMPOSER_CALLBACK_SETTLE_MS = 500;

/** Select media only after VK has registered the composer's upload callbacks. */
export async function uploadMediaAfterComposerSettles(
  page: Page,
  input: Locator,
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
    throw uploadError("vk media upload preflight failed", "media_upload_preflight");
  }

  // VK renders the modal before its uploadManager callbacks are registered.
  // Selecting a file during that window emits trusted input/change events but
  // silently loses the attachment. A single settle wait avoids unsafe retries.
  await page.waitForTimeout(COMPOSER_CALLBACK_SETTLE_MS);

  try {
    const bytes = readFileSync(canonical);
    if (
      statSync(canonical).size !== size ||
      createHash("sha256").update(bytes).digest("hex") !== sha256
    ) {
      throw new Error("changed");
    }
  } catch {
    throw uploadError("vk media changed after validation", "media_upload_preflight");
  }

  try {
    await input.setInputFiles(canonical);
  } catch {
    throw uploadError("vk media file selection failed", "media_upload_select");
  }
}

function uploadError(message: string, stage: string): AdapterError {
  return new AdapterError(ErrorCode.VERIFY_FAILED, message, { stage });
}
