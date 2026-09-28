/**
 * Ad-hoc BiDi inspector for the live CSP debugging session.
 * Connects to a Firefox WebDriver BiDi endpoint, lists top-level browsing
 * contexts, and (optionally) runs a CSP probe in a chosen context.
 *
 * Usage:
 *   node scripts/bidi-inspect.js                 # list contexts
 *   node scripts/bidi-inspect.js <contextId>     # probe one context
 */
const BIDI_PORT = Number(process.env.BIDI_PORT) || 9222;
const ENDPOINT = process.env.BIDI_WS || `ws://127.0.0.1:${BIDI_PORT}/session`;

function call(ws, method, params = {}) {
  const id = call.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 15000);
    function onMessage(event) {
      let data;
      try {
        data = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (data.id !== id) {
        return;
      }
      ws.removeEventListener("message", onMessage);
      clearTimeout(timer);
      if (data.error) {
        reject(new Error(`${data.error}: ${data.message || method}`));
        return;
      }
      resolve(data.result);
    }
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
call.nextId = 1;

async function ensureSession(ws) {
  // A session may already exist (the user's BiDi session, or a prior run).
  // Probing with getTree avoids "session already started" from a blind new.
  try {
    await call(ws, "browsingContext.getTree", {});
    return;
  } catch {
    // no active session on this connection yet
  }
  await call(ws, "session.new", { capabilities: {} }).catch(() => {});
}

async function finish(ws) {
  // Always end the session so the single BiDi session slot is not orphaned
  // when the socket closes (Firefox caps active sessions and does not reap
  // promptly on disconnect).
  await call(ws, "session.end", {}).catch(() => {});
  ws.close();
}

const PROBE = String.raw`
(() => {
  const out = { url: location.href, metaCsp: [], pageNonce: "", tests: {} };
  try {
    for (const m of document.querySelectorAll('meta[http-equiv]')) {
      if (/content-security-policy/i.test(m.getAttribute('http-equiv') || '')) {
        out.metaCsp.push(m.getAttribute('content') || '');
      }
    }
    const n = document.querySelector('script[nonce]');
    out.pageNonce = n ? (n.nonce || n.getAttribute('nonce') || '') : '';
  } catch (e) { out.metaError = String(e); }

  // Record CSP violations that fire during the synchronous probe below.
  const violations = [];
  const onV = (e) => violations.push({
    directive: e.effectiveDirective || e.violatedDirective,
    blocked: e.blockedURI,
    source: (e.sourceFile || '') + ':' + (e.lineNumber || ''),
  });
  document.addEventListener('securitypolicyviolation', onV);

  // eval
  try { out.tests.eval = (eval('1+1') === 2) ? 'allowed' : 'ran-wrong'; }
  catch (e) { out.tests.eval = 'blocked: ' + (e && e.name); }

  // plain inline <script>
  try {
    window.__probeInline = false;
    const s = document.createElement('script');
    s.textContent = 'window.__probeInline = true;';
    (document.head || document.documentElement).appendChild(s);
    s.remove();
    out.tests.inline = window.__probeInline ? 'allowed' : 'blocked';
  } catch (e) { out.tests.inline = 'error: ' + String(e); }

  // nonced inline <script> borrowing the page nonce
  try {
    window.__probeNonce = false;
    const s = document.createElement('script');
    if (out.pageNonce) { s.setAttribute('nonce', out.pageNonce); s.nonce = out.pageNonce; }
    s.textContent = 'window.__probeNonce = true;';
    (document.head || document.documentElement).appendChild(s);
    s.remove();
    out.tests.nonceInline = window.__probeNonce ? 'allowed' : 'blocked';
  } catch (e) { out.tests.nonceInline = 'error: ' + String(e); }

  return new Promise((resolve) => {
    setTimeout(() => {
      document.removeEventListener('securitypolicyviolation', onV);
      out.violations = violations.slice(0, 12);
      resolve(JSON.stringify(out));
    }, 60);
  });
})()
`;

function headerValue(header) {
  const v = header?.value;
  if (v == null) return "";
  if (typeof v === "string") return v;
  // BiDi encodes header values as { type: "string", value } or base64.
  return v.value ?? "";
}

async function probeContext(ws, target) {
  const result = await call(ws, "script.evaluate", {
    expression: PROBE,
    target: { context: target },
    awaitPromise: true,
    resultOwnership: "none",
  });
  const value = result?.result?.value ?? result?.result;
  try {
    return JSON.parse(value);
  } catch {
    return { raw: result };
  }
}

async function main() {
  if (typeof WebSocket !== "function") {
    throw new Error("This Node build has no global WebSocket (need Node 22+).");
  }
  const ws = new WebSocket(ENDPOINT);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", () =>
      reject(new Error(`WS connect failed to ${ENDPOINT}`))
    );
  });

  await ensureSession(ws);

  const mode = process.argv[2];

  try {

  if (mode === "end") {
    await call(ws, "session.end", {});
    console.log("session.end OK");
    return;
  }

  if (mode === "diag") {
    for (const method of ["session.status", "browsingContext.getTree", "session.new"]) {
      try {
        const params = method === "session.new" ? { capabilities: {} } : {};
        const r = await call(ws, method, params);
        console.log(`${method} OK:`, JSON.stringify(r).slice(0, 300));
      } catch (e) {
        console.log(`${method} ERR:`, e.message);
      }
    }
    return;
  }

  if (mode === "nav") {
    const url = process.argv[3];
    const tree = await call(ws, "browsingContext.getTree", {});
    const context =
      process.argv[4] || tree.contexts?.[0]?.context;
    if (!context) throw new Error("no context to navigate");

    // Capture document response headers for this navigation.
    const captured = [];
    await call(ws, "session.subscribe", { events: ["network.responseCompleted"] });
    ws.addEventListener("message", (event) => {
      let data;
      try { data = JSON.parse(String(event.data)); } catch { return; }
      if (data.method !== "network.responseCompleted") return;
      const p = data.params || {};
      if (p.context !== context) return;
      const rd = p.response || {};
      const cspHeaders = (rd.headers || [])
        .filter((h) => /content-security-policy/i.test(h.name || ""))
        .map((h) => `${h.name}: ${headerValue(h)}`);
      captured.push({ url: rd.url, status: rd.status, csp: cspHeaders });
    });

    await call(ws, "browsingContext.navigate", { context, url, wait: "complete" });
    await new Promise((r) => setTimeout(r, 1200));

    const doc = captured.find((c) => c.url === url) || captured[0] || null;
    console.log("=== navigation:", url);
    console.log("document response CSP header(s):");
    if (doc && doc.csp.length) {
      for (const line of doc.csp) console.log("  " + line);
    } else {
      console.log("  (none captured on document response)");
    }
    console.log("\nall responses carrying a CSP header:");
    for (const c of captured.filter((c) => c.csp.length)) {
      console.log(`  [${c.status}] ${c.url}`);
      for (const line of c.csp) console.log("      " + line);
    }
    console.log("\n=== enforced-behavior probe:");
    console.log(JSON.stringify(await probeContext(ws, context), null, 2));
    return;
  }

  const tree = await call(ws, "browsingContext.getTree", {});
  const contexts = tree.contexts || [];
  const target = mode;
  if (!target) {
    console.log("Top-level browsing contexts:");
    for (const c of contexts) {
      console.log(`  ${c.context}  ${c.url}`);
      for (const child of c.children || []) {
        console.log(`    - ${child.context}  ${child.url}`);
      }
    }
    return;
  }

  console.log(JSON.stringify(await probeContext(ws, target), null, 2));
  } finally {
    await finish(ws);
  }
}

main().catch((error) => {
  console.error("bidi-inspect error:", error.message);
  process.exit(1);
});
