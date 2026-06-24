import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { selectors, shadowClickPatterns } from "../src/selectors.js";

// PUB-0031 / PUB-0032 fixture tests: assert the captured real-UI control LABELS
// match the production selector regexes. When LinkedIn ships a localized or
// renamed control, the recorded label fails its regex here — the same break the
// live flow would hit, caught offline with no browser and no publishing.
//
// See tests/fixtures/README.md for the capture procedure. New labels that do not
// match are exactly the drift we want CI to surface.

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

interface LabelFixture {
  source: "real" | "synthetic";
  capturedAt: string;
  locale: string;
  note?: string;
  controls: {
    postControlMenu: string[];
    deleteMenuItem: string[];
    confirmDelete: string[];
    commentBox: string[];
  };
}

function compileSource(src: string): RegExp {
  const m = /^\/(.*)\/([a-z]*)$/s.exec(src);
  if (!m) throw new Error(`not a regex literal source: ${src}`);
  return new RegExp(m[1], m[2]);
}

function loadFixtures(): { file: string; fx: LabelFixture }[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".labels.json"))
    .map((file) => ({
      file,
      fx: JSON.parse(readFileSync(join(FIXTURES_DIR, file), "utf8")) as LabelFixture,
    }));
}

describe("dom fixtures — captured LinkedIn labels match production selectors", () => {
  const fixtures = loadFixtures();

  it("finds at least one label fixture", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const { file, fx } of fixtures) {
    describe(`${file} (${fx.locale}, ${fx.source})`, () => {
      // The shadow-walk DOM-click path (delete) uses these source patterns.
      const ctlMenuRe = compileSource(shadowClickPatterns.postControlMenu);
      const delItemRe = compileSource(shadowClickPatterns.deleteMenuItem);
      const confirmRe = compileSource(shadowClickPatterns.confirmDelete);

      it("every postControlMenu label matches editPostAction* AND the shadow pattern", () => {
        for (const label of fx.controls.postControlMenu) {
          const byLocator =
            selectors.editPostActionEn.test(label) || selectors.editPostActionRu.test(label);
          expect(byLocator, `editPostAction* should match "${label}"`).toBe(true);
          expect(ctlMenuRe.test(label), `shadow control-menu should match "${label}"`).toBe(true);
        }
      });

      it("every deleteMenuItem label matches the selector AND the shadow pattern", () => {
        for (const label of fx.controls.deleteMenuItem) {
          expect(selectors.deleteMenuItem.test(label), `deleteMenuItem "${label}"`).toBe(true);
          expect(delItemRe.test(label), `shadow delete "${label}"`).toBe(true);
        }
      });

      it("every confirmDelete label matches the selector AND the shadow pattern", () => {
        for (const label of fx.controls.confirmDelete) {
          expect(selectors.confirmDelete.test(label), `confirmDelete "${label}"`).toBe(true);
          expect(confirmRe.test(label), `shadow confirm "${label}"`).toBe(true);
        }
      });

      it("every commentBox label matches the comment composer selector", () => {
        for (const label of fx.controls.commentBox) {
          expect(selectors.commentBox.test(label), `commentBox "${label}"`).toBe(true);
        }
      });
    });
  }
});
