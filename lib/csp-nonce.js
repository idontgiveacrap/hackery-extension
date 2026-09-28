/**
 * CSP nonce helpers: punch a nonce into a policy string, remember per-frame
 * nonce/reason, rewrite meta tags after DNR strip + listener compose.
 *
 * Do not set CSP in place from webRequest — Firefox MV3 merges policies.
 */

const ENFORCING_CSP_HEADERS = new Set([
  "content-security-policy",
  "x-content-security-policy",
  "x-webkit-csp",
]);

const SCRIPT_DIRECTIVES = ["script-src-elem", "script-src", "default-src"];

const META_CSP_TAG =
  /<meta\b[^>]*?http-equiv\s*=\s*["']?content-security-policy(?!-report-only)["']?[^>]*>/gi;

/** @type {Map<string, string>} */
const nonceByFrame = new Map();

/**
 * Why the last document in a frame was or was not punched. Read by the inject
 * probe: without it, a missing nonce is indistinguishable from a page that
 * simply sends no CSP.
 * @type {Map<string, string>}
 */
const punchReasonByFrame = new Map();

/**
 * What policy the last response in a frame carried, recorded for every document
 * whether or not it was rewritten. Frame targeting spans origins, so "can this
 * frame take an injection" is a per-frame question the strip cannot answer.
 * @type {Map<string, object>}
 */
const framePolicyByFrame = new Map();

let nonceCleanupRegistered = false;

function frameKey(tabId, frameId) {
  return `${tabId}:${frameId ?? 0}`;
}

/**
 * @returns {string}
 */
export function createCspNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const byte of bytes) {
    bin += String.fromCharCode(byte);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * Whether this source list can take a nonce without killing 'unsafe-inline'.
 * @param {string} sourceList
 */
export function canPunchScriptSources(sourceList) {
  const lower = String(sourceList || "").toLowerCase();
  const hasNonceOrHash =
    /'nonce-[^']+'/.test(lower) || /'sha(256|384|512)-[^']+'/.test(lower);
  const hasUnsafeInline = /'unsafe-inline'/.test(lower);
  if (hasUnsafeInline && !hasNonceOrHash) {
    return false;
  }
  return true;
}

/**
 * Add 'nonce-…' to script-src-elem, else script-src, else default-src.
 * @param {string} policy
 * @param {string} nonce
 * @returns {{ value: string | null, reason: string }} `value` is null when the
 *   policy must be left alone; `reason` names the case for the inject probe.
 */
export function punchCspPolicy(policy, nonce) {
  if (!policy || !nonce) {
    return { value: null, reason: "no-policy" };
  }
  const token = `'nonce-${nonce}'`;
  const parts = String(policy)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  let targetIndex = -1;
  for (const name of SCRIPT_DIRECTIVES) {
    const index = parts.findIndex((part) => {
      const lower = part.toLowerCase();
      return lower === name || lower.startsWith(`${name} `);
    });
    if (index >= 0) {
      targetIndex = index;
      break;
    }
  }
  if (targetIndex < 0) {
    return { value: null, reason: "no-script-directive" };
  }

  const directive = parts[targetIndex];
  const space = directive.indexOf(" ");
  const name = space < 0 ? directive : directive.slice(0, space);
  const sources = space < 0 ? "" : directive.slice(space + 1);
  if (!canPunchScriptSources(sources)) {
    return { value: null, reason: "unsafe-inline-without-nonce" };
  }
  if (sources.includes(token)) {
    return { value: policy, reason: "already-punched" };
  }
  const nextSources = sources ? `${sources} ${token}` : token;
  parts[targetIndex] = `${name} ${nextSources}`;
  return { value: parts.join("; "), reason: `punched ${name}` };
}

/**
 * Rewrite enforcing CSP headers in place. Stores the nonce when at least one
 * header changes.
 * @param {Array<{ name?: string, value?: string }> | undefined} responseHeaders
 * @param {number} tabId
 * @param {number} [frameId]
 * @returns {{ headers: typeof responseHeaders, nonce: string, changed: boolean, reason: string }}
 */
export function punchCspResponseHeaders(responseHeaders, tabId, frameId = 0) {
  if (!responseHeaders?.length || tabId < 0) {
    return {
      headers: responseHeaders,
      nonce: "",
      changed: false,
      reason: "no-headers",
    };
  }
  const nonce = createCspNonce();
  let changed = false;
  let seenCspHeader = false;
  const reasons = [];
  const headers = responseHeaders.map((header) => {
    const name = String(header.name || "").toLowerCase();
    if (!ENFORCING_CSP_HEADERS.has(name)) {
      return header;
    }
    seenCspHeader = true;
    const { value, reason } = punchCspPolicy(header.value || "", nonce);
    reasons.push(reason);
    if (value == null || value === header.value) {
      return header;
    }
    changed = true;
    return { ...header, value };
  });
  const reason = seenCspHeader ? reasons.join(" | ") : "no-csp-header";
  rememberCspPunchReason(tabId, frameId, reason);
  if (changed) {
    rememberCspNonce(tabId, frameId, nonce);
    return { headers, nonce, changed: true, reason };
  }
  forgetCspNonce(tabId, frameId);
  return { headers: responseHeaders, nonce: "", changed: false, reason };
}

/**
 * Replace enforcing meta CSP tag contents with a composed policy string.
 * @param {string} html
 * @param {string} policy
 * @returns {string | null}
 */
export function rewriteMetaCspTags(html, policy) {
  if (!html || !policy || !/content-security-policy/i.test(html)) {
    return null;
  }
  let changed = false;
  const next = html.replace(META_CSP_TAG, (tag) => {
    const contentMatch = /\bcontent\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
    if (!contentMatch) {
      return tag;
    }
    const quoted = contentMatch[1];
    const quote = quoted.startsWith("'") ? "'" : '"';
    const replacement = `content=${quote}${policy}${quote}`;
    changed = true;
    return (
      tag.slice(0, contentMatch.index) +
      replacement +
      tag.slice(contentMatch.index + contentMatch[0].length)
    );
  });
  return changed ? next : null;
}

/**
 * Punch a nonce into enforcing meta CSP tags (not report-only).
 *
 * Reports why nothing changed: a document with no header policy and no meta
 * policy needs no nonce, while a meta policy that refuses one is a dead end
 * worth naming.
 * @param {string} html
 * @param {string} nonce
 * @returns {{ html: string | null, reason: string }} html is null when unchanged.
 */
export function punchMetaCspTags(html, nonce) {
  if (!html || !nonce || !/content-security-policy/i.test(html)) {
    return { html: null, reason: "no-meta-csp" };
  }
  let changed = false;
  let reason = "no-meta-csp";
  const next = html.replace(META_CSP_TAG, (tag) => {
    const contentMatch = /\bcontent\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
    if (!contentMatch) {
      return tag;
    }
    const quoted = contentMatch[1];
    const policy = contentMatch[2] ?? contentMatch[3] ?? "";
    const punched = punchCspPolicy(policy, nonce);
    if (punched.value == null || punched.value === policy) {
      reason = `meta-${punched.reason}`;
      return tag;
    }
    changed = true;
    reason = "meta-nonce-punched";
    const quote = quoted.startsWith("'") ? "'" : '"';
    const replacement = `content=${quote}${punched.value}${quote}`;
    return (
      tag.slice(0, contentMatch.index) +
      replacement +
      tag.slice(contentMatch.index + contentMatch[0].length)
    );
  });
  return { html: changed ? next : null, reason };
}

/**
 * @param {number} tabId
 * @param {number} [frameId]
 */
export function getCspNonce(tabId, frameId = 0) {
  return nonceByFrame.get(frameKey(tabId, frameId)) || "";
}

/**
 * @param {number} tabId
 * @param {number} frameId
 * @param {string} nonce
 */
export function rememberCspNonce(tabId, frameId, nonce) {
  nonceByFrame.set(frameKey(tabId, frameId), nonce);
}

/**
 * @param {number} tabId
 * @param {number} frameId
 * @param {string} reason
 */
export function rememberCspPunchReason(tabId, frameId, reason) {
  punchReasonByFrame.set(frameKey(tabId, frameId), reason);
}

/**
 * Last punch outcome for a frame. "not-seen" means no document response passed
 * through onHeadersReceived since the background script last started, so the
 * page predates the current listeners and needs a hard reload.
 * @param {number} tabId
 * @param {number} [frameId]
 * @returns {string}
 */
export function getCspPunchReason(tabId, frameId = 0) {
  return punchReasonByFrame.get(frameKey(tabId, frameId)) || "not-seen";
}

/**
 * Record the policy seen on a frame's document, keyed tab+frame.
 * @param {number} tabId
 * @param {number} frameId
 * @param {{ url: string, origin: string, type: string, sitePolicy: string,
 *   policy: string, meta: string }} info
 */
export function rememberCspFramePolicy(tabId, frameId, info) {
  framePolicyByFrame.set(frameKey(tabId, frameId), info);
}

/**
 * @param {number} tabId
 * @param {number} [frameId]
 * @returns {object|null}
 */
export function getCspFramePolicy(tabId, frameId = 0) {
  return framePolicyByFrame.get(frameKey(tabId, frameId)) || null;
}

/**
 * @param {number} tabId
 * @param {number} [frameId]
 */
export function forgetCspNonce(tabId, frameId) {
  if (frameId == null) {
    const prefix = `${tabId}:`;
    for (const key of [...nonceByFrame.keys()]) {
      if (key.startsWith(prefix)) {
        nonceByFrame.delete(key);
        punchReasonByFrame.delete(key);
        framePolicyByFrame.delete(key);
      }
    }
    return;
  }
  nonceByFrame.delete(frameKey(tabId, frameId));
  framePolicyByFrame.delete(frameKey(tabId, frameId));
}

/**
 * Whether this realm owns the per-frame nonce maps. Only the background calls
 * initCspNonce, and only the background's webRequest listener fills the maps —
 * an extension page importing this module gets its own empty copies, so it has
 * to ask the background instead of reading them.
 * @returns {boolean}
 */
export function ownsCspNonceState() {
  return nonceCleanupRegistered;
}

export function initCspNonce() {
  if (nonceCleanupRegistered || typeof browser === "undefined") {
    return;
  }
  nonceCleanupRegistered = true;
  browser.webNavigation.onBeforeNavigate.addListener((details) => {
    if (details.tabId < 0) {
      return;
    }
    forgetCspNonce(details.tabId, details.frameId);
    rememberCspPunchReason(details.tabId, details.frameId, "pending-navigation");
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    forgetCspNonce(tabId);
  });
}
