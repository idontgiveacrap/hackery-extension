import { MessageTypes } from "../lib/message-types.js";
import { respondAsync } from "../lib/message-router.js";
import {
  defaultNetworkRulesState,
  normalizeNetworkRulesState,
} from "./engine/network-rules-shared.js";
import { NetworkMessageTypes } from "./message-types.js";

/**
 * Message handlers owned by the network-rules plugin.
 * @param {object} ctx Plugin runtime methods (from network/background.js).
 */
export function createNetworkMessageHandlers(ctx) {
  const {
    NETWORK_RULES_KEY,
    NETWORK_RULES_LOG_KEY,
    loadNetworkTabState,
    installNetworkHookInTab,
    refreshNetworkRulesState,
    reinjectNetworkHookAllTabs,
    loadNetworkRulesState,
    appendNetworkRuleLog,
    persistSharedState,
    pageHookRules,
    validateNetworkLogToken,
    startTestRuleSession,
    getNetworkArmSnapshot,
    setNetworkArmed,
    resetNetworkArmTimer,
    loadNetworkHooksEnabled,
  } = ctx;

  const T = NetworkMessageTypes;
  const HT = MessageTypes;

  return {
    [T.INSTALL_NETWORK_HOOK](_message, sender, sendResponse) {
      const tabId = sender.tab?.id;
      const frameId = sender.frameId;
      if (!tabId) {
        sendResponse({ ok: false, error: "Missing tab id." });
        return false;
      }
      if (!pageHookRules().length) {
        sendResponse({ ok: true });
        return false;
      }
      respondAsync(
        (async () => {
          await loadNetworkTabState();
          await installNetworkHookInTab(tabId, frameId);
          return { ok: true };
        })(),
        sendResponse
      );
      return true;
    },

    [T.REFRESH_NETWORK_RULES](_message, _sender, sendResponse) {
      respondAsync(
        refreshNetworkRulesState()
          .then(() => reinjectNetworkHookAllTabs())
          .then(() => ({ ok: true })),
        sendResponse
      );
      return true;
    },

    [T.GET_NETWORK_RULES](_message, _sender, sendResponse) {
      respondAsync(
        loadNetworkRulesState().then((state) => ({ ok: true, state })),
        sendResponse
      );
      return true;
    },

    [T.SAVE_NETWORK_RULES](message, _sender, sendResponse) {
      const nextState = normalizeNetworkRulesState(
        message.state || defaultNetworkRulesState()
      );
      respondAsync(
        browser.storage.local
          .set({ [NETWORK_RULES_KEY]: nextState })
          .then(() => ({ ok: true })),
        sendResponse
      );
      return true;
    },

    [T.NETWORK_RULE_LOG](message, sender, sendResponse) {
      if (!validateNetworkLogToken(message.token)) {
        sendResponse({ ok: false, error: "Invalid network hook token." });
        return false;
      }
      respondAsync(
        appendNetworkRuleLog(message.entry, sender.tab?.id).then(() => ({ ok: true })),
        sendResponse
      );
      return true;
    },

    [T.NETWORK_SHARED_STATE](message, sender, sendResponse) {
      if (!validateNetworkLogToken(message.token)) {
        sendResponse({ ok: false, error: "Invalid network hook token." });
        return false;
      }
      const tabId = sender.tab?.id;
      respondAsync(
        (async () => {
          await persistSharedState(message.persistent, message.tab, tabId);
          if (tabId != null) {
            await loadNetworkTabState();
            await installNetworkHookInTab(tabId);
          }
          return { ok: true };
        })(),
        sendResponse
      );
      return true;
    },

    [T.CLEAR_NETWORK_RULE_LOG](_message, _sender, sendResponse) {
      respondAsync(
        browser.storage.session
          .set({ [NETWORK_RULES_LOG_KEY]: [] })
          .then(() => ({ ok: true })),
        sendResponse
      );
      return true;
    },

    [T.TEST_NETWORK_RULE](message, _sender, sendResponse) {
      const ruleId = message.ruleId;
      const url = String(message.url || "").trim();
      if (!ruleId || !url) {
        sendResponse({ ok: false, error: "Rule id and URL are required." });
        return false;
      }
      respondAsync(
        startTestRuleSession(ruleId, url).then((result) => ({ ok: true, ...result })),
        sendResponse
      );
      return true;
    },

    [HT.GET_NETWORK_ARM](_message, _sender, sendResponse) {
      respondAsync(
        (async () => {
          await loadNetworkHooksEnabled();
          await loadNetworkRulesState();
          return { ok: true, ...getNetworkArmSnapshot() };
        })(),
        sendResponse
      );
      return true;
    },

    [HT.SET_NETWORK_ARM](message, _sender, sendResponse) {
      respondAsync(
        (async () => {
          if (message.reset) {
            const arm = await resetNetworkArmTimer();
            return { ok: true, ...arm };
          }
          await setNetworkArmed(Boolean(message.armed));
          return { ok: true, ...getNetworkArmSnapshot() };
        })(),
        sendResponse
      );
      return true;
    },
  };
}
