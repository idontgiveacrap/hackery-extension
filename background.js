import { clearTabFlags, refresh as refreshBadge } from "./lib/action-badge.js";
import { activateLinkNode } from "./lib/activate-link.js";
import { createBackgroundMessageHandlers } from "./lib/background-messages.js";
import { getCatalogSnapshot, invalidateCatalogSnapshot } from "./lib/catalog-service.js";
import { CATALOG_CHANGED, isCatalogChangedMessage } from "./lib/catalog-events.js";
import {
  initCspCompose,
  isCspNonceTab,
  setCspNonceForTab,
  whenCspComposeReady,
} from "./lib/csp-compose.js";
import { initCspNonce } from "./lib/csp-nonce.js";
import {
  collectScriptlets,
  getEditableValueDefs,
  getParameterDefs,
  linkAppliesToUrl,
  resolveParamValues,
  resolveRunAt,
  urlSkipReason,
} from "./lib/link-model.js";
import { StorageKeys } from "./lib/storage-keys.js";
import { searchCatalog } from "./lib/link-search.js";
import { findNodeByStableKey, isSlotCommand, loadShortcutSlots } from "./lib/link-shortcuts.js";
import { createMessageRouter, respondAsync } from "./lib/message-router.js";
import { MessageTypes, MessageTypeSet } from "./lib/message-types.js";
import { executeScriptletWithBindings, isFrameTargeted } from "./lib/scriptlet-inject.js";
import { appendActivityLogQueue, ACTIVITY_LOG_KEY } from "./lib/link-activity-log.js";
import { getActiveTab } from "./lib/tab-target.js";
import { canonicalizeHref } from "./lib/url-normalize.js";
import { NetworkMessageTypeSet } from "./network/message-types.js";
import * as Network from "./network/plugin.js";

const {
  INJECT_ON_LOAD_ENABLED_KEY,
  INJECT_ON_LOAD_KEY,
  PARAM_VALUES_KEY,
  LINKS_OVERLAY_KEY,
  CATALOG_ORDER_KEY,
  LINK_SHORTCUT_SLOTS_KEY,
  LINK_BUILDER_PREFILL_KEY,
  PARAM_PROMPT_KEY,
} = StorageKeys;

const HTTP_CONTENT_SCRIPT_MATCHES = ["http://*/*", "https://*/*"];

const INJECT_SCRIPT_ID = "hackery-lab-on-load";
const CONTEXT_TARGET_SCRIPT_ID = "hackery-lab-context-target";
const LEGACY_INJECT_SCRIPT_ID = "complex-linker-on-load";
const LEGACY_CONTEXT_TARGET_SCRIPT_ID = "complex-linker-context-target";
const LEGACY_CONTENT_SCRIPT_IDS = [
  LEGACY_INJECT_SCRIPT_ID,
  LEGACY_CONTEXT_TARGET_SCRIPT_ID,
];
const PARAM_PROMPT_PAGE = "prompt/params.html";
const REFRESH_DEBOUNCE_MS = 300;

let injectEntries = [];
let extensionSettings = { injectOnLoadEnabled: true };
let injectRefreshTimer = null;

async function getLinkSections() {
  const snapshot = await getCatalogSnapshot();
  return snapshot.mergedUnordered;
}

function codesForUrl(url) {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return [];
  }

  return injectEntries.filter((entry) =>
    linkAppliesToUrl(url, entry.match, entry.exclude)
  );
}

async function logOnLoadSkips(pageUrl, { masterOff = false } = {}) {
  if (!injectEntries.length) {
    return;
  }
  for (const entry of injectEntries) {
    const reason = masterOff
      ? "Master On load off"
      : urlSkipReason(pageUrl, entry.match, entry.exclude);
    if (!masterOff && !reason) {
      continue;
    }
    await appendActivityLog({
      trigger: "on-load",
      name: entry.name,
      linkKey: entry.linkKey,
      behaviorId: "run",
      outcome: "skipped",
      reason: reason || "URL does not match",
      pageUrl,
      runAt: entry.runAt,
    });
  }
}

async function getActivityLog() {
  const stored = await browser.storage.session.get(ACTIVITY_LOG_KEY);
  return stored[ACTIVITY_LOG_KEY] || [];
}

