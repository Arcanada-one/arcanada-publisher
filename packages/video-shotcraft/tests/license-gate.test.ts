// License-ack gate (D-REQ-08 / F6): fail-closed without the marker, passes with
// the env var and with the committed marker file.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertLicenseAck, LICENSE_ACK_ENV, LICENSE_ACK_FILE } from "../src/license-gate.js";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";

describe("assertLicenseAck", () => {
  const saved = process.env[LICENSE_ACK_ENV];
  beforeEach(() => {
    delete process.env[LICENSE_ACK_ENV];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[LICENSE_ACK_ENV];
    else process.env[LICENSE_ACK_ENV] = saved;
  });

  it("refuses (MISSING_INPUT) when neither env nor marker file is present", () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "sc-lic-"));
    try {
      assertLicenseAck(emptyRoot);
      expect.fail("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).code).toBe(ErrorCode.MISSING_INPUT);
      expect((err as AdapterError).message).toContain("D-REQ-08");
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it("passes via the env var and records its disposition", () => {
    process.env[LICENSE_ACK_ENV] = "individual-small-team-free";
    const ack = assertLicenseAck("/nonexistent");
    expect(ack.source).toBe("env");
    expect(ack.disposition).toBe("individual-small-team-free");
  });

  it("passes via a committed marker file", () => {
    const root = mkdtempSync(join(tmpdir(), "sc-lic-"));
    writeFileSync(join(root, LICENSE_ACK_FILE), "individual-small-team-free\n");
    try {
      const ack = assertLicenseAck(root);
      expect(ack.source).toBe("file");
      expect(ack.disposition).toContain("individual-small-team-free");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes via the package's own committed marker (default root)", () => {
    const ack = assertLicenseAck();
    expect(ack.disposition).toContain("individual-small-team-free");
  });
});
