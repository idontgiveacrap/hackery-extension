/**
 * Network-rules background orchestration.
 * Host wires this via network/plugin.js.
 */
import { patchTabFlags, clearTabFlags, getTabFlags } from "../lib/action-badge.js";
import { installNetworkHook } from "./engine/network-hook-install.js";
import {
  appendNetworkLogQueue,
  buildNetworkHookMatches,
  compileRulesForMatching,
  defaultNetworkRulesState,
  getNetworkHookVersion,
  LEGACY_NETWORK_CONTENT_SCRIPT_IDS,
  NETWORK_EARLY_HOOK_SCRIPT_ID,
  NETWORK_LOG_BRIDGE_SCRIPT_ID,
  NETWORK_MAIN_HOOK_SCRIPT_ID,
  normalizeNetworkRulesState,
  rulesForPageHook,
} from "./engine/network-rules-shared.js";
import { configureNetworkWebRequest, syncNetworkWebRequest, rememberNetworkTabUrl, forgetNetworkTabUrl } from "./engine/network-webrequest.js";
import { createNetworkMessageHandlers } from "./messages.js";
import { MessageTypes } from "../lib/message-types.js";
import { initCspCompose, syncCspDnrRules } from "../lib/csp-compose.js";
import {
  NETWORK_ARM_EXPIRES_AT_KEY,
  NETWORK_ARM_MINUTES,
  NETWORK_HOOKS_ENABLED_KEY,
  NETWORK_RULES_KEY,
  NETWORK_RULES_LOG_KEY,
  NETWORK_SHARED_STATE_KEY,
  NETWORK_TAB_STATE_KEY,
} from "./storage-keys.js";
import { networkArmTimerActive } from "../lib/csp-compose-core.js";

const TEST_RULE_TIMEOUT_MS = 8000;
const REFRESH_DEBOUNCE_MS = 300;
const NETWORK_ARM_ALARM = "network-rules-expire";

let networkRulesState = defaultNetworkRulesState();
let networkRulesCompiled = [];
let networkHooksEnabled = false;
let networkArmExpiresAt = 0;
let networkHookVersion = "";
let networkLogToken = "";
let networkSharedState = {};
let networkTabState = {};
let networkRefreshTimer = null;
let networkNavigationHookRegistered = false;
/** @type {{ ruleId: string, tabId: number, deadline: number, timerId: ReturnType<typeof setTimeout> } | null} */
let testRuleSession = null;

/** Optional host callback after rules refresh (e.g. refresh action badge). */
let onRulesChanged = null;

configureNetworkWebRequest({ appendNetworkRuleLog });

async function loadNetworkArmExpiresAt() {
  const stored = await browser.storage.session.get(NETWORK_ARM_EXPIRES_AT_KEY);
  networkArmExpiresAt = Number(stored[NETWORK_ARM_EXPIRES_AT_KEY]) || 0;
}

async function persistArmExpiresAt() {
  await browser.storage.session.set({
    [NETWORK_ARM_EXPIRES_AT_KEY]: networkArmExpiresAt,
  });
}

function enabledRuleCount() {
  if (!networkRulesState.enabled) {
    return 0;
  }
  return (networkRulesState.rules || []).filter((rule) => rule.enabled).length;
}

function getArmSnapshot() {
  const count = enabledRuleCount();
  const armed = networkHooksEnabled;
  const waiting = armed && count === 0;
  const timed = networkArmTimerActive(armed, count);
  const expiresAt = timed ? networkArmExpiresAt : 0;
  return {
    armed,
    waiting,
    expiresAt,
    enabledRuleCount: count,
    minutes: NETWORK_ARM_MINUTES,
  };
}

function broadcastArmChanged() {
  browser.runtime
    .sendMessage({
      type: MessageTypes.NETWORK_ARM_CHANGED,
      ...getArmSnapshot(),
    })
    .catch(() => {});
}

