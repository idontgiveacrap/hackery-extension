const assert = require("node:assert/strict");

async function main() {
  const {
    collectScriptlets,
    linkAppliesToUrl,
    matchLooksPathOrHash,
    normalizeLeafNode,
    resolveExclude,
    resolveMatch,
    resolveRunAt,
  } = await import("../lib/link-model.js");
  const { walkCatalogNodes } = await import("../lib/catalog-walk.js");

  assert.equal(linkAppliesToUrl("https://a.example.com/x", "\\.example\\.com$", null), true);
  assert.equal(linkAppliesToUrl("https://other.test/x", "\\.example\\.com$", null), false);
  assert.equal(
    linkAppliesToUrl("https://a.example.com/login", "\\.example\\.com$", "/login"),
    false
  );
  assert.equal(
    linkAppliesToUrl("https://a.example.com/home", "\\.example\\.com$", "/login"),
    true
  );
  assert.equal(linkAppliesToUrl("https://a.example.com/login", null, "/login"), false);
  assert.equal(linkAppliesToUrl("https://a.example.com/home", null, "/login"), true);

  assert.equal(matchLooksPathOrHash("\\.example\\.com$"), false);
  assert.equal(matchLooksPathOrHash("example\\.com/detail/"), true);
  assert.equal(matchLooksPathOrHash("example\\.com#/app"), true);

  const inherited = {
    match: "\\.example\\.com$",
    exclude: "/admin",
  };
  const leaf = { name: "A", code: "1" };
  assert.equal(resolveMatch(leaf, inherited.match), inherited.match);
  assert.equal(resolveExclude(leaf, inherited.exclude), inherited.exclude);
  assert.equal(resolveMatch({ ...leaf, match: null }, inherited.match), null);
  assert.equal(resolveExclude({ ...leaf, exclude: null }, inherited.exclude), null);
  assert.equal(
    resolveExclude({ ...leaf, exclude: "/login" }, inherited.exclude),
    "/login"
  );

  const walked = [];
  walkCatalogNodes(
    [
      {
        name: "Folder",
        exclude: "/folder-ex",
        children: [{ name: "Child", code: "void 0" }],
      },
    ],
    {
      sectionName: "S",
      inheritedMatch: "\\.host$",
      inheritedExclude: "/sec",
    },
    (entry) => walked.push(entry)
  );
  const child = walked.find((entry) => entry.kind === "leaf");
  assert.equal(child.match, "\\.host$");
  assert.equal(child.exclude, "/folder-ex");

  const rewritten = normalizeLeafNode({
    name: "Rewrite",
    code: "void {limit}; void $limit; void arguments;",
    params: { limit: {} },
  });
  assert.equal(rewritten.code.includes("{limit}"), false);
  assert.match(rewritten.code, /void arguments;/);

  const normalized = normalizeLeafNode({
    name: "Run later",
    code: "console.log(1)",
    runAt: "document_end",
    exclude: "/skip",
  });
  assert.equal(normalized.runAt, "document_end");
  assert.equal(normalized.exclude, "/skip");
  assert.equal(
    normalizeLeafNode({ name: "Iso", code: "1", sandbox: "isolated" }).sandbox,
    "isolated"
  );
  assert.equal(resolveRunAt(normalized), "document_end");
  assert.equal(resolveRunAt({ code: "1" }), "document_start");

  const scriptlets = [];
  collectScriptlets(
    [{ name: "On", code: "1", match: "\\.ex$" }],
    "\\.ex$",
    "S",
    scriptlets,
    "/nogo"
  );
  assert.equal(scriptlets.length, 1);
  assert.equal(scriptlets[0].node.exclude, "/nogo");

  const { resolveDerivedUrlTraced } = await import("../lib/navigation-shared.js");
  const traced = await resolveDerivedUrlTraced(
    {
      url: "https://ex.test/{id}",
      navParams: { id: { fromUrl: "/item/(\\d+)" } },
    },
    "https://page.test/item/42",
    {}
  );
  assert.equal(traced.url, "https://ex.test/42");
  assert.equal(traced.sources.id, "fromUrl");
  assert.equal(traced.values.id, "42");

  const { appendActivityLogQueue } = await import("../lib/link-activity-log.js");
  const queued = appendActivityLogQueue([{ n: 1 }], { n: 2 }, { maxEntries: 2 });
  assert.deepEqual(queued, [{ n: 1 }, { n: 2 }]);
  assert.equal(appendActivityLogQueue(queued, { n: 3 }, { maxEntries: 2 }).length, 2);

  console.log("test-link-apply: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