async function appendActivityLog(entry) {
  const existing = await getActivityLog();
  const next = appendActivityLogQueue(existing, {
    ts: Date.now(),
    ...entry,
  });
  await browser.storage.session.set({ [ACTIVITY_LOG_KEY]: next });
  browser.runtime
    .sendMessage({ type: MessageTypes.ACTIVITY_LOG_CHANGED })
    .catch(() => {});
}

async function clearActivityLog() {
  await browser.storage.session.set({ [ACTIVITY_LOG_KEY]: [] });
  browser.runtime
    .sendMessage({ type: MessageTypes.ACTIVITY_LOG_CHANGED })
    .catch(() => {});
}

async function runInjectEntriesForTab(tabId, entries, frameId, meta = {}) {
  let tabFrames = null;
  async function listFrames() {
    if (!tabFrames) {
      tabFrames = await browser.webNavigation.getAllFrames({ tabId });
    }
    return tabFrames || [];
  }

  for (const entry of entries) {
    const baseLog = {
      trigger: meta.trigger || "on-load",
      name: entry.name,
      linkKey: entry.linkKey,
      behaviorId: "run",
      tabId,
      pageUrl: meta.pageUrl || "",
      runAt: meta.runAt || entry.runAt || "document_start",
      paramValues: entry.paramValues,
    };
    try {
      if (entry.frames) {
        if (frameId != null) {
          const frames = await listFrames();
          const frame = frames.find((item) => item.frameId === frameId);
          if (!frame || !isFrameTargeted(entry.frames, frame, frames)) {
            await appendActivityLog({
              ...baseLog,
              outcome: "skipped",
              reason: "Frame not in target set",
              frameId,
              frameUrl: frame?.url || "",
            });
            continue;
          }
          await executeScriptletInTab(tabId, entry.code, entry.paramValues, {
            frameId,
            sandbox: entry.sandbox,
          });
          await appendActivityLog({
            ...baseLog,
            outcome: "ran",
            frameId,
            frameUrl: frame?.url || "",
          });
          continue;
        }
        const frames = await listFrames();
        if (!frames.length) {
          await appendActivityLog({
            ...baseLog,
            outcome: "skipped",
            reason: "empty frames",
          });
          continue;
        }
        const outcome = await executeScriptletWithBindings(tabId, entry.code, entry.paramValues, {
          frames: entry.frames,
          sandbox: entry.sandbox,
        });
        await appendActivityLog({
          ...baseLog,
          outcome: outcome.someFailed ? "ran-partial" : "ran",
          frames: outcome.successes,
        });
        continue;
      }
      await executeScriptletInTab(tabId, entry.code, entry.paramValues, {
        frameId,
        sandbox: entry.sandbox,
      });
      await appendActivityLog({
        ...baseLog,
        outcome: "ran",
        frameId: frameId ?? 0,
      });
    } catch (error) {
      await appendActivityLog({
        ...baseLog,
        outcome: "failed",
        reason: error.message || String(error),
        frameId,
      });
    }
  }
}

async function loadHostSettings() {
  const stored = await browser.storage.local.get([INJECT_ON_LOAD_ENABLED_KEY]);
  extensionSettings = {
    injectOnLoadEnabled: stored[INJECT_ON_LOAD_ENABLED_KEY] !== false,
  };
  return extensionSettings;
}

async function loadExtensionSettings() {
  const host = await loadHostSettings();
  const network = (await Network.getSettingsFragment()) || {};
  return { ...host, ...network };
}

async function rebuildInjectCache() {
  const stored = await browser.storage.local.get([
    INJECT_ON_LOAD_KEY,
    PARAM_VALUES_KEY,
  ]);
  const injectOnLoad = stored[INJECT_ON_LOAD_KEY] || {};
  const paramValues = stored[PARAM_VALUES_KEY] || {};
  const sections = await getLinkSections();
  const scriptlets = [];

  for (const [name, section] of Object.entries(sections)) {
    collectScriptlets(
      section.children || [],
      section.match ?? null,
      name,
      scriptlets,
      section.exclude ?? null
    );
  }

  injectEntries = [];
  for (const { linkKey, node } of scriptlets) {
    if (!injectOnLoad[linkKey]) continue;

    const parameterDefs = getParameterDefs(node);
    const rawValues = paramValues[linkKey] || {};
    const values = resolveParamValues(parameterDefs, rawValues);
    injectEntries.push({
      name: node.name,
      linkKey,
      match: node.match ?? null,
      exclude: node.exclude ?? null,
      runAt: resolveRunAt(node),
      code: node.code,
      paramValues: values,
      sandbox: node.sandbox,
      ...(node.frames ? { frames: node.frames } : {}),
    });
  }
}

