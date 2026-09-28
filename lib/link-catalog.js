import { matchBehavior } from "./link-behaviors.js";
import {
  normalizeCatalog,
  normalizeLeafNode,
  normalizeTreeNode,
} from "./link-model.js";
import { StorageKeys } from "./storage-keys.js";

export const DEFAULT_CUSTOM_SECTION = "Misc";

const EXPORTABLE_LINK_KEYS = [
  "id",
  "name",
  "tooltip",
  "code",
  "url",
  "open",
  "match",
  "exclude",
  "runAt",
  "sandbox",
  "params",
  "navParams",
  "searchTags",
  "frames",
];

const EXPORTABLE_SECTION_KEYS = ["match", "exclude"];

/**
 * Whether a rendered leaf is a user link stored in `linksJsonOverlay`.
 * Not the same as "has an id": bundled leaves in `data/links.json` also carry
 * ids, and edit/remove only reach the overlay.
 * @param {Set<string>} overlayLinkIds ids from collectOverlayCustomLinkIds()
 */
export function isOverlayCustomLink(node, overlayLinkIds) {
  return Boolean(node?.id && !node.children && overlayLinkIds?.has(node.id));
}

export function mergeLinksCatalog(bundled, overlay) {
  const normalizedBundled = normalizeCatalog(bundled);
  if (!overlay || typeof overlay !== "object") {
    return normalizedBundled;
  }

  const normalizedOverlay = normalizeCatalog(overlay);
  const result = { ...normalizedBundled };
  for (const [sectionName, sectionOverlay] of Object.entries(normalizedOverlay)) {
    if (!sectionOverlay || typeof sectionOverlay !== "object") {
      continue;
    }

    const base = result[sectionName] || { children: [] };
    const baseChildren = Array.isArray(base.children) ? base.children : [];
    const overlayChildren = Array.isArray(sectionOverlay.children)
      ? sectionOverlay.children
      : [];
    const { match: _overlayMatch, children: _overlayChildren, ...sectionMeta } =
      sectionOverlay;

    result[sectionName] = {
      ...base,
      ...sectionMeta,
      ...(Object.prototype.hasOwnProperty.call(sectionOverlay, "match")
        ? { match: sectionOverlay.match }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(sectionOverlay, "exclude")
        ? { exclude: sectionOverlay.exclude }
        : {}),
      children: baseChildren.concat(overlayChildren),
    };
  }
  return result;
}

export function serializeLinkNode(node) {
  if (node.children) {
    const folder = { name: node.name };
    if (Object.prototype.hasOwnProperty.call(node, "match")) {
      folder.match = node.match;
    }
    if (Object.prototype.hasOwnProperty.call(node, "exclude")) {
      folder.exclude = node.exclude;
    }
    folder.children = node.children.map((child) => serializeLinkNode(child));
    return folder;
  }

  const out = {};
  for (const key of EXPORTABLE_LINK_KEYS) {
    if (key === "match" || key === "exclude") {
      if (Object.prototype.hasOwnProperty.call(node, key)) {
        out[key] = node[key];
      }
      continue;
    }
    const value = node[key];
    if (value === undefined || value === null) {
      continue;
    }
    if (key === "searchTags" && (!Array.isArray(value) || value.length === 0)) {
      continue;
    }
    if (key === "tooltip" && String(value).trim() === "") {
      continue;
    }
    if ((key === "code" || key === "url") && value === "") {
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function serializeSection(section) {
  const out = {};
  for (const key of EXPORTABLE_SECTION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(section, key)) {
      out[key] = section[key];
    }
  }
  out.children = (section?.children || []).map((node) => serializeLinkNode(node));
  return out;
}

export function ensureLinkId(node) {
  if (node.children || node.id) {
    return node;
  }
  return { ...node, id: crypto.randomUUID() };
}

/**
 * Assign missing leaf ids in a folder tree. Folders are left without ids.
 * @returns {{ nodes: object[], changed: boolean }}
 */
export function ensureLinkIdsInTree(nodes) {
  let changed = false;
  const next = (nodes || []).map((node) => {
    if (node?.children) {
      const nested = ensureLinkIdsInTree(node.children);
      if (nested.changed) {
        changed = true;
        return { ...node, children: nested.nodes };
      }
      return node;
    }
    if (node?.id) {
      return node;
    }
    changed = true;
    return ensureLinkId(node);
  });
  return { nodes: next, changed };
}

/** Overlay stored in `linksJsonOverlay`. Empty object when unset. */
export async function loadLinksOverlay() {
  const { LINKS_OVERLAY_KEY } = StorageKeys;
  const stored = await browser.storage.local.get(LINKS_OVERLAY_KEY);
  const overlay = stored[LINKS_OVERLAY_KEY];
  if (!overlay || typeof overlay !== "object") {
    return {};
  }
  return overlay;
}

export function isSectionOverlay(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return false;
  }
  if (data.code || data.url) {
    return false;
  }
  if (Array.isArray(data.children)) {
    return false;
  }

  const entries = Object.entries(data);
  if (!entries.length) {
    return false;
  }

  return entries.every(
    ([, section]) =>
      section &&
      typeof section === "object" &&
      Array.isArray(section.children)
  );
}

export function parseImportOverlay(raw) {
  const data = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!isSectionOverlay(data)) {
    throw new Error(
      'Import JSON must be a section overlay: { "SectionName": { "children": [...] } }'
    );
  }
  return data;
}

