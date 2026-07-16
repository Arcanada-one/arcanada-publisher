import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAudit, AUDIT_REF_RE } from "../src/audit.js";

describe("appendAudit", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "audit-test-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("writes one JSONL record and returns an auditRef in PUB-audit-<date>-<hex8> form", async () => {
    const ref = await appendAudit(
      {
        platform: "x",
        account: "@paxbeach",
        action: "publish",
        postUrl: "https://x.com/paxbeach/status/123",
      },
      { baseDir, now: new Date("2026-06-01T10:30:00.000Z") },
    );
    expect(ref).toMatch(AUDIT_REF_RE);
    expect(ref).toMatch(/^PUB-audit-20260601-[0-9a-f]{8}$/);

    const file = join(baseDir, "2026-06-01.jsonl");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(rec).toMatchObject({
      platform: "x",
      account: "@paxbeach",
      action: "publish",
      postUrl: "https://x.com/paxbeach/status/123",
      auditRef: ref,
    });
    expect(typeof rec.ts).toBe("string");
  });

  it("appends a second record to the same daily file without truncating the first", async () => {
    const opts = { baseDir, now: new Date("2026-06-01T10:30:00.000Z") };
    await appendAudit({ platform: "x", account: "@a", action: "publish" }, opts);
    await appendAudit({ platform: "facebook", account: "fb-acct", action: "comment" }, opts);
    const lines = readFileSync(join(baseDir, "2026-06-01.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("creates the audit directory with mode 0o700 and the file with 0o600", async () => {
    await appendAudit(
      { platform: "x", account: "@a", action: "publish" },
      { baseDir, now: new Date("2026-06-01T10:30:00.000Z") },
    );
    // Skip the permission assertion on platforms that do not honour POSIX modes.
    if (process.platform === "win32") return;
    const dirMode = statSync(baseDir).mode & 0o777;
    const fileMode = statSync(join(baseDir, "2026-06-01.jsonl")).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });

  it("never persists cookies, tokens, or credentials even if passed in", async () => {
    await appendAudit(
      {
        platform: "x",
        account: "@a",
        action: "publish",
        // @ts-expect-error — these keys are not part of the AuditInput type; the
        // writer must drop anything outside the allowlisted fields.
        cookie: "session=secret",
        token: "Bearer abc123",
        password: "hunter2",
      },
      { baseDir, now: new Date("2026-06-01T10:30:00.000Z") },
    );
    const raw = readFileSync(join(baseDir, "2026-06-01.jsonl"), "utf8");
    expect(raw).not.toContain("secret");
    expect(raw).not.toContain("abc123");
    expect(raw).not.toContain("hunter2");
    expect(raw.toLowerCase()).not.toContain("cookie");
    expect(raw.toLowerCase()).not.toContain("password");
  });

  it("returns null and writes nothing when the base directory is unwritable (fail-soft)", async () => {
    // Force a filesystem error: point baseDir at an existing regular file so the
    // recursive mkdir under it fails (ENOTDIR / EEXIST).
    const { writeFileSync } = await import("node:fs");
    const fileAsDir = join(baseDir, "iam-a-file");
    writeFileSync(fileAsDir, "x");
    const ref = await appendAudit(
      { platform: "x", account: "@a", action: "publish" },
      { baseDir: fileAsDir, now: new Date("2026-06-01T10:30:00.000Z") },
    );
    expect(ref).toBeNull();
    // The pre-existing file is untouched; no directory was created at its path.
    expect(statSync(fileAsDir).isFile()).toBe(true);
  });

  it("includes an optional callerToken when provided", async () => {
    await appendAudit(
      { platform: "x", account: "@a", action: "publish", callerToken: "agent-claude-01" },
      { baseDir, now: new Date("2026-06-01T10:30:00.000Z") },
    );
    const files = readdirSync(baseDir);
    const rec = JSON.parse(readFileSync(join(baseDir, files[0]), "utf8").trim()) as Record<
      string,
      unknown
    >;
    expect(rec.callerToken).toBe("agent-claude-01");
  });

  it("persists the allowlisted mutation phase and operation id", async () => {
    await appendAudit(
      {
        platform: "youtube",
        account: "UCfixture",
        action: "playlist-insert",
        phase: "intent",
        operationId: "youtube-playlist-insert-fixture",
      },
      { baseDir, now: new Date("2026-07-16T19:30:00.000Z") },
    );
    const rec = JSON.parse(
      readFileSync(join(baseDir, "2026-07-16.jsonl"), "utf8").trim(),
    ) as Record<string, unknown>;
    expect(rec).toMatchObject({
      action: "playlist-insert",
      phase: "intent",
      operationId: "youtube-playlist-insert-fixture",
    });
  });
});
