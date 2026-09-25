/**
 * Shared fuzzy scoring for sidebar search and omnibox suggestions.
 */
import { walkCatalog } from "./catalog-walk.js";

export function normalizeSearchQuery(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase();
}

export function isExactSearchMatch(label, query) {
  return Boolean(query) && String(label).toLowerCase() === query;
}

export function searchMatchScore(label, query) {
  if (!query) {
    return 1;
  }

  const normalizedLabel = String(label).toLowerCase();
  if (normalizedLabel === query) {
    return 1000;
  }
  if (normalizedLabel.startsWith(query)) {
    return 500 + Math.max(0, 100 - query.length);
  }

  const index = normalizedLabel.indexOf(query);
  if (index === -1) {
    return 0;
  }

  return 200 - index;
}

export function displayLabel(node) {
  return node.name || "";
}

export function getSearchTags(node) {
  if (!Array.isArray(node.searchTags)) {
    return [];
  }
  return node.searchTags
    .filter((tag) => typeof tag === "string")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function nodeSearchScore(node, query) {
  const q = normalizeSearchQuery(query);
  if (!q) {
    return 1;
  }

  let score = searchMatchScore(displayLabel(node), q);
  for (const tag of getSearchTags(node)) {
    score = Math.max(score, searchMatchScore(tag, q));
  }
  return score;
}

export function nodeHasExactSearchMatch(node, query) {
  const q = normalizeSearchQuery(query);
  if (!q) {
    return false;
  }
  if (isExactSearchMatch(displayLabel(node), q)) {
    return true;
  }
  return getSearchTags(node).some((tag) => isExactSearchMatch(tag, q));
}

/**
 * Score a leaf against a query for omnibox / flat search.
 * @returns {{ node: object, score: number, label: string, key?: string }}
 */
export function scoreLink(query, node, key) {
  const q = normalizeSearchQuery(query);
  const label = displayLabel(node);
  const scored = {
    node,
    score: nodeSearchScore(node, q),
    label,
  };
  if (key) {
    scored.key = key;
  }
  return scored;
}

/**
 * Walk catalog sections and return scored matches (score > 0), best first.
 * Each match includes the leaf stable `key` for unambiguous activation.
 */
export function searchCatalog(catalog, query, limit = 10) {
  const q = normalizeSearchQuery(query);
  const results = [];

  walkCatalog(catalog, (entry) => {
    if (entry.kind !== "leaf") {
      return;
    }
    const enriched = {
      ...entry.node,
      match: entry.match,
      sectionName: entry.sectionName,
    };
    const scored = scoreLink(q, enriched, entry.key);
    if (!q || scored.score > 0) {
      results.push(scored);
    }
  });
  results.sort(
    (a, b) => b.score - a.score || a.label.localeCompare(b.label)
  );
  return results.slice(0, limit);
}
