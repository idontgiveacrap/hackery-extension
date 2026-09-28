/**
 * Per-tab CSP nonce toggle and DNR strip for compose/replace.
 * Isolation headers are not stripped here — only enforcing CSP.
 *
 * Scope is the tab, not the origin: scriptlet frame targeting selects frames by
 * depth and URL across origins, so a policy gate keyed to the top origin left
 * every third-party frame uncovered while the checkbox read "on". DNR has no
 * frameId, so the tab is the narrowest unit that can cover a frame tree.
 */
import { MessageTypes } from "./message-types.js";
import {
  originFromUrl,
  isCspTouchingRule,
  wildcardToDnrUrlFilter,
  cspTouchingRuleIsDnrRepresentable,
  DOCUMENT_RESOURCE_TYPES,
  policyHasNonceOrHash,
  policyNeedsDnrStrip,
} from "./csp-compose-core.js";

const { CSP_NONCE_CHANGED } = MessageTypes;

const CSP_NONCE_TABS_KEY = "cspNonceTabs";
const ENFORCING_CSP_HEADER = "content-security-policy";

const DNR_RESOURCE_TYPES = DOCUMENT_RESOURCE_TYPES;
const DNR_NONCE_ID_BASE = 2000001;
const DNR_RULE_ID_BASE = 3000001;
const POLICY_URL_CACHE_MAX = 200;

/** @type {Set<number>} */
const nonceTabs = new Set();
/** @type {Map<string, string>} */
const policyByUrl = new Map();
/** @type {Map<string, string>} */
const policyByOrigin = new Map();
/** @type {number[]} */
let installedDnrIds = [];
let lastDnrSignature = "";
/** @type {object} */
let lastNetworkStateForDnr = { enabled: true, rules: [] };
let lastNetworkArmedForDnr = false;
let composeHydrated = false;
/** @type {Promise<void> | null} */
let composeHydration = null;

/**
 * @returns {Promise<void> | null}
 */
export function whenCspComposeReady() {
  if (composeHydrated) {
    return null;
  }
  if (!composeHydration) {
    // storage.session, not local: tab ids are meaningless after a restart, but
    // the set has to survive the event page suspending while tabs stay open.
    composeHydration = browser.storage.session
      .get(CSP_NONCE_TABS_KEY)
      .then((stored) => {
        for (const tabId of stored[CSP_NONCE_TABS_KEY] || []) {
          if (Number.isInteger(tabId) && tabId >= 0) {
            nonceTabs.add(tabId);
          }
        }
      })
      .catch(() => {})
      .then(() => {
        composeHydrated = true;
      });
  }
  return composeHydration;
}

function persistNonceTabs() {
  browser.storage.session
    .set({ [CSP_NONCE_TABS_KEY]: [...nonceTabs] })
    .catch(() => {});
}

/**
 * @param {number} tabId
 */
export function isCspNonceTab(tabId) {
  return Number.isInteger(tabId) && tabId >= 0 && nonceTabs.has(tabId);
}

export const getCspNonceForTab = isCspNonceTab;

/**
 * @returns {number[]}
 */
export function getCspNonceTabs() {
  return [...nonceTabs];
}

/**
 * @param {string} url
 * @returns {string}
 */
export function getCachedCspPolicy(url) {
  if (policyByUrl.has(url)) {
    return policyByUrl.get(url) || "";
  }
  const origin = originFromUrl(url);
  if (origin && policyByOrigin.has(origin)) {
    return policyByOrigin.get(origin) || "";
  }
  return "";
}

/**
 * @param {string} url
 */
export function hasCachedCspPolicy(url) {
  return policyByUrl.has(url) || policyByOrigin.has(originFromUrl(url));
}

/**
 * Record an observed policy.
 *
 * An empty value is never cached. A stripped response, or one answered without
 * the caller's cookies, must not overwrite a policy already seen — and absence
 * of an entry is what makes a cache miss visible instead of quietly composing
 * from an empty seed and shipping a document with no policy at all.
 * @param {string} url
 * @param {string} policy
 */
