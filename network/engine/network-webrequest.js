import { stripMetaCspTags } from "../../lib/csp-disable.js";
import {
  cacheCspPolicy,
  getCachedCspPolicy,
  hasCachedCspPolicy,
  isCspNonceTab,
} from "../../lib/csp-compose.js";
import {
  applyCspTouchingRules,
  isCspHeaderName,
  isCspTouchingRule,
  isDocumentResourceType,
  originFromUrl,
  policyHasNonceOrHash,
  ruleDisablesCsp,
  shouldRewriteCsp,
  shouldSeedOriginal,
} from "../../lib/csp-compose-core.js";
import {
  createCspNonce,
  getCspPunchReason,
  initCspNonce,
  punchCspPolicy,
  punchMetaCspTags,
  rememberCspFramePolicy,
  rememberCspNonce,
  rememberCspPunchReason,
  rewriteMetaCspTags,
} from "../../lib/csp-nonce.js";
import {
  applyModifyReplacementsToContext,
  appendNetworkLogQueue,
  compileRulesForMatching,
  getMatchingRules,
  getSortedEnabledRules,
  isTextLikeContentType,
  objectToWebRequestHeaders,
  rewritePrivilegedRequestHeaders,
  rulesForPageHook,
  sanitizeLogEntry,
  webRequestHeadersToObject,
} from "./network-rules-shared.js";
import { NETWORK_RULES_LOG_KEY, NETWORK_SHARED_STATE_KEY } from "../storage-keys.js";

/**
 * An enforcing meta CSP only applies from inside <head>, so the streaming
 * filter stops holding bytes back once the head ends (or the cap is hit on a
 * document with no head close in sight).
 */
const HEAD_END_PATTERN = /<\/head\s*>|<body[\s>]/i;
const HEAD_SCAN_LIMIT = 262144;

let webRequestRules = [];
let webRequestEnabled = false;
let webRequestListenersRegistered = false;
let webRequestPageHookActive = false;
let webRequestSharedState = {};
/** @type {Map<number, string>} */
const networkTabUrls = new Map();

/** @type {((entry: object, tabId?: number) => Promise<void>) | null} */
let appendNetworkRuleLogFn = null;

/**
 * Wire in the shared append-log function owned by network/background.js so
 * webRequest-originated matches land in the same log queue as page-hook matches.
 * @param {{ appendNetworkRuleLog: (entry: object, tabId?: number) => Promise<void> }} deps
 */
export function configureNetworkWebRequest({ appendNetworkRuleLog }) {
  appendNetworkRuleLogFn = appendNetworkRuleLog || null;
}

/**
 * Cache the top-level tab URL for PAGE URL matching in blocking webRequest.
 * @param {number} tabId
 * @param {string} url
 */
export function rememberNetworkTabUrl(tabId, url) {
  if (tabId == null || tabId < 0) {
    return;
  }
  if (!url || !/^https?:/i.test(url)) {
    networkTabUrls.delete(tabId);
    return;
  }
  networkTabUrls.set(tabId, url);
}

/**
 * Drop a cached tab URL when the tab closes.
 * @param {number} tabId
 */
export function forgetNetworkTabUrl(tabId) {
  networkTabUrls.delete(tabId);
}

function persistWebRequestSharedState() {
  if (!Object.keys(webRequestSharedState).length) {
    return;
  }
  browser.storage.local
    .set({ [NETWORK_SHARED_STATE_KEY]: webRequestSharedState })
    .catch(() => {});
}

async function logWebRequestRule(entry, tabId) {
  if (typeof appendNetworkRuleLogFn === "function") {
    await appendNetworkRuleLogFn({ ...entry, via: "webRequest" }, tabId);
    return;
  }
  const sanitized = sanitizeLogEntry({ ...entry, via: "webRequest" });
  if (!sanitized) {
    return;
  }
  const stored = await browser.storage.session.get(NETWORK_RULES_LOG_KEY);
  const entries = appendNetworkLogQueue(stored[NETWORK_RULES_LOG_KEY] || [], sanitized);
  await browser.storage.session.set({ [NETWORK_RULES_LOG_KEY]: entries });
}