const LEGACY_IMPORT_KEYS = [
  "extract",
  "type",
  "path",
  "nav",
  "hostPattern",
  "parameter",
  "parameters",
  "displayName",
];

const CANONICAL_OPEN = new Set(["same-tab", "tab", "background", "download"]);

export function validateImportNode(node, indexLabel) {
  if (!node || typeof node !== "object") {
    throw new Error(`Invalid node at ${indexLabel}.`);
  }

  for (const key of LEGACY_IMPORT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(node, key)) {
      throw new Error(`${indexLabel} uses removed field "${key}".`);
    }
  }

  if (node.children) {
    if (!node.name) {
      throw new Error(`Folder at ${indexLabel} needs a name.`);
    }
    node.children.forEach((child, index) =>
      validateImportNode(child, `${indexLabel}.${index}`)
    );
    return;
  }

  if (!node.name) {
    throw new Error(`Link at ${indexLabel} needs a name.`);
  }

  const normalized = normalizeLeafNode(node);
  const behavior = matchBehavior(normalized);
  if (!behavior) {
    throw new Error(`Link "${node.name}" needs code or url.`);
  }
  if (node.open && !CANONICAL_OPEN.has(node.open)) {
    throw new Error(
      `Link "${node.name}" needs open of same-tab, tab, background, or download.`
    );
  }
  if (behavior.id === "open-url" && !normalized.open) {
    throw new Error(`URL link "${node.name}" needs open.`);
  }
  if (behavior.id === "open-from-script" && !normalized.open) {
    throw new Error(`Script navigation link "${node.name}" needs open.`);
  }
  if (behavior.id === "run" && !normalized.code) {
    throw new Error(`Scriptlet "${node.name}" needs code.`);
  }
}

export function normalizeImportedNodes(nodes) {
  return nodes.map((node) => {
    if (node.children) {
      return {
        ...normalizeTreeNode(node),
        children: normalizeImportedNodes(node.children),
      };
    }
    return ensureLinkId(normalizeLeafNode(node));
  });
}

function countOverlayLeaves(nodes) {
  let count = 0;
  for (const node of nodes || []) {
    if (node.children) {
      count += countOverlayLeaves(node.children);
    } else {
      count += 1;
    }
  }
  return count;
}

function findCustomLeafIndex(nodes, importedNode) {
  if (importedNode.id) {
    const byId = nodes.findIndex(
      (node) => !node.children && node.id === importedNode.id
    );
    if (byId !== -1) {
      return byId;
    }
  }

  return nodes.findIndex(
    (node) => !node.children && node.id && node.name === importedNode.name
  );
}

