/**
 * MAIN-world document_start gate. It captures requests made before the
 * configured network hook arrives, then hands them to that hook. If extension
 * setup fails, requests fall through to native APIs after a short delay.
 */
(function () {
  const root = globalThis;
  if (
    root.__HackeryLabNetworkHook ||
    root.__HackeryLabNetworkEarlyHook ||
    root.__ComplexLinkerNetworkHook ||
    root.__ComplexLinkerNetworkEarlyHook
  ) {
    return;
  }

  const natives = {
    fetch: root.fetch.bind(root),
    xhrOpen: XMLHttpRequest.prototype.open,
    xhrSend: XMLHttpRequest.prototype.send,
    xhrSetRequestHeader: XMLHttpRequest.prototype.setRequestHeader,
  };
  let release;
  const configured = new Promise((resolve) => {
    release = resolve;
  });
  const readyOrTimeout = Promise.race([
    configured,
    new Promise((resolve) => root.setTimeout(resolve, 250)),
  ]);

  /**
   * Queue fetch until configuration arrives, then use the configured hook.
   * @param {RequestInfo | URL} input
   * @param {RequestInit} [init]
   * @returns {Promise<Response>}
   */
  function HackeryLabEarlyFetch(input, init) {
    return readyOrTimeout.then(() => {
      const nextFetch =
        root.fetch === HackeryLabEarlyFetch ? natives.fetch : root.fetch;
      return nextFetch(input, init);
    });
  }

  /**
   * Capture XHR metadata before the configured hook replaces this wrapper.
   * @param {string} method
   * @param {string | URL} url
   * @param {boolean} [async]
   * @param {string} [user]
   * @param {string} [password]
   * @returns {void}
   */
  function HackeryLabEarlyOpen(method, url, async, user, password) {
    this.__HackeryLab = {
      method: String(method || "GET").toUpperCase(),
      url: String(url),
      async: async !== false,
      user,
      password,
      headers: {},
    };
    return natives.xhrOpen.call(this, method, url, async, user, password);
  }

  /**
   * Capture request headers for an XHR queued before hook configuration.
   * @param {string} name
   * @param {string} value
   * @returns {void}
   */
  function HackeryLabEarlySetRequestHeader(name, value) {
    if (this.__HackeryLab) {
      this.__HackeryLab.headers[name] = value;
    }
    return natives.xhrSetRequestHeader.call(this, name, value);
  }

  /**
   * Queue asynchronous XHR sends until configuration; synchronous XHR must
   * remain synchronous and therefore falls through immediately.
   * @param {Document | XMLHttpRequestBodyInit | null} [body]
   * @returns {void}
   */
  function HackeryLabEarlySend(body) {
    if (this.__HackeryLab?.async === false) {
      return natives.xhrSend.call(this, body);
    }
    const xhr = this;
    readyOrTimeout.then(() => {
      const nextSend =
        XMLHttpRequest.prototype.send === HackeryLabEarlySend
          ? natives.xhrSend
          : XMLHttpRequest.prototype.send;
      nextSend.call(xhr, body);
    });
  }

  root.__HackeryLabNetworkEarlyHook = { natives, release };
  root.fetch = HackeryLabEarlyFetch;
  XMLHttpRequest.prototype.open = HackeryLabEarlyOpen;
  XMLHttpRequest.prototype.send = HackeryLabEarlySend;
  XMLHttpRequest.prototype.setRequestHeader = HackeryLabEarlySetRequestHeader;
})();
