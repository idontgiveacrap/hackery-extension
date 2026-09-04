import {
  applyTemplate,
  getNavParamDefs,
  getNavParamsObject,
  normalizeNavParamDerivations,
  seedNavParamValues,
} from "./link-model.js";

export function resolvePathOnTab(tab, path) {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  if (!tab?.url) {
    throw new Error("Active tab has no URL to resolve path against.");
  }
  return new URL(path, tab.url).href;
}

export function applyUrlTemplate(template, values) {
  return applyTemplate(template, values, {
    encode: true,
  });
}

export function extractValueFromUrl(pattern, pageUrl) {
  const match = pageUrl.match(new RegExp(pattern, "i"));
  return match ? match[1] || "" : "";
}

export async function extractValuesFromDom(tabId, domEntries) {
  if (!tabId) {
    throw new Error("No target tab for DOM extraction.");
  }
  if (domEntries.length === 0) {
    return {};
  }

  const [{ result }] = await browser.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (specs) => {
      const values = {};
      for (const spec of specs) {
        const element = document.querySelector(spec.selector);
        if (!element) {
          values[spec.paramName] = "";
          continue;
        }
        let raw;
        switch (spec.stringSource) {
          case "innerHTML":
            raw = element.innerHTML;
            break;
          case "textContent":
            raw = element.textContent;
            break;
          case "id":
            raw = element.id;
            break;
          case "attribute":
            raw = element.getAttribute(spec.attribute);
            break;
          default:
            raw = element.textContent;
        }
        values[spec.paramName] = raw == null ? "" : String(raw).trim();
      }
      return values;
    },
    args: [
      domEntries.map(({ paramName, selector, stringSource, attribute }) => ({
        paramName,
        selector,
        stringSource,
        attribute,
      })),
    ],
  });

  return result || {};
}

/**
 * Resolve URL template values: non-empty manual → derivation → default.
 * Missing required values → url null (no-op). optional: true allows empty.
 * @returns {Promise<{ url: string|null, values: Record<string,string>, sources: Record<string,string> }>}
 */
export async function resolveDerivedUrlTraced(
  node,
  pageUrl,
  paramValues = {},
  { origin = null, tabId = null } = {}
) {
  const { url } = node;
  if (!url) {
    throw new Error("URL action requires a url template.");
  }

  const defs = getNavParamDefs(node);
  const entries = normalizeNavParamDerivations(getNavParamsObject(node));
  const urlEntries = entries.filter((entry) => entry.kind === "url");
  const domEntries = entries.filter((entry) => entry.kind === "dom");
  const sources = {};

  if (urlEntries.length > 0 && !pageUrl) {
    throw new Error("Tab has no URL to resolve derived URL against.");
  }
  if (domEntries.length > 0 && !tabId) {
    throw new Error("No target tab for DOM extraction.");
  }

  const values = seedNavParamValues(defs, paramValues);
  for (const def of defs) {
    if ((values[def.name] ?? "").trim()) {
      sources[def.name] = "manual";
    }
  }

  for (const entry of urlEntries) {
    if ((values[entry.paramName] ?? "").trim()) {
      continue;
    }
    const value = extractValueFromUrl(entry.pattern, pageUrl);
    if (value) {
      values[entry.paramName] = value;
      sources[entry.paramName] = "fromUrl";
    }
  }

  const pendingDomEntries = domEntries.filter(
    (entry) => !(values[entry.paramName] ?? "").trim()
  );
  if (pendingDomEntries.length > 0) {
    const domValues = await extractValuesFromDom(tabId, pendingDomEntries);
    for (const entry of pendingDomEntries) {
      const value = (domValues[entry.paramName] ?? "").trim();
      if (value) {
        values[entry.paramName] = value;
        sources[entry.paramName] = "fromSelector";
      }
    }
  }

  for (const def of defs) {
    if ((values[def.name] ?? "").trim()) {
      continue;
    }
    if (def.default !== "" && def.default !== undefined) {
      values[def.name] = def.default;
      sources[def.name] = "default";
    }
  }

  for (const def of defs) {
    if ((values[def.name] ?? "").trim()) {
      continue;
    }
    if (def.optional) {
      values[def.name] = "";
      sources[def.name] = "empty";
      continue;
    }
    return { url: null, values, sources };
  }

  if (origin) {
    values.origin = origin;
  }

  const resolved = applyUrlTemplate(url, values);
  if (isAbsoluteUrl(resolved)) {
    return { url: resolved, values, sources };
  }
  const base = origin || pageUrl;
  if (base) {
    return { url: new URL(resolved, base).href, values, sources };
  }
  return { url: resolved, values, sources };
}

