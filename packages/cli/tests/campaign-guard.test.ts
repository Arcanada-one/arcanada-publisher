import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdapterError, ErrorCode, type Adapter, type Platform } from "@arcanada/publisher-core";
import { run } from "../src/run.js";

const roots: string[] = [];

function textFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "publisher-cli-guard-"));
  roots.push(dir);
  const path = join(dir, "body.txt");
  writeFileSync(path, "managed body");
  return path;
}

function fakeAdapter(platform: Platform): Adapter {
  return {
    platform,
    async login() {},
    async publish() {
      return {
        ok: true,
        platform,
        account: "fake",
        postUrl: "https://example.com/post/1",
        attachments: [],
        commentIds: [],
      };
    },
    async comment(input) {
      return {
        ok: true,
        platform,
        account: "fake",
        commentId: "c1",
        parentPostUrl: input.parentPostUrl,
      };
    },
    async edit(input) {
      return { ok: true, platform, account: "fake", postUrl: input.postUrl, edited: true };
    },
    async delete(input) {
      return { ok: true, platform, account: "fake", targetUrl: input.targetUrl, deleted: true };
    },
    async verify(postUrl) {
      return { ok: true, platform, postUrl, reachable: true, status: 200 };
    },
  };
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("CLI CampaignGuard chokepoint", () => {
  it("denies a managed publish before adapter construction", async () => {
    const makeAdapter = vi.fn(fakeAdapter);
    const authorize = vi.fn(async () => {
      throw new AdapterError(ErrorCode.CAMPAIGN_RECEIPT_REQUIRED, "receipt required");
    });
    const result = await run(["publish", "--platform", "x", "--text-file", textFile()], {
      makeAdapter,
      campaignGuard: { authorize, preflight: vi.fn() },
    });
    expect(result.code).toBe(ErrorCode.CAMPAIGN_RECEIPT_REQUIRED);
    expect(authorize).toHaveBeenCalledOnce();
    expect(makeAdapter).not.toHaveBeenCalled();
  });

  it("constructs the adapter exactly once after authorization", async () => {
    const makeAdapter = vi.fn(fakeAdapter);
    const authorize = vi.fn(async () => ({ managed: true, targetId: "arcanada-x" }));
    const recordResult = vi.fn();
    const result = await run(
      [
        "publish",
        "--platform",
        "x",
        "--text-file",
        textFile(),
        "--image",
        "/secure/video.mp4",
        "--campaign-manifest",
        "/secure/campaign.json",
        "--campaign-receipt",
        "signed-receipt",
        "--campaign-target",
        "content-0377-x-main",
      ],
      { makeAdapter, campaignGuard: { authorize, preflight: vi.fn(), recordResult } },
    );
    expect(result.code).toBe(0);
    expect(authorize).toHaveBeenCalledOnce();
    expect(makeAdapter).toHaveBeenCalledOnce();
    expect(recordResult).toHaveBeenCalledWith(
      expect.objectContaining({ managed: true }),
      "https://example.com/post/1",
    );
  });

  it("campaign-preflight issues one receipt without constructing an adapter", async () => {
    const makeAdapter = vi.fn(fakeAdapter);
    const preflight = vi.fn(async () => "signed-receipt");
    const result = await run(
      [
        "campaign-preflight",
        "--platform",
        "x",
        "--text-file",
        textFile(),
        "--image",
        "/secure/video.mp4",
        "--campaign-manifest",
        "/secure/campaign.json",
        "--campaign-action",
        "publish",
        "--campaign-target",
        "content-0377-x-main",
      ],
      { makeAdapter, campaignGuard: { authorize: vi.fn(), preflight } },
    );
    expect(result).toEqual({ code: 0, message: "signed-receipt" });
    expect(preflight).toHaveBeenCalledOnce();
    expect(preflight).toHaveBeenCalledWith(
      expect.objectContaining({ campaignTargetId: "content-0377-x-main" }),
    );
    expect(makeAdapter).not.toHaveBeenCalled();
  });

  it("binds comment replacement authorization to parent, comment identity, and old bytes", async () => {
    const oldPath = textFile();
    const newPath = textFile();
    writeFileSync(oldPath, "old comment");
    writeFileSync(newPath, "replacement");
    const authorize = vi.fn(async () => ({ managed: true, targetId: "x-comment-edit" }));
    const replaceComment = vi.fn(async () => ({ commentId: "new-comment" }));
    const makeAdapter = vi.fn(
      () =>
        ({
          ...fakeAdapter("x"),
          replaceComment,
        }) as unknown as Adapter,
    );

    const result = await run(
      [
        "replace-comment",
        "--platform",
        "x",
        "--parent-url",
        "https://example.com/post/1",
        "--comment-id",
        "comment-1",
        "--expected-author-profile-url",
        "https://example.com/acme",
        "--expected-content-file",
        oldPath,
        "--text-file",
        newPath,
        "--campaign-manifest",
        "/secure/campaign.json",
        "--campaign-receipt",
        "signed-receipt",
        "--campaign-target",
        "content-0377-x-comment-edit",
      ],
      { makeAdapter, campaignGuard: { authorize, preflight: vi.fn() } },
    );

    expect(result.code).toBe(0);
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "edit",
        campaignTargetId: "content-0377-x-comment-edit",
        subjectUrl: "https://example.com/post/1",
        subjectIdentity: "comment-1",
        existingText: "old comment",
        text: "replacement",
      }),
    );
  });

  it("campaign-setup and confirmed de-enrollment are explicit adapter-free operations", async () => {
    const makeAdapter = vi.fn(fakeAdapter);
    const setup = vi.fn(() => ({ enrolled: true as const }));
    const deEnroll = vi.fn(() => ({ enrolled: false as const, archiveDir: "/private/archive" }));
    const guard = { authorize: vi.fn(), preflight: vi.fn() };
    await expect(
      run(["campaign-setup"], {
        makeAdapter,
        campaignGuard: guard,
        setupCampaignPolicy: setup,
        deEnrollCampaignPolicy: deEnroll,
      }),
    ).resolves.toEqual({
      code: 0,
      message: "managed campaign policy enrolled",
    });
    await expect(
      run(["campaign-deenroll", "--confirm-managed-deenroll"], {
        makeAdapter,
        campaignGuard: guard,
        setupCampaignPolicy: setup,
        deEnrollCampaignPolicy: deEnroll,
      }),
    ).resolves.toEqual({ code: 0, message: "managed campaign policy de-enrolled" });
    expect(setup).toHaveBeenCalledOnce();
    expect(deEnroll).toHaveBeenCalledWith(true);
    expect(makeAdapter).not.toHaveBeenCalled();
  });
});
