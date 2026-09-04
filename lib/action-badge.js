/**
 * Single writer for browser.action badge text/color and hover title.
 * Features contribute marks; the host merges them so writers do not race.
 */
export const BADGE_COLOR = "#81b5a1";
export const DEFAULT_ACTION_TITLE = "Hackery Lab";

/** @type {Map<number, { networkMatched?: boolean }>} */
const tabFlags = new Map();

/**
 * @param {number} tabId
 * @param {{ networkMatched?: boolean }} patch
 */
export function patchTabFlags(tabId, patch) {
  if (tabId == null || tabId < 0) {
    return;
  }
  const prev = tabFlags.get(tabId) || {};
  tabFlags.set(tabId, { ...prev, ...patch });
}

/**
 * @param {number} tabId
 */
export function clearTabFlags(tabId) {
  tabFlags.delete(tabId);
}

export function getTabFlags(tabId) {
  return tabFlags.get(tabId) || {};
}

/**
 * @param {number} tabId
 * @param {string} text
 */
export async function setBadgeText(tabId, text) {
  if (tabId == null || tabId < 0) {
    return;
  }
  try {
    await browser.action.setBadgeBackgroundColor({ color: BADGE_COLOR, tabId });
    await browser.action.setBadgeText({ text: text || "", tabId });
  } catch {
    // badge unsupported or tab gone
  }
}

/**
 * @param {number} tabId
 * @param {string} [title]
 */
export async function setActionTitle(tabId, title) {
  if (tabId == null || tabId < 0) {
    return;
  }
  try {
    await browser.action.setTitle({
      title: title || DEFAULT_ACTION_TITLE,
      tabId,
    });
  } catch {
    // title unsupported or tab gone
  }
}

/**
 * Merge contributor marks into one badge string.
 * Convention: network "●", inject "+", both "●+".
 * @param {{ network?: string, inject?: string }} marks
 */
export function mergeMarks(marks) {
  const network = marks.network || "";
  const inject = marks.inject || "";
  if (network && inject) {
    return `${network}${inject}`;
  }
  return network || inject || "";
}

/**
 * Build the toolbar hover title from badge contributors.
 * @param {number} tabId
 * @param {{ network?: string, inject?: string }} marks
 * @returns {string}
 */
export function titleFromMarks(tabId, marks) {
  const parts = [];
  if (marks.network) {
    if (getTabFlags(tabId).networkMatched) {
      parts.push("network rule matched on this tab");
    } else {
      parts.push("active network hooks");
    }
  }
  if (marks.inject) {
    parts.push("inject-on-load applies to this page");
  }
  if (!parts.length) {
    return DEFAULT_ACTION_TITLE;
  }
  return `${DEFAULT_ACTION_TITLE} — ${parts.join("; ")}`;
}

/**
 * @param {number} tabId
 * @param {{ network?: string, inject?: string }} marks
 */
export async function refresh(tabId, marks) {
  await setBadgeText(tabId, mergeMarks(marks));
  await setActionTitle(tabId, titleFromMarks(tabId, marks));
}