async function syncNetworkArmAlarm() {
  await loadNetworkArmExpiresAt();
  if (!networkArmTimerActive(networkHooksEnabled, enabledRuleCount())) {
    networkArmExpiresAt = 0;
    await persistArmExpiresAt();
    await browser.alarms.clear(NETWORK_ARM_ALARM);
    return;
  }
  const now = Date.now();
  if (!networkArmExpiresAt || networkArmExpiresAt <= now) {
    networkArmExpiresAt = now + NETWORK_ARM_MINUTES * 60 * 1000;
    await persistArmExpiresAt();
  }
  await browser.alarms.create(NETWORK_ARM_ALARM, {
    when: networkArmExpiresAt,
  });
}

export async function setNetworkArmed(armed) {
  networkHooksEnabled = Boolean(armed);
  if (!armed) {
    networkArmExpiresAt = 0;
    await persistArmExpiresAt();
    await browser.alarms.clear(NETWORK_ARM_ALARM);
  }
  await browser.storage.local.set({
    [NETWORK_HOOKS_ENABLED_KEY]: networkHooksEnabled,
  });
  await refreshNetworkRulesState();
  if (armed) {
    await syncNetworkArmAlarm();
  }
  broadcastArmChanged();
}

export async function resetNetworkArmTimer() {
  if (!networkArmTimerActive(networkHooksEnabled, enabledRuleCount())) {
    return getArmSnapshot();
  }
  networkArmExpiresAt = Date.now() + NETWORK_ARM_MINUTES * 60 * 1000;
  await persistArmExpiresAt();
  await syncNetworkArmAlarm();
  broadcastArmChanged();
  return getArmSnapshot();
}

export function getNetworkArmSnapshot() {
  return getArmSnapshot();
}

function initNetworkArmAlarm() {
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== NETWORK_ARM_ALARM) {
      return;
    }
    void setNetworkArmed(false);
  });
}

async function loadNetworkHooksEnabled() {
  const stored = await browser.storage.local.get([
    NETWORK_HOOKS_ENABLED_KEY,
    NETWORK_SHARED_STATE_KEY,
  ]);
  networkHooksEnabled = stored[NETWORK_HOOKS_ENABLED_KEY] === true;
  networkSharedState = stored[NETWORK_SHARED_STATE_KEY] || {};
  await loadNetworkArmExpiresAt();
  if (networkHooksEnabled && networkArmExpiresAt && networkArmExpiresAt <= Date.now()) {
    networkHooksEnabled = false;
    networkArmExpiresAt = 0;
    await browser.storage.local.set({ [NETWORK_HOOKS_ENABLED_KEY]: false });
    await persistArmExpiresAt();
  }
  return networkHooksEnabled;
}

async function loadNetworkTabState() {
  const stored = await browser.storage.session.get(NETWORK_TAB_STATE_KEY);
  networkTabState = stored[NETWORK_TAB_STATE_KEY] || {};
  return networkTabState;
}

function getSharedStateBundleForTab(tabId) {
  const tabKey = tabId == null ? "unknown" : String(tabId);
  return {
    persistent: { ...networkSharedState },
    tab: { ...(networkTabState[tabKey] || {}) },
  };
}

async function persistSharedState(persistent, tabStateFromPage, tabId) {
  if (persistent && typeof persistent === "object") {
    networkSharedState = { ...networkSharedState, ...persistent };
    await browser.storage.local.set({
      [NETWORK_SHARED_STATE_KEY]: networkSharedState,
    });
  }
  if (tabId == null) {
    return;
  }
  const tabKey = String(tabId);
  if (tabStateFromPage && typeof tabStateFromPage === "object") {
    networkTabState = {
      ...networkTabState,
      [tabKey]: { ...(networkTabState[tabKey] || {}), ...tabStateFromPage },
    };
    await browser.storage.session.set({
      [NETWORK_TAB_STATE_KEY]: networkTabState,
    });
  }
}

async function loadNetworkRulesState() {
  const stored = await browser.storage.local.get(NETWORK_RULES_KEY);
  const raw = stored[NETWORK_RULES_KEY] || defaultNetworkRulesState();
  networkRulesState = normalizeNetworkRulesState(raw);
  if (!Array.isArray(networkRulesState.rules)) {
    networkRulesState.rules = [];
  }
  if (JSON.stringify(raw) !== JSON.stringify(networkRulesState)) {
    await browser.storage.local.set({ [NETWORK_RULES_KEY]: networkRulesState });
  }
  networkRulesCompiled = compileRulesForMatching(networkRulesState.rules);
  networkHookVersion = getNetworkHookVersion({
    enabled: networkRulesState.enabled,
    rules: rulesForPageHook(networkRulesState.rules),
    sharedState: networkSharedState,
  });
  return networkRulesState;
}

