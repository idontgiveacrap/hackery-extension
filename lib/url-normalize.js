/**
 * Canonicalize runtime tab/page URLs for matching, origin memory, and badges.
 * Does not rewrite links.json templates.
 */
const TRACKING_EXACT = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "si",
]);

export function isNoiseQueryKey(key) {
  const lower = String(key).toLowerCase();
  if (TRACKING_EXACT.has(lower)) {
    return true;
  }
  if (lower.startsWith("utm_")) {
    return true;
  }
  return false;
}

/**
 * @param {string} href
 * @param {{ stripHash?: boolean }} [options]
 * @returns {string} Canonical href, or the original string if unparseable.
 */
export function canonicalizeHref(href, options = {}) {
  if (!href || typeof href !== "string") {
    return href || "";
  }

  let url;
  try {
    url = new URL(href);
  } catch {
    return href;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return href;
  }

  url.hostname = url.hostname.toLowerCase();
  if (
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443")
  ) {
    url.port = "";
  }

  const kept = [];
  url.searchParams.forEach((value, key) => {
    if (!isNoiseQueryKey(key)) {
      kept.push([key, value]);
    }
  });
  kept.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  url.search = "";
  for (const [key, value] of kept) {
    url.searchParams.append(key, value);
  }

  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  }

  if (options.stripHash) {
    url.hash = "";
  }

  return url.href;
}

/** Canonical form for equality / duplicate-style matching (hash ignored). */
export function canonicalizeForMatch(href) {
  return canonicalizeHref(href, { stripHash: true });
}

export function originsEqual(a, b) {
  if (!a || !b) {
    return false;
  }
  try {
    return new URL(a).origin.toLowerCase() === new URL(b).origin.toLowerCase();
  } catch {
    return a === b;
  }
}
