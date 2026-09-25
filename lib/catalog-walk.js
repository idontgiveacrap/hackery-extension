/**
 * Catalog tree walk: stable keys, inherited match, parent pointers.
 */
const CATALOG_KEY = "__catalogKey";

/**
 * Inherited match for a node. Explicit `match` (including null) wins.
 * @param {object} node
 * @param {string|null} inherited
 */
export function resolveMatch(node, inherited) {
  if (Object.prototype.hasOwnProperty.call(node, "match")) {
    return node.match || null;
  }
  return inherited ?? null;
}

/**
 * Inherited exclude for a node. Explicit `exclude` (including null) wins.
 * @param {object} node
 * @param {string|null} inherited
 */
export function resolveExclude(node, inherited) {
  if (Object.prototype.hasOwnProperty.call(node, "exclude")) {
    return node.exclude || null;
  }
  return inherited ?? null;
}

/**
 * Stable key for shortcuts and ordering.
 * Prefer id; fall back to section/folder path/name for leaves without one.
 */
export function linkStableKey(sectionName, pathParts, node) {
  if (node?.id) {
    return `id:${node.id}`;
  }
  const parts = [sectionName, ...(pathParts || []), node?.name || ""]
    .map((p) => String(p).replace(/\//g, "\\/"))
    .filter((p) => p !== "");
  return parts.join("/");
}

export function folderStableKey(sectionName, pathParts, folderName) {
  const parts = [sectionName, ...(pathParts || []), folderName || ""]
    .map((p) => String(p).replace(/\//g, "\\/"));
  return `folder:${parts.join("/")}`;
}

export function stampCatalogKey(node, key) {
  Object.defineProperty(node, CATALOG_KEY, {
    value: key,
    enumerable: false,
    configurable: true,
  });
}

export function nodeCatalogKey(node, sectionName, pathParts) {
  if (node?.[CATALOG_KEY]) {
    return node[CATALOG_KEY];
  }
  if (node?.children) {
    return folderStableKey(sectionName, pathParts, node.name);
  }
  return linkStableKey(sectionName, pathParts, node);
}

/**
 * Walk a children array. Visitor receives folders and leaves.
 * @param {object[]} nodes
 * @param {{
 *   sectionName: string,
 *   pathParts?: string[],
 *   inheritedMatch?: string|null,
 *   inheritedExclude?: string|null,
 *   parentKey?: string|null,
 *   parentList?: object[],
 *   stampKeys?: boolean,
 * }} context
 * @param {(entry: object) => void} visitor
 */
export function walkCatalogNodes(nodes, context, visitor) {
  const sectionName = context.sectionName;
  const pathParts = context.pathParts || [];
  const inheritedMatch = context.inheritedMatch ?? null;
  const inheritedExclude = context.inheritedExclude ?? null;
  const parentKey = context.parentKey ?? null;
  const parentList = context.parentList || nodes || [];
  const stampKeys = Boolean(context.stampKeys);

  for (const node of nodes || []) {
    const match = resolveMatch(node, inheritedMatch);
    const exclude = resolveExclude(node, inheritedExclude);
    const isFolder = Boolean(node?.children);
    const key = isFolder
      ? folderStableKey(sectionName, pathParts, node.name)
      : linkStableKey(sectionName, pathParts, node);
    if (stampKeys) {
      stampCatalogKey(node, key);
    }
    visitor({
      kind: isFolder ? "folder" : "leaf",
      node,
      sectionName,
      pathParts,
      key,
      match,
      exclude,
      parentKey,
      parentList,
    });
    if (isFolder) {
      walkCatalogNodes(
        node.children,
        {
          sectionName,
          pathParts: [...pathParts, node.name],
          inheritedMatch: match,
          inheritedExclude: exclude,
          parentKey: key,
          parentList: node.children,
          stampKeys,
        },
        visitor
      );
    }
  }
}

/**
 * Walk every section in a catalog object.
 * @param {object} catalog
 * @param {(entry: object) => void} visitor
 * @param {{ stampKeys?: boolean }} [options]
 */
export function walkCatalog(catalog, visitor, options = {}) {
  const stampKeys = Boolean(options.stampKeys);
  for (const [sectionName, section] of Object.entries(catalog || {})) {
    const children = Array.isArray(section?.children) ? section.children : [];
    walkCatalogNodes(
      children,
      {
        sectionName,
        pathParts: [],
        inheritedMatch: section?.match ?? null,
        inheritedExclude: section?.exclude ?? null,
        parentKey: null,
        parentList: children,
        stampKeys,
      },
      visitor
    );
  }
}