function buildWebRequestContext(details, phase) {
  const tabUrl =
    details.tabId >= 0 ? networkTabUrls.get(details.tabId) || "" : "";
  return {
    phase,
    method: details.method || "GET",
    url: details.url,
    // Prefer top-level tab URL for PAGE URL filters.
    pageUrl: tabUrl || details.documentUrl || details.originUrl || "",
    resourceType: details.type || "",
    tabId: details.tabId,
    headers: webRequestHeadersToObject(
      phase === "request" ? details.requestHeaders : details.responseHeaders
    ),
    status: details.statusCode,
  };
}

function isPageHookResourceType(resourceType) {
  return resourceType === "xmlhttprequest";
}

function shouldDeferToPageHook(resourceType) {
  return webRequestPageHookActive && isPageHookResourceType(resourceType);
}

function responseNeedsBodyFilter(rule, resourceType) {
  if (resourceType === "xmlhttprequest") {
    return false;
  }
  const phases = rule.phases?.length ? rule.phases : ["request", "response"];
  if (!phases.includes("response")) {
    return false;
  }
  if (rule.action === "block") {
    return true;
  }
  const mod = rule.modify || {};
  // Scripts are page-hook only today; keep body replacements declarative here.
  return Boolean(mod.bodyReplacements?.length);
}

function processRequestControlRules(rules, ctx) {
  let nextUrl = ctx.url;

  for (const rule of rules) {
    if (rule.action === "block") {
      logWebRequestRule({
        ruleId: rule.id,
        ruleName: rule.name,
        phase: "request",
        method: ctx.method,
        url: ctx.url,
        pageUrl: ctx.pageUrl,
        resourceType: ctx.resourceType,
        outcome: "blocked",
        action: "block",
      }, ctx.tabId);
      return { cancel: true };
    }

    if (rule.action === "redirect" && rule.redirectUrl) {
      nextUrl = rule.redirectUrl;
      logWebRequestRule({
        ruleId: rule.id,
        ruleName: rule.name,
        phase: "request",
        method: ctx.method,
        url: nextUrl,
        pageUrl: ctx.pageUrl,
        resourceType: ctx.resourceType,
        outcome: "redirect",
        action: "redirect",
      }, ctx.tabId);
      continue;
    }

    if (rule.action === "modify" && rule.modify?.urlReplacements?.length) {
      const modified = applyModifyReplacementsToContext(
        { ...ctx, url: nextUrl },
        rule
      );
      if (modified.url && modified.url !== nextUrl) {
        nextUrl = modified.url;
        logWebRequestRule({
          ruleId: rule.id,
          ruleName: rule.name,
          phase: "request",
          method: ctx.method,
          url: nextUrl,
          pageUrl: ctx.pageUrl,
          resourceType: ctx.resourceType,
          outcome: "redirect",
          action: "modify",
        }, ctx.tabId);
      }
    }
  }

  if (nextUrl !== ctx.url) {
    return { redirectUrl: nextUrl };
  }
  return null;
}

function applyHeaderRules(rules, ctx, headerList) {
  let headers = webRequestHeadersToObject(headerList);
  let changed = false;

  for (const rule of rules) {
    if (rule.action !== "modify") {
      continue;
    }
    const mod = rule.modify || {};
    if (mod.headerReplacements?.length || mod.setHeaders?.length) {
      const before = JSON.stringify(headers);
      headers = applyModifyReplacementsToContext(
        { ...ctx, headers: { ...headers } },
        rule
      ).headers;
      // Future (CSP-safe interpreter): apply requestScript via webRequest here.
      if (JSON.stringify(headers) !== before) {
        changed = true;
        logWebRequestRule({
          ruleId: rule.id,
          ruleName: rule.name,
          phase: ctx.phase,
          method: ctx.method,
          url: ctx.url,
          pageUrl: ctx.pageUrl,
          resourceType: ctx.resourceType,
          outcome: "modified",
          action: "modify",
        }, ctx.tabId);
      }
    }
  }

  persistWebRequestSharedState();
  return changed ? objectToWebRequestHeaders(headers) : null;
}

