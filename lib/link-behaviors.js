import { getNavParamsObject, resolveNode } from "./link-model.js";
import {
  coerceScriptletNavigationUrl,
  isAbsoluteUrl,
  performNavigation,
  resolveUrlAction,
  resolveUrlActionTraced,
} from "./navigation-shared.js";

function urlHasTemplateTokens(url) {
  return /\{[^}]+\}/.test(url || "");
}

function urlHasNavParams(node) {
  const navParams = getNavParamsObject(node);
  return navParams && Object.keys(navParams).length > 0;
}

function isUrlDerived(node) {
  return urlHasNavParams(node) || urlHasTemplateTokens(node.url);
}

/** Short label for how a URL action opens (same tab / new tab / …). */
export function openModeLabel(open) {
  switch (open) {
    case "same-tab":
      return "Same tab";
    case "tab":
      return "New tab";
    case "background":
      return "Background tab";
    case "download":
      return "Download";
    default:
      return "";
  }
}

function previewUrlHint(url) {
  return (url || "")
    .replace(/\{encode:[^}]+\}/g, "…")
    .replace(/\{[^}]+\}/g, "…");
}

export function formatOpenHint(open, urlPreview) {
  const mode = openModeLabel(open);
  const preview = previewUrlHint(urlPreview);
  if (mode && preview) {
    return `${mode} · ${preview}`;
  }
  return mode || preview || "";
}

export const behaviors = [
  {
    id: "open-from-script",
    when(node) {
      return Boolean(node.code && node.open);
    },
    badge(node) {
      return {
        label: "Open",
        className: "link-badge nav-scriptlet",
        title: "Opens a URL returned by the script",
      };
    },
    hint(node) {
      // The target URL is only knowable by running the script in the page, and
      // rendering a row must not execute user code. Name the source instead.
      return formatOpenHint(node.open, "Navigation script");
    },
    async run(node, ctx) {
      const { tab, origin, paramValues, executeScriptlet } = ctx;
      const outcome = await executeScriptlet(tab.id, node.code, paramValues, {
        frames: node.frames,
      });
      const urls = [];
      for (const item of outcome.successes) {
        const url = coerceScriptletNavigationUrl(item.value, tab, origin);
        if (url) {
          urls.push(url);
        }
      }
      if (!urls.length) {
        throw new Error("Navigation script did not resolve to a URL.");
      }
      const open = node.open;
      if (open === "same-tab") {
        await performNavigation(open, urls[0], tab, node.match ?? null);
      } else {
        for (const url of urls) {
          await performNavigation(open, url, tab, node.match ?? null);
        }
      }
      if (outcome.someFailed) {
        throw new Error("failed in some frames");
      }
      return {
        navigated: true,
        url: urls[0],
        urls,
        frames: outcome.successes,
      };
    },
  },
  {
    id: "open-url",
    when(node) {
      return Boolean(node.url);
    },
    badge(node) {
      if (isUrlDerived(node)) {
        return {
          label: "Derive",
          className: "link-badge derived-url",
          title: "Derives a URL from the current page",
        };
      }
      if (isAbsoluteUrl(node.url)) {
        return {
          label: "Web",
          className: "link-badge absolute-url",
          title: "Opens an absolute URL",
        };
      }
      return {
        label: "Open",
        className: "link-badge",
        title: "Opens a path on the matched instance",
      };
    },
    hint(node, paramValues = {}) {
      const resolved = resolveNode(node, paramValues);
      return formatOpenHint(node.open, resolved.url || "");
    },
    async run(node, ctx) {
      const { tab, origin, paramValues } = ctx;
      const traced = await resolveUrlActionTraced(node, tab, origin, paramValues);
      if (traced.url === null) {
        return { navigated: false, url: null, derivation: traced };
      }
      const open = node.open;
      if (!open) {
        throw new Error(`URL action "${node.name}" requires open.`);
      }
      await performNavigation(
        open,
        traced.url,
        tab,
        node.match ?? null
      );
      return { navigated: true, url: traced.url, derivation: traced };
    },
  },
  {
    id: "run",
    when(node) {
      return Boolean(node.code);
    },
    badge() {
      return {
        label: "Run",
        className: "link-badge",
        title: "Runs a scriptlet on the page",
      };
    },
    hint(node) {
      return node.match
        ? "Runs on the matched host tab"
        : "Runs on the active tab";
    },
    async run(node, ctx) {
      const { tab, paramValues, executeScriptlet } = ctx;
      const outcome = await executeScriptlet(tab.id, node.code, paramValues, {
        frames: node.frames,
      });
      if (outcome.someFailed) {
        throw new Error("failed in some frames");
      }
      return { ran: true, frames: outcome.successes, someFailed: outcome.someFailed };
    },
  },
];

export function matchBehavior(node) {
  for (const behavior of behaviors) {
    if (behavior.when(node)) {
      return behavior;
    }
  }
  return null;
}

export function linkBadgeLabel(node) {
  const behavior = matchBehavior(node);
  return behavior ? behavior.badge(node).label : "Open";
}

export function linkBadgeClass(node) {
  const behavior = matchBehavior(node);
  return behavior ? behavior.badge(node).className : "link-badge";
}

/** Native tooltip text for the sidebar behavior badge. */
export function linkBadgeTitle(node) {
  const behavior = matchBehavior(node);
  return behavior ? behavior.badge(node).title || "" : "";
}

export function displayHint(node, paramValues = {}) {
  const behavior = matchBehavior(node);
  if (!behavior?.hint) {
    return "";
  }
  return behavior.hint(node, paramValues) ?? "";
}

export function supportsOnLoad(node) {
  const behavior = matchBehavior(node);
  return behavior?.id === "run";
}