async function unregisterContentScriptIds(ids) {
  for (const id of ids) {
    try {
      await browser.scripting.unregisterContentScripts({ ids: [id] });
    } catch {
      // not registered yet
    }
  }
}

async function syncInjectRegistration() {
  // Only the ids this function owns: unregistering the context-target script
  // here raced the other sync and could leave the page with neither script.
  await unregisterContentScriptIds([INJECT_SCRIPT_ID, LEGACY_INJECT_SCRIPT_ID]);

  if (!extensionSettings.injectOnLoadEnabled || injectEntries.length === 0) {
    return;
  }

  await browser.scripting.registerContentScripts([
    {
      id: INJECT_SCRIPT_ID,
      matches: HTTP_CONTENT_SCRIPT_MATCHES,
      runAt: "document_start",
      allFrames: true,
      js: ["inject/on-load.js"],
    },
  ]);
}

/**
 * Keep context-target.js resident so contextmenu fires into an already-listening script.
 * Late injection on menu click misses the event that just opened the menu.
 */
async function syncContextTargetRegistration() {
  await unregisterContentScriptIds([
    CONTEXT_TARGET_SCRIPT_ID,
    LEGACY_CONTEXT_TARGET_SCRIPT_ID,
  ]);

  await browser.scripting.registerContentScripts([
    {
      id: CONTEXT_TARGET_SCRIPT_ID,
      matches: HTTP_CONTENT_SCRIPT_MATCHES,
      runAt: "document_start",
      allFrames: true,
      js: ["inject/context-target.js"],
    },
  ]);
}

async function injectContextTargetAllTabs() {
  const tabs = await browser.tabs.query({ url: ["http://*/*", "https://*/*"] });
  for (const tab of tabs) {
    if (!tab.id) {
      continue;
    }
    try {
      await browser.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ["inject/context-target.js"],
      });
    } catch {
      // restricted tab — skip
    }
  }
}

async function reinjectOnLoadAllTabs() {
  if (!extensionSettings.injectOnLoadEnabled || injectEntries.length === 0) {
    return;
  }

  const tabs = await browser.tabs.query({ url: ["http://*/*", "https://*/*"] });
  for (const tab of tabs) {
    if (!tab.id || !tab.url) {
      continue;
    }
    const codes = codesForUrl(tab.url);
    if (!codes.length) {
      continue;
    }
    try {
      await runInjectEntriesForTab(tab.id, codes);
    } catch {
      // restricted tab — skip
    }
  }
}

async function refreshInjectState() {
  await loadHostSettings();
  await rebuildInjectCache();
  await syncInjectRegistration();
  await reinjectOnLoadAllTabs();
}

async function executeScriptletInTab(tabId, code, paramValues = {}, options = {}) {
  const frameId = typeof options === "number" ? options : options.frameId;
  const sandbox = typeof options === "object" ? options.sandbox : undefined;
  return executeScriptletWithBindings(tabId, code, paramValues, { frameId, sandbox });
}

function scheduleRefreshInjectState() {
  clearTimeout(injectRefreshTimer);
  injectRefreshTimer = setTimeout(() => {
    refreshInjectState().catch(() => {});
  }, REFRESH_DEBOUNCE_MS);
}

async function refreshActionBadge(tabId, url) {
  if (!tabId) {
    return;
  }
  const settings = await loadExtensionSettings();
  const networkMark =
    settings.networkHooksEnabled === true ? Network.getBadgeMark(tabId) : "";
  let injectMark = "";
  if (settings.injectOnLoadEnabled && url && codesForUrl(url).length) {
    injectMark = "+";
  }
  await refreshBadge(tabId, {
    network: networkMark,
    inject: injectMark,
  });
}

function scheduleActiveTabBadgeRefresh() {
  void browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    const tab = tabs[0];
    if (tab) {
      refreshActionBadge(tab.id, tab.url);
    }
  });
}

/**
 * Registered content scripts persist across sessions, and onInstalled fires
 * alongside the top-level call on a reload, so a second concurrent run would
 * re-register ids the first run had just claimed.
 * @type {Promise<void> | null}
 */
let initExtensionRun = null;

