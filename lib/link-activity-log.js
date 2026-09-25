/**
 * Session-backed catalog activity log (runs, derivations, on-load skips).
 */
export const ACTIVITY_LOG_LIMIT = 100;
export const ACTIVITY_LOG_KEY = "linkActivityLog";

/**
 * Append one entry, dropping oldest past the cap.
 * @param {object[]} existing
 * @param {object} entry
 * @param {number} [maxEntries]
 */
export function appendActivityLogQueue(existing, entry, { maxEntries = ACTIVITY_LOG_LIMIT } = {}) {
  const list = Array.isArray(existing) ? existing : [];
  return [...list, entry].slice(-maxEntries);
}