function applyResponseBodyRules(rules, ctx, bodyText) {
  let body = bodyText;
  let status = ctx.status;

  for (const rule of rules) {
    if (rule.action === "block") {
      logWebRequestRule({
        ruleId: rule.id,
        ruleName: rule.name,
        phase: "response",
        method: ctx.method,
        url: ctx.url,
        pageUrl: ctx.pageUrl,
        resourceType: ctx.resourceType,
        outcome: "blocked",
        action: "block",
      }, ctx.tabId);
      return { blocked: true, body: "" };
    }

    if (rule.action !== "modify") {
      continue;
    }

    const before = { body, status };
    const nextCtx = applyModifyReplacementsToContext(
      { ...ctx, body, status },
      rule
    );
    // Future (CSP-safe interpreter): apply responseScript via webRequest here.

    body = nextCtx.body ?? body;
    status = nextCtx.status ?? status;
    if (body !== before.body || status !== before.status) {
      logWebRequestRule({
        ruleId: rule.id,
        ruleName: rule.name,
        phase: "response",
        method: ctx.method,
        url: ctx.url,
        pageUrl: ctx.pageUrl,
        resourceType: ctx.resourceType,
        outcome: "modified",
        action: "modify",
      }, ctx.tabId);
    }
  }

  persistWebRequestSharedState();

  return { blocked: false, body, status };
}

function onBeforeRequest(details) {
  if (!webRequestEnabled || details.tabId < 0) {
    return {};
  }
  if (shouldDeferToPageHook(details.type)) {
    return {};
  }

  const ctx = buildWebRequestContext(details, "request");
  const matching = getMatchingRules(webRequestRules, ctx).filter(
    (rule) =>
      rule.action === "block" ||
      rule.action === "redirect" ||
      (rule.action === "modify" && rule.modify?.urlReplacements?.length)
  );

  const result = processRequestControlRules(matching, ctx);
  return result || {};
}

function onBeforeSendHeaders(details) {
  // Always rewrite page-hook dummy headers, even when rule matching defers to
  // the page hook for fetch/XHR — otherwise Cookie/Origin/Referer never land.
  const rewritten = rewritePrivilegedRequestHeaders(details.requestHeaders);
  let headers = rewritten.headers;
  let changed = rewritten.changed;

  if (!webRequestEnabled || details.tabId < 0) {
    return changed ? { requestHeaders: headers } : {};
  }
  if (shouldDeferToPageHook(details.type)) {
    return changed ? { requestHeaders: headers } : {};
  }

  const ctx = buildWebRequestContext(
    { ...details, requestHeaders: headers },
    "request"
  );
  const matching = getMatchingRules(webRequestRules, ctx).filter(
    (rule) =>
      rule.action === "modify" &&
      (rule.modify?.headerReplacements?.length ||
        rule.modify?.setHeaders?.length)
  );
  const applied = applyHeaderRules(matching, ctx, headers);
  if (applied) {
    return { requestHeaders: applied };
  }
  return changed ? { requestHeaders: headers } : {};
}

/**
 * Whether a response is an HTML document safe to rewrite for meta-CSP stripping.
 * Missing Content-Type counts as HTML: Firefox sniffs those for documents.
 * A declared non-UTF-8 charset disqualifies it — the filter decodes and
 * re-encodes as UTF-8, which would corrupt anything else.
 * @param {object} details webRequest details for the response.
 * @param {Record<string, string>} headers Response headers, original casing.
 */
function isHtmlDocumentResponse(details, headers) {
  if (details.type !== "main_frame" && details.type !== "sub_frame") {
    return false;
  }
  const contentType = String(
    headers?.["Content-Type"] || headers?.["content-type"] || ""
  ).toLowerCase();
  if (contentType && !contentType.includes("html")) {
    return false;
  }
  const charset = /charset\s*=\s*"?([^";]+)/.exec(contentType)?.[1]?.trim();
  return !charset || charset === "utf-8" || charset === "us-ascii";
}

function dropEnforcingCspHeaders(headers) {
  return (headers || []).filter(
    (header) => String(header.name || "").toLowerCase() !== "content-security-policy"
  );
}

function matchingSkippingCspHeaderEdits(rules) {
  return (rules || []).map((rule) => {
    const mod = rule.modify || {};
    return {
      ...rule,
      modify: {
        ...mod,
        setHeaders: (mod.setHeaders || []).filter(
          (header) => !isCspHeaderName(header.name)
        ),
        headerReplacements: (mod.headerReplacements || []).filter(
          (entry) => !entry.name || !isCspHeaderName(entry.name)
        ),
      },
    };
  });
}

/**
 * DNR already removed CSP. Re-add a single composed policy, or leave none.
 * @param {object} details
 * @param {object[]} matching
 * @param {object[]} responseHeaders
 */
