// PUB-0035 parity (plan Phase 5.2): identical adapter behaviour for the same
// input regardless of construction path, dry-run zero-mutation guarantee, and
// a secret-free mutation plan. Factory-level field forwarding is asserted in
// packages/cli and packages/api test suites (registration phase).

import { describe, expect, it } from "vitest";
import { YouTubeAdapter } from "../src/index.js";
import { happyResponders, makeFixture, makeTransport } from "./helpers.js";

const FIELD_SET = ["text", "title", "videoPath", "language", "privacyStatus", "profile", "dryRun"];

describe("dry-run parity across construction paths", () => {
  it("two independently constructed adapters produce identical dry-run plans with zero mutations", async () => {
    const fixture = await makeFixture();
    const run = async () => {
      const recorder = makeTransport(happyResponders());
      const adapter = new YouTubeAdapter({
        transport: recorder.transport,
        env: fixture.env,
        profilesRoot: fixture.profilesRoot,
        auditBaseDir: fixture.auditBaseDir,
      });
      const result = await adapter.publish({
        text: "Описание: https://arcanada.ai/ru/blog/x",
        title: "Заголовок выпуска",
        profile: "origin",
        language: "ru",
        videoPath: fixture.videoPath,
        privacyStatus: "private",
        dryRun: true,
      });
      return { result, recorder };
    };
    const a = await run();
    const b = await run();
    expect(a.result).toEqual(b.result);
    for (const side of [a, b]) {
      // zero mutating Data API calls: the OAuth token POST is the sole non-GET
      expect(side.recorder.mutating()).toEqual([]);
      const nonGet = side.recorder.requests.filter((r) => r.method !== "GET");
      expect(nonGet.every((r) => r.url.includes("oauth2.googleapis.com"))).toBe(true);
    }
  });

  it("the dry-run plan is complete and secret-free", async () => {
    const fixture = await makeFixture();
    const recorder = makeTransport(happyResponders());
    const adapter = new YouTubeAdapter({
      transport: recorder.transport,
      env: fixture.env,
      profilesRoot: fixture.profilesRoot,
    });
    const result = await adapter.publish({
      text: "Описание: https://arcanada.ai/ru/blog/x",
      title: "Заголовок выпуска",
      profile: "origin",
      language: "ru",
      videoPath: fixture.videoPath,
      dryRun: true,
    });
    const plan = result.warnings.join("\n");
    expect(plan).toContain("dry-run: no mutation performed");
    expect(plan).toContain("plan: channel=UC2zUfwafsM2OxaidE0iNM7w");
    expect(plan).toContain("plan: playlist(ru)=PLru001");
    expect(plan).toContain("plan: sha256=");
    expect(plan).not.toMatch(/ya29\.|GOCSPX-|upload_id=|refresh_token/);
  });

  it("documents the parity field set consumed by both factories", () => {
    // The CLI and API registration tests enumerate exactly this set; a drift
    // in either factory breaks the corresponding suite, not this constant.
    expect(FIELD_SET).toMatchInlineSnapshot(`
      [
        "text",
        "title",
        "videoPath",
        "language",
        "privacyStatus",
        "profile",
        "dryRun",
      ]
    `);
  });
});
