export function createMessageRouter(handlers, options = {}) {
  const knownTypes = options.knownTypes || null;
  const warnUnknown = options.warnUnknown !== false;

  return function onRuntimeMessage(message, sender, sendResponse) {
    const type = message?.type;
    const handler = handlers[type];
    if (!handler) {
      if (
        warnUnknown &&
        knownTypes &&
        type &&
        !knownTypes.has(type) &&
        // Catalog events and other cross-feature broadcasts may not be in the map.
        typeof type === "string"
      ) {
        // Soft assert: typos fail closed (return false) but are visible in the console.
        console.warn(`hackery-lab: no handler for message type "${type}"`);
      }
      return false;
    }
    return handler(message, sender, sendResponse);
  };
}

export function respondAsync(promise, sendResponse) {
  promise
    .then((result) => sendResponse(result ?? { ok: true }))
    .catch((error) =>
      sendResponse({ ok: false, error: error.message || String(error) })
    );
  return true;
}