function pageHookRules() {
  if (!networkHooksEnabled || !networkRulesState.enabled) {
    return [];
  }
  return rulesForPageHook(enabledNetworkRules());
}

function getHookVersionForTab(tabId) {
  const rules = pageHookRules();
  const tabKey = tabId == null ? "" : String(tabId);
  return getNetworkHookVersion({
    enabled: networkRulesState.enabled,
    rules,
    sharedState: networkSharedState,
    tabState: networkTabState[tabKey] || {},
  });
}

function enabledNetworkRules() {
  if (!networkRulesState.enabled) {
    return [];
  }
  return networkRulesCompiled.filter((rule) => rule.enabled);
}

/**
 * Accept bridge messages only when they carry the current hook token.
 * @param {string} token Token forwarded from the page-world network hook.
 * @returns {boolean} Whether the token belongs to the active hook installation.
 */
function validateNetworkLogToken(token) {
  return Boolean(networkLogToken) && token === networkLogToken;
}

async function installNetworkHookInTab(tabId, frameId) {
  const rules = pageHookRules();
  if (!rules.length) {
    return;
  }

  const target = { tabId };
  if (frameId != null) {
    target.frameIds = [frameId];
  } else {
    // Re-inject / tab-wide refresh must cover iframes that issue fetch/XHR.
    target.allFrames = true;
  }

  let tabUrl = "";
  try {
    const tab = await browser.tabs.get(tabId);
    tabUrl = tab?.url || "";
  } catch {
    // restricted / closed tab
  }
  rememberNetworkTabUrl(tabId, tabUrl);

  const sharedStateBundle = {
    ...getSharedStateBundleForTab(tabId),
    tabUrl,
  };
  const hookVersion = getHookVersionForTab(tabId);

  // Isolated bridge must exist before MAIN-world logs are accepted.
  await browser.scripting.executeScript({
    target,
    files: ["network/inject/network-log-bridge.js"],
    injectImmediately: true,
  });

  await browser.scripting.executeScript({
    target,
    world: "MAIN",
    injectImmediately: true,
    func: installNetworkHook,
    args: [rules, hookVersion, networkLogToken, sharedStateBundle],
  });
}

async function syncNetworkHookRegistration() {
  const scriptIds = [
    NETWORK_EARLY_HOOK_SCRIPT_ID,
    NETWORK_MAIN_HOOK_SCRIPT_ID,
    NETWORK_LOG_BRIDGE_SCRIPT_ID,
    ...LEGACY_NETWORK_CONTENT_SCRIPT_IDS,
  ];

  for (const id of scriptIds) {
    try {
      await browser.scripting.unregisterContentScripts({ ids: [id] });
    } catch {
      // not registered yet
    }
  }

  const allRules = enabledNetworkRules();
  const rules = pageHookRules();

  if (
    !networkHooksEnabled ||
    !networkRulesState.enabled ||
    !allRules.length ||
    !rules.length
  ) {
    return;
  }

  networkLogToken = crypto.randomUUID();
  const matches = buildNetworkHookMatches();

  await browser.scripting.registerContentScripts([
    {
      id: NETWORK_EARLY_HOOK_SCRIPT_ID,
      matches,
      runAt: "document_start",
      allFrames: true,
      world: "MAIN",
      js: ["network/inject/network-early-hook.js"],
    },
    {
      id: NETWORK_MAIN_HOOK_SCRIPT_ID,
      matches,
      runAt: "document_start",
      allFrames: true,
      js: ["network/inject/network-hook-bootstrap.js"],
    },
    {
      id: NETWORK_LOG_BRIDGE_SCRIPT_ID,
      matches,
      runAt: "document_start",
      allFrames: true,
      js: ["network/inject/network-log-bridge.js"],
    },
  ]);
}

