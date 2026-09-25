/**
 * Classic content script. Cannot import ESM message-types;
 * string must stay in sync with NetworkMessageTypes.INSTALL_NETWORK_HOOK
 * in network/message-types.js.
 */
(function () {
  browser.runtime
    .sendMessage({ type: "INSTALL_NETWORK_HOOK" })
    .catch(() => {});
})();
