import { ensureLinkId } from "../lib/link-catalog.js";
import { defaultScriptName, normalizeScriptInput } from "../lib/link-model.js";
import { StorageKeys } from "../lib/storage-keys.js";

function defaultUrlName(path, existingCount) {
  try {
    if (/^https?:\/\//i.test(path)) {
      const url = new URL(path);
      const suffix = url.pathname !== "/" ? url.pathname : "";
      return `Open ${url.hostname}${suffix}`.slice(0, 72);
    }
    const leaf = path.split(/[/?#]/).filter(Boolean).pop() || "page";
    return `Go to ${leaf}`;
  } catch {
    return `Custom link ${existingCount + 1}`;
  }
}

export function buildQuickLinkNode(
  rawInput,
  nameInput,
  existingNodes = [],
  mode = "link"
) {
  const input = String(rawInput ?? "").trim();
  if (!input) {
    throw new Error("Paste a script or URL before adding an action.");
  }

  if (mode === "link") {
    const node = {
      name: nameInput.trim() || defaultUrlName(input, existingNodes.length),
      url: input,
      open: input.startsWith("/") ? "same-tab" : "tab",
    };
    return ensureLinkId(node);
  }

  const code = normalizeScriptInput(input);
  const scriptlets = existingNodes.filter((node) => node.code && !node.url);
  return ensureLinkId({
    name: nameInput.trim() || defaultScriptName(code, scriptlets),
    code,
  });
}

export function pathFromTabUrl(urlString) {
  try {
    const url = new URL(urlString);
    if (!/^https?:$/i.test(url.protocol)) {
      return urlString;
    }
    return `${url.pathname}${url.search}${url.hash}` || "/";
  } catch {
    return urlString;
  }
}

export function hostPatternFromUrl(urlString) {
  try {
    const hostname = new URL(urlString).hostname;
    if (!hostname) {
      return null;
    }
    return `^${hostname.replace(/\./g, "\\.")}$`;
  } catch {
    return null;
  }
}

/**
 * Turn a tab URL into an instance-relative template plus its navParam specs.
 * Each query parameter becomes a `{name}` token with the observed value as default.
 * @param {string} urlString
 * @returns {{url: string, navParams?: Record<string, object>}}
 */
export function buildPathTemplateFromUrl(urlString) {
  try {
    const url = new URL(urlString);
    if (!/^https?:$/i.test(url.protocol)) {
      return {
        url: urlString,
      };
    }

    const paramEntries = [...new URLSearchParams(url.search).entries()];
    const pathname = url.pathname || "/";
    const hash = url.hash || "";

    if (paramEntries.length === 0) {
      return {
        url: `${pathname}${hash}`,
      };
    }

    //query values feed URL templates, so they belong in navParams (ADR 0001)
    const navParams = {};
    const queryParts = [];
    for (const [name, value] of paramEntries) {
      queryParts.push(`${encodeURIComponent(name)}={${name}}`);
      navParams[name] = { default: value, placeholder: name };
    }

    const urlTemplate = `${pathname}?${queryParts.join("&")}${hash}`;
    return { url: urlTemplate, navParams };
  } catch {
    return {
      url: pathFromTabUrl(urlString),
    };
  }
}

export function buildPrefillFromTab(tab) {
  if (!tab?.url || !/^https?:\/\//i.test(tab.url)) {
    return null;
  }

  const { url, navParams } = buildPathTemplateFromUrl(tab.url);
  const title = tab.title?.trim() || defaultUrlName(url, 0);
  return {
    name: title,
    url,
    navParams,
    match: hostPatternFromUrl(tab.url),
    absoluteUrl: tab.url,
  };
}

export async function captureTabPrefillForBuilder() {
  let [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!buildPrefillFromTab(tab)) {
    [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  }
  return buildPrefillFromTab(tab);
}

async function findBrowsingTab() {
  const windows = await browser.windows.getAll({ populate: true, windowTypes: ["normal"] });
  const ordered = [...windows].sort((a, b) => Number(b.focused) - Number(a.focused));

  for (const win of ordered) {
    const activeTab = win.tabs?.find((tab) => tab.active && buildPrefillFromTab(tab));
    if (activeTab) {
      return activeTab;
    }
  }

  for (const win of ordered) {
    const browsable = win.tabs?.find((tab) => buildPrefillFromTab(tab));
    if (browsable) {
      return browsable;
    }
  }

  const tabs = await browser.tabs.query({ url: ["http://*/*", "https://*/*"] });
  if (tabs.length === 0) {
    return null;
  }

  return tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}

export async function getBrowsingTabPrefill() {
  return buildPrefillFromTab(await findBrowsingTab());
}

export async function consumeBuilderPrefill() {
  const key = StorageKeys.LINK_BUILDER_PREFILL_KEY;
  const stored = await browser.storage.session.get(key);
  if (Object.prototype.hasOwnProperty.call(stored, key)) {
    const prefill = stored[key];
    await browser.storage.session.remove(key);
    if (prefill) {
      return prefill;
    }
  }
  return getBrowsingTabPrefill();
}

export async function getTabPrefill() {
  return getBrowsingTabPrefill();
}
