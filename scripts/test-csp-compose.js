const assert = require("node:assert/strict");

function applyModify(ctx, rule) {
  const headers = { ...(ctx.headers || {}) };
  const cspName = "Content-Security-Policy";
  for (const header of rule.modify?.setHeaders || []) {
    if (String(header.name || "").toLowerCase() === "content-security-policy") {
      headers[cspName] = header.value ?? "";
    }
  }
  for (const entry of rule.modify?.headerReplacements || []) {
    if (String(entry.name || "").toLowerCase() !== "content-security-policy") {
      continue;
    }
    const current = String(headers[cspName] || "");
    headers[cspName] = current.split(entry.find).join(entry.replace);
  }
  return { ...ctx, headers };
}

async function main() {
  const {
    applyCspTouchingRules,
    cspTouchingRuleIsDnrRepresentable,
    isCspTouchingRule,
    networkArmTimerActive,
    ruleDisablesCsp,
    shouldRewriteCsp,
    shouldSeedOriginal,
    wildcardToDnrUrlFilter,
    policyHasNonceOrHash,
    policyNeedsDnrStrip,
  } = await import("../lib/csp-compose-core.js");

  assert.equal(networkArmTimerActive(true, 0), false);
  assert.equal(networkArmTimerActive(true, 1), true);
  assert.equal(networkArmTimerActive(false, 3), false);

  const disableRule = {
    enabled: true,
    action: "modify",
    modify: { cspMode: "disable", setHeaders: [] },
  };
  const onlySelf = {
    enabled: true,
    action: "modify",
    modify: {
      cspSeed: "empty",
      setHeaders: [
        {
          name: "Content-Security-Policy",
          value: "default-src 'self'; script-src 'self'",
        },
      ],
    },
  };
  const regexCsp = {
    enabled: true,
    action: "modify",
    pageUrlPattern: "example\\.com",
    pageUrlPatternIsRegex: true,
    modify: { cspSeed: "original" },
  };

  assert.equal(isCspTouchingRule(disableRule), true);
  assert.equal(ruleDisablesCsp(disableRule), true);
  assert.equal(cspTouchingRuleIsDnrRepresentable(regexCsp), false);
  assert.equal(cspTouchingRuleIsDnrRepresentable(onlySelf), true);
  assert.equal(wildcardToDnrUrlFilter(".*", true), null);

  assert.equal(
    shouldRewriteCsp({
      nonceToggle: true,
      networkArmed: false,
      matchingCspRules: [],
    }),
    true
  );
  assert.equal(
    shouldRewriteCsp({
      nonceToggle: true,
      networkArmed: false,
      matchingCspRules: [],
      resourceType: "xmlhttprequest",
    }),
    false
  );
  assert.equal(
    shouldRewriteCsp({
      nonceToggle: true,
      networkArmed: false,
      matchingCspRules: [],
      resourceType: "main_frame",
      borrowableNonce: true,
    }),
    false
  );
  assert.equal(
    shouldRewriteCsp({
      nonceToggle: true,
      networkArmed: true,
      matchingCspRules: [disableRule],
      resourceType: "main_frame",
      borrowableNonce: true,
    }),
    true
  );
  assert.equal(
    shouldRewriteCsp({
      nonceToggle: false,
      networkArmed: false,
      matchingCspRules: [disableRule],
    }),
    false
  );
  assert.equal(
    shouldRewriteCsp({
      nonceToggle: false,
      networkArmed: true,
      matchingCspRules: [regexCsp],
    }),
    false
  );
  assert.equal(
    shouldRewriteCsp({
      nonceToggle: false,
      networkArmed: true,
      matchingCspRules: [disableRule],
    }),
    true
  );

  assert.equal(shouldSeedOriginal(true, []), true);
  assert.equal(shouldSeedOriginal(false, [onlySelf]), false);
  assert.equal(shouldSeedOriginal(false, [{ modify: { cspSeed: "original" } }]), true);

  const disabled = applyCspTouchingRules("script-src 'self'", [disableRule], applyModify);
  assert.deepEqual(disabled, { policy: "", disabled: true });

  const replaced = applyCspTouchingRules("", [onlySelf], applyModify);
  assert.equal(replaced.disabled, false);
  assert.equal(replaced.policy, "default-src 'self'; script-src 'self'");

  const xhrOnly = {
    enabled: true,
    action: "modify",
    resourceTypes: ["xmlhttprequest"],
    modify: { cspMode: "disable" },
  };
  assert.equal(isCspTouchingRule(xhrOnly), false);

  assert.equal(policyHasNonceOrHash("script-src 'self' 'nonce-abc'"), true);
  assert.equal(policyHasNonceOrHash("script-src github.githubassets.com"), false);
  assert.equal(
    policyNeedsDnrStrip(
      "default-src 'none'; script-src github.githubassets.com; style-src 'unsafe-inline'"
    ),
    true
  );
  assert.equal(
    policyNeedsDnrStrip("script-src 'self' 'nonce-page' 'unsafe-inline'"),
    false
  );
  assert.equal(
    policyNeedsDnrStrip("script-src 'self' 'unsafe-inline'"),
    false
  );

  console.log("test-csp-compose: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
