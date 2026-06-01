import { describe, it, expect, vi } from "vitest";
import { ErrorCode } from "@arcanada/publisher-core";
import { VKontakteAdapter, type VkTransport } from "../src/index.js";
import type { VkPublishInput } from "../src/index.js";

describe("vk publish — wall.post", () => {
  it("posts to the wall and returns the wall<owner>_<id> permalink", async () => {
    const captured: Array<{ method: string; params: Record<string, string> }> = [];
    const transport: VkTransport = vi.fn(async (req) => {
      captured.push(req);
      return { status: 200, json: { response: { post_id: 789 } } };
    });
    const adapter = new VKontakteAdapter({ transport });
    const res = await adapter.publish({
      text: "привет",
      ownerId: -123456,
      profile: "p1",
    } as VkPublishInput);
    expect(captured[0].method).toBe("wall.post");
    expect(captured[0].params["owner_id"]).toBe("-123456");
    expect(res.postUrl).toBe("https://vk.com/wall-123456_789");
  });

  it("rejects empty text with MISSING_INPUT", async () => {
    const transport: VkTransport = vi.fn(async () => ({ status: 200, json: {} }));
    const adapter = new VKontakteAdapter({ transport });
    await expect(
      adapter.publish({ text: "  ", ownerId: -1, profile: "p1" } as VkPublishInput),
    ).rejects.toMatchObject({ code: ErrorCode.MISSING_INPUT });
  });

  it("dry-run returns a placeholder permalink and never calls the transport", async () => {
    const transport: VkTransport = vi.fn(async () => ({ status: 200, json: {} }));
    const adapter = new VKontakteAdapter({ transport });
    const res = await adapter.publish({
      text: "привет",
      ownerId: -123456,
      profile: "p1",
      dryRun: true,
    } as VkPublishInput);
    expect(res.account).toBe("-123456");
    expect(transport).not.toHaveBeenCalled();
  });

  it("requires accessToken when no transport is injected", () => {
    expect(() => new VKontakteAdapter({})).toThrow();
  });
});
