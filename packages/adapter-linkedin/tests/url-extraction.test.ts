import { describe, it, expect } from "vitest";
import { AdapterError } from "@arcanada/publisher-core";
import {
  ACTIVITY_URN_RE,
  extractActivityUrn,
  extractActivityId,
  pickFirstActivityHref,
} from "../src/url-extraction.js";
import { LinkedInAdapter } from "../src/index.js";

describe("INFRA-0260 — Activity URN extraction closure", () => {
  it("LinkedInAdapter exports and platform=linkedin", () => {
    const adapter = new LinkedInAdapter();
    expect(adapter.platform).toBe("linkedin");
  });

  it("extractActivityUrn accepts canonical activity URL (www host)", () => {
    const raw = "https://www.linkedin.com/feed/update/urn:li:activity:7462962260978642944/";
    const out = extractActivityUrn(raw);
    expect(out).toBe(raw);
  });

  it("extractActivityUrn accepts host without www subdomain", () => {
    const raw = "https://linkedin.com/feed/update/urn:li:activity:7462962260978642944/";
    expect(extractActivityUrn(raw)).toBe(raw);
  });

  it("extractActivityUrn accepts URL without trailing slash", () => {
    const raw = "https://www.linkedin.com/feed/update/urn:li:activity:7462962260978642944";
    expect(extractActivityUrn(raw)).toBe(raw);
  });

  it("extractActivityUrn strips wrapping double quotes (defence-in-depth)", () => {
    const wrapped = '"https://www.linkedin.com/feed/update/urn:li:activity:7462962260978642944/"';
    const out = extractActivityUrn(wrapped);
    expect(out).not.toContain('"');
    expect(ACTIVITY_URN_RE.test(out)).toBe(true);
  });

  it("INFRA-0260: REJECTS recommended-card /company/.../posts/ URLs", () => {
    expect(() =>
      extractActivityUrn("https://www.linkedin.com/company/lazy-programmer/posts/"),
    ).toThrow(AdapterError);
  });

  it("INFRA-0260: REJECTS /in/<slug>/recent-activity/all/ feed root", () => {
    expect(() =>
      extractActivityUrn("https://www.linkedin.com/in/pavel/recent-activity/all/"),
    ).toThrow(AdapterError);
  });

  it("REJECTS foreign host", () => {
    expect(() =>
      extractActivityUrn("https://evil.example.com/feed/update/urn:li:activity:123/"),
    ).toThrow(AdapterError);
  });

  it("REJECTS empty string and undefined-like input", () => {
    expect(() => extractActivityUrn("")).toThrow(AdapterError);
    expect(() => extractActivityUrn(null as unknown as string)).toThrow(AdapterError);
  });

  it("REJECTS unparseable URL", () => {
    expect(() => extractActivityUrn("not a url")).toThrow(AdapterError);
  });

  it("extractActivityId returns numeric id segment", () => {
    expect(
      extractActivityId(
        "https://www.linkedin.com/feed/update/urn:li:activity:7462962260978642944/",
      ),
    ).toBe("7462962260978642944");
  });

  it("extractActivityId throws on non-activity URL", () => {
    expect(() => extractActivityId("https://www.linkedin.com/company/foo/posts/")).toThrow(
      AdapterError,
    );
  });

  it("pickFirstActivityHref skips adversarial recommended-card mixed list", () => {
    const candidates = [
      "https://www.linkedin.com/company/lazy-programmer/posts/",
      "https://www.linkedin.com/in/pavel/recent-activity/all/",
      "https://www.linkedin.com/feed/update/urn:li:activity:7462962260978642944/",
      "https://www.linkedin.com/jobs/view/123/",
    ];
    const picked = pickFirstActivityHref(candidates);
    expect(picked).toBe(
      "https://www.linkedin.com/feed/update/urn:li:activity:7462962260978642944/",
    );
  });

  it("pickFirstActivityHref returns undefined when no activity URL present", () => {
    const candidates = [
      "https://www.linkedin.com/company/foo/posts/",
      "https://www.linkedin.com/jobs/view/123/",
    ];
    expect(pickFirstActivityHref(candidates)).toBeUndefined();
  });

  it("pickFirstActivityHref returns undefined on empty list", () => {
    expect(pickFirstActivityHref([])).toBeUndefined();
  });

  it("ACTIVITY_URN_RE captures numeric id group exactly", () => {
    const m = ACTIVITY_URN_RE.exec(
      "https://www.linkedin.com/feed/update/urn:li:activity:1234567890/",
    );
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe("1234567890");
  });
});
