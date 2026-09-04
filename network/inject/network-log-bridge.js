/**
 * Isolated-world bridge for messages emitted by the page-world network hook.
 * The background validates the forwarded token before accepting either message.
 * Safe to inject repeatedly (Re-inject / per-frame install).
 */
(function () {
  const previousHandler =
    globalThis.__hackeryLabNetworkLogBridgeHandler ||
    globalThis.__complexLinkerNetworkLogBridgeHandler;
  if (previousHandler) {
    window.removeEventListener("message", previousHandler);
  }

  /**
   * Forward network hook events to the extension background.
   * @param {MessageEvent} event Window message emitted by the page-world hook.
   */
  function handleNetworkHookMessage(event) {
    if (event.source !== window) {
      return;
    }
    const data = event.data;
    if (
      !data ||
      (data.source !== "hackery-lab-network-hook" &&
        data.source !== "complex-linker-network-hook")
    ) {
      return;
    }
    if (data.type === "log") {
      browser.runtime
        .sendMessage({
          type: "NETWORK_RULE_LOG",
          token: data.token,
          entry: data.entry,
        })
        .catch(() => {});
      return;
    }
    if (data.type === "sharedState") {
      browser.runtime
        .sendMessage({
          type: "NETWORK_SHARED_STATE",
          token: data.token,
          persistent: data.persistent,
          tab: data.tab,
        })
        .catch(() => {});
    }
  }

  globalThis.__hackeryLabNetworkLogBridgeHandler = handleNetworkHookMessage;
  window.addEventListener("message", handleNetworkHookMessage);
})();
