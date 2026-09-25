/**
 * Classic content script (document_start). Cannot import ESM message-types;
 * strings must stay in sync with MessageTypes.RUN_INJECT_CODES in lib/message-types.js.
 *
 * Background injects document_start entries immediately. This script waits
 * locally for document_end / document_idle so the event page is not required
 * to stay alive across those gaps.
 */
(function () {
  const TYPE = "RUN_INJECT_CODES";

  function request(runAt) {
    return browser.runtime
      .sendMessage({ type: TYPE, url: location.href, runAt })
      .catch(() => null);
  }

  function whenDomReady(callback) {
    if (document.readyState !== "loading") {
      callback();
      return;
    }
    document.addEventListener("DOMContentLoaded", callback, { once: true });
  }

  function whenIdle(callback) {
    function afterLoad() {
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(() => callback(), { timeout: 2000 });
        return;
      }
      callback();
    }
    if (document.readyState === "complete") {
      afterLoad();
      return;
    }
    window.addEventListener("load", afterLoad, { once: true });
  }

  request("document_start").then((response) => {
    if (!response) {
      return;
    }
    if (response.needEnd) {
      whenDomReady(() => {
        request("document_end");
      });
    }
    if (response.needIdle) {
      whenIdle(() => {
        request("document_idle");
      });
    }
  });
})();
