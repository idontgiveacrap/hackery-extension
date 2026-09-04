const assert = require("node:assert/strict");

/**
 * Regression tests for custom-link deletion and catalogOrder placement.
 *
 * A leaf carries an `id` whether it lives in the bundled catalog or in the
 * overlay, so id presence alone must not decide whether the sidebar offers a
 * Remove button — only overlay membership can, and a delete that cannot find
 * its target must fail loudly instead of silently re-rendering.
 */

const BUNDLED = {
  Misc: {
    children: [
      { name: "Bundled plain", url: "https://example.com/a", open: "tab" },
      {
        id: "bundled-with-id",
        name: "Bundled with id",
        url: "https://example.com/b",
        open: "tab",
      },
    ],
  },
  Other: {
    children: [
      {
        name: "Outer",
        children: [
          {
            name: "Inner",
            children: [
              {
                id: "bundled-deep",
                name: "Bundled deep",
                url: "https://example.com/d",
                open: "tab",
              },
            ],
          },
        ],
      },
      {
        id: "bundled-root",
        name: "Bundled root",
        url: "https://example.com/c",
        open: "tab",
      },
    ],
  },
};

function defaultOverlay() {
  return {
    Misc: {
      children: [
        { id: "custom-top", name: "Custom top", code: "console.log(1)" },
        {
          name: "Folder",
          children: [
            {
              id: "custom-nested",
              name: "Custom nested",
              code: "console.log(2)",
            },
          ],
        },
      ],
    },
  };
}

function installExtensionGlobals() {
  const store = {
    linksJsonOverlay: defaultOverlay(),
  };
  const setLog = [];

  globalThis.browser = {
    storage: {
      local: {
        async get(keys) {
          const names = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const name of names) {
            if (name in store) {
              out[name] = structuredClone(store[name]);
            }
          }
          return out;
        },
        async set(values) {
          setLog.push(...Object.keys(values));
          for (const [name, value] of Object.entries(values)) {
            store[name] = structuredClone(value);
          }
        },
        async remove(name) {
          delete store[name];
        },
      },
      onChanged: { addListener() {} },
    },
    runtime: {
      getURL: (path) => path,
      sendMessage: async () => {},
      onMessage: { addListener() {} },
    },
  };

  globalThis.fetch = async () => ({ json: async () => structuredClone(BUNDLED) });
  globalThis.__invalidateCatalogSnapshot?.();

  return { store, setLog };
}

function sectionLeafIds(catalog, sectionName) {
  const ids = [];
  const walk = (nodes) => {
    for (const node of nodes || []) {
      if (node.children) {
        walk(node.children);
        continue;
      }
      if (node.id) {
        ids.push(node.id);
      }
    }
  };
  walk(catalog[sectionName]?.children);
  return ids;
}

function childNames(nodes) {
  return (nodes || []).map((node) => node.name);
}

function findFolder(nodes, name) {
  return (nodes || []).find((node) => node.children && node.name === name);
}

