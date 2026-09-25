/**
 * Per-realm catalog snapshot: merge, ordered view, flat index, section flags.
 * Sidebar and background each keep their own cache (separate JS heaps).
 */
import {
  getCachedCatalogSnapshot,
  getCatalogSnapshotPromise,
  invalidateCatalogSnapshot,
  setCachedCatalogSnapshot,
  setCatalogSnapshotPromise,
} from "./catalog-cache.js";
import { applyOrder, loadCatalogOrder } from "./catalog-order.js";
import { walkCatalog, walkCatalogNodes } from "./catalog-walk.js";
import { isCatalogChangedMessage } from "./catalog-events.js";
import { loadLinksOverlay, mergeLinksCatalog } from "./link-catalog.js";
import { supportsOnLoad } from "./link-behaviors.js";
import { getEditableValueDefs } from "./link-model.js";
import { StorageKeys } from "./storage-keys.js";

export { invalidateCatalogSnapshot };

const { LINKS_OVERLAY_KEY, CATALOG_ORDER_KEY } = StorageKeys;

let listenersBound = false;

function collectOverlayLinkIds(overlay) {
  const ids = new Set();
  walkCatalog(overlay || {}, (entry) => {
    if (entry.kind === "leaf" && entry.node?.id) {
      ids.add(entry.node.id);
    }
  });
  return ids;
}

function buildSectionsAndLeaves(ordered, overlayLinkIds) {
  const sections = [];
  const flatLeaves = [];

  for (const [name, section] of Object.entries(ordered || {})) {
    const children = section?.children || [];
    let hasCustom = false;
    let hasParams = false;
    let hasOnLoad = false;
    walkCatalogNodes(
      children,
      {
        sectionName: name,
        inheritedMatch: section?.match ?? null,
        inheritedExclude: section?.exclude ?? null,
        parentList: children,
      },
      (entry) => {
        if (entry.kind !== "leaf") {
          return;
        }
        const node = {
          ...entry.node,
          match: entry.match,
          exclude: entry.exclude,
          sectionName: entry.sectionName,
        };
        flatLeaves.push({
          stableKey: entry.key,
          sectionName: entry.sectionName,
          pathParts: entry.pathParts,
          node,
        });
        if (node.id && overlayLinkIds.has(node.id)) {
          hasCustom = true;
        }
        if (getEditableValueDefs(node).length) {
          hasParams = true;
        }
        if (supportsOnLoad(node)) {
          hasOnLoad = true;
        }
      }
    );
    sections.push({
      name,
      match: section?.match ?? null,
      exclude: section?.exclude ?? null,
      children,
      hasCustom,
      hasParams,
      hasOnLoad,
    });
  }

  return { sections, flatLeaves };
}

async function loadBundledLinksJson() {
  const response = await fetch(browser.runtime.getURL("data/links.json"));
  return response.json();
}

async function buildSnapshot() {
  const bundled = await loadBundledLinksJson();
  const overlay = await loadLinksOverlay();
  const mergedUnordered = mergeLinksCatalog(bundled, overlay);
  const order = await loadCatalogOrder();
  const ordered = applyOrder(mergedUnordered, order);
  const overlayLinkIds = collectOverlayLinkIds(overlay);
  const { sections, flatLeaves } = buildSectionsAndLeaves(ordered, overlayLinkIds);
  return {
    overlay,
    overlayLinkIds,
    mergedUnordered,
    ordered,
    sections,
    flatLeaves,
  };
}

function bindInvalidationListeners() {
  if (listenersBound) {
    return;
  }
  if (typeof browser === "undefined") {
    return;
  }
  listenersBound = true;
  browser.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local") {
      return;
    }
    if (changes[LINKS_OVERLAY_KEY] || changes[CATALOG_ORDER_KEY]) {
      invalidateCatalogSnapshot();
    }
  });
  browser.runtime?.onMessage?.addListener((message) => {
    if (isCatalogChangedMessage(message)) {
      invalidateCatalogSnapshot();
    }
  });
}

/**
 * Cached compiled catalog for this extension page / background realm.
 */
export async function getCatalogSnapshot() {
  bindInvalidationListeners();
  const cached = getCachedCatalogSnapshot();
  if (cached) {
    return cached;
  }
  const existing = getCatalogSnapshotPromise();
  if (existing) {
    return existing;
  }
  const pending = buildSnapshot()
    .then((next) => {
      setCachedCatalogSnapshot(next);
      return next;
    })
    .finally(() => {
      setCatalogSnapshotPromise(null);
    });
  setCatalogSnapshotPromise(pending);
  return pending;
}
