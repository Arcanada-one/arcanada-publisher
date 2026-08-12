// Remotion licensing acknowledgement gate (D-REQ-08 / DESIGN §3, F6).
//
// D-REQ-08 was resolved by the operator (plan round 1): implementation proceeds
// under Remotion's INDIVIDUAL / SMALL-TEAM FREE terms — NOT a paid commercial
// license. This gate is fail-closed: renderCinematic refuses to render unless the
// disposition is acknowledged, either via the PUBLISHER_SHOTCRAFT_LICENSE_ACK
// environment variable or the committed LICENSE-REMOTION.ack marker file. The
// marker records the free-tier / individual-small-team disposition; it is a
// boolean acknowledgement, not a credential (S3 — no secrets in code/logs).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";
import { packageRoot } from "./paths.js";

export const LICENSE_ACK_ENV = "PUBLISHER_SHOTCRAFT_LICENSE_ACK";
export const LICENSE_ACK_FILE = "LICENSE-REMOTION.ack";

export interface LicenseAck {
  /** Where the acknowledgement came from. */
  source: "env" | "file";
  /** The recorded disposition string (e.g. "individual-small-team-free"). */
  disposition: string;
}

/**
 * Assert that the Remotion licensing disposition has been acknowledged.
 * Returns the acknowledgement on success; throws AdapterError(MISSING_INPUT)
 * when neither the env var nor the marker file is present.
 *
 * @param root package root override (tests); defaults to the resolved package root.
 */
export function assertLicenseAck(root?: string): LicenseAck {
  const env = process.env[LICENSE_ACK_ENV];
  if (env !== undefined && env.trim() !== "") {
    return { source: "env", disposition: env.trim() };
  }

  const base = root ?? packageRoot();
  const ackPath = join(base, LICENSE_ACK_FILE);
  if (existsSync(ackPath)) {
    const disposition = readFileSync(ackPath, "utf8").trim();
    return { source: "file", disposition: disposition || "acknowledged" };
  }

  throw new AdapterError(
    ErrorCode.MISSING_INPUT,
    `shotcraft: Remotion licensing not acknowledged — see D-REQ-08. Set ${LICENSE_ACK_ENV} ` +
      `(recording the individual/small-team free-tier disposition) or add a ${LICENSE_ACK_FILE} ` +
      `marker file to the package root.`,
  );
}