export function cacheCspPolicy(url, policy) {
  const value = policy == null ? "" : String(policy).trim();
  if (!url || !value) {
    return;
  }
  policyByUrl.set(url, value);
  // Per-URL entries are unbounded otherwise: query-unique document URLs would
  // grow this map for the life of the event page.
  while (policyByUrl.size > POLICY_URL_CACHE_MAX) {
    const oldest = policyByUrl.keys().next().value;
    policyByUrl.delete(oldest);
  }
  const origin = originFromUrl(url);
  if (origin) {
    // A nonce/hash is per-document. Putting it on the origin map would replay
    // yesterday's token onto the next URL at this origin (Office, logged-in
    // GitHub) and block the page's own scripts.
    if (policyHasNonceOrHash(value)) {
      policyByOrigin.delete(origin);
    } else {
      policyByOrigin.set(origin, value);
    }
  }
  scheduleStripDomainSync();
}

/**
 * @param {number} tabId
 * @param {boolean} enabled
 */
export async function setCspNonceForTab(tabId, enabled) {
  await whenCspComposeReady();
  if (!Number.isInteger(tabId) || tabId < 0) {
    return;
  }
  if (enabled) {
    nonceTabs.add(tabId);
  } else {
    nonceTabs.delete(tabId);
  }
  persistNonceTabs();
  await syncCspDnrRules();
  browser.runtime
    .sendMessage({
      type: CSP_NONCE_CHANGED,
      tabId,
      enabled: nonceTabs.has(tabId),
    })
    .catch(() => {});
}

/**
 * @param {object} [state]
 * @param {boolean} [networkArmed]
 */
export function cspTouchingRulesFromState(state, networkArmed) {
  if (!networkArmed || !state?.enabled) {
    return [];
  }
  return (state.rules || []).filter((rule) => isCspTouchingRule(rule));
}

function dnrRemoveCspRule(id, extraCondition = {}) {
  return {
    id,
    priority: 50,
    action: {
      type: "modifyHeaders",
      responseHeaders: [{ header: ENFORCING_CSP_HEADER, operation: "remove" }],
    },
    condition: {
      resourceTypes: DNR_RESOURCE_TYPES,
      excludedTabIds: [-1],
      ...extraCondition,
    },
  };
}

function hostnameFromUrl(url) {
  try {
    return new URL(String(url || "")).hostname;
  } catch {
    return "";
  }
}

/**
 * Hosts whose last observed document CSP cannot take a borrowed nonce, so DNR
 * must strip before the listener re-adds + punches. Hosts with a live nonce
 * (Office, Slack, logged-in GitHub) stay off this list — tab-wide strip was
 * replacing their per-document token with a cached one and blocking the page.
 * Unknown hosts are also left alone: a first visit can fill the cache, then a
 * reload strips if needed.
 */
function domainsNeedingStrip() {
  const domains = new Set();
  for (const [url, policy] of policyByUrl) {
    if (!policyNeedsDnrStrip(policy)) {
      continue;
    }
    const host = hostnameFromUrl(url);
    if (host) {
      domains.add(host);
    }
  }
  for (const [origin, policy] of policyByOrigin) {
    if (!policyNeedsDnrStrip(policy)) {
      continue;
    }
    const host = hostnameFromUrl(origin);
    if (host) {
      domains.add(host);
    }
  }
  return [...domains].sort();
}

let stripDomainSyncTimer = null;
let lastStripDomainSig = "";

function scheduleStripDomainSync() {
  const signature = domainsNeedingStrip().join(",");
  if (signature === lastStripDomainSig) {
    return;
  }
  lastStripDomainSig = signature;
  clearTimeout(stripDomainSyncTimer);
  stripDomainSyncTimer = setTimeout(() => {
    void syncCspDnrRules();
  }, 0);
}

/**
 * One session rule per nonce tab, limited to hosts that need a punch. `tabIds`
 * is session-rule-only. Listing the tab also excludes tabId -1.
 */
function nonceTabToDnr(tabId, index, requestDomains) {
  const extra = { tabIds: [tabId] };
  if (requestDomains.length) {
    extra.requestDomains = requestDomains;
  }
  return dnrRemoveCspRule(DNR_NONCE_ID_BASE + index, extra);
}

