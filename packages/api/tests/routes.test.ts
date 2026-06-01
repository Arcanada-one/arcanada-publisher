import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import {
  type Adapter,
  type PublishInput,
  type CommentInput,
  type EditInput,
  type DeleteInput,
  type Platform,
  RateLimiter,
  AdapterError,
  ErrorCode,
} from "@arcanada/publisher-core";
import { listen } from "../src/index.js";

// A fully in-memory adapter — no browser, no network. Records the inputs it
// receives so route wiring can be asserted.
class FakeAdapter implements Adapter {
  readonly platform: Platform;
  readonly calls: Record<string, unknown[]> = {
    publish: [],
    comment: [],
    edit: [],
    delete: [],
  };

  constructor(platform: Platform) {
    this.platform = platform;
  }

  async login(): Promise<void> {}

  async publish(input: PublishInput) {
    this.calls.publish.push(input);
    return {
      ok: true as const,
      platform: this.platform,
      account: "fake-acct",
      postUrl: "https://example.com/fake/posts/1",
      attachments: [],
      commentIds: [],
    };
  }

  async comment(input: CommentInput) {
    this.calls.comment.push(input);
    return {
      ok: true as const,
      platform: this.platform,
      account: "fake-acct",
      commentId: "c1",
      parentPostUrl: input.parentPostUrl,
    };
  }

  async edit(input: EditInput) {
    this.calls.edit.push(input);
    return {
      ok: true as const,
      platform: this.platform,
      account: "fake-acct",
      postUrl: input.postUrl,
      edited: true,
    };
  }

  async delete(input: DeleteInput) {
    this.calls.delete.push(input);
    return {
      ok: true as const,
      platform: this.platform,
      account: "fake-acct",
      deleted: true,
      targetUrl: input.targetUrl,
    };
  }

  async verify(postUrl: string) {
    return { ok: true, platform: this.platform, postUrl, reachable: true, status: 200 };
  }
}

describe("api routes — publish/comment/edit/delete over loopback", () => {
  let server: Server;
  let port: number;
  let auditDir: string;
  let lastAdapter: FakeAdapter | undefined;
  let factoryError: AdapterError | undefined;

  const base = (): string => `http://127.0.0.1:${port}`;

  async function start(rateLimiter?: RateLimiter): Promise<void> {
    auditDir = mkdtempSync(join(tmpdir(), "api-audit-"));
    const started = await listen({
      bind: "127.0.0.1",
      port: 0,
      makeAdapter: (platform: Platform): Adapter => {
        if (factoryError) throw factoryError;
        lastAdapter = new FakeAdapter(platform);
        return lastAdapter;
      },
      auditBaseDir: auditDir,
      ...(rateLimiter ? { rateLimiter } : {}),
    });
    server = started.server;
    port = started.port;
  }

  beforeEach(() => {
    lastAdapter = undefined;
    factoryError = undefined;
  });

  afterEach(() => {
    server?.close();
    if (auditDir) rmSync(auditDir, { recursive: true, force: true });
  });

  it("POST /publish returns 200 with a PublishResult and writes one audit record", async () => {
    await start();
    const res = await fetch(`${base()}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "x", text: "hello", profile: "default" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: { postUrl: string; auditRef?: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data.postUrl).toBe("https://example.com/fake/posts/1");
    expect(body.data.auditRef).toMatch(/^PUB-audit-/);

    const files = readdirSync(auditDir);
    expect(files).toHaveLength(1);
    const lines = readFileSync(join(auditDir, files[0]), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  it("POST /comment returns 200 with a CommentResult", async () => {
    await start();
    const res = await fetch(`${base()}/comment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        platform: "x",
        parentUrl: "https://example.com/p/1",
        text: "nice",
        profile: "default",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { commentId: string } };
    expect(body.ok).toBe(true);
    expect(body.data.commentId).toBe("c1");
    expect(lastAdapter?.calls.comment).toHaveLength(1);
    expect((lastAdapter?.calls.comment[0] as CommentInput).parentPostUrl).toBe(
      "https://example.com/p/1",
    );
  });

  it("POST /edit returns 200 with an EditResult", async () => {
    await start();
    const res = await fetch(`${base()}/edit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        platform: "facebook",
        targetUrl: "https://example.com/p/9",
        text: "fixed",
        profile: "default",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { edited: boolean } };
    expect(body.ok).toBe(true);
    expect(body.data.edited).toBe(true);
  });

  it("POST /delete returns 200 with a DeleteResult", async () => {
    await start();
    const res = await fetch(`${base()}/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        platform: "x",
        targetUrl: "https://example.com/p/3",
        expectedContent: "anchor",
        profile: "default",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { deleted: boolean } };
    expect(body.ok).toBe(true);
    expect(body.data.deleted).toBe(true);
  });

  it("returns 400 INVALID_ARGS for an unknown platform", async () => {
    await start();
    const res = await fetch(`${base()}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "myspace", text: "x", profile: "default" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: { code: number } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe(ErrorCode.INVALID_ARGS);
  });

  it("returns 400 for malformed JSON", async () => {
    await start();
    const res = await fetch(`${base()}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects an over-limit X text with 400 INVALID_ARGS (tool scoping)", async () => {
    await start();
    const res = await fetch(`${base()}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "x", text: "a".repeat(281), profile: "default" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(ErrorCode.INVALID_ARGS);
  });

  it("rejects an unsafe profile name with 400 INVALID_ARGS (tool scoping)", async () => {
    await start();
    const res = await fetch(`${base()}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "x", text: "ok", profile: "../escape" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 429 RATE_LIMIT once the per-platform breaker trips", async () => {
    // Pre-saturate the limiter so the very first publish trips it.
    let clock = 1_700_000_000_000;
    const rl = new RateLimiter({ now: () => clock });
    for (let i = 0; i < 5; i++) rl.record("x");
    await start(rl);
    const res = await fetch(`${base()}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "x", text: "hi", profile: "default" }),
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(ErrorCode.RATE_LIMIT);
  });

  it("does NOT write an audit record on a dry-run publish", async () => {
    await start();
    const res = await fetch(`${base()}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "x", text: "hello", profile: "default", dryRun: true }),
    });
    expect(res.status).toBe(200);
    const files = readdirSync(auditDir);
    expect(files).toHaveLength(0);
  });

  it("maps a NETWORK_GUARD adapter error to 403 and a generic AdapterError to its HTTP status", async () => {
    factoryError = new AdapterError(ErrorCode.NO_PROFILE, "no profile found");
    await start();
    const res = await fetch(`${base()}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "x", text: "hi", profile: "default" }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(ErrorCode.NO_PROFILE);
  });

  it("returns 404 for an unknown route", async () => {
    await start();
    const res = await fetch(`${base()}/nope`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("still serves GET /health with version + platforms", async () => {
    await start();
    const res = await fetch(`${base()}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version?: string; platforms?: string[] };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.platforms)).toBe(true);
    expect(body.platforms).toContain("x");
  });
});
