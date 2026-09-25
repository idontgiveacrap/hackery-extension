/**
 * Capture last contextmenu target and build a usable CSS selector for builder prefill.
 * Must be present before the contextmenu event (registered as a content script).
 */
(function () {
  if (
    globalThis.__hackeryLabContextTargetInstalled ||
    globalThis.__complexLinkerContextTargetInstalled
  ) {
    return;
  }
  globalThis.__hackeryLabContextTargetInstalled = true;

  let lastTarget = null;

  function cssEscapeIdent(value) {
    if (typeof CSS !== "undefined" && CSS.escape) {
      return CSS.escape(value);
    }
    return String(value).replace(/([^a-zA-Z0-9_-])/g, "\\$1");
  }

  function buildSelector(el) {
    if (!el || el.nodeType !== 1) {
      return "";
    }
    if (el.id) {
      return `#${cssEscapeIdent(el.id)}`;
    }

    const parts = [];
    let current = el;
    while (current && current.nodeType === 1 && current !== document.documentElement) {
      let part = current.tagName.toLowerCase();
      if (current.id) {
        parts.unshift(`#${cssEscapeIdent(current.id)}`);
        break;
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter(
          (child) => child.tagName === current.tagName
        );
        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1;
          part += `:nth-of-type(${index})`;
        }
      }
      parts.unshift(part);
      current = parent;
      if (parts.length >= 6) {
        break;
      }
    }
    return parts.join(" > ");
  }

  document.addEventListener(
    "contextmenu",
    (event) => {
      lastTarget = event.target;
    },
    true
  );

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    // Must match MessageTypes.GET_CONTEXT_TARGET in lib/message-types.js.
    if (message?.type !== "GET_CONTEXT_TARGET") {
      return false;
    }
    sendResponse({
      ok: true,
      selector: buildSelector(lastTarget),
      tagName: lastTarget?.tagName || null,
      text: (lastTarget?.textContent || "").trim().slice(0, 80),
      href: lastTarget?.closest?.("a")?.href || null,
    });
    return false;
  });
})();
