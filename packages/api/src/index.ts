// arcanada-publisher HTTP API (Phase 6). Loopback-only by design: the bind host
// is contract-guarded by core's `assertLoopback`, so the server refuses to
// listen on any non-loopback address unless the operator explicitly overrides
// the bind (Tier-1 default per the network-exposure baseline).
//
// Built on Node's stdlib `http` — no inbound framework dependency, no surface
// beyond the loopback interface.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { assertLoopback, isLoopback } from "@arcanada/publisher-core";

export interface ApiServerOptions {
  /** Bind host. Defaults to loopback; a non-loopback bind is rejected. */
  bind?: string;
  port?: number;
}

const DEFAULT_BIND = "127.0.0.1";
const DEFAULT_PORT = 8787;

/**
 * Build the loopback API server. The bind host is validated eagerly via
 * `assertLoopback` so a misconfiguration throws at construction, not at first
 * request. Returns the un-listening `http.Server`; call `.listen()` to start.
 */
export function createApiServer(options: ApiServerOptions = {}): Server {
  const bind = options.bind ?? DEFAULT_BIND;
  // Fail-closed: refuse any non-loopback bind (Tier-1 default).
  assertLoopback(bind);
  return createServer(handle);
}

/** Start the loopback server; resolves once it is listening (with the bound port). */
export function listen(options: ApiServerOptions = {}): Promise<{ server: Server; port: number }> {
  const bind = options.bind ?? DEFAULT_BIND;
  assertLoopback(bind);
  const port = options.port ?? DEFAULT_PORT;
  const server = createServer(handle);
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

function handle(req: IncomingMessage, res: ServerResponse): void {
  // Defense-in-depth: reject any request whose Host header is not loopback,
  // guarding against DNS-rebinding even though the socket is loopback-bound.
  const host = (req.headers.host ?? "").split(":")[0];
  if (host && !isLoopback(host)) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "non-loopback host rejected" }));
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
}

export { assertLoopback, isLoopback } from "@arcanada/publisher-core";