function composeDocumentCsp(details, matching, responseHeaders) {
  const nonceToggle = isCspNonceTab(details.tabId);
  const cspRules = matching.filter(isCspTouchingRule);
  const frameId = details.frameId ?? 0;
  const headerPolicy = String(
    (responseHeaders || []).find((header) => isCspHeaderName(header.name))
      ?.value || ""
  ).trim();
  if (
    !shouldRewriteCsp({
      nonceToggle,
      networkArmed: webRequestEnabled,
      matchingCspRules: cspRules,
      resourceType: details.type,
      borrowableNonce: policyHasNonceOrHash(headerPolicy),
    })
  ) {
    return { headers: responseHeaders, meta: null };
  }

  const seedOriginal = shouldSeedOriginal(nonceToggle, cspRules);
  // A policy still on the response beats any cached read: DNR has not stripped
  // this one, and a cookie-gated app can answer the background seed fetch
  // without the policy it sends to a signed-in navigation.
  if (headerPolicy) {
    cacheCspPolicy(details.url, headerPolicy);
  }
  if (
    seedOriginal &&
    !headerPolicy &&
    !hasCachedCspPolicy(details.url) &&
    !cspRules.length
  ) {
    rememberCspPunchReason(details.tabId, frameId, "cache-miss");
    // Fail-open, and worth saying out loud: DNR stripped this document and we
    // never observed its policy, so it ends up with no CSP at all. Happens when
    // a frame origin first appears after the tab's strip rule was installed.
    console.warn(
      `CSP cache miss ${details.url} (frame ${frameId}): stripped with no policy restored`
    );
    return {
      headers: dropEnforcingCspHeaders(responseHeaders),
      meta: { mode: "strip" },
    };
  }

  const seed = seedOriginal
    ? headerPolicy || getCachedCspPolicy(details.url)
    : "";
  const { policy, disabled } = applyCspTouchingRules(
    seed,
    cspRules,
    applyModifyReplacementsToContext
  );
  if (disabled || cspRules.some(ruleDisablesCsp)) {
    rememberCspPunchReason(details.tabId, frameId, "csp-rule-disable");
    return {
      headers: dropEnforcingCspHeaders(responseHeaders),
      meta: { mode: "strip" },
    };
  }

  let finalPolicy = policy;
  if (!finalPolicy && !nonceToggle) {
    rememberCspPunchReason(details.tabId, frameId, "empty-composed-csp");
    return {
      headers: dropEnforcingCspHeaders(responseHeaders),
      meta: { mode: "strip" },
    };
  }
  if (!finalPolicy && nonceToggle) {
    // No header policy to seed from, but a meta policy can still be enforcing
    // and is the only CSP on plenty of app shells. Mint a nonce and punch the
    // tag; with no policy anywhere the nonce attribute is simply ignored.
    const metaNonce = createCspNonce();
    rememberCspNonce(details.tabId, frameId, metaNonce);
    rememberCspPunchReason(details.tabId, frameId, "no-csp-header-meta-nonce");
    return {
      headers: dropEnforcingCspHeaders(responseHeaders),
      meta: { mode: "punch", nonce: metaNonce },
    };
  }

  const nonce = createCspNonce();
  const punched = punchCspPolicy(finalPolicy, nonce);
  if (punched.value) {
    finalPolicy = punched.value;
    rememberCspNonce(details.tabId, frameId, nonce);
    rememberCspPunchReason(details.tabId, frameId, punched.reason);
  } else {
    rememberCspPunchReason(details.tabId, frameId, punched.reason);
  }

  return {
    headers: [
      ...dropEnforcingCspHeaders(responseHeaders),
      { name: "Content-Security-Policy", value: finalPolicy },
    ],
    meta: { mode: "rewrite", policy: finalPolicy },
  };
}

/**
 * One filterResponseData per request, shared by text body rules and meta-CSP
 * edits.
 *
 * Body rules need the whole response, so that path buffers. Meta-CSP alone
 * streams: an enforcing meta policy only counts inside <head>, so the filter
 * holds back the head, rewrites it, and passes the rest through. Buffering
 * whole documents here stalled first paint on every navigation.
 *
 * @param {object} details
 * @param {object[]} bodyRules
 * @param {object} ctx
 * @param {{ mode: "strip" } | { mode: "punch", nonce: string }
 *   | { mode: "rewrite", policy: string } | null} metaCsp
 */
