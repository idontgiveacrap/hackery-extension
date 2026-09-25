const assert = require("node:assert/strict");
const fs = require("node:fs");

/**
 * Regression test: a fetch started before hook configuration must wait and
 * pass through the configured matcher exactly once.
 */
async function run() {
  const installSource = fs.readFileSync(
    "network/engine/network-hook-install.js",
    "utf8"
  );
  const installModule = await import(
    `data:text/javascript;base64,${Buffer.from(installSource).toString("base64")}`
  );
  const messages = [];
  globalThis.location = { href: "https://app.example.com/page" };
  globalThis.top = globalThis;
  globalThis.postMessage = (message) => messages.push(message);

  class MockXHR {}
  MockXHR.prototype.open = function () {};
  MockXHR.prototype.send = function () {};
  MockXHR.prototype.setRequestHeader = function () {};
  globalThis.XMLHttpRequest = MockXHR;

  let nativeCalls = 0;
  globalThis.fetch = async () => {
    nativeCalls += 1;
    return new Response("ok");
  };

  const earlySource = fs.readFileSync(
    "network/inject/network-early-hook.js",
    "utf8"
  );
  new Function(earlySource)();

  const requestInit = Object.create({
    body: '{"pipelineId":"entity_list"}',
  });
  requestInit.method = "POST";
  requestInit.headers = { "Content-Type": "application/json" };
  assert.equal(
    await new Request(
      "https://app.example.com/api/v1/batch",
      requestInit
    ).text(),
    '{"pipelineId":"entity_list"}'
  );
  const pending = globalThis.fetch(
    "https://app.example.com/api/v1/batch",
    requestInit
  );

  installModule.installNetworkHook(
    [
      {
        id: "early-request",
        name: "Early request",
        enabled: true,
        priority: 100,
        pageUrlPattern: "",
        requestUrlPattern: "",
        requestBodyPattern: "*entity_list*",
        requestBodyPatternIsRegex: false,
        requestContentTypePattern: "application/json*",
        requestContentTypePatternIsRegex: false,
        methods: ["POST"],
        resourceTypes: [],
        phases: ["request"],
        action: "modify",
        modify: { requestScript: "" },
      },
    ],
    "v1",
    "token",
    {
      persistent: {},
      tab: {},
      tabUrl: globalThis.location.href,
    }
  );

  await pending;
  assert.equal(nativeCalls, 1);
  assert.equal(globalThis.fetch.name, "HackeryLabFetch");
  assert.equal(
    messages.some(
      (message) =>
        message.type === "log" && message.entry.outcome === "matched"
    ),
    true
  );
  console.log("Early request captured and matched.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