function initExtension() {
  if (!initExtensionRun) {
    initExtensionRun = runInitExtension().finally(() => {
      initExtensionRun = null;
    });
  }
  return initExtensionRun;
}

async function runInitExtension() {
  await Promise.all([
    refreshInjectState(),
    syncContextTargetRegistration()
      .then(() => injectContextTargetAllTabs())
      .catch((error) => {
        console.error("context-target registration failed:", error);
      }),
    Network.init({
      onRulesChanged(tabId) {
        if (tabId != null) {
          void browser.tabs.get(tabId).then((tab) => {
            refreshActionBadge(tab.id, tab.url);
          }).catch(() => {});
          return;
        }
        scheduleActiveTabBadgeRefresh();
      },
    }),
  ]);
}

const messageHandlers = {
  ...createBackgroundMessageHandlers({
    INJECT_ON_LOAD_ENABLED_KEY,
    extensionSettings: () => extensionSettings,
    codesForUrl,
    runInjectEntriesForTab,
    executeScriptletInTab,
    refreshInjectState,
    loadExtensionSettings,
    collectNetworkSettingsPayload: (next) => Network.collectSettingsPayload(next),
    getCspNonceForTab: isCspNonceTab,
    setCspNonceForTab,
    whenCspComposeReady,
    appendActivityLog,
    getActivityLog,
    clearActivityLog,
    logOnLoadSkips,
  }),
  ...Network.createMessageHandlers(),

  [MessageTypes.ACTIVATE_LINK_WITH_PARAMS](message, _sender, sendResponse) {
    const windowId = message.windowId ?? null;
    respondAsync(
      activateByStableKey(message.stableKey, {
        rawValues: message.rawValues || {},
        windowId,
        promptParams: "never",
        trigger: "prompt",
      }).then(async (outcome) => {
        // Hand focus back to the window the action ran in; the prompt took it.
        if (outcome.ok && windowId != null) {
          await browser.windows
            .update(windowId, { focused: true })
            .catch(() => {});
        }
        return outcome;
      }),
      sendResponse
    );
    return true;
  },
};

const knownMessageTypes = new Set([
  ...MessageTypeSet,
  ...NetworkMessageTypeSet,
  CATALOG_CHANGED,
]);

browser.runtime.onMessage.addListener(
  createMessageRouter(messageHandlers, { knownTypes: knownMessageTypes })
);

browser.storage.onChanged.addListener((changes, area) => {
  Network.handleStorageChange(changes, area);
  if (area === "local") {
    if (
      changes[INJECT_ON_LOAD_KEY] ||
      changes[PARAM_VALUES_KEY] ||
      changes[LINKS_OVERLAY_KEY] ||
      changes[INJECT_ON_LOAD_ENABLED_KEY]
    ) {
      if (changes[LINKS_OVERLAY_KEY]) {
        invalidateCatalogSnapshot();
      }
      scheduleRefreshInjectState();
    }
    if (changes[INJECT_ON_LOAD_ENABLED_KEY]) {
      loadHostSettings();
    }
  }
});

// Top level, not inside initExtension: event pages only wake for listeners
// registered during the background script's first synchronous run.
initCspCompose();
initCspNonce();

browser.tabs.onRemoved.addListener((tabId) => {
  Network.handleTabRemoved(tabId);
  clearTabFlags(tabId);
  void refreshBadge(tabId, {});
});

browser.runtime.onInstalled.addListener(() => {
  initExtension();
  initContextMenus();
});

browser.runtime.onStartup.addListener(() => {
  initExtension();
});

initExtension();
initContextMenus();

// --- Sidebar toggle, omnibox, shortcuts, context menus, badges ---

async function getOrderedCatalog() {
  const snapshot = await getCatalogSnapshot();
  return snapshot.ordered;
}

async function openSidebarPanel() {
  try {
    await browser.sidebarAction.open();
  } catch {
    // Some hosts disallow open(); toggle may still work from user gesture.
  }
}

async function toggleSidebarPanel() {
  try {
    if (browser.sidebarAction.toggle) {
      await browser.sidebarAction.toggle();
      return;
    }
  } catch {
    // fall through
  }
  await openSidebarPanel();
}

browser.action.onClicked.addListener(() => {
  void toggleSidebarPanel();
});

function flashBadge(text, durationMs = 1200) {
  void browser.action.setBadgeText({ text });
  setTimeout(() => browser.action.setBadgeText({ text: "" }), durationMs);
}