async function run() {
  installExtensionGlobals();

  const {
    collectOverlayCustomLinkIds,
    getLinksOverlayForExport,
    loadMergedLinkCatalog,
    removeCustomLinkById,
    restoreCustomLinkAt,
  } = await import("../sidebar/link-storage.js");
  const {
    applyOrder,
    collectOriginParentMap,
    folderStableKey,
    linkStableKey,
    loadCatalogOrder,
    moveKeysInOrder,
    placementWouldCycle,
    saveCatalogOrder,
  } = await import("../lib/catalog-order.js");

  const {
    isOverlayCustomLink,
    ensureLinkIdsInTree,
    importOverlayIntoExisting,
    overlayExport,
    overlayTreeFromMerged,
    mergeLinksCatalog,
  } = await import("../lib/link-catalog.js");
  const { getCatalogSnapshot, invalidateCatalogSnapshot } = await import(
    "../lib/catalog-service.js"
  );
  globalThis.__invalidateCatalogSnapshot = invalidateCatalogSnapshot;

  const backfill = ensureLinkIdsInTree([
    { name: "No id yet", code: "1" },
    {
      name: "Folder",
      children: [{ name: "Nested no id", code: "2" }, { id: "keep-me", name: "Has id", code: "3" }],
    },
  ]);
  assert.equal(backfill.changed, true);
  assert.ok(backfill.nodes[0].id, "leaf without id gets one");
  assert.ok(backfill.nodes[1].children[0].id, "nested leaf without id gets one");
  assert.equal(backfill.nodes[1].children[1].id, "keep-me");
  assert.equal(
    ensureLinkIdsInTree(backfill.nodes).changed,
    false,
    "second pass is a no-op"
  );

  const overlayIds = await collectOverlayCustomLinkIds();
  assert.ok(
    overlayIds.has("custom-top") && overlayIds.has("custom-nested"),
    "overlay links (including nested ones) count as custom"
  );
  assert.ok(
    !overlayIds.has("bundled-with-id"),
    "a bundled leaf with an id is not a custom link"
  );

  const rendered = (await loadMergedLinkCatalog()).Misc.children;
  assert.deepEqual(
    rendered
      .filter((node) => isOverlayCustomLink(node, overlayIds))
      .map((node) => node.id),
    ["custom-top"],
    "only overlay links may be offered for removal"
  );

  const order = await loadCatalogOrder();
  const customKey = linkStableKey("Misc", [], { id: "custom-top" });
  const reordered = [
    customKey,
    ...order.linkKeys.filter((key) => key !== customKey),
  ];
  await saveCatalogOrder({
    linkKeys: moveKeysInOrder(order.linkKeys, reordered),
    sectionOrder: order.sectionOrder,
  });

  await removeCustomLinkById("custom-top");
  assert.ok(
    !sectionLeafIds(await loadMergedLinkCatalog(), "Misc").includes("custom-top"),
    "reordering a custom link must not break deleting it"
  );

  await removeCustomLinkById("custom-nested");
  assert.ok(
    !sectionLeafIds(await loadMergedLinkCatalog(), "Misc").includes(
      "custom-nested"
    ),
    "a custom link inside an overlay folder must be deletable"
  );

  await assert.rejects(
    () => removeCustomLinkById("bundled-with-id"),
    /not found/i,
    "deleting a bundled leaf must report failure, not no-op"
  );

  installExtensionGlobals();
  const nestedSnapshot = await removeCustomLinkById("custom-nested");
  assert.deepEqual(nestedSnapshot.parentPath, ["Folder"]);
  await restoreCustomLinkAt(nestedSnapshot);
  const restored = await loadMergedLinkCatalog();
  const folder = findFolder(restored.Misc.children, "Folder");
  assert.equal(folder.children[nestedSnapshot.index].id, "custom-nested");

  installExtensionGlobals();
  const merged = mergeLinksCatalog(BUNDLED, defaultOverlay());
  const innerKey = folderStableKey("Other", ["Outer"], "Inner");
  const outerKey = folderStableKey("Other", [], "Outer");
  const originParent = collectOriginParentMap(merged);
  assert.equal(
    placementWouldCycle(outerKey, innerKey, {}, originParent),
    true,
    "moving a folder into its descendant is a cycle"
  );

  const movedInner = applyOrder(merged, {
    linkKeys: [],
    sectionOrder: ["Misc", "Other"],
    parentByKey: {
      [innerKey]: { section: "Misc", parentKey: null },
    },
  });
  assert.ok(
    findFolder(movedInner.Misc.children, "Inner"),
    "moved folder attaches to destination section root"
  );
  assert.ok(
    !findFolder(findFolder(movedInner.Other.children, "Outer").children, "Inner"),
    "moved folder is absent from the source parent"
  );
  assert.ok(
    findFolder(movedInner.Misc.children, "Inner").children.some(
      (node) => node.id === "bundled-deep"
    ),
    "moved folder keeps its children"
  );

  const cycled = applyOrder(merged, {
    linkKeys: [],
    sectionOrder: [],
    parentByKey: {
      [outerKey]: { section: "Other", parentKey: innerKey },
    },
  });
  assert.ok(
    findFolder(cycled.Other.children, "Outer"),
    "cyclic folder placement is ignored"
  );

  const nestedCustom = applyOrder(merged, {
    linkKeys: [],
    sectionOrder: ["Other", "Misc"],
    parentByKey: {
      "id:custom-top": {
        section: "Other",
        parentKey: folderStableKey("Other", [], "Outer"),
      },
    },
  });
  const outer = findFolder(nestedCustom.Other.children, "Outer");
  assert.ok(
    outer.children.some((node) => node.id === "custom-top"),
    "custom leaf can nest under a bundled folder"
  );
  assert.ok(!childNames(nestedCustom.Misc.children).includes("Custom top"));

  const overlayIds2 = new Set(["custom-top", "custom-nested"]);
  const exported = overlayExport(
    overlayTreeFromMerged(nestedCustom, overlayIds2)
  );
  assert.ok(exported.Other, "export uses effective section");
  assert.equal(exported.Other.children[0].name, "Outer");
  assert.equal(
    exported.Other.children[0].children.some((node) => node.id === "custom-top"),
    true,
    "export includes a folder shell for a bundled parent"
  );
  assert.ok(
    !exported.Misc.children.some((node) => node.id === "custom-top"),
    "export omits the leaf from its JSON home section"
  );

  installExtensionGlobals();
  await saveCatalogOrder({
    linkKeys: [],
    sectionOrder: ["Other", "Misc"],
    parentByKey: {
      "id:custom-top": {
        section: "Other",
        parentKey: folderStableKey("Other", [], "Outer"),
      },
    },
  });
  const fromStorage = overlayExport(await getLinksOverlayForExport());
  assert.ok(
    fromStorage.Other.children.some((node) => node.name === "Outer"),
    "getLinksOverlayForExport honors parentByKey"
  );

  const sectionMoved = applyOrder(merged, {
    linkKeys: ["id:bundled-root"],
    sectionOrder: ["Misc", "Other"],
    parentByKey: {
      "id:bundled-root": { section: "Misc", parentKey: null },
    },
  });
  assert.ok(
    sectionMoved.Misc.children.some((node) => node.id === "bundled-root")
  );
  assert.ok(
    !sectionMoved.Other.children.some((node) => node.id === "bundled-root")
  );

  const env = installExtensionGlobals();
  const snapA = await getCatalogSnapshot();
  const snapB = await getCatalogSnapshot();
  assert.equal(snapA, snapB, "catalog snapshot is reused until invalidated");
  const writesAfterRead = env.setLog.filter(
    (key) => key === "catalogOrder" || key === "linksJsonOverlay"
  );
  assert.deepEqual(writesAfterRead, [], "catalog reads must not persist overlay or order");

  const deep = snapA.flatLeaves.find((leaf) => leaf.node.id === "bundled-deep");
  assert.ok(deep, "snapshot indexes nested bundled leaves");
  assert.deepEqual(deep.pathParts, ["Outer", "Inner"]);
  assert.equal(deep.stableKey, "id:bundled-deep");

  const unnamed = snapA.flatLeaves.find((leaf) => leaf.node.name === "Bundled plain");
  assert.equal(unnamed.stableKey, "Misc/Bundled plain");
  assert.deepEqual(unnamed.pathParts, []);

  const misc = snapA.sections.find((section) => section.name === "Misc");
  assert.equal(misc.hasCustom, true);
  assert.equal(misc.hasOnLoad, true);
  assert.equal(misc.hasParams, false);

  await saveCatalogOrder({
    linkKeys: ["id:custom-top"],
    sectionOrder: ["Misc", "Other"],
  });
  const snapC = await getCatalogSnapshot();
  assert.notEqual(snapA, snapC, "order save invalidates the snapshot");

  assert.throws(
    () =>
      importOverlayIntoExisting(
        {},
        JSON.stringify({
          Misc: {
            children: [{ name: "Old", type: "scriptlet", code: "console.log(1)" }],
          },
        })
      ),
    /removed field "type"/
  );
  assert.throws(
    () =>
      importOverlayIntoExisting(
        {},
        JSON.stringify({
          Misc: {
            children: [
              { name: "Old url", path: "/foo", nav: "foreground" },
            ],
          },
        })
      ),
    /removed field/
  );

  console.log("link storage: OK");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
