  const root = typeof globalThis !== "undefined" ? globalThis : window;
  const prevHook =
    root.__HackeryLabNetworkHook || root.__ComplexLinkerNetworkHook;
  const injectedTabUrl =
    typeof sharedStateBundle?.tabUrl === "string" ? sharedStateBundle.tabUrl : "";
  if (
    prevHook?.version === version &&
    prevHook?.logToken === logToken &&
    prevHook?.tabUrl === injectedTabUrl
  ) {
    return;
  }

  /**
   * PAGE URL uses the top-level tab URL when readable; otherwise the URL from
   * the background inject, then this frame's location.
   * @returns {string}
   */
  function resolveMatchingPageUrl() {
    try {
      const topHref = root.top?.location?.href;
      if (topHref) {
        return topHref;
      }
    } catch {
      // Cross-origin iframe cannot read top.location.
    }
    if (injectedTabUrl) {
      return injectedTabUrl;
    }
    return root.location.href;
  }

  const patternEngine = createNetworkRuleEngine();
  const compiledById = {};
  for (const rule of rules || []) {
    if (rule?.id) {
      compiledById[rule.id] = patternEngine.compileRulePatterns(rule);
    }
  }

  const compiledRules = patternEngine.attachCompiledPatterns(rules || [], compiledById);
  const inspectRequestBody = compiledRules.some(
    (rule) =>
      rule.requestBodyPattern ||
      rule.modify?.bodyReplacements?.length ||
      rule.modify?.requestScript?.trim()
  );

  const persistentState = sharedStateBundle?.persistent
    ? { ...sharedStateBundle.persistent }
    : {};
  const tabState = sharedStateBundle?.tab ? { ...sharedStateBundle.tab } : {};

  const stateView = {
    persistent: persistentState,
    tab: tabState,
  };

  let hookDepth = 0;
  const activeRuleStack = [];

  const engine = createNetworkRuleEngine({
    resolveBaseUrl: (ctx) => ctx.pageUrl || root.location.href,
    afterRuleScript: ({ error, ctx, rule }) => {
      postSharedStateUpdate();
      if (error) {
        postLog({
          ruleId: rule.id,
          ruleName: rule.name,
          phase: ctx.phase,
          method: ctx.method,
          url: ctx.url,
          pageUrl: ctx.pageUrl,
          outcome: "error",
          detail: String(error),
        });
      }
    },
  });

  const {
    ruleMatches,
    applyModifyReplacements,
    runRuleScript,
    ruleServesWithoutRequest,
    buildMockResponseContext,
    getSortedEnabledRules,
    bodyToString,
  } = engine;

  function attachSharedState(ctx) {
    return engine.attachSharedState(ctx, stateView);
  }

  function postSharedStateUpdate() {
    root.postMessage(
      {
        source: "hackery-lab-network-hook",
        type: "sharedState",
        token: logToken,
        persistent: stateView.persistent,
        tab: stateView.tab,
      },
      "*"
    );
  }

  function postLog(entry) {
    root.postMessage(
      {
        source: "hackery-lab-network-hook",
        type: "log",
        token: logToken,
        entry: { ...entry, ts: Date.now() },
      },
      "*"
    );
  }

  function sortedRules() {
    return getSortedEnabledRules(compiledRules);
  }

  function shouldSkipRule(rule, isHookOriginated) {
    if (activeRuleStack.includes(rule.id)) {
      return true;
    }
    if (isHookOriginated && !rule.matchHookOriginated) {
      return true;
    }
    return false;
  }

  function findMockRule(requestCtx, isHookOriginated) {
    for (const rule of sortedRules()) {
      if (shouldSkipRule(rule, isHookOriginated)) {
        continue;
      }
      if (!ruleServesWithoutRequest(rule)) {
        continue;
      }
      if (ruleMatches(rule, { ...requestCtx, phase: "request" })) {
        return rule;
      }
    }
    return null;
  }

  function processRules(phase, baseCtx, isHookOriginated = false) {
    const pageUrl = resolveMatchingPageUrl();
    let ctx = attachSharedState({ ...baseCtx, phase, pageUrl });

    for (const rule of sortedRules()) {
      if (shouldSkipRule(rule, isHookOriginated)) {
        continue;
      }
      if (!ruleMatches(rule, ctx)) {
        continue;
      }

      activeRuleStack.push(rule.id);
      try {
        if (rule.action === "block") {
          postLog({
            ruleId: rule.id,
            ruleName: rule.name,
            phase,
            method: ctx.method,
            url: ctx.url,
            pageUrl,
            outcome: "blocked",
            action: "block",
          });
          return null;
        }

        if (rule.action === "redirect" && rule.redirectUrl) {
          ctx.url = rule.redirectUrl;
          postLog({
            ruleId: rule.id,
            ruleName: rule.name,
            phase,
            method: ctx.method,
            url: ctx.url,
            pageUrl,
            outcome: "redirect",
            action: "redirect",
          });
          continue;
        }

        if (rule.action === "mock") {
          postLog({
            ruleId: rule.id,
            ruleName: rule.name,
            phase,
            method: ctx.method,
            url: ctx.url,
            pageUrl,
            outcome: "matched",
            action: "mock",
          });
          continue;
        }

        if (rule.action === "modify") {
          if (rule.modify?.serveWithoutRequest) {
            postLog({
              ruleId: rule.id,
              ruleName: rule.name,
              phase,
              method: ctx.method,
              url: ctx.url,
              pageUrl,
              outcome: "matched",
              action: "modify",
            });
            continue;
          }
          const snapshot = JSON.stringify({
            url: ctx.url,
            headers: ctx.headers,
            body: ctx.body,
          });
          ctx = applyModifyReplacements(ctx, rule);
          const script =
            phase === "response"
              ? rule.modify?.responseScript
              : rule.modify?.requestScript;
          ctx = runRuleScript(ctx, script, rule, stateView);
          if (ctx === null) {
            postLog({
              ruleId: rule.id,
              ruleName: rule.name,
              phase,
              method: baseCtx.method,
              url: baseCtx.url,
              pageUrl,
              outcome: "blocked",
              action: "modify",
            });
            return null;
          }
          const changed =
            JSON.stringify({
              url: ctx.url,
              headers: ctx.headers,
              body: ctx.body,
            }) !== snapshot;
          postLog({
            ruleId: rule.id,
            ruleName: rule.name,
            phase,
            method: ctx.method,
            url: ctx.url,
            pageUrl,
            outcome: ctx.logDetail
              ? "observed"
              : changed
                ? "modified"
                : "matched",
            action: "modify",
            detail: ctx.logDetail,
          });
        }
      } finally {
        activeRuleStack.pop();
      }
    }

    return ctx;
  }

  function headersToObject(headers) {
    const out = {};
    if (!headers) {
      return out;
    }
    if (headers instanceof Headers) {
      headers.forEach((value, key) => {
        out[key] = value;
      });
      return out;
    }
    if (Array.isArray(headers)) {
      for (const [key, value] of headers) {
        out[key] = value;
      }
      return out;
    }
    return { ...headers };
  }

  function objectToHeaders(headers) {
    const next = new Headers();
    // Cookie/Origin/Referer/User-Agent are forbidden in page JS — send as
    // x-hackerylab-* and let webRequest rewrite them (see
    // rewritePrivilegedRequestHeaders).
    for (const [key, value] of Object.entries(
      encodePrivilegedRequestHeaders(headers)
    )) {
      next.set(key, value);
    }
    return next;
  }

  function parseXhrResponseHeaders(raw) {
    const headers = {};
    if (!raw) {
      return headers;
    }
    for (const line of raw.trim().split(/[\r\n]+/)) {
      const index = line.indexOf(":");
      if (index === -1) {
        continue;
      }
      headers[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    }
    return headers;
  }

  function deliverMockXhr(xhr, mockCtx, rule, requestCtx) {
    const pageUrl = resolveMatchingPageUrl();
    postLog({
      ruleId: rule.id,
      ruleName: rule.name,
      phase: "response",
      method: requestCtx.method,
      url: requestCtx.url,
      pageUrl,
      outcome: "mocked",
      action: rule.action,
    });

    const status = mockCtx?.status ?? 200;
    const body = mockCtx?.body ?? "";
    const statusText = mockCtx?.statusText ?? "OK";

    Object.defineProperty(xhr, "status", { configurable: true, value: status });
    Object.defineProperty(xhr, "statusText", {
      configurable: true,
      value: statusText,
    });
    Object.defineProperty(xhr, "responseText", {
      configurable: true,
      get() {
        return body;
      },
    });
    Object.defineProperty(xhr, "response", {
      configurable: true,
      get() {
        return body;
      },
    });
    Object.defineProperty(xhr, "readyState", {
      configurable: true,
      writable: true,
      value: 4,
    });

    root.setTimeout(() => {
      xhr.dispatchEvent(new ProgressEvent("loadstart"));
      xhr.dispatchEvent(new Event("readystatechange"));
      xhr.dispatchEvent(new ProgressEvent("load"));
      xhr.dispatchEvent(new ProgressEvent("loadend"));
    }, 0);
  }

  const earlyHook =
    root.__HackeryLabNetworkEarlyHook || root.__ComplexLinkerNetworkEarlyHook;
  const natives = prevHook?.natives || earlyHook?.natives || {
    fetch: root.fetch.bind(root),
    xhrOpen: XMLHttpRequest.prototype.open,
    xhrSend: XMLHttpRequest.prototype.send,
    xhrSetRequestHeader: XMLHttpRequest.prototype.setRequestHeader,
  };

  root.fetch = natives.fetch;
  XMLHttpRequest.prototype.open = natives.xhrOpen;
  XMLHttpRequest.prototype.send = natives.xhrSend;
  XMLHttpRequest.prototype.setRequestHeader = natives.xhrSetRequestHeader;

  const origFetch = natives.fetch;
  root.fetch = async function HackeryLabFetch(input, init) {
    const isHookOriginated = hookDepth > 0;
    hookDepth += 1;
    try {
    const request = input instanceof Request ? input : null;
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : request.url;
    const baseInit = init ? { ...init } : {};
    const method = (
      init?.method ||
      request?.method ||
      "GET"
    ).toUpperCase();
    let bodyForRules = init?.body;
    if (inspectRequestBody) {
      try {
        // Reconstruct from the original arguments so inherited RequestInit
        // properties and encoded FormData/Blob bodies are available to rules.
        const inspectionInput = request ? request.clone() : input;
        bodyForRules = await new Request(inspectionInput, init).text();
      } catch {
        // Used or non-cloneable streams still pass through unchanged.
      }
    }
    if (bodyForRules != null && typeof bodyForRules !== "string") {
      bodyForRules = bodyToString(bodyForRules);
    }
    const headers = headersToObject(init?.headers || request?.headers);

    const requestBase = {
      method,
      url,
      body: bodyForRules,
      headers,
      resourceType: "fetch",
    };

    let ctx = processRules("request", requestBase, isHookOriginated);
    if (ctx === null) {
      throw new DOMException("Blocked by network rule", "AbortError");
    }

    const nextMethod = ctx.method || method;
    const nextUrl = ctx.url || url;
    const nextHeaders = ctx.headers || headers;
    const nextBodyForRules = ctx.body ?? bodyForRules;
    const requestChanged =
      nextMethod !== method ||
      nextUrl !== url ||
      JSON.stringify(nextHeaders) !== JSON.stringify(headers) ||
      nextBodyForRules !== bodyForRules;

    const mockRule = findMockRule(
      {
        ...requestBase,
        method: nextMethod,
        url: nextUrl,
        body: nextBodyForRules,
        headers: nextHeaders,
      },
      isHookOriginated
    );
    if (mockRule) {
      const mockCtx = buildMockResponseContext(
        mockRule,
        {
          ...requestBase,
          method: nextMethod,
          url: nextUrl,
          body: nextBodyForRules,
          headers: nextHeaders,
        },
        stateView
      );
      if (mockCtx === null) {
        throw new DOMException("Blocked by network rule", "AbortError");
      }
      postLog({
        ruleId: mockRule.id,
        ruleName: mockRule.name,
        phase: "response",
        method: nextMethod,
        url: nextUrl,
        pageUrl: resolveMatchingPageUrl(),
        outcome: "mocked",
        action: mockRule.action,
      });
      return new Response(mockCtx.body ?? "", {
        status: mockCtx.status ?? 200,
        statusText: mockCtx.statusText ?? "OK",
        headers: objectToHeaders(mockCtx.headers),
      });
    }

    // Unchanged request: pass original args so Request/FormData/Blob bodies stay intact.
    const response = requestChanged
      ? await origFetch(nextUrl, {
          ...baseInit,
          method: nextMethod,
          body: nextBodyForRules,
          headers: nextHeaders,
        })
      : await origFetch(input, init);

    let responseBody = await response.clone().text();
    const responseCtx = processRules(
      "response",
      {
        method: nextMethod,
        url: nextUrl,
        status: response.status,
        headers: headersToObject(response.headers),
        body: responseBody,
        resourceType: "fetch",
      },
      isHookOriginated
    );

    if (responseCtx === null) {
      throw new DOMException("Blocked by network rule", "AbortError");
    }

    const responseChanged =
      (responseCtx.status ?? response.status) !== response.status ||
      JSON.stringify(responseCtx.headers || {}) !==
        JSON.stringify(headersToObject(response.headers)) ||
      (responseCtx.body ?? responseBody) !== responseBody;

    if (!responseChanged) {
      return response;
    }

    return new Response(responseCtx.body ?? responseBody, {
      status: responseCtx.status ?? response.status,
      statusText: response.statusText,
      headers: responseCtx.headers
        ? objectToHeaders(responseCtx.headers)
        : response.headers,
    });
    } finally {
      hookDepth -= 1;
    }
  };

  const origOpen = natives.xhrOpen;
  const origSend = natives.xhrSend;
  const origSetRequestHeader = natives.xhrSetRequestHeader;

  XMLHttpRequest.prototype.open = function HackeryLabOpen(
    method,
    url,
    async,
    user,
    password
  ) {
    this.__HackeryLab = {
      method: String(method || "GET").toUpperCase(),
      url: String(url),
      async: async !== false,
      user,
      password,
      headers: {},
    };
    return origOpen.call(this, method, url, async, user, password);
  };

  XMLHttpRequest.prototype.setRequestHeader = function HackeryLabSetHeader(
    name,
    value
  ) {
    if (this.__HackeryLab) {
      this.__HackeryLab.headers[name] = value;
    } else if (this.__ComplexLinker) {
      this.__ComplexLinker.headers[name] = value;
    }
    return origSetRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function HackeryLabSend(body) {
    const isHookOriginated = hookDepth > 0;
    hookDepth += 1;
    try {
    const meta = this.__HackeryLab || this.__ComplexLinker || {
      method: "GET",
      url: "",
      headers: {},
    };

    const bodyForRules =
      body != null && typeof body !== "string" ? bodyToString(body) : body;

    let ctx = processRules(
      "request",
      {
        method: meta.method,
        url: meta.url,
        body: bodyForRules,
        headers: { ...meta.headers },
        resourceType: "xmlhttprequest",
      },
      isHookOriginated
    );
    if (ctx === null) {
      root.setTimeout(() => {
        this.dispatchEvent(new ProgressEvent("error"));
      }, 0);
      return;
    }

    const nextMethod = ctx.method || meta.method;
    const nextUrl = ctx.url || meta.url;
    const nextHeaders = ctx.headers || meta.headers;
    const nextBodyForRules = ctx.body ?? bodyForRules;
    const requestChanged =
      nextMethod !== meta.method ||
      nextUrl !== meta.url ||
      JSON.stringify(nextHeaders) !== JSON.stringify(meta.headers) ||
      nextBodyForRules !== bodyForRules;

    const mockRule = findMockRule(
      {
        method: nextMethod,
        url: nextUrl,
        body: nextBodyForRules,
        headers: nextHeaders,
        resourceType: "xmlhttprequest",
      },
      isHookOriginated
    );
    if (mockRule) {
      const mockCtx = buildMockResponseContext(
        mockRule,
        {
          method: nextMethod,
          url: nextUrl,
          body: nextBodyForRules,
          headers: nextHeaders,
          resourceType: "xmlhttprequest",
        },
        stateView
      );
      if (mockCtx === null) {
        root.setTimeout(() => {
          this.dispatchEvent(new ProgressEvent("error"));
        }, 0);
        return;
      }
      deliverMockXhr(this, mockCtx, mockRule, {
        method: nextMethod,
        url: nextUrl,
      });
      return;
    }

    if (requestChanged) {
      const urlChanged = nextUrl !== meta.url;
      const methodChanged = nextMethod !== meta.method;
      const headersChanged =
        JSON.stringify(nextHeaders) !== JSON.stringify(meta.headers);
      if (urlChanged || methodChanged || headersChanged) {
        origOpen.call(
          this,
          nextMethod,
          nextUrl,
          meta.async,
          meta.user,
          meta.password
        );
        for (const [name, value] of Object.entries(
          encodePrivilegedRequestHeaders(nextHeaders)
        )) {
          origSetRequestHeader.call(this, name, value);
        }
      }
    }

    const xhr = this;
    const origReady = xhr.onreadystatechange;
    xhr.onreadystatechange = function HackeryLabReadyState() {
      if (xhr.readyState === 4) {
        try {
          const responseCtx = processRules(
            "response",
            {
              method: nextMethod,
              url: nextUrl,
              status: xhr.status,
              headers: parseXhrResponseHeaders(xhr.getAllResponseHeaders()),
              body: xhr.responseText,
              resourceType: "xmlhttprequest",
            },
            isHookOriginated
          );
          if (
            responseCtx &&
            responseCtx.body != null &&
            responseCtx.body !== xhr.responseText
          ) {
            Object.defineProperty(xhr, "responseText", {
              configurable: true,
              get() {
                return responseCtx.body;
              },
            });
            Object.defineProperty(xhr, "response", {
              configurable: true,
              get() {
                return responseCtx.body;
              },
            });
          }
        } catch {
          // response rewrite failed — leave original
        }
      }
      if (typeof origReady === "function") {
        origReady.apply(this, arguments);
      }
    };

    // Unchanged request: pass original body so FormData/Blob stay intact.
    return origSend.call(this, requestChanged ? nextBodyForRules : body);
    } finally {
      hookDepth -= 1;
    }
  };

  root.__HackeryLabNetworkHook = {
    version,
    logToken,
    tabUrl: injectedTabUrl,
    rulesCount: compiledRules.length,
    natives,
  };
  earlyHook?.release();