function filterResponseBody(details, bodyRules, ctx, metaCsp) {
  try {
    const filter = browser.webRequest.filterResponseData(details.requestId);
    // Streaming decode: partial multi-byte sequences are held back rather than
    // turning into U+FFFD at a chunk boundary.
    const decoder = new TextDecoder("utf-8");
    const encoder = new TextEncoder();
    const chunks = [];

    function editMetaCsp(text) {
      if (metaCsp?.mode === "strip") {
        return stripMetaCspTags(text, details.url) ?? text;
      }
      if (metaCsp?.mode === "punch") {
        const punched = punchMetaCspTags(text, metaCsp.nonce);
        const reason =
          punched.html || punched.reason !== "no-meta-csp"
            ? punched.reason
            : "no-csp-anywhere";
        rememberCspPunchReason(details.tabId, details.frameId ?? 0, reason);
        // The header-stage line is logged before the body streams, so the meta
        // outcome needs its own line to be visible without opening Inspect.
        if (details.type === "main_frame") {
          console.info(`CSP meta ${details.url}: ${reason}`);
        }
        return punched.html ?? text;
      }
      if (metaCsp?.mode === "rewrite") {
        return (
          rewriteMetaCspTags(text, metaCsp.policy) ??
          stripMetaCspTags(text, details.url) ??
          text
        );
      }
      return text;
    }

    if (!bodyRules.length) {
      let headText = "";
      let headFlushed = false;

      const flushHead = () => {
        headFlushed = true;
        const edited = editMetaCsp(headText);
        headText = "";
        if (edited) {
          filter.write(encoder.encode(edited));
        }
      };

      filter.ondata = (event) => {
        const text = decoder.decode(event.data, { stream: true });
        if (headFlushed) {
          if (text) {
            filter.write(encoder.encode(text));
          }
          return;
        }
        headText += text;
        if (
          HEAD_END_PATTERN.test(headText) ||
          headText.length >= HEAD_SCAN_LIMIT
        ) {
          flushHead();
        }
      };

      filter.onstop = () => {
        try {
          const tail = decoder.decode();
          if (headFlushed) {
            if (tail) {
              filter.write(encoder.encode(tail));
            }
          } else {
            headText += tail;
            flushHead();
          }
        } catch {
          if (!headFlushed && headText) {
            filter.write(encoder.encode(headText));
          }
        }
        filter.close();
      };

      filter.onerror = () => {
        filter.disconnect();
      };
      return;
    }

    filter.ondata = (event) => {
      chunks.push(event.data);
    };

    filter.onstop = () => {
      try {
        const totalLength = chunks.reduce(
          (sum, chunk) => sum + chunk.byteLength,
          0
        );
        const merged = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(new Uint8Array(chunk), offset);
          offset += chunk.byteLength;
        }

        const bodyText = editMetaCsp(decoder.decode(merged));
        const result = applyResponseBodyRules(bodyRules, ctx, bodyText);
        filter.write(
          encoder.encode(result.blocked ? "" : result.body ?? bodyText)
        );
      } catch {
        for (const chunk of chunks) {
          filter.write(chunk);
        }
      }
      filter.close();
    };

    filter.onerror = () => {
      filter.disconnect();
    };
  } catch {
    // filterResponseData unavailable for this request
  }
}

