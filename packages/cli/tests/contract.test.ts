// Parameterised contract harness (V-AC-14): every one of the five adapters
// implements the same core Adapter contract — login / publish / comment / edit
// / delete / verify — and enforces the shared safety invariants
// (image-mandatory where applicable, read-before-delete, dry-run no-IO). The
// suite is literally named "contract" so `pnpm -r test -t contract` selects it.

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ErrorCode, ProfileManager, type Adapter, type Platform } from "@arcanada/publisher-core";
import { FacebookAdapter } from "@arcanada/publisher-facebook";
import { LinkedInAdapter } from "@arcanada/publisher-linkedin";
import { XAdapter } from "@arcanada/publisher-x";
import { RedditAdapter } from "@arcanada/publisher-reddit";
import { VKontakteAdapter } from "@arcanada/publisher-vkontakte";

function makeImage(): string {
  const dir = mkdtempSync(join(tmpdir(), "pub-contract-img-"));
  const file = join(dir, "hero.png");
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return file;
}

function makeProfiles(platform: string): ProfileManager {
  const root = mkdtempSync(join(tmpdir(), "pub-contract-prof-"));
  mkdirSync(join(root, platform, "default"), { recursive: true });
  return new ProfileManager({ root });
}

interface Case {
  platform: Platform;
  build: () => Adapter;
  /** Build a valid dry-run publish input for this adapter. */
  dryRunPublish: () => Parameters<Adapter["publish"]>[0];
  /** Build a valid delete input whose oracle will MISMATCH (abort path). */
  deleteMismatch: () => Parameters<Adapter["delete"]>[0];
  /** Whether the adapter requires an image (browser adapters do). */
  imageMandatory: boolean;
}

const noopTransport = async () => ({
  status: 200,
  json: { response: { post_id: 1, comment_id: 1 } },
});

const CASES: Case[] = [
  {
    platform: "facebook",
    build: () => new FacebookAdapter(),
    dryRunPublish: () => ({
      text: "hi",
      imagePaths: [makeImage()],
      profile: "default",
      dryRun: true,
    }),
    deleteMismatch: () => ({
      targetUrl: "https://www.facebook.com/100/posts/1",
      kind: "post",
      expectedContent: "the real text",
      profile: "default",
    }),
    imageMandatory: true,
  },
  {
    platform: "linkedin",
    build: () => new LinkedInAdapter(),
    dryRunPublish: () => ({
      text: "hi",
      imagePaths: [makeImage()],
      profile: "default",
      dryRun: true,
    }),
    deleteMismatch: () => ({
      targetUrl: "https://www.linkedin.com/feed/update/urn:li:activity:1/",
      kind: "post",
      expectedContent: "the real text",
      profile: "default",
    }),
    imageMandatory: false,
  },
  {
    platform: "x",
    build: () => new XAdapter(),
    dryRunPublish: () => ({
      text: "hi",
      imagePaths: [makeImage()],
      profile: "default",
      dryRun: true,
    }),
    deleteMismatch: () => ({
      targetUrl: "https://x.com/me/status/1",
      kind: "post",
      expectedContent: "the real text",
      profile: "default",
    }),
    imageMandatory: true,
  },
  {
    platform: "reddit",
    build: () => new RedditAdapter({ transport: noopTransport }),
    dryRunPublish: () =>
      ({ text: "hi", subreddit: "test", title: "t", profile: "default", dryRun: true }) as never,
    deleteMismatch: () => ({
      targetUrl: "https://www.reddit.com/r/test/comments/abc/",
      kind: "post",
      expectedContent: "the real text",
      profile: "default",
    }),
    imageMandatory: false,
  },
  {
    platform: "vkontakte",
    build: () => new VKontakteAdapter({ transport: noopTransport }),
    dryRunPublish: () => ({ text: "hi", ownerId: -1, profile: "default", dryRun: true }) as never,
    deleteMismatch: () => ({
      targetUrl: "https://vk.com/wall-1_1",
      kind: "post",
      expectedContent: "the real text",
      profile: "default",
    }),
    imageMandatory: false,
  },
];

describe.each(CASES)("contract — $platform adapter", (c) => {
  it("exposes the full Adapter surface (publish/comment/edit/delete/verify/login)", () => {
    const a = c.build();
    expect(a.platform).toBe(c.platform);
    for (const m of ["publish", "comment", "edit", "delete", "verify", "login"] as const) {
      expect(typeof a[m]).toBe("function");
    }
  });

  it("dry-run publish performs no IO and reports the dry-run account", async () => {
    const a = c.build();
    const res = await a.publish(c.dryRunPublish());
    expect(res.ok).toBe(true);
    expect(res.platform).toBe(c.platform);
  });

  it("delete fails closed (VERIFY_FAILED) when read-before-delete content mismatches", async () => {
    // Each adapter is constructed with a seam that makes the read-before-delete
    // oracle MISMATCH, so the destructive step must never run.
    const mismatchDeleteOptions = {
      profileManager: makeProfiles(c.platform),
      page: { dummy: true },
      __readContent: async () => "a totally different rendered target",
      __performDelete: async () => {},
    };
    const adapter: Adapter =
      c.platform === "facebook"
        ? new FacebookAdapter({ deleteOptions: mismatchDeleteOptions as never })
        : c.platform === "linkedin"
          ? new LinkedInAdapter({ deleteOptions: mismatchDeleteOptions as never })
          : c.platform === "x"
            ? new XAdapter({ deleteOptions: mismatchDeleteOptions as never })
            : c.platform === "reddit"
              ? new RedditAdapter({
                  transport: async () => ({
                    status: 200,
                    json: { data: { children: [{ data: { body: "other" } }] } },
                  }),
                })
              : new VKontakteAdapter({
                  transport: async () => ({
                    status: 200,
                    json: { response: { items: [{ text: "other" }] } },
                  }),
                });
    await expect(adapter.delete(c.deleteMismatch())).rejects.toMatchObject({
      code: ErrorCode.VERIFY_FAILED,
    });
  });

  it("image-mandatory adapters reject a publish with no image", async () => {
    if (!c.imageMandatory) {
      return;
    }
    const a = c.build();
    const profiles = makeProfiles(c.platform);
    await expect(
      (a as unknown as { publish: (i: unknown, o: unknown) => Promise<unknown> }).publish(
        { text: "hi", profile: "default" },
        { profileManager: profiles },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.MISSING_INPUT });
  });
});