export async function refreshNetworkRulesState() {
  await loadNetworkHooksEnabled();
  await loadNetworkTabState();
  await loadNetworkRulesState();
  syncNetworkWebRequest(
    networkRulesState,
    networkHooksEnabled,
    networkSharedState
  );
  await syncNetworkArmAlarm();
  await syncCspDnrRules(networkRulesState, networkHooksEnabled);
  await syncNetworkHookRegistration();
  broadcastArmChanged();
  if (typeof onRulesChanged === "function") {
    onRulesChanged();
  }
}

async function injectRuleTestToast(tabId, message, success) {
  if (tabId == null || tabId < 0) {
    return;
  }
  try {
    await browser.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      injectImmediately: true,
      func: (text, ok) => {
        const id = "hackery-lab-rule-test-toast";
        let el = document.getElementById(id);
        if (!el) {
          el = document.createElement("div");
          el.id = id;
          el.style.cssText =
            "position:fixed;bottom:16px;right:16px;z-index:2147483647;padding:10px 14px;border-radius:6px;font:13px/1.4 system-ui,sans-serif;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.25);max-width:320px;";
          document.documentElement.appendChild(el);
        }
        el.style.background = ok ? "#2f7d62" : "#6b7280";
        el.textContent = text;
        el.style.opacity = "1";
        clearTimeout(el.__HackeryLabHideTimer);
        el.__HackeryLabHideTimer = setTimeout(() => {
          el.style.opacity = "0";
        }, 4000);
      },
      args: [message, success],
    });
  } catch {
    // restricted tab
  }
}

function clearTestRuleSession() {
  if (testRuleSession?.timerId) {
    clearTimeout(testRuleSession.timerId);
  }
  testRuleSession = null;
}

async function startTestRuleSession(ruleId, url) {
  clearTestRuleSession();

  const tab = await browser.tabs.create({ url, active: true });
  if (!tab?.id) {
    throw new Error("Could not open test tab.");
  }

  const deadline = Date.now() + TEST_RULE_TIMEOUT_MS;
  const timerId = setTimeout(async () => {
    if (!testRuleSession || testRuleSession.tabId !== tab.id) {
      return;
    }
    await injectRuleTestToast(tab.id, "No match yet for this rule.", false);
    clearTestRuleSession();
  }, TEST_RULE_TIMEOUT_MS);

  testRuleSession = { ruleId, tabId: tab.id, deadline, timerId };
  return { tabId: tab.id };
}

async function handleTestRuleMatch(entry, tabId) {
  if (!testRuleSession || testRuleSession.tabId !== tabId) {
    return;
  }
  if (entry.ruleId !== testRuleSession.ruleId) {
    return;
  }
  if (Date.now() > testRuleSession.deadline) {
    return;
  }

  const ruleName = entry.ruleName || "Rule";
  clearTestRuleSession();
  await injectRuleTestToast(tabId, `${ruleName} applied.`, true);
}

async function appendNetworkRuleLog(entry, tabId) {
  const stored = await browser.storage.session.get(NETWORK_RULES_LOG_KEY);
  const payload =
    tabId != null && tabId >= 0 ? { ...entry, tabId } : entry;
  const entries = appendNetworkLogQueue(stored[NETWORK_RULES_LOG_KEY] || [], payload);
  await browser.storage.session.set({ [NETWORK_RULES_LOG_KEY]: entries });
  if (tabId != null && tabId >= 0) {
    patchTabFlags(tabId, { networkMatched: true });
    if (typeof onRulesChanged === "function") {
      onRulesChanged(tabId);
    }
    await handleTestRuleMatch(entry, tabId);
  }
}

async function reinjectNetworkHookAllTabs() {
  const rules = pageHookRules();
  if (!rules.length) {
    return;
  }

  await loadNetworkTabState();
  networkLogToken = crypto.randomUUID();

  const tabs = await browser.tabs.query({ url: ["http://*/*", "https://*/*"] });
  for (const tab of tabs) {
    if (!tab.id) {
      continue;
    }
    try {
      await installNetworkHookInTab(tab.id);
    } catch {
      // restricted tab — skip
    }
  }
}

