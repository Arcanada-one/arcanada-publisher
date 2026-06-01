// arcanada-publisher HTTP API (Phase 6). Loopback-only by design: the bind host
// is contract-guarded by core's `assertLoopback`, so the server refuses to
// listen on any non-loopback address unless the operator explicitly overrides
// the bind (Tier-1 default per the network-exposure baseline).
//
// Built on Node's stdlib `http` — no inbound framework dependency, no surface
// beyond the loopback interface. Each POST route runs the agent-callable
// gauntlet defined in routes.ts (tool-scoping → rate-limit → adapter → audit).

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import {
  type Adapter,
  type Platform,
  AdapterError,
  ErrorCode,
  PLATFORMS,
  RateLimiter,
  assertLoopback,
  isLoopback,
} from "@arcanada/publisher-core";
import { dispatchPost, isPostRoute, statusForCode, type RouteDeps } from "./routes.js";
import { defaultMakeAdapter } from "./default-adapter.js";
import { VERSION } from "./version.js";

export interface ApiServerOptions {
  /** Bind host. Defaults to loopback; a non-loopback bind is rejected. */
  bind?: string;
  port?: number;
  /** Adapter factory. Defaults to the live browser/API adapters. */
  makeAdapter?: (platform: Platform) => Adapter;
  /** Audit root override (tests inject a temp dir; prod uses ~/.arcanada-publisher). */
  auditBaseDir?: string;
  /** Shared rate limiter. Defaults to a fresh per-process limiter. */
  rateLimiter?: RateLimiter;
}

const DEFAULT_BIND = "127.0.0.1";
const DEFAULT_PORT = 8787;

/** Build the route dependencies from server options, filling in live defaults. */
function resolveDeps(options: ApiServerOptions): RouteDeps {
  return {
    makeAdapter: options.makeAdapter ?? defaultMakeAdapter,
    rateLimiter: options.rateLimiter ?? new RateLimiter(),
    ...(options.auditBaseDir ? { auditBaseDir: options.auditBaseDir } : {}),
  };
}

/** Read the full request body as a UTF-8 string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Write a JSON response with the given status. */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

/** Map a thrown value to the `{ ok:false, error }` envelope at its HTTP status. */
function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof AdapterError) {
    sendJson(res, statusForCode(err.code), {
      ok: false,
      error: { code: err.code, message: err.message },
    });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  sendJson(res, 500, { ok: false, error: { code: ErrorCode.INTERNAL_PANIC, message } });
}

/** Handle a POST route: parse JSON, dispatch, wrap the result envelope. */
async function handlePost(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: RouteDeps,
): Promise<void> {
  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    sendJson(res, 400, {
      ok: false,
      error: { code: ErrorCode.INVALID_ARGS, message: "malformed JSON body" },
    });
    return;
  }
  try {
    const data = await dispatchPost(path, body, deps);
    sendJson(res, 200, { ok: true, data });
  } catch (err) {
    sendError(res, err);
  }
}

/** Build the request handler bound to the resolved dependencies. */
function makeHandler(deps: RouteDeps) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    // Defense-in-depth: reject any request whose Host header is not loopback,
    // guarding against DNS-rebinding even though the socket is loopback-bound.
    const host = (req.headers.host ?? "").split(":")[0];
    if (host && !isLoopback(host)) {
      sendJson(res, 403, {
        ok: false,
        error: { code: ErrorCode.NETWORK_GUARD, message: "non-loopback host rejected" },
      });
      return;
    }
    const url = req.url ?? "/";
    if (req.method === "GET" && url === "/health") {
      sendJson(res, 200, { ok: true, version: VERSION, platforms: [...PLATFORMS] });
      return;
    }
    if (req.method === "POST" && isPostRoute(url)) {
      void handlePost(req, res, url, deps);
      return;
    }
    sendJson(res, 404, {
      ok: false,
      error: { code: ErrorCode.INVALID_ARGS, message: "not found" },
    });
  };
}

/**
 * Build the loopback API server. The bind host is validated eagerly via
 * `assertLoopback` so a misconfiguration throws at construction, not at first
 * request. Returns the un-listening `http.Server`; call `.listen()` to start.
 */
export function createApiServer(options: ApiServerOptions = {}): Server {
  assertLoopback(options.bind ?? DEFAULT_BIND);
  return createServer(makeHandler(resolveDeps(options)));
}

/** Start the loopback server; resolves once it is listening (with the bound port). */
export async function listen(
  options: ApiServerOptions = {},
): Promise<{ server: Server; port: number }> {
  const bind = options.bind ?? DEFAULT_BIND;
  assertLoopback(bind);
  const port = options.port ?? DEFAULT_PORT;
  const server = createServer(makeHandler(resolveDeps(options)));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bind, () => {
      // port 0 → OS-assigned; read the real bound port from the address.
      const addr = server.address();
      const boundPort = addr && typeof addr === "object" ? addr.port : port;
      resolve({ server, port: boundPort });
    });
  });
}

export { assertLoopback, isLoopback } from "@arcanada/publisher-core";
