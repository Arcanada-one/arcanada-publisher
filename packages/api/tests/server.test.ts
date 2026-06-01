import { describe, it, expect } from "vitest";
import { createApiServer, listen } from "../src/index.js";
import { ErrorCode } from "@arcanada/publisher-core";

describe("api server — loopback-only bind (network-guard contract)", () => {
  it("constructs with the default loopback bind", () => {
    const server = createApiServer();
    expect(server).toBeDefined();
    server.close();
  });

  it("constructs with an explicit loopback bind (localhost / ::1)", () => {
    for (const bind of ["127.0.0.1", "localhost", "::1"]) {
      const server = createApiServer({ bind });
      expect(server).toBeDefined();
      server.close();
    }
  });

  it("REJECTS a non-loopback bind with NETWORK_GUARD (fail-closed)", () => {
    expect(() => createApiServer({ bind: "0.0.0.0" })).toThrow();
    try {
      createApiServer({ bind: "0.0.0.0" });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as { code: number }).code).toBe(ErrorCode.NETWORK_GUARD);
    }
  });

  it("rejects a public IP bind", () => {
    try {
      createApiServer({ bind: "203.0.113.7" });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as { code: number }).code).toBe(ErrorCode.NETWORK_GUARD);
    }
  });

  it("listens on loopback and serves /health", async () => {
    const { server, port } = await listen({ bind: "127.0.0.1", port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    } finally {
      server.close();
    }
  });
});
