import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";

interface ClipboardDeps {
  platform: NodeJS.Platform;
  exec: typeof execFileSync;
  realpath: typeof realpathSync;
  stat: typeof statSync;
  read: typeof readFileSync;
}

const defaults: ClipboardDeps = {
  platform: process.platform,
  exec: execFileSync,
  realpath: realpathSync,
  stat: statSync,
  read: readFileSync,
};

export interface ClipboardProof {
  verified: boolean;
  size: number;
  sha256: string;
}

export function prepareMediaClipboard(
  mediaPath: string,
  deps: ClipboardDeps = defaults,
): ClipboardProof | null {
  if (deps.platform !== "darwin") return null;
  let source: string;
  try {
    source = deps.realpath(mediaPath);
  } catch {
    throw clipboardError("macOS media file verification failed");
  }
  const script = [
    "on run argv",
    "set mediaFile to POSIX file (item 1 of argv)",
    "set the clipboard to mediaFile",
    "delay 0.1",
    "return POSIX path of (the clipboard as alias)",
    "end run",
  ].join("\n");
  let roundTrip: string;
  try {
    roundTrip = String(
      deps.exec("osascript", ["-e", script, "--", source], { encoding: "utf8" }),
    ).trim();
  } catch {
    throw clipboardError("macOS clipboard did not return a file alias");
  }
  let resolved: string;
  try {
    resolved = deps.realpath(roundTrip);
  } catch {
    throw clipboardError("macOS clipboard returned a non-file value");
  }
  let sourceBytes: Buffer;
  let targetBytes: Buffer;
  let sourceSize: number;
  let targetSize: number;
  try {
    sourceBytes = deps.read(source) as Buffer;
    targetBytes = deps.read(resolved) as Buffer;
    sourceSize = deps.stat(source).size;
    targetSize = deps.stat(resolved).size;
  } catch {
    throw clipboardError("macOS media file verification failed");
  }
  const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
  const targetHash = createHash("sha256").update(targetBytes).digest("hex");
  if (source !== resolved || sourceSize !== targetSize || sourceHash !== targetHash) {
    throw clipboardError("macOS clipboard file verification mismatch");
  }
  return { verified: true, size: sourceSize, sha256: sourceHash };
}

function clipboardError(message: string): AdapterError {
  return new AdapterError(ErrorCode.VERIFY_FAILED, message, {
    stage: "media_clipboard_preflight",
  });
}
