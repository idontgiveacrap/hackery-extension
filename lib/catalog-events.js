/**
 * Typed catalog-change broadcast for sidebar, inject cache, badge, omnibox.
 */
export const CATALOG_CHANGED = "CATALOG_CHANGED";

export function emitCatalogChanged(detail = {}) {
  const message = {
    type: CATALOG_CHANGED,
    reason: detail.reason || "update",
    at: Date.now(),
    ...detail,
  };
  try {
    browser.runtime.sendMessage(message).catch(() => {});
  } catch {
    // No receiver yet (startup) is fine.
  }
  return message;
}

export function isCatalogChangedMessage(message) {
  return message && message.type === CATALOG_CHANGED;
}
