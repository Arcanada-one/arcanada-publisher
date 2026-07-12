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

export function validateMediaFile(
  mediaPath: string,
  deps: ClipboardDeps = defaults,
): ClipboardProof {
  try {
    const path = deps.realpath(mediaPath);
    const bytes = deps.read(path) as Buffer;
    const size = deps.stat(path).size;
    return { verified: true, size, sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch {
    throw clipboardError("media file validation failed");
  }
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
    "ObjC.import('AppKit');",
    "function run(argv) {",
    "  const path = ObjC.unwrap(argv[0]);",
    "  const pb = $.NSPasteboard.generalPasteboard;",
    "  pb.clearContents;",
    "  const url = $.NSURL.fileURLWithPath(path);",
    "  const wrote = pb.writeObjects($.NSArray.arrayWithObject(url));",
    "  pb.setPropertyListForType([path], 'NSFilenamesPboardType');",
    "  pb.setStringForType(url.absoluteString, 'public.file-url');",
    "  pb.setStringForType(url.absoluteString, 'NSURLPboardType');",
    "  const files = ObjC.deepUnwrap(pb.propertyListForType('NSFilenamesPboardType'));",
    "  const types = ObjC.deepUnwrap(pb.types);",
    "  return JSON.stringify({ path: files[0], types: types, wrote: Boolean(wrote) });",
    "}",
  ].join("\n");
  let roundTrip: string;
  try {
    roundTrip = String(
      deps.exec("osascript", ["-l", "JavaScript", "-e", script, "--", source], {
        encoding: "utf8",
      }),
    ).trim();
    const parsed = JSON.parse(roundTrip) as { path?: string; types?: string[]; wrote?: boolean };
    const required = ["public.file-url", "NSURLPboardType", "NSFilenamesPboardType"];
    if (!parsed.wrote || !parsed.path || !required.every((type) => parsed.types?.includes(type))) {
      throw new Error("incomplete pasteboard types");
    }
    roundTrip = parsed.path;
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
