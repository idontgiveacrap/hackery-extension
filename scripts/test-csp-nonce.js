const assert = require("node:assert/strict");

async function main() {
  const {
    canPunchScriptSources,
    getCspNonce,
    getCspPunchReason,
    punchCspPolicy,
    punchCspResponseHeaders,
    punchMetaCspTags,
    rewriteMetaCspTags,
  } = await import("../lib/csp-nonce.js");

  assert.equal(canPunchScriptSources("'self'"), true);
  assert.equal(canPunchScriptSources("'self' 'unsafe-inline'"), false);
  assert.equal(canPunchScriptSources("'self' 'unsafe-inline' 'nonce-abc'"), true);
  assert.equal(canPunchScriptSources("'self' 'sha256-abcd'"), true);

  const nonce = "testnonce";
  assert.equal(
    punchCspPolicy("default-src 'self'; script-src 'self'", nonce).value,
    "default-src 'self'; script-src 'self' 'nonce-testnonce'"
  );
  assert.equal(
    punchCspPolicy("script-src-elem 'self'; script-src 'self'", nonce).value,
    "script-src-elem 'self' 'nonce-testnonce'; script-src 'self'"
  );
  assert.deepEqual(punchCspPolicy("img-src 'self'", nonce), {
    value: null,
    reason: "no-script-directive",
  });
  assert.deepEqual(punchCspPolicy("script-src 'self' 'unsafe-inline'", nonce), {
    value: null,
    reason: "unsafe-inline-without-nonce",
  });
  assert.deepEqual(punchCspPolicy("", nonce), { value: null, reason: "no-policy" });
  assert.match(
    punchCspPolicy("script-src 'self' 'unsafe-inline' 'nonce-page'", nonce).value,
    /nonce-testnonce/
  );

  const punchedHeaders = punchCspResponseHeaders(
    [
      { name: "Content-Security-Policy", value: "script-src 'self'" },
      { name: "Content-Security-Policy-Report-Only", value: "script-src 'self'" },
    ],
    1,
    0
  );
  assert.equal(punchedHeaders.changed, true);
  assert.ok(punchedHeaders.nonce);
  assert.match(punchedHeaders.headers[0].value, /nonce-/);
  assert.equal(punchedHeaders.headers[1].value, "script-src 'self'");

  const skipped = punchCspResponseHeaders(
    [{ name: "Content-Security-Policy", value: "script-src 'self' 'unsafe-inline'" }],
    1,
    0
  );
  assert.equal(skipped.changed, false);
  assert.equal(skipped.nonce, "");
  assert.equal(skipped.reason, "unsafe-inline-without-nonce");
  assert.equal(getCspNonce(1, 0), "");
  assert.equal(getCspPunchReason(1, 0), "unsafe-inline-without-nonce");

  const noCsp = punchCspResponseHeaders([{ name: "Content-Type", value: "text/html" }], 2, 0);
  assert.equal(noCsp.changed, false);
  assert.equal(noCsp.reason, "no-csp-header");
  assert.equal(getCspPunchReason(2, 0), "no-csp-header");
  assert.equal(getCspPunchReason(99, 0), "not-seen");

  const punchedMeta = punchMetaCspTags(
    '<meta http-equiv="content-security-policy" content="script-src \'self\'">',
    nonce
  );
  assert.match(punchedMeta.html, /nonce-testnonce/);
  assert.equal(punchedMeta.reason, "meta-nonce-punched");
  assert.deepEqual(
    punchMetaCspTags(
      '<meta http-equiv="content-security-policy" content="script-src \'self\' \'unsafe-inline\'">',
      nonce
    ),
    { html: null, reason: "meta-unsafe-inline-without-nonce" }
  );
  assert.deepEqual(punchMetaCspTags("<html><head></head></html>", nonce), {
    html: null,
    reason: "no-meta-csp",
  });
  assert.deepEqual(
    punchMetaCspTags(
      '<meta http-equiv="content-security-policy-report-only" content="script-src \'self\'">',
      nonce
    ),
    { html: null, reason: "no-meta-csp" }
  );

  const rewritten = rewriteMetaCspTags(
    '<meta http-equiv="content-security-policy" content="script-src \'self\'">',
    "default-src 'self'; script-src 'self' 'nonce-abc'"
  );
  assert.match(rewritten, /nonce-abc/);
  assert.equal(
    rewriteMetaCspTags(
      '<meta http-equiv="content-security-policy-report-only" content="script-src \'self\'">',
      "script-src 'self' 'nonce-abc'"
    ),
    null
  );

  const { normalizeSandbox, normalizeLeafNode } = await import("../lib/link-model.js");
  assert.equal(normalizeSandbox("main"), undefined);
  assert.equal(normalizeSandbox("isolated"), "isolated");
  assert.equal(normalizeSandbox("readonly-dom"), "readonly-dom");
  assert.equal(
    normalizeLeafNode({ name: "I", code: "1", sandbox: "isolated" }).sandbox,
    "isolated"
  );

  const { scriptletWorld, SANDBOX_READONLY_DOM } = await import(
    "../lib/scriptlet-inject.js"
  );
  assert.equal(scriptletWorld(undefined), "MAIN");
  assert.equal(scriptletWorld("isolated"), "ISOLATED");
  assert.equal(scriptletWorld(SANDBOX_READONLY_DOM), "ISOLATED");

  console.log("test-csp-nonce: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