export async function resolveDerivedUrl(
  node,
  pageUrl,
  paramValues = {},
  options = {}
) {
  const traced = await resolveDerivedUrlTraced(node, pageUrl, paramValues, options);
  return traced.url;
}

export function urlHasTemplateTokens(url) {
  return /\{[^}]+\}/.test(url || "");
}

export function urlHasNavParams(node) {
  const navParams = getNavParamsObject(node);
  return navParams && Object.keys(navParams).length > 0;
}

export async function resolveUrlActionTraced(node, tab, origin, paramValues = {}) {
  const urlTemplate = node.url;
  if (!urlTemplate) {
    throw new Error("URL action requires url.");
  }

  if (urlHasNavParams(node) || urlHasTemplateTokens(urlTemplate)) {
    return resolveDerivedUrlTraced(node, tab?.url, paramValues, {
      origin,
      tabId: tab?.id ?? null,
    });
  }

  return {
    url: resolvePathUrl(urlTemplate, tab, origin),
    values: {},
    sources: {},
  };
}

export async function resolveUrlAction(node, tab, origin, paramValues = {}) {
  const traced = await resolveUrlActionTraced(node, tab, origin, paramValues);
  return traced.url;
}

// Navigation scripts are never evaluated here. They read page globals and the
// page DOM, and extension pages have no `unsafe-eval` under MV3, so they run
// only via scriptlet-inject.js in the target tab's MAIN world. Callers that
// need the resolved URL inject the script and pass the return value to
// coerceScriptletNavigationUrl below.

export function resolveAbsoluteUrl(urlOrPath, tab, origin) {
  if (urlOrPath == null || urlOrPath === "") {
    return null;
  }
  const text = String(urlOrPath);
  if (/^https?:\/\//i.test(text)) {
    return text;
  }
  const base = origin || tab?.url;
  if (!base) {
    throw new Error("No origin to resolve URL against.");
  }
  return new URL(text, base).href;
}

export function coerceScriptletNavigationUrl(value, tab, origin) {
  if (value == null || value === "") {
    return null;
  }
  const text = String(value).trim();
  if (!text) {
    return null;
  }
  return resolveAbsoluteUrl(text, tab, origin);
}

export function isAbsoluteUrl(path) {
  return /^https?:\/\//i.test(path || "");
}

export function resolvePathUrl(path, tab, origin) {
  if (isAbsoluteUrl(path)) {
    return path;
  }
  if (origin) {
    return new URL(path, origin).href;
  }
  return resolvePathOnTab(tab, path);
}

export function resolveOpen(node) {
  return node.open || null;
}

export async function performNavigation(open, url, tab, matchPattern) {
  if (!url) {
    return;
  }
  if (!open) {
    throw new Error("Navigation mode is required.");
  }

  // Pin new tabs to the target tab's window. Without it, activation from an
  // extension popup window (the parameter prompt) creates tabs against
  // whichever window the browser considers current — possibly that popup.
  const inTargetWindow = tab?.windowId != null ? { windowId: tab.windowId } : {};

  switch (open) {
    case "same-tab":
      if (tab?.id) {
        await browser.tabs.update(tab.id, {
          url,
          active: Boolean(matchPattern),
        });
      } else {
        await browser.tabs.create({ url, active: true, ...inTargetWindow });
      }
      return;
    case "tab":
      await browser.tabs.create({ url, active: true, ...inTargetWindow });
      return;
    case "background":
      await browser.tabs.create({ url, active: false, ...inTargetWindow });
      return;
    case "download": {
      // downloads.download names the file after the requested URL, so endpoints
      // that carry the real filename in a redirect (the Chrome Web Store CRX
      // endpoint ends in "/crx") save as an extensionless blob. Resolve the
      // redirect chain first and use the served name when there is one.
      let filename = null;
      try {
        const response = await fetch(url, { method: "HEAD", redirect: "follow" });
        const disposition = response.headers.get("content-disposition") || "";
        const fromHeader = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition);
        const candidate =
          fromHeader?.[1] || new URL(response.url).pathname.split("/").pop();
        const decoded = decodeURIComponent(candidate || "").trim();
        if (/\.[a-z0-9]{1,8}$/i.test(decoded)) {
          filename = decoded.replace(/[\\/:*?"<>|]/g, "_");
        }
      } catch {
        // Unreachable/HEAD-hostile endpoint: let the browser name the file.
      }
      await browser.downloads.download(filename ? { url, filename } : { url });
      return;
    }
    default:
      throw new Error(`Unknown open mode: ${open}`);
  }
}
