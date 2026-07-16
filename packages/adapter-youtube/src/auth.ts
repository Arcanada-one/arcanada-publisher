// OAuth 2.0 Desktop-app flow over the injectable transport — PKCE S256 +
// `state`, loopback single-shot listener bound to 127.0.0.1, refresh token
// persisted 0600 under the profiles root (plan C8, D-REQ-02).
//
// The token endpoint is called through the SAME transport seam as the Data
// API, so every auth branch is fixture-testable; no third-party OAuth client
// (and no gaxios bypassing the seam).

import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";
import { parseJson, type Transport } from "./transport.js";

export const OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";

export interface AuthDeps {
  transport: Transport;
  env?: NodeJS.ProcessEnv;
  /** Profiles root override (tests). Default mirrors core ProfileManager. */
  profilesRoot?: string;
  now?: () => number;
  /** Consent-URL presenter: default prints for the operator's own browser. */
  openUrl?: (url: string) => void | Promise<void>;
}

interface StoredToken {
  refresh_token: string;
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class AuthManager {
  private readonly deps: Required<Pick<AuthDeps, "transport">> & AuthDeps;
  private accessToken: { value: string; expiresAt: number } | undefined;

  constructor(
    private readonly profile: string,
    deps: AuthDeps,
  ) {
    this.deps = deps;
  }

  tokenPath(): string {
    const root =
      this.deps.profilesRoot ??
      this.deps.env?.["ARCANADA_PUBLISHER_PROFILES_ROOT"] ??
      process.env["ARCANADA_PUBLISHER_PROFILES_ROOT"] ??
      join(homedir(), ".arcanada-publisher", "profiles");
    return join(root, "youtube", this.profile === "" ? "default" : this.profile, "token.json");
  }

  private clientCredentials(): { id: string; secret: string } {
    const env = this.deps.env ?? process.env;
    const id = env["YOUTUBE_OAUTH_CLIENT_ID"];
    const secret = env["YOUTUBE_OAUTH_CLIENT_SECRET"];
    if (!id || !secret) {
      throw new AdapterError(
        ErrorCode.MISSING_INPUT,
        "YOUTUBE_OAUTH_CLIENT_ID / YOUTUBE_OAUTH_CLIENT_SECRET are required (env only, sourced from config/credentials/)",
      );
    }
    return { id, secret };
  }

  /** One-time headed consent. Never logs tokens or authorization codes. */
  async login(): Promise<void> {
    const { id } = this.clientCredentials();
    const verifier = base64url(randomBytes(48));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const state = randomBytes(16).toString("hex");

    const code = await this.receiveAuthCode(id, challenge, state);
    const token = await this.exchange({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: this.redirectUri,
    });
    const refresh = (token as { refresh_token?: string }).refresh_token;
    if (!refresh) {
      throw new AdapterError(
        ErrorCode.AUTH_EXPIRED,
        "consent completed but no refresh_token was issued — re-run login with prompt=consent",
      );
    }
    await this.persistRefreshToken(refresh);
  }

  private redirectUri = "";

  /** Single-shot 127.0.0.1 listener: accepts exactly one redirect, then closes. */
  private receiveAuthCode(clientId: string, challenge: string, state: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", this.redirectUri);
        res.setHeader("content-type", "text/plain; charset=utf-8");
        // Single-shot: `connection: close` retires this socket after the
        // response flushes (no RST mid-read), and server.close() refuses any
        // new connection — together the listener serves exactly one redirect.
        res.setHeader("connection", "close");
        const gotState = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        res.end("Arcanada Publisher: you may close this tab.");
        server.close();
        if (gotState !== state) {
          reject(
            new AdapterError(ErrorCode.INVALID_ARGS, "OAuth state mismatch — consent aborted"),
          );
          return;
        }
        if (!code) {
          reject(new AdapterError(ErrorCode.INVALID_ARGS, "OAuth redirect carried no code"));
          return;
        }
        resolve(code);
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          reject(new AdapterError(ErrorCode.INTERNAL_PANIC, "loopback listener failed to bind"));
          return;
        }
        this.redirectUri = `http://127.0.0.1:${address.port}/oauth2/callback`;
        const consent = new URL(OAUTH_AUTH_URL);
        consent.searchParams.set("client_id", clientId);
        consent.searchParams.set("redirect_uri", this.redirectUri);
        consent.searchParams.set("response_type", "code");
        consent.searchParams.set("scope", YOUTUBE_SCOPE);
        consent.searchParams.set("access_type", "offline");
        consent.searchParams.set("prompt", "consent");
        consent.searchParams.set("code_challenge", challenge);
        consent.searchParams.set("code_challenge_method", "S256");
        consent.searchParams.set("state", state);
        const present = this.deps.openUrl ?? ((u: string) => console.error(`Open to consent: ${u}`));
        void present(consent.toString());
      });
    });
  }

  private async persistRefreshToken(refreshToken: string): Promise<void> {
    const path = this.tokenPath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify({ refresh_token: refreshToken } satisfies StoredToken), {
      mode: 0o600,
    });
    await chmod(path, 0o600);
  }

  private async readRefreshToken(): Promise<string> {
    try {
      const raw = await readFile(this.tokenPath(), "utf8");
      const stored = JSON.parse(raw) as StoredToken;
      if (!stored.refresh_token) throw new Error("empty");
      return stored.refresh_token;
    } catch {
      throw new AdapterError(
        ErrorCode.NO_PROFILE,
        `no stored YouTube token for profile '${this.profile || "default"}' — run 'arcanada-publisher login --platform youtube' first`,
      );
    }
  }

  /** Cached access token with a 60 s expiry margin; refreshes via the seam. */
  async getAccessToken(): Promise<string> {
    const now = (this.deps.now ?? Date.now)();
    if (this.accessToken && this.accessToken.expiresAt - 60_000 > now) {
      return this.accessToken.value;
    }
    return this.refreshAccessToken();
  }

  async refreshAccessToken(): Promise<string> {
    this.clientCredentials(); // fail fast on missing env config before touching the profile
    const refreshToken = await this.readRefreshToken();
    const token = await this.exchange({ grant_type: "refresh_token", refresh_token: refreshToken });
    const parsed = token as { access_token?: string; expires_in?: number };
    if (!parsed.access_token) {
      throw new AdapterError(ErrorCode.AUTH_EXPIRED, "token endpoint returned no access_token");
    }
    const now = (this.deps.now ?? Date.now)();
    this.accessToken = {
      value: parsed.access_token,
      expiresAt: now + (parsed.expires_in ?? 3_600) * 1_000,
    };
    return parsed.access_token;
  }

  private async exchange(fields: Record<string, string>): Promise<unknown> {
    const { id, secret } = this.clientCredentials();
    const body = new URLSearchParams({ client_id: id, client_secret: secret, ...fields });
    const response = await this.deps.transport({
      method: "POST",
      url: OAUTH_TOKEN_URL,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (response.status === 400 || response.status === 401) {
      // invalid_grant = revoked/expired refresh token (or 7-day Testing-status death).
      throw new AdapterError(
        ErrorCode.AUTH_EXPIRED,
        "OAuth token exchange rejected — refresh token expired or revoked; re-run login",
        { status: response.status },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new AdapterError(ErrorCode.INVALID_ARGS, `OAuth token endpoint error (${response.status})`, {
        status: response.status,
      });
    }
    return parseJson(response, "oauth token exchange");
  }
}
