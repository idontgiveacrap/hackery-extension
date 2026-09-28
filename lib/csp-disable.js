/**
 * Strip CSP headers and meta tags. Used when a disable-CSP network rule
 * clears the composed policy, and for rewriting meta to match a new policy.
 */

const CSP_HEADER_NAMES = [
  "content-security-policy",
  "content-security-policy-report-only",
  "x-content-security-policy",
  "x-content-security-policy-report-only",
  "x-webkit-csp",
  "x-frame-options",
];

const ISOLATION_HEADER_NAMES = [
  "cross-origin-resource-policy",
  "cross-origin-embedder-policy",
  "cross-origin-opener-policy",
];

const REMOVED_HEADER_NAMES = [...CSP_HEADER_NAMES, ...ISOLATION_HEADER_NAMES];
const REMOVED_HEADER_LOOKUP = new Set(REMOVED_HEADER_NAMES);

const META_CSP_PATTERN =
  /<meta\b[^>]*?http-equiv\s*=\s*["']?content-security-policy(?:-report-only)?["']?[^>]*>/gi;

export function stripCspHeaders(responseHeaders) {
  if (!responseHeaders?.length) {
    return null;
  }
  const filtered = responseHeaders.filter(
    (header) => !REMOVED_HEADER_LOOKUP.has(String(header.name || "").toLowerCase())
  );
  if (filtered.length === responseHeaders.length) {
    return null;
  }
  return filtered;
}

/**
 * Remove meta-tag CSP from an HTML document.
 * @param {string} html
 * @param {string} [url]
 * @returns {string | null}
 */
export function stripMetaCspTags(html, url = "") {
  if (!html || !/content-security-policy/i.test(html)) {
    return null;
  }
  const removed = html.match(META_CSP_PATTERN);
  if (!removed) {
    return null;
  }
  void url;
  return html.replace(META_CSP_PATTERN, "");
}

export { ISOLATION_HEADER_NAMES };
