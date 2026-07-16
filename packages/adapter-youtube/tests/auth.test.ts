// PUB-0035 auth: PKCE loopback consent + token store discipline (plan Phase
// 2.3). The OAuth token endpoint rides the same injectable transport as the
// Data API; the loopback listener is exercised for real (second seam).

import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";
import { describe, expect, it } from "vitest";
import { AuthManager, OAUTH_TOKEN_URL } from "../src/auth.js";
import type { Transport, TransportRequest, TransportResponse } from "../src/transport.js";

const ENV = {
  YOUTUBE_OAUTH_CLIENT_ID: "client-id.apps.googleusercontent.com",
  YOUTUBE_OAUTH_CLIENT_SECRET: "GOCSPX-test-secret-value",
} as NodeJS.ProcessEnv;

function recordingTransport(
  respond: (req: TransportRequest) => TransportResponse,
): { transport: Transport; requests: TransportRequest[] } {
  const requests: TransportRequest[] = [];
  return {
    requests,
    transport: (req) => {
      requests.push(req);
      return Promise.resolve(respond(req));
    },
  };
}

const tokenOk: TransportResponse = {
  status: 200,
  headers: {},
  text: JSON.stringify({ access_token: "ya29.test-access", expires_in: 3600, refresh_token: "1//0refresh" }),
};

async function seededManager(respond: (req: TransportRequest) => TransportResponse) {
  const profilesRoot = await mkdtemp(join(tmpdir(), "pub0035-auth-"));
  const { transport, requests } = recordingTransport(respond);
  const auth = new AuthManager("origin", { transport, env: ENV, profilesRoot });
  return { auth, requests, profilesRoot };
}

describe("consent login (real loopback listener)", () => {
  it("PKCE+state flow persists refresh token 0600 under 0700 dirs; listener is 127.0.0.1 single-shot", async () => {
    const { auth } = await seededManager(() => tokenOk);
    let consentUrl = "";
    (auth as unknown as { deps: { openUrl: (u: string) => void } }).deps.openUrl = (u) => {
      consentUrl = u;
    };
    const loginDone = auth.login();
    await new Promise((r) => setTimeout(r, 50)); // listener up, consent URL captured
    const url = new URL(consentUrl);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
    expect(redirect.hostname).toBe("127.0.0.1"); // loopback-only bind
    const state = url.searchParams.get("state") ?? "";
    redirect.searchParams.set("code", "4/0Axcode");
    redirect.searchParams.set("state", state);
    const first = await fetch(redirect);
    expect(first.status).toBe(200);
    await loginDone;
    // single-shot: the listener is gone after one redirect
    await expect(fetch(redirect)).rejects.toThrow();
    const tokenPath = auth.tokenPath();
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(tokenPath))).mode & 0o777).toBe(0o700);
    expect(await readFile(tokenPath, "utf8")).toContain("refresh_token");
  });

  it("state mismatch aborts the consent fail-closed", async () => {
    const { auth } = await seededManager(() => tokenOk);
    let consentUrl = "";
    (auth as unknown as { deps: { openUrl: (u: string) => void } }).deps.openUrl = (u) => {
      consentUrl = u;
    };
    const loginDone = auth.login();
    await new Promise((r) => setTimeout(r, 50));
    const redirect = new URL(new URL(consentUrl).searchParams.get("redirect_uri") ?? "");
    redirect.searchParams.set("code", "4/0Axcode");
    redirect.searchParams.set("state", "WRONG");
    await fetch(redirect);
    await expect(loginDone).rejects.toThrow(/state mismatch/);
  });
});

describe("access-token refresh", () => {
  it("mints via the transport seam and caches until expiry margin", async () => {
    const { auth, requests, profilesRoot } = await seededManager(() => tokenOk);
    // Seed a stored refresh token by running the exchange path directly.
    const { writeFile, mkdir } = await import("node:fs/promises");
    const tokenPath = join(profilesRoot, "youtube", "origin", "token.json");
    await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });
    await writeFile(tokenPath, JSON.stringify({ refresh_token: "1//0seed" }), { mode: 0o600 });
    const token1 = await auth.getAccessToken();
    const token2 = await auth.getAccessToken();
    expect(token1).toBe("ya29.test-access");
    expect(token2).toBe(token1);
    const tokenCalls = requests.filter((r) => r.url === OAUTH_TOKEN_URL);
    expect(tokenCalls).toHaveLength(1); // cached — no second refresh
  });

  it("maps invalid_grant (400) to AUTH_EXPIRED and never leaks secret material", async () => {
    const { auth, profilesRoot } = await seededManager(() => ({
      status: 400,
      headers: {},
      text: JSON.stringify({ error: "invalid_grant" }),
    }));
    const { writeFile, mkdir } = await import("node:fs/promises");
    const tokenPath = join(profilesRoot, "youtube", "origin", "token.json");
    await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });
    await writeFile(tokenPath, JSON.stringify({ refresh_token: "1//0secret-refresh" }), { mode: 0o600 });
    try {
      await auth.getAccessToken();
      expect.unreachable();
    } catch (error) {
      const err = error as AdapterError;
      expect(err.code).toBe(ErrorCode.AUTH_EXPIRED);
      expect(err.message).not.toContain("1//0secret-refresh");
      expect(err.message).not.toContain("GOCSPX-");
      expect(JSON.stringify(err.toJSON())).not.toContain("1//0secret-refresh");
    }
  });

  it("missing token file → NO_PROFILE with login hint", async () => {
    const { auth } = await seededManager(() => tokenOk);
    await expect(auth.getAccessToken()).rejects.toMatchObject({ code: ErrorCode.NO_PROFILE });
  });

  it("missing env credentials → MISSING_INPUT", async () => {
    const profilesRoot = await mkdtemp(join(tmpdir(), "pub0035-auth-"));
    const auth = new AuthManager("origin", {
      transport: () => Promise.resolve(tokenOk),
      env: {} as NodeJS.ProcessEnv,
      profilesRoot,
    });
    await expect(auth.getAccessToken()).rejects.toMatchObject({ code: ErrorCode.MISSING_INPUT });
  });
});