/**
 * Collect parameter values in a popup window.
 *
 * A window rather than the sidebar: `sidebarAction.open()` only works inside an
 * unbroken user-input handler, and resolving the catalog and stored values
 * before we know whether a prompt is needed already spends that status.
 *
 * @param {string} stableKey leaf to activate once values are entered
 * @param {object} [options]
 * @param {number|null} [options.windowId] window activation should target
 * @param {Record<string,string>|null} [options.rawValues] values already supplied
 * @param {number} [options.fieldCount] editable defs, for window height
 */
async function openParamPrompt(
  stableKey,
  { windowId = null, rawValues = null, fieldCount = 1 } = {}
) {
  await browser.storage.session.set({
    [PARAM_PROMPT_KEY]: {
      stableKey,
      windowId,
      rawValues: rawValues || {},
    },
  });

  const baseUrl = browser.runtime.getURL(PARAM_PROMPT_PAGE);
  // Timestamp so reusing an open prompt window reloads it and re-reads the request.
  const targetUrl = `${baseUrl}?t=${Date.now()}`;

  const windows = await browser.windows.getAll({ populate: true });
  for (const win of windows) {
    for (const tab of win.tabs || []) {
      if (tab.url?.startsWith(baseUrl) && win.id != null && tab.id != null) {
        await browser.tabs.update(tab.id, { url: targetUrl });
        await browser.windows.update(win.id, { focused: true });
        return;
      }
    }
  }

  await browser.windows.create({
    url: targetUrl,
    type: "popup",
    width: 420,
    height: Math.min(560, 200 + 66 * Math.max(1, fieldCount)),
  });
}

/**
 * @param {string} stableKey
 * @param {object} [options]
 * @param {"always"|"when-needed"|"never"} [options.promptParams] when to open the
 *   parameter prompt window. `always` prompts before running so shortcut users
 *   can change a saved value; `never` is used by the prompt window itself.
 * @param {Record<string,string>|null} [options.rawValues] caller-supplied values
 * @param {number|null} [options.windowId] window activation should target
 */
async function activateByStableKey(stableKey, options = {}) {
  const {
    promptParams = "when-needed",
    rawValues = null,
    windowId = null,
  } = options;

  const catalog = await getOrderedCatalog();
  const node = findNodeByStableKey(catalog, stableKey);
  if (!node) {
    flashBadge("?");
    return { ok: false, message: "Link not found." };
  }

  const editableDefs = getEditableValueDefs(node);
  const canPrompt = promptParams !== "never" && editableDefs.length > 0;

  if (canPrompt && promptParams === "always") {
    await openParamPrompt(stableKey, {
      windowId,
      rawValues,
      fieldCount: editableDefs.length,
    });
    return { ok: true, prompted: true };
  }

  // Activation failures used to surface nowhere on these paths: a rejection in a
  // command listener is an unhandled promise. Report them to the caller instead.
  let outcome;
  try {
    outcome = await activateLinkNode(node, {
      rawValues,
      windowId,
      allowMissingParams: false,
      trigger: options.trigger || "shortcut",
    });
  } catch (error) {
    outcome = { ok: false, message: error.message || String(error) };
  }

  if (outcome.needsParams && canPrompt) {
    await openParamPrompt(stableKey, {
      windowId,
      rawValues,
      fieldCount: editableDefs.length,
    });
    return { ...outcome, prompted: true };
  }

  if (!outcome.ok) {
    flashBadge("!");
    console.warn(
      `hackery-lab: "${node.name}" not activated: ${
        outcome.message || "unknown error"
      }`
    );
  }
  return outcome;
}

browser.commands.onCommand.addListener((command) => {
  if (command === "_execute_sidebar_action") {
    void toggleSidebarPanel();
    return;
  }
  if (!isSlotCommand(command)) {
    return;
  }
  void (async () => {
    const slots = await loadShortcutSlots();
    const key = slots[command];
    if (!key) {
      flashBadge("—", 1000);
      return;
    }
    // Capture the window now: the prompt window takes focus, and "current
    // window" afterwards would resolve to the prompt instead of the browser.
    const activeTab = await getActiveTab();
    await activateByStableKey(key, {
      promptParams: "always",
      windowId: activeTab?.windowId ?? null,
      trigger: "shortcut",
    });
  })();
});

let omniboxCatalogCache = null;
let omniboxCacheAt = 0;
// Suggestion `content` string → stable key for the last suggestion set offered.
let omniboxSuggestionKeys = new Map();