async function onNavigationCommitted(details) {
  if (details.tabId < 0) {
    return;
  }
  if (!/^https?:/i.test(details.url || "")) {
    return;
  }
  if (!pageHookRules().length) {
    return;
  }

  if (details.frameId === 0) {
    rememberNetworkTabUrl(details.tabId, details.url);
  }

  await loadNetworkTabState();
  try {
    // Top-frame navigations refresh every frame so PAGE URL (tab URL) stays current
    // for cross-origin iframes that cannot read top.location.
    if (details.frameId === 0) {
      await installNetworkHookInTab(details.tabId);
    } else {
      await installNetworkHookInTab(details.tabId, details.frameId);
    }
  } catch {
    // restricted tab — skip
  }
}

function initNetworkNavigationHook() {
  if (networkNavigationHookRegistered) {
    return;
  }
  browser.webNavigation.onCommitted.addListener((details) => {
    onNavigationCommitted(details).catch(() => {});
  });
  networkNavigationHookRegistered = true;
}

export function scheduleRefreshNetworkRulesState() {
  clearTimeout(networkRefreshTimer);
  networkRefreshTimer = setTimeout(() => {
    refreshNetworkRulesState()
      .then(() => reinjectNetworkHookAllTabs())
      .catch(() => {});
  }, REFRESH_DEBOUNCE_MS);
}

/**
 * Badge mark for this tab: ● only while at least one network rule is active.
 * @param {number} _tabId
 */
export function getBadgeMark(_tabId) {
  if (networkHooksEnabled && enabledNetworkRules().length) {
    return "●";
  }
  return "";
}

export function handleStorageChange(changes, area) {
  if (area !== "local") {
    return;
  }
  if (
    changes[NETWORK_RULES_KEY] ||
    changes[NETWORK_HOOKS_ENABLED_KEY] ||
    changes[NETWORK_SHARED_STATE_KEY]
  ) {
    scheduleRefreshNetworkRulesState();
  }
  if (changes[NETWORK_HOOKS_ENABLED_KEY]) {
    loadNetworkHooksEnabled();
  }
}

export function handleTabRemoved(tabId) {
  const tabKey = String(tabId);
  if (networkTabState[tabKey]) {
    delete networkTabState[tabKey];
    browser.storage.session.set({ [NETWORK_TAB_STATE_KEY]: networkTabState });
  }
  if (testRuleSession?.tabId === tabId) {
    clearTestRuleSession();
  }
  forgetNetworkTabUrl(tabId);
  clearTabFlags(tabId);
}

export async function init(options = {}) {
  onRulesChanged = options.onRulesChanged || null;
  initNetworkArmAlarm();
  initCspCompose();
  initNetworkNavigationHook();
  try {
    const tabs = await browser.tabs.query({ url: ["http://*/*", "https://*/*"] });
    for (const tab of tabs) {
      if (tab.id != null && tab.url) {
        rememberNetworkTabUrl(tab.id, tab.url);
      }
    }
  } catch {
    // ignore
  }
  await refreshNetworkRulesState();
}

export function createMessageHandlers() {
  return createNetworkMessageHandlers({
    NETWORK_RULES_KEY,
    NETWORK_RULES_LOG_KEY,
    loadNetworkTabState,
    installNetworkHookInTab,
    refreshNetworkRulesState,
    reinjectNetworkHookAllTabs,
    loadNetworkRulesState,
    appendNetworkRuleLog,
    persistSharedState,
    pageHookRules,
    validateNetworkLogToken,
    startTestRuleSession,
    getNetworkArmSnapshot,
    setNetworkArmed,
    resetNetworkArmTimer,
    loadNetworkHooksEnabled,
  });
}

/**
 * Settings fragment owned by this plugin (merged by host for GET_EXTENSION_SETTINGS).
 */
export async function getSettingsFragment() {
  await loadNetworkHooksEnabled();
  await loadNetworkRulesState();
  return { networkHooksEnabled, networkArm: getArmSnapshot() };
}

/**
 * Persist settings fragment keys owned by this plugin.
 * @param {object} next
 */
export function collectSettingsPayload(next) {
  const payload = {};
  if (typeof next.networkHooksEnabled === "boolean") {
    payload[NETWORK_HOOKS_ENABLED_KEY] = next.networkHooksEnabled;
  }
  return payload;
}
