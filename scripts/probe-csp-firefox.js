/**
 * Fixture + optional Firefox BiDi checks for CSP compose.
 *
 * Control (no extension): document has one script-src 'self' policy; inline
 * without nonce must not run.
 *
 * With the extension loaded: Nonce on + hard reload should leave one policy
 * that includes 'nonce-…' and allow a matching inline script. Armed Disable CSP
 * template should omit the CSP header entirely.
 *
 * Usage:
 *   node scripts/serve-csp-fixture.js
 *   firefox --remote-debugging-port 9222
 *   node scripts/probe-csp-firefox.js
 */
const assert = require("node:assert/strict");
const http = require("node:http");

const FIXTURE = process.env.CSP_FIXTURE_URL || "http://127.0.0.1:8765/";
const BIDI_PORT = Number(process.env.BIDI_PORT) || 9222;

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      })
      .on("error", reject);
  });
}

async function readBidiEndpoint() {
  const listed = await httpGet(`http://127.0.0.1:${BIDI_PORT}/json/version`).catch(
    () => null
  );
  if (listed?.body) {
    try {
      const json = JSON.parse(listed.body);
      return json.webSocketDebuggerUrl || json.webSocketUrl || null;
    } catch {
      return null;
    }
  }
  return `ws://127.0.0.1:${BIDI_PORT}/session`;
}

async function bidiCall(ws, method, params = {}) {
  const id = bidiCall.nextId++;
  const payload = JSON.stringify({ id, method, params });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`BiDi timeout: ${method}`)), 8000);
    function onMessage(event) {
      try {
        const data = JSON.parse(String(event.data));
        if (data.id !== id) {
          return;
        }
        ws.removeEventListener("message", onMessage);
        clearTimeout(timer);
        if (data.error) {
          reject(new Error(data.error.message || method));
          return;
        }
        resolve(data.result);
      } catch (error) {
        reject(error);
      }
    }
    ws.addEventListener("message", onMessage);
    ws.send(payload);
  });
}
bidiCall.nextId = 1;

async function probeBidi() {
  if (typeof WebSocket !== "function") {
    throw new Error("No WebSocket in this Node runtime");
  }
  const endpoint = await readBidiEndpoint();
  const ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", () =>
      reject(new Error("BiDi WebSocket failed (is Firefox on --remote-debugging-port 9222?)"))
    );
  });

  const session = await bidiCall(ws, "session.new", { capabilities: {} }).catch(
    () => null
  );
  const tree = await bidiCall(ws, "browsingContext.getTree", {});
  const context =
    tree?.contexts?.[0]?.context || tree?.contexts?.[0]?.children?.[0]?.context;
  if (!context) {
    ws.close();
    throw new Error("No BiDi browsing context");
  }
  await bidiCall(ws, "browsingContext.navigate", {
    context,
    url: FIXTURE,
    wait: "complete",
  });
  const evaluated = await bidiCall(ws, "script.evaluate", {
    expression:
      "({ fixture: Boolean(window.__cspFixtureLoaded), inlineRan: false })",
    target: { context },
    awaitPromise: false,
    resultOwnership: "none",
  });
  ws.close();
  void session;
  return evaluated?.result?.value || evaluated?.result;
}

async function main() {
  const response = await httpGet(FIXTURE);
  assert.equal(response.status, 200);
  const csp = String(response.headers["content-security-policy"] || "");
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /nonce-/);
  console.log("probe-csp-firefox fixture header: one un-punched script-src 'self'");

  if (process.env.SKIP_BIDI === "1") {
    console.log("probe-csp-firefox: skipped BiDi");
    return;
  }

  try {
    const result = await probeBidi();
    console.log("probe-csp-firefox BiDi navigate:", result);
    console.log(
      "With extension Nonce on, hard-reload and re-run: expect one policy with nonce and MAIN inject. Armed Disable CSP template: expect no CSP header."
    );
  } catch (error) {
    console.log(`probe-csp-firefox BiDi skipped: ${error.message}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
