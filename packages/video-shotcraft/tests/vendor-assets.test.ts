// Vendor-asset resolver: 106 cards present, lookup by designation, typed
// card-not-found error, Ink Press template dir present (V-AC-2 / F9).

import { describe, it, expect } from "vitest";
import {
  shotCardCount,
  listShotCards,
  resolveShotCard,
  inkPressTemplateDir,
  _resetVendorIndex,
} from "../src/vendor-assets.js";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";

describe("vendor-assets", () => {
  it("indexes exactly 106 shot cards", () => {
    _resetVendorIndex();
    expect(shotCardCount()).toBe(106);
  });

  it("lists at least 106 unique designations", () => {
    expect(listShotCards().length).toBeGreaterThanOrEqual(106);
  });

  it("resolves a known card (brand-ink-open)", () => {
    const card = resolveShotCard("brand-ink-open");
    expect(card.name).toBe("brand-ink-open");
    expect(card.file).toContain("references/shots/brand-ink-open.md");
  });

  it("throws a typed card-not-found error for an unknown designation", () => {
    try {
      resolveShotCard("no-such-card-xyz");
      expect.fail("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).code).toBe(ErrorCode.MISSING_INPUT);
      expect((err as AdapterError).message).toContain("card not found");
    }
  });

  it("exposes the Ink Press template directory", () => {
    expect(inkPressTemplateDir()).toContain("vendor/video-shotcraft/template");
  });
});
