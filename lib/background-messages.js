import { MessageTypes } from "./message-types.js";
import { respondAsync } from "./message-router.js";
import {
  getCspFramePolicy,
  getCspNonce,
  getCspPunchReason,
} from "./csp-nonce.js";

/**
 * @param {object} ctx
 * @param {string} ctx.INJECT_ON_LOAD_ENABLED_KEY
 * @param {Function} ctx.extensionSettings
 * @param {Function} ctx.codesForUrl
 * @param {Function} ctx.runInjectEntriesForTab
 * @param {Function} ctx.executeScriptletInTab
 * @param {Function} ctx.refreshInjectState
 * @param {Function} ctx.loadExtensionSettings
 * @param {Function} [ctx.getCspNonceForTab]
 * @param {Function} [ctx.setCspNonceForTab]
 * @param {Function} [ctx.whenCspComposeReady]
 * @param {Function} [ctx.appendActivityLog]
 * @param {Function} [ctx.getActivityLog]
 * @param {Function} [ctx.logOnLoadSkips]
 */
export function createBackgroundMessageHandlers(ctx) {
  const {
    INJECT_ON_LOAD_ENABLED_KEY,
    extensionSettings,
    codesForUrl,
    runInjectEntriesForTab,
    executeScriptletInTab,
    refreshInjectState,
    loadExtensionSettings,
    collectNetworkSettingsPayload,
    getCspNonceForTab,
    setCspNonceForTab,
    whenCspComposeReady,
    appendActivityLog,
    getActivityLog,
    clearActivityLog,
    logOnLoadSkips,
  } = ctx;

  const T = MessageTypes;

  return {
    [T.RUN_SCRIPTLET](message, _sender, sendResponse) {
      respondAsync(
        executeScriptletInTab(
          message.tabId,
          message.code,
          message.paramValues || {},
          { frameId: message.frameId, sandbox: message.sandbox }
        ).then(() => ({ ok: true })),
        sendResponse
      );
      return true;
    },

    [T.RUN_INJECT_CODES](message, sender, sendResponse) {
      const tabId = sender.tab?.id;
      const frameId = sender.frameId;
      if (!tabId) {
        sendResponse({ ok: false, error: "Missing tab id." });
        return false;
      }
      const pageUrl = message.url || "";
      const runAt = message.runAt || "document_start";
      if (!extensionSettings().injectOnLoadEnabled) {
        respondAsync(
          Promise.resolve(logOnLoadSkips?.(pageUrl, { masterOff: true })).then(
            () => ({ ok: true, needEnd: false, needIdle: false })
          ),
          sendResponse
        );
        return true;
      }
      const all = codesForUrl(pageUrl);
      const needEnd = all.some((entry) => entry.runAt === "document_end");
      const needIdle = all.some((entry) => entry.runAt === "document_idle");
      const entries = all.filter(
        (entry) => (entry.runAt || "document_start") === runAt
      );
      respondAsync(
        Promise.resolve(
          runAt === "document_start" ? logOnLoadSkips?.(pageUrl) : undefined
        )
          .then(() =>
            runInjectEntriesForTab(tabId, entries, frameId, {
              trigger: "on-load",
              runAt,
              pageUrl,
            })
          )
          .then(() => ({ ok: true, needEnd, needIdle })),
        sendResponse
      );
      return true;
    },

    [T.REFRESH_INJECT](_message, _sender, sendResponse) {
      respondAsync(refreshInjectState().then(() => ({ ok: true })), sendResponse);
      return true;
    },

    [T.GET_EXTENSION_SETTINGS](_message, _sender, sendResponse) {
      respondAsync(
        loadExtensionSettings().then((settings) => ({ ok: true, settings })),
        sendResponse
      );
      return true;
    },

    [T.SET_EXTENSION_SETTINGS](message, _sender, sendResponse) {
      const next = message.settings || {};
      const payload = {};
      if (typeof next.injectOnLoadEnabled === "boolean") {
        payload[INJECT_ON_LOAD_ENABLED_KEY] = next.injectOnLoadEnabled;
      }
      if (collectNetworkSettingsPayload) {
        Object.assign(payload, collectNetworkSettingsPayload(next));
      }
      respondAsync(
        browser.storage.local.set(payload).then(() => ({ ok: true })),
        sendResponse
      );
      return true;
    },

    // Both handlers await hydration: after an event-page wake-up the
    // disabled-tab set is still in storage.session, so answering synchronously
    // would report every tab as enabled and overwrite the stored set.
    [T.GET_CSP_NONCE](message, _sender, sendResponse) {
      respondAsync(
        Promise.resolve(whenCspComposeReady?.()).then(() => ({
          ok: true,
          enabled: Boolean(getCspNonceForTab?.(message.tabId)),
        })),
        sendResponse
      );
      return true;
    },

    [T.SET_CSP_NONCE](message, _sender, sendResponse) {
      respondAsync(
        Promise.resolve(whenCspComposeReady?.())
          .then(() => setCspNonceForTab?.(message.tabId, Boolean(message.enabled)))
          .then(() => ({ ok: true })),
        sendResponse
      );
      return true;
    },

    [T.GET_FRAME_CSP](message, _sender, sendResponse) {
      const frames = {};
      for (const frameId of message.frameIds || []) {
        frames[frameId] = {
          nonce: getCspNonce(message.tabId, frameId),
          diag: getCspPunchReason(message.tabId, frameId),
          seen: getCspFramePolicy(message.tabId, frameId),
        };
      }
      sendResponse({ ok: true, frames });
      return false;
    },

    [T.APPEND_ACTIVITY_LOG](message, _sender, sendResponse) {
      respondAsync(
        appendActivityLog(message.entry || {}).then(() => ({ ok: true })),
        sendResponse
      );
      return true;
    },

    [T.GET_ACTIVITY_LOG](_message, _sender, sendResponse) {
      respondAsync(
        getActivityLog().then((entries) => ({ ok: true, entries })),
        sendResponse
      );
      return true;
    },

    [T.CLEAR_ACTIVITY_LOG](_message, _sender, sendResponse) {
      respondAsync(clearActivityLog().then(() => ({ ok: true })), sendResponse);
      return true;
    },
  };
}