function mergeOverlayChildren(existingChildren, importedChildren) {
  const result = existingChildren.slice();

  for (const importedNode of importedChildren) {
    if (importedNode.children) {
      const folderIndex = result.findIndex(
        (node) => node.children && node.name === importedNode.name
      );
      if (folderIndex !== -1) {
        const existingFolder = result[folderIndex];
        result[folderIndex] = {
          ...existingFolder,
          ...(Object.prototype.hasOwnProperty.call(importedNode, "match")
            ? { match: importedNode.match }
            : {}),
          children: mergeOverlayChildren(
            existingFolder.children || [],
            importedNode.children
          ),
        };
      } else {
        result.push(normalizeImportedNodes([importedNode])[0]);
      }
      continue;
    }

    const replaceIndex = findCustomLeafIndex(result, importedNode);
    if (replaceIndex !== -1) {
      const existing = result[replaceIndex];
      result[replaceIndex] = {
        ...importedNode,
        id: existing.id,
      };
    } else {
      result.push(ensureLinkId(importedNode));
    }
  }

  return result;
}

function mergeSectionOverlay(existingSection, importedSection) {
  const existingChildren = Array.isArray(existingSection?.children)
    ? existingSection.children
    : [];
  const importedChildren = Array.isArray(importedSection?.children)
    ? importedSection.children
    : [];

  const merged = { ...(existingSection || {}) };

  for (const key of EXPORTABLE_SECTION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(importedSection || {}, key)) {
      merged[key] = importedSection[key];
    }
  }

  merged.children = mergeOverlayChildren(existingChildren, importedChildren);
  return merged;
}

function normalizeImportSectionEntries(importedOverlay) {
  const mergedEntries = new Map();

  for (const [sectionName, section] of Object.entries(importedOverlay)) {
    const existing = mergedEntries.get(sectionName);
    mergedEntries.set(
      sectionName,
      existing ? mergeSectionOverlay(existing, section) : section
    );
  }

  return mergedEntries;
}

export function importOverlayIntoExisting(existingOverlay, raw) {
  const importedOverlay = parseImportOverlay(raw);
  const overlay = { ...(existingOverlay || {}) };
  const sectionNames = [];
  let importedLeafCount = 0;

  for (const [sectionName, section] of normalizeImportSectionEntries(
    importedOverlay
  )) {
    if (Object.prototype.hasOwnProperty.call(section, "hostPattern")) {
      throw new Error(`Section "${sectionName}" uses removed field "hostPattern".`);
    }
    (section.children || []).forEach((node, index) =>
      validateImportNode(node, `${sectionName}.${index}`)
    );

    importedLeafCount += countOverlayLeaves(section.children);
    overlay[sectionName] = mergeSectionOverlay(overlay[sectionName], section);
    sectionNames.push(sectionName);
  }

  if (!importedLeafCount) {
    throw new Error("No links found in file.");
  }

  return {
    overlay,
    importedLeafCount,
    sectionNames,
  };
}

function pickOverlayNodes(nodes, overlayLinkIds) {
  const out = [];
  for (const node of nodes || []) {
    if (node?.children) {
      const children = pickOverlayNodes(node.children, overlayLinkIds);
      if (!children.length) {
        continue;
      }
      const folder = { name: node.name, children };
      if (Object.prototype.hasOwnProperty.call(node, "match")) {
        folder.match = node.match;
      }
      out.push(folder);
      continue;
    }
    if (node?.id && overlayLinkIds?.has(node.id)) {
      out.push(node);
    }
  }
  return out;
}

/**
 * Overlay-shaped catalog from a merged ordered tree: custom leaves only,
 * with folder shells for their effective paths (including bundled folders).
 */
export function overlayTreeFromMerged(merged, overlayLinkIds) {
  const result = {};
  for (const [sectionName, section] of Object.entries(merged || {})) {
    const children = pickOverlayNodes(section?.children, overlayLinkIds);
    if (!children.length) {
      continue;
    }
    result[sectionName] = {
      ...section,
      children,
    };
  }
  return result;
}

export function overlayExport(overlay) {
  if (!overlay || typeof overlay !== "object") {
    return {};
  }

  const result = {};
  for (const [sectionName, section] of Object.entries(overlay)) {
    if (!section?.children?.length) {
      continue;
    }
    result[sectionName] = serializeSection(section);
  }
  return result;
}

