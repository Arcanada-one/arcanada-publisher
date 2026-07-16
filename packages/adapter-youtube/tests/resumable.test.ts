// PUB-0035 resumable matrix (plan Phase 4.1, V-AC-4): non-boundary 308 resume,
// 5xx backoff, 401 mid-upload token refresh into the SAME session, 404 expiry.

import { describe, expect, it } from "vitest";
import { probeSession, startSession, uploadFromOffset, type ByteSource } from "../src/resumable-upload.js";
import type { TransportRequest, TransportResponse } from "../src/transport.js";
import { SESSION_URI, json, makeTransport, type Responder } from "./helpers.js";

const BYTES = new Uint8Array([10, 11, 12, 13, 14, 15, 16, 17]); // 8 bytes
const source: ByteSource = { size: BYTES.length, slice: (o) => BYTES.subarray(o) };

function deps(responders: Responder[], tokens: string[] = ["ya29.one"]) {
  const recorder = makeTransport(responders);
  let tokenIndex = 0;
  const issued: string[] = [];
  return {
    recorder,
    issued,
    deps: {
      transport: recorder.transport,
      getAccessToken: () => {
        const token = tokens[Math.min(tokenIndex, tokens.length - 1)] ?? "ya29.one";
        tokenIndex += 1;
        issued.push(token);
        return Promise.resolve(token);
      },
      sleep: () => Promise.resolve(),
    },
  };
}

describe("startSession", () => {
  it("returns the Location session URI and sends length/type preflight headers", async () => {
    const { recorder, deps: d } = deps([
      (req) =>
        req.method === "POST" && req.url.includes("uploadType=resumable")
          ? json(200, {}, { location: SESSION_URI })
          : undefined,
    ]);
    const uri = await startSession(d, { snippet: {} }, BYTES.length, "video/mp4");
    expect(uri).toBe(SESSION_URI);
    const start = recorder.requests[0];
    expect(start?.headers?.["x-upload-content-length"]).toBe("8");
    expect(start?.headers?.["x-upload-content-type"]).toBe("video/mp4");
  });
});

describe("uploadFromOffset", () => {
  it("happy path: single PUT completes with the videoId", async () => {
    const { deps: d } = deps([
      (req) => (req.method === "PUT" ? json(200, { id: "vidX" }) : undefined),
    ]);
    await expect(uploadFromOffset(d, SESSION_URI, source, 0)).resolves.toBe("vidX");
  });

  it("resumes from a NON-boundary server-reported offset after a 503", async () => {
    const puts: TransportRequest[] = [];
    const { deps: d } = deps([
      (req, index): TransportResponse | undefined => {
        if (req.method !== "PUT") return undefined;
        puts.push(req);
        if (req.headers?.["content-range"] === "bytes */8") {
          return { status: 308, headers: { range: "bytes=0-2" }, text: "" }; // 3 bytes landed — not a boundary
        }
        if (index === 0) return json(503, {});
        return json(201, { id: "vidY" });
      },
    ]);
    await expect(uploadFromOffset(d, SESSION_URI, source, 0)).resolves.toBe("vidY");
    const resumed = puts.at(-1);
    expect(resumed?.headers?.["content-range"]).toBe("bytes 3-7/8");
    expect(resumed?.body).toEqual(BYTES.subarray(3)); // continuation is byte-exact from the server offset
  });

  it("401 mid-upload refreshes the token and resumes the SAME session", async () => {
    const { recorder, deps: d, issued } = deps(
      [
        (req): TransportResponse | undefined => {
          if (req.method !== "PUT") return undefined;
          if (req.headers?.["content-range"] === "bytes */8") {
            return { status: 308, headers: { range: "bytes=0-3" }, text: "" };
          }
          return req.headers?.authorization === "Bearer ya29.two"
            ? json(200, { id: "vidZ" })
            : json(401, {});
        },
      ],
      ["ya29.one", "ya29.two"],
    );
    await expect(uploadFromOffset(d, SESSION_URI, source, 0)).resolves.toBe("vidZ");
    expect(issued).toContain("ya29.two"); // refresh happened
    expect(recorder.requests.every((r) => r.url === SESSION_URI)).toBe(true); // same session throughout
  });

  it("expired session at retry probe fails with an explicit error", async () => {
    const { deps: d } = deps([
      (req): TransportResponse | undefined => {
        if (req.method !== "PUT") return undefined;
        if (req.headers?.["content-range"] === "bytes */8") return json(404, {});
        return json(503, {});
      },
    ]);
    await expect(uploadFromOffset(d, SESSION_URI, source, 0)).rejects.toThrow(/expired/);
  });
});

describe("probeSession", () => {
  it("maps 308/200/404 to incomplete/done/expired", async () => {
    const { deps: d1 } = deps([
      () => ({ status: 308, headers: { range: "bytes=0-4" }, text: "" }),
    ]);
    expect(await probeSession(d1, SESSION_URI, 8)).toEqual({ kind: "incomplete", receivedBytes: 5 });
    const { deps: d2 } = deps([() => json(200, { id: "vidP" })]);
    expect(await probeSession(d2, SESSION_URI, 8)).toEqual({ kind: "done", videoId: "vidP" });
    const { deps: d3 } = deps([() => json(404, {})]);
    expect(await probeSession(d3, SESSION_URI, 8)).toEqual({ kind: "expired" });
  });
});
