/**
 * Public plugin facade for network rules.
 *
 * Host contract (Hackery Lab today):
 * 1. Import this module from the ESM background entry.
 * 2. Call init({ onRulesChanged }) during extension init.
 * 3. Merge createMessageHandlers() into the runtime message router.
 * 4. Forward storage.onChanged / tabs.onRemoved to the plugin handlers.
 * 5. Ask getBadgeMark(tabId) when refreshing the action badge.
 *
 * To ship as a separate extension later: copy the network/ tree, point a new
 * manifest at network/ui + the permissions listed below, and replace the host
 * merge with a thin background module that only calls this plugin.
 */
import {
  collectSettingsPayload,
  createMessageHandlers,
  getBadgeMark,
  getSettingsFragment,
  handleStorageChange,
  handleTabRemoved,
  init,
} from "./background.js";

export const permissions = [
  "scripting",
  "storage",
  "tabs",
  "webNavigation",
  "webRequest",
  "webRequestBlocking",
  "webRequestFilterResponse",
];

export const hostPermissions = ["<all_urls>"];
export const uiPanel = "network/ui/rules.html";

export {
  init,
  createMessageHandlers,
  handleStorageChange,
  handleTabRemoved,
  getBadgeMark,
  getSettingsFragment,
  collectSettingsPayload,
};
