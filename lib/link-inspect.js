/**
 * Per-leaf inspect snapshot: matching tabs, frames, cached origin, params,
 * compiled URL/code, on-load skip reasons.
 */
import { supportsOnLoad } from "./link-behaviors.js";
import {
  getEditableValueDefs,
  getRuntimeValueDefs,
  linkAppliesToUrl,
  linkStorageKey,
  resolveParamValues,
  resolveRunAt,
  seedNavParamValues,
  urlSkipReason,
} from "./link-model.js";
import { resolveUrlActionTraced } from "./navigation-shared.js";
import { isFrameTargeted } from "./scriptlet-inject.js";
import { StorageKeys } from "./storage-keys.js";
import { MessageTypes } from "./message-types.js";
import { getRememberedOrigin, getTargetTab } from "./tab-target.js";

const { INJECT_ON_LOAD_KEY, INJECT_ON_LOAD_ENABLED_KEY, PARAM_VALUES_KEY } =
  StorageKeys;

function tabSummary(tab) {
  return {
    id: tab.id,
    url: tab.url || "",
    title: tab.title || "",
    active: Boolean(tab.active),
  };
}

/**
 * @param {object} node flattened leaf
 * @param {{ row?: HTMLElement, activeTab?: object, windowId?: number|null, paramValues?: Record<string,string> }} [options]
 */
export async function buildLinkInspectSnapshot(node, options = {}) {
  const match = node.match ?? null;
  const exclude = node.exclude ?? null;
  const linkKey = linkStorageKey(node);
  const behaviorId = node.code && node.open ? "open-from-script" : node.url ? "open-url" : "run";

  const stored = await browser.storage.local.get([
    PARAM_VALUES_KEY,
    INJECT_ON_LOAD_KEY,
    INJECT_ON_LOAD_ENABLED_KEY,
  ]);
  const savedParams = stored[PARAM_VALUES_KEY]?.[linkKey] || {};
  const rowValues = options.paramValues || {};
  const mergedRaw = { ...savedParams, ...rowValues };
  const runtimeDefs = getRuntimeValueDefs(node);
  const paramValues =
    behaviorId === "open-url"
      ? seedNavParamValues(runtimeDefs, mergedRaw)
      : resolveParamValues(runtimeDefs, mergedRaw);

  let tabs = [];
  try {
    tabs = await browser.tabs.query({ currentWindow: true });
  } catch {
    tabs = [];
  }
  const matchingTabs = tabs
    .filter((tab) => tab.url && linkAppliesToUrl(tab.url, match, exclude))
    .map(tabSummary);

  let target = null;
  let targetError = "";
  try {
    const resolved = await getTargetTab(match, {
      windowId: options.windowId ?? null,
      excludePattern: exclude,
    });
    target = {
      tab: tabSummary(resolved.tab),
      origin: resolved.origin,
    };
  } catch (error) {
    targetError = error.message || String(error);
  }

  let frames = [];
  if (target?.tab?.id && node.code) {
    try {
      const list = await browser.webNavigation.getAllFrames({
        tabId: target.tab.id,
      });
      frames = (list || []).map((frame) => ({
        frameId: frame.frameId,
        url: frame.url || "",
        targeted: isFrameTargeted(node.frames, frame, list || []),
      }));
    } catch {
      frames = [];
    }
  }

  const lastOrigin = match ? await getRememberedOrigin(match) : null;
  const activeUrl = options.activeTab?.url || target?.tab?.url || "";

  let compiled = null;
  let derivation = null;
  if (node.url) {
    try {
      derivation = await resolveUrlActionTraced(
        node,
        target?.tab ? { id: target.tab.id, url: target.tab.url } : options.activeTab,
        target?.origin || null,
        paramValues
      );
      compiled = { kind: "url", url: derivation.url, values: derivation.values, sources: derivation.sources };
    } catch (error) {
      compiled = { kind: "url", error: error.message || String(error) };
    }
  } else if (node.code) {
    compiled = {
      kind: "script",
      paramNames: Object.keys(paramValues),
      paramValues,
      source: node.code,
    };
  }

  const injectOnLoad = stored[INJECT_ON_LOAD_KEY] || {};
  const injectOnLoadEnabled = stored[INJECT_ON_LOAD_ENABLED_KEY] !== false;
  const onLoadChecked = Boolean(injectOnLoad[linkKey]);
  let onLoadSkip = "";
  if (supportsOnLoad(node)) {
    if (!onLoadChecked) {
      onLoadSkip = "On-load checkbox off";
    } else if (!injectOnLoadEnabled) {
      onLoadSkip = "Master On load off";
    } else {
      onLoadSkip = urlSkipReason(activeUrl, match, exclude);
    }
  } else {
    onLoadSkip = "Not a Run scriptlet";
  }

  return {
    name: node.name,
    linkKey,
    behaviorId,
    match,
    exclude,
    runAt: resolveRunAt(node),
    sandbox: node.sandbox || "main",
    activeTab: options.activeTab ? tabSummary(options.activeTab) : null,
    matchingTabs,
    cachedOrigin: lastOrigin,
    target,
    targetError,
    frames,
    params: {
      saved: savedParams,
      merged: paramValues,
      defs: getEditableValueDefs(node).map((def) => def.name),
    },
    compiled,
    onLoad: {
      eligible: supportsOnLoad(node),
      checked: onLoadChecked,
      masterEnabled: injectOnLoadEnabled,
      skipReason: onLoadSkip,
    },
    applySkip: urlSkipReason(activeUrl, match, exclude),
  };
}

/**
 * Dump a snapshot into the target tab's page console.
 * @param {number} tabId
 * @param {object} snapshot
 */
export async function dumpInspectSnapshotToTab(tabId, snapshot) {
  if (!tabId) {
    return;
  }
  await browser.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    world: "MAIN",
    func: (payload) => {
      console.groupCollapsed(`[Hackery Lab] ${payload.name}`);
      console.log(payload);
      if (payload.matchingTabs?.length) {
        console.table(payload.matchingTabs);
      }
      if (payload.frames?.length) {
        console.table(payload.frames);
      }
      if (payload.compiled?.kind === "url") {
        console.log("compiled URL", payload.compiled);
      }
      if (payload.compiled?.kind === "script") {
        console.log("compiled script", payload.compiled);
      }
      console.groupEnd();
    },
    args: [snapshot],
  });
}

/**
 * Send an activity entry to the background ring buffer.
 * @param {object} entry
 */
export async function reportActivity(entry) {
  try {
    await browser.runtime.sendMessage({
      type: MessageTypes.APPEND_ACTIVITY_LOG,
      entry,
    });
  } catch {
    // background gone
  }
}