async function getOmniboxCatalog() {
  if (omniboxCatalogCache && Date.now() - omniboxCacheAt < 5000) {
    return omniboxCatalogCache;
  }
  try {
    omniboxCatalogCache = await getOrderedCatalog();
  } catch (error) {
    console.error("ordered catalog failed, using raw merge:", error);
    omniboxCatalogCache = await getLinkSections();
  }
  omniboxCacheAt = Date.now();
  return omniboxCatalogCache;
}

function escapeOmniboxXml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const OMNIBOX_ARG_SEPARATOR = "|";

/**
 * Split omnibox input into the action query and inline parameter segments:
 * `find user | jsmith` → `{ query: "find user", args: ["jsmith"] }`.
 * @param {string} text
 */
function parseOmniboxInput(text) {
  const segments = String(text || "").split(OMNIBOX_ARG_SEPARATOR);
  return {
    query: (segments[0] || "").trim(),
    args: segments.slice(1).map((segment) => segment.trim()),
  };
}

/**
 * Map inline segments onto parameter defs. `name=value` binds by name; the rest
 * fill the remaining defs in declaration order. Blank segments are skipped so
 * they fall through to saved values and defaults rather than clearing them.
 * @param {object[]} defs editable value defs
 * @param {string[]} args
 * @returns {Record<string,string>}
 */
function mapOmniboxArgs(defs, args) {
  const values = {};
  const positional = [];

  for (const arg of args) {
    const equals = arg.indexOf("=");
    const name = equals > 0 ? arg.slice(0, equals).trim() : "";
    if (name && defs.some((def) => def.name === name)) {
      values[name] = arg.slice(equals + 1).trim();
      continue;
    }
    positional.push(arg);
  }

  const unclaimed = defs.filter((def) => values[def.name] === undefined);
  positional.forEach((value, index) => {
    const def = unclaimed[index];
    if (def && value) {
      values[def.name] = value;
    }
  });

  return values;
}

/** `q=jsmith` for supplied values, `q: username or name` for the rest. */
function describeOmniboxParams(defs, values) {
  return defs
    .map((def) => {
      const value = values[def.name];
      if (value) {
        return `${def.name}=${value}`;
      }
      return `${def.name}: ${def.placeholder || def.default || def.name}`;
    })
    .join(", ");
}

browser.omnibox.setDefaultSuggestion({
  description:
    "Search Hackery Lab actions (Enter to run top match; add | value for parameters)",
});

browser.omnibox.onInputChanged.addListener((text, suggest) => {
  void (async () => {
    try {
      const { query, args } = parseOmniboxInput(text);
      const catalog = await getOmniboxCatalog();
      const matches = searchCatalog(catalog, query, 8);
      const suppliedArgs = args.filter(Boolean);
      // onInputEntered receives only the chosen suggestion's `content`, so each
      // label segment must be unique to resolve back to one link. Links sharing
      // a name are disambiguated by section, then by an ordinal.
      omniboxSuggestionKeys = new Map();
      suggest(
        matches.map((entry) => {
          const label = entry.label || "";
          const section = entry.node.sectionName || "";
          let labelSegment = label;
          if (omniboxSuggestionKeys.has(labelSegment) && section) {
            labelSegment = `${label} — ${section}`;
          }
          for (let n = 2; omniboxSuggestionKeys.has(labelSegment); n += 1) {
            labelSegment = `${label} (${n})`;
          }
          omniboxSuggestionKeys.set(labelSegment, entry.key || null);

          const defs = getEditableValueDefs(entry.node);
          const paramText = defs.length
            ? describeOmniboxParams(defs, mapOmniboxArgs(defs, args))
            : "";
          const safeLabel = escapeOmniboxXml(label);
          const safeSection = escapeOmniboxXml(section);
          let description = safeSection
            ? `${safeLabel} — ${safeSection}`
            : safeLabel;
          if (paramText) {
            description += ` · ${escapeOmniboxXml(paramText)}`;
          }

          // Carry typed args into `content`: selecting a suggestion replaces the
          // whole input, so a bare label would drop them.
          return {
            content: suppliedArgs.length
              ? `${labelSegment} ${OMNIBOX_ARG_SEPARATOR} ${suppliedArgs.join(
                  ` ${OMNIBOX_ARG_SEPARATOR} `
                )}`
              : labelSegment,
            description,
          };
        })
      );
    } catch (error) {
      console.error("omnibox search failed:", error);
      suggest([]);
    }
  })();
});

