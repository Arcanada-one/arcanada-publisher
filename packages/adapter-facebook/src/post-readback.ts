import type { Page } from "playwright";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";

export interface FacebookPostReadback {
  canonicalPermalink: string;
  authorProfileIdentity: string;
  normalizedBody: string;
  hasImage: boolean;
  mediaIdentity: string;
}

export function normalizeFacebookText(value: string): string {
  return value.normalize("NFKC").replace(/\r\n/g, "\n").trim();
}

export function canonicalFacebookPostUrl(raw: string): string {
  const url = new URL(raw);
  if (!/^((www|m)\.)?facebook\.com$/i.test(url.hostname)) throw readbackError("invalid host");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 3 || parts[1] !== "posts") throw readbackError("invalid post permalink");
  return `https://www.facebook.com/${parts[0]}/posts/${parts[2]}`;
}

export function facebookProfileIdentity(raw: string): string {
  const url = new URL(raw, "https://www.facebook.com");
  if (!/^((www|m)\.)?facebook\.com$/i.test(url.hostname))
    throw readbackError("invalid author host");
  if (url.pathname === "/profile.php") {
    const id = url.searchParams.get("id");
    if (!id) throw readbackError("missing stable author id");
    return `www.facebook.com/profile.php?id=${id}`;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 1) throw readbackError("unstable author profile");
  return `www.facebook.com/${parts[0]!.toLowerCase()}`;
}

export async function readFacebookPost(
  page: Page,
  targetUrl: string,
): Promise<FacebookPostReadback> {
  const target = canonicalFacebookPostUrl(targetUrl);
  await page.goto(target);
  const expanders = page.getByRole("button", {
    name: /^(See more|Показать ещё|Ещё|Näytä lisää)$/i,
  });
  for (let i = 0, count = await expanders.count().catch(() => 0); i < count; i += 1) {
    await expanders
      .nth(i)
      .click()
      .catch(() => undefined);
  }
  const raw = await page.locator("body").evaluate((root, expected) => {
    type DomElement = {
      innerText: string;
      href?: string;
      closest(selector: string): DomElement | null;
      querySelector(selector: string): DomElement | null;
      querySelectorAll(selector: string): ArrayLike<DomElement> & Iterable<DomElement>;
      compareDocumentPosition(other: DomElement): number;
    };
    const bodyRoot = root as unknown as DomElement;
    const browserLocation = (globalThis as unknown as { location: { href: string } }).location;
    const canonical = (href: string): string | null => {
      try {
        const url = new URL(href, browserLocation.href);
        const parts = url.pathname.split("/").filter(Boolean);
        return parts.length >= 3 && parts[1] === "posts"
          ? `https://www.facebook.com/${parts[0]}/posts/${parts[2]}`
          : null;
      } catch {
        return null;
      }
    };
    const matches = Array.from(bodyRoot.querySelectorAll('[role="article"]')).flatMap((article) => {
      const anchors = Array.from(article.querySelectorAll("a[href]"));
      const permalink = anchors.find(
        (anchor) => anchor.href && canonical(anchor.href) === expected,
      );
      if (!permalink) return [];
      const body = article.querySelector(
        '[data-ad-preview="message"], [data-ad-comet-preview="message"]',
      );
      if (!body || body.closest('[role="article"]') !== article) return [];
      const author = anchors.find((anchor) => {
        if (anchor.closest('[role="article"]') !== article) return false;
        if ((anchor.compareDocumentPosition(body) & 4) === 0) return false;
        try {
          if (!anchor.href) return false;
          const url = new URL(anchor.href, browserLocation.href);
          const parts = url.pathname.split("/").filter(Boolean);
          return url.pathname === "/profile.php" ? url.searchParams.has("id") : parts.length === 1;
        } catch {
          return false;
        }
      });
      if (!author) return [];
      const mediaAnchor = anchors.find((anchor) => {
        if (anchor.closest('[role="article"]') !== article || !anchor.href) return false;
        if (Array.from(anchor.querySelectorAll("img")).length === 0) return false;
        try {
          const url = new URL(anchor.href, browserLocation.href);
          return url.pathname.includes("/photo") || url.pathname === "/photo.php";
        } catch {
          return false;
        }
      });
      if (!mediaAnchor?.href) return [];
      const mediaUrl = new URL(mediaAnchor.href, browserLocation.href);
      mediaUrl.searchParams.delete("__cft__[0]");
      mediaUrl.searchParams.delete("__tn__");
      return [
        {
          canonicalPermalink: expected,
          authorProfileHref: author.href!,
          body: body.innerText,
          hasImage: true,
          mediaIdentity: mediaUrl.toString(),
        },
      ];
    });
    return matches;
  }, target);
  const candidates = raw.map((match) => ({
    canonicalPermalink: match.canonicalPermalink,
    authorProfileIdentity: facebookProfileIdentity(match.authorProfileHref),
    normalizedBody: normalizeFacebookText(match.body),
    hasImage: match.hasImage,
    mediaIdentity: match.mediaIdentity,
  }));
  return dedupeFacebookPostReadbacks(candidates);
}

export function dedupeFacebookPostReadbacks(
  candidates: FacebookPostReadback[],
): FacebookPostReadback {
  if (candidates.length === 0) throw readbackError("expected one target article, found 0");
  const ordered = [...candidates].sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
  const first = ordered[0]!;
  const identical = ordered.every(
    (candidate) =>
      candidate.canonicalPermalink === first.canonicalPermalink &&
      candidate.normalizedBody === first.normalizedBody &&
      candidate.authorProfileIdentity === first.authorProfileIdentity &&
      candidate.hasImage === first.hasImage &&
      candidate.mediaIdentity === first.mediaIdentity,
  );
  if (!identical) throw readbackError(`ambiguous target evidence across ${ordered.length} copies`);
  return first;
}

function readbackError(message: string): AdapterError {
  return new AdapterError(ErrorCode.VERIFY_FAILED, `facebook post readback: ${message}`);
}
