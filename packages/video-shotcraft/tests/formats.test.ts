// RenderFormat registry (D5): baseline landscape descriptor + fail-closed unknown id.

import { describe, it, expect } from "vitest";
import { LANDSCAPE, DEFAULT_FORMAT, resolveFormat, listFormats } from "../src/formats.js";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";

describe("RenderFormat registry", () => {
  it("landscape is 1920x1080 @ 30 h264/aac", () => {
    expect(LANDSCAPE).toEqual({
      id: "landscape",
      width: 1920,
      height: 1080,
      fps: 30,
      videoCodec: "h264",
      audioCodec: "aac",
    });
  });

  it("default format is landscape", () => {
    expect(DEFAULT_FORMAT.id).toBe("landscape");
  });

  it("resolveFormat('landscape') returns the descriptor", () => {
    expect(resolveFormat("landscape")).toBe(LANDSCAPE);
  });

  it("resolveFormat rejects an unknown id with INVALID_ARGS", () => {
    try {
      resolveFormat("vertical");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).code).toBe(ErrorCode.INVALID_ARGS);
    }
  });

  it("listFormats registers only landscape in the baseline", () => {
    expect(listFormats()).toEqual(["landscape"]);
  });
});