function onHeadersReceived(details) {
  let responseHeaders = details.responseHeaders;
  if (details.tabId < 0) {
    // Not a seed source: an extension or service-worker fetch carries different
    // Sec-Fetch-* and credentials than the navigation, so its policy can differ
    // from the one the document actually gets.
    return {};
  }

  const headerObject = webRequestHeadersToObject(responseHeaders);
  const htmlDocument = isHtmlDocumentResponse(details, headerObject);

  const rulesApply =
    webRequestEnabled &&
    details.tabId >= 0 &&
    !shouldDeferToPageHook(details.type);

  let matching = [];
  let ctx = null;
  if (rulesApply) {
    ctx = buildWebRequestContext(
      { ...details, responseHeaders },
      "response"
    );
    matching = getMatchingRules(webRequestRules, ctx);
    const headerRules = matchingSkippingCspHeaderEdits(
      matching.filter(
        (rule) =>
          rule.action === "modify" &&
          (rule.modify?.headerReplacements?.length || rule.modify?.setHeaders?.length)
      )
    );
    const networkHeaderChange = applyHeaderRules(
      headerRules,
      ctx,
      responseHeaders
    );
    if (networkHeaderChange) {
      responseHeaders = networkHeaderChange;
    }
  }

  const sitePolicy = String(
    (details.responseHeaders || []).find((header) => isCspHeaderName(header.name))
      ?.value || ""
  );
  // Seed the cache from ordinary browsing, whether or not the toggle is on.
  // Documents only: XHR/image CSP (often `default-src 'none'`) must not become
  // the origin seed, and punching those responses merged a second policy under
  // MV3. The alternative — a second background request per origin — doubled
  // every navigation and still read the wrong policy on cookie-gated apps.
  // Once the tab's strip rule is installed there is nothing left to observe, so
  // the seed has to come from a load that happened before it.
  if (isDocumentResourceType(details.type)) {
    cacheCspPolicy(details.url, sitePolicy);
  }

  const composed = composeDocumentCsp(details, matching, responseHeaders);
  responseHeaders = composed.headers;
  const metaCsp = htmlDocument ? composed.meta : null;

  // Recorded for every document, composed or not: a scriptlet's frame targets
  // are chosen by depth and URL, so the answer to "will this frame take an
  // injection" is per frame and per origin, not per tab.
  if (details.type === "main_frame" || details.type === "sub_frame") {
    rememberCspFramePolicy(details.tabId, details.frameId ?? 0, {
      url: details.url,
      origin: originFromUrl(details.url),
      type: details.type,
      sitePolicy,
      policy: String(
        responseHeaders.find((header) => isCspHeaderName(header.name))?.value || ""
      ),
      meta: composed.meta?.mode || "none",
    });
  }

  if (details.type === "main_frame" && isCspNonceTab(details.tabId)) {
    const added = responseHeaders.find((header) => isCspHeaderName(header.name));
    console.info(
      `CSP compose ${details.url}: reason=${getCspPunchReason(details.tabId, details.frameId ?? 0)}` +
        ` meta=${composed.meta?.mode || "none"} header=${added ? added.value : "none"}`
    );
  }

  if (!rulesApply) {
    if (metaCsp) {
      filterResponseBody(details, [], null, metaCsp);
    }
    return responseHeaders !== details.responseHeaders
      ? { responseHeaders }
      : {};
  }

  const bodyRules = matching.filter((rule) =>
    responseNeedsBodyFilter(rule, ctx.resourceType)
  );
  const bodyRulesNeedFilter =
    bodyRules.length > 0 &&
    (bodyRules.some((rule) => rule.action === "block") ||
      isTextLikeContentType(ctx.headers));

  if (bodyRulesNeedFilter || metaCsp) {
    filterResponseBody(
      details,
      bodyRulesNeedFilter ? bodyRules : [],
      ctx,
      metaCsp
    );
  }

  return responseHeaders !== details.responseHeaders
    ? { responseHeaders }
    : {};
}

/**
 * Firefox only wakes an event page for listeners added synchronously during the
 * background script's first run, so this runs at module load rather than from
 * syncNetworkWebRequest. Registering late meant CSP stripping and rule matching
 * silently stopped once the background suspended. The handlers read the
 * webRequest* module state, which stays empty until the first sync — safe,
 * because empty state simply means no rules match.
 */
function registerWebRequestListeners() {
  if (webRequestListenersRegistered) {
    return;
  }

  const urls = ["<all_urls>"];
  browser.webRequest.onBeforeRequest.addListener(onBeforeRequest, { urls }, [
    "blocking",
  ]);
  browser.webRequest.onBeforeSendHeaders.addListener(
    onBeforeSendHeaders,
    { urls },
    ["blocking", "requestHeaders"]
  );
  browser.webRequest.onHeadersReceived.addListener(
    onHeadersReceived,
    { urls },
    ["blocking", "responseHeaders"]
  );
  webRequestListenersRegistered = true;
  initCspNonce();
}

export function syncNetworkWebRequest(state, hooksEnabled = true, sharedState = {}) {
  webRequestSharedState =
    sharedState && typeof sharedState === "object" ? sharedState : {};
  webRequestEnabled = Boolean(hooksEnabled && state?.enabled);
  webRequestRules = compileRulesForMatching(getSortedEnabledRules(state?.rules || []));
  webRequestPageHookActive =
    webRequestEnabled && rulesForPageHook(state?.rules || []).length > 0;
  if (!hooksEnabled) {
    webRequestEnabled = false;
    webRequestPageHookActive = false;
  }
}

registerWebRequestListeners();