browser.omnibox.onInputEntered.addListener((text) => {
  void (async () => {
    try {
      const { query, args } = parseOmniboxInput(text);
      const catalog = await getOmniboxCatalog();
      // Free-typed text (or the default suggestion) has no stable key behind it.
      const stableKey =
        omniboxSuggestionKeys.get(query) ||
        searchCatalog(catalog, query, 1)[0]?.key ||
        null;
      if (!stableKey) {
        flashBadge("?");
        return;
      }

      const node = findNodeByStableKey(catalog, stableKey);
      const rawValues =
        node && args.length
          ? mapOmniboxArgs(getEditableValueDefs(node), args)
          : null;
      const activeTab = await getActiveTab();
      await activateByStableKey(stableKey, {
        rawValues,
        windowId: activeTab?.windowId ?? null,
        trigger: "omnibox",
      });
    } catch (error) {
      console.error("omnibox activate failed:", error);
      flashBadge("!");
    }
  })();
});

async function ensureContextTargetScript(tabId, frameId) {
  try {
    const target = { tabId };
    if (typeof frameId === "number") {
      target.frameIds = [frameId];
    } else {
      target.allFrames = true;
    }
    await browser.scripting.executeScript({
      target,
      files: ["inject/context-target.js"],
    });
  } catch {
    // Restricted pages
  }
}

async function openBuilderWithContextPrefill(info, tab) {
  let selector = "";
  let text = "";
  if (tab?.id) {
    await ensureContextTargetScript(tab.id, info.frameId);
    try {
      const options =
        typeof info.frameId === "number" ? { frameId: info.frameId } : undefined;
      const response = await browser.tabs.sendMessage(
        tab.id,
        { type: MessageTypes.GET_CONTEXT_TARGET },
        options
      );
      selector = response?.selector || "";
      text = response?.text || "";
    } catch {
      // no content script response
    }
  }

  const pageUrl = info.pageUrl || tab?.url || "";
  const linkUrl = info.linkUrl || "";
  let match = null;
  let name = text || tab?.title || "New action";
  try {
    if (pageUrl) {
      const host = new URL(pageUrl).hostname.replace(/\./g, "\\.");
      match = `^${host}$`;
    }
  } catch {
    // ignore
  }

  const prefill = {
    name: String(name).slice(0, 80),
    absoluteUrl: linkUrl || pageUrl,
    path: "",
    match,
    fromSelector: selector || null,
    builderType: selector ? "derived-url" : "navigate",
    selectionText: info.selectionText || "",
  };

  if (pageUrl) {
    prefill.absoluteUrl = canonicalizeHref(linkUrl || pageUrl);
  }

  await browser.storage.session.set({ [LINK_BUILDER_PREFILL_KEY]: prefill });

  const baseUrl = browser.runtime.getURL("builder/builder.html");
  const targetUrl = `${baseUrl}?new=1`;
  await browser.windows.create({
    url: targetUrl,
    type: "popup",
    width: 960,
    height: 720,
  });
}

function initContextMenus() {
  browser.contextMenus.removeAll().then(() => {
    browser.contextMenus.create({
      id: "cl-create-action",
      title: "Create Hackery Lab action",
      contexts: ["page", "link", "selection", "editable"],
    });
  });
}

browser.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "cl-create-action") {
    void openBuilderWithContextPrefill(info, tab);
  }
});

browser.tabs.onActivated.addListener((activeInfo) => {
  void browser.tabs.get(activeInfo.tabId).then((tab) => {
    refreshActionBadge(tab.id, tab.url);
  });
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" || changeInfo.url) {
    void refreshActionBadge(tabId, tab.url);
  }
});

browser.runtime.onMessage.addListener((message) => {
  if (isCatalogChangedMessage(message)) {
    invalidateCatalogSnapshot();
    omniboxCatalogCache = null;
    omniboxSuggestionKeys = new Map();
    scheduleRefreshInjectState();
    scheduleActiveTabBadgeRefresh();
  }
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes[CATALOG_ORDER_KEY] || changes[LINK_SHORTCUT_SLOTS_KEY])) {
    invalidateCatalogSnapshot();
    omniboxCatalogCache = null;
    omniboxSuggestionKeys = new Map();
  }
});