function cspNetworkRuleToDnr(rule, index) {
  if (!cspTouchingRuleIsDnrRepresentable(rule)) {
    return null;
  }
  const page = String(rule.pageUrlPattern || "").trim();
  const request = String(rule.requestUrlPattern || "").trim();
  const pageFilter = wildcardToDnrUrlFilter(page, false);
  const requestFilter = wildcardToDnrUrlFilter(request, false);
  const urlFilter = requestFilter || pageFilter || "";
  const extra = {};
  if (urlFilter) {
    extra.urlFilter = urlFilter;
  }
  return dnrRemoveCspRule(DNR_RULE_ID_BASE + index, extra);
}

/**
 * Rebuild session DNR CSP-remove rules from nonce tabs + armed CSP rules.
 * @param {object} [networkState]
 * @param {boolean} [networkArmed]
 */
export async function syncCspDnrRules(networkState, networkArmed) {
  await whenCspComposeReady();
  if (networkState !== undefined) {
    lastNetworkStateForDnr = networkState;
  }
  if (networkArmed !== undefined) {
    lastNetworkArmedForDnr = Boolean(networkArmed);
  }
  const next = [];
  const tabs = [...nonceTabs];
  const requestDomains = domainsNeedingStrip();
  lastStripDomainSig = requestDomains.join(",");
  // No known punch-hosts yet: do not strip the whole tab. Office-class pages
  // would lose their live nonce; GitHub-class pages still get stripped once
  // their policy has been observed (toggle-off load, or first unstripped load).
  if (requestDomains.length) {
    tabs.forEach((tabId, index) => {
      next.push(nonceTabToDnr(tabId, index, requestDomains));
    });
  }
  if (lastNetworkArmedForDnr) {
    cspTouchingRulesFromState(lastNetworkStateForDnr, true).forEach((rule, index) => {
      const dnr = cspNetworkRuleToDnr(rule, index);
      if (dnr) {
        next.push(dnr);
      }
    });
  }
  const removeRuleIds = [...new Set([...installedDnrIds, ...next.map((rule) => rule.id)])];
  try {
    await browser.declarativeNetRequest.updateSessionRules({
      removeRuleIds,
      addRules: next,
    });
    installedDnrIds = next.map((rule) => rule.id);
    // Every rules refresh re-syncs, so log only when the set actually changes.
    // A nonce toggle that appears to do nothing is usually a strip rule that
    // never installed, which is what this line is for.
    const signature = JSON.stringify(next);
    if (tabs.length && signature !== lastDnrSignature) {
      console.info(
        `CSP strip rules installed: ${installedDnrIds.length} (nonce tabs: ${tabs.join(", ")})`
      );
    }
    lastDnrSignature = signature;
  } catch (error) {
    // updateSessionRules is all-or-nothing: one condition Firefox rejects would
    // otherwise drop every CSP strip, which reads as "the toggle does nothing".
    console.error("CSP DNR batch failed, retrying per rule:", error);
    installedDnrIds = [];
    await browser.declarativeNetRequest
      .updateSessionRules({ removeRuleIds })
      .catch(() => {});
    for (const rule of next) {
      try {
        await browser.declarativeNetRequest.updateSessionRules({
          addRules: [rule],
        });
        installedDnrIds.push(rule.id);
      } catch (ruleError) {
        console.error("CSP DNR rule rejected:", rule, ruleError);
      }
    }
  }
}

/**
 * Installed CSP-strip rules, for diagnosing a toggle that appears to do nothing.
 * @returns {Promise<object[]>}
 */
export async function getInstalledCspDnrRules() {
  try {
    const rules = await browser.declarativeNetRequest.getSessionRules();
    return (rules || []).filter((rule) => installedDnrIds.includes(rule.id));
  } catch {
    return [];
  }
}

export function initCspCompose() {
  void whenCspComposeReady().then(() => syncCspDnrRules());
  // A closed tab's id gets reused, so a stale entry would silently strip CSP in
  // whatever tab inherits the id.
  browser.tabs.onRemoved.addListener((tabId) => {
    if (nonceTabs.delete(tabId)) {
      persistNonceTabs();
      void syncCspDnrRules();
    }
  });
}
