import { createActivateLink } from "./activate-link.js";
import { createCopyLink } from "./copy-link.js";
import { createSearchController } from "./search.js";
import {
  handleDocumentClickForCombobox,
  closeOpenContextMenu,
  createLinkUi,
  loadInjectOnLoad,
  setInjectOnLoad,
  syncAppliesToTabDots,
} from "./link-ui.js";
import {
  addLinksToSection,
  removeCustomLinkById,
  restoreCustomLinkAt,
  reparentCatalogKey,
} from "./link-storage.js";
import { buildQuickLinkNode } from "./link-quick-add.js";
import { copyLinkNodeJson } from "./link-export.js";
import { openLinkBuilderWindow } from "./open-builder-window.js";
import { loadParamValues } from "../lib/activate-link.js";
import { getCatalogSnapshot } from "../lib/catalog-service.js";
import { isCatalogChangedMessage } from "../lib/catalog-events.js";
import {
  linkStableKey,
  loadCatalogOrder,
  moveKeysInOrder,
  nodeCatalogKey,
  saveCatalogOrder,
} from "../lib/catalog-order.js";
import { isOverlayCustomLink } from "../lib/link-catalog.js";
import {
  LINK_SHORTCUT_SLOTS_KEY,
  loadShortcutSlots,
  assignSlot,
  slotForKey,
  SLOT_LABELS,
} from "../lib/link-shortcuts.js";
import { MessageTypes } from "../lib/message-types.js";
import { createNetworkArmControl } from "../lib/network-arm-control.js";
import { StorageKeys } from "../lib/storage-keys.js";
import { getActiveTab } from "../lib/tab-target.js";
import { createUiMessage } from "../lib/ui-message.js";

const UNDO_DELETE_MS = 8000;

const {
  SECTION_TAB_KEY,
  ADD_SCRIPT_EXPANDED_KEY,
  LINKS_OVERLAY_KEY,
  CATALOG_ORDER_KEY,
  INJECT_ON_LOAD_KEY,
} = StorageKeys;

const sectionTabsEl = document.getElementById("section-tabs");
const linksEl = document.getElementById("links");
const activeTabStatusEl = document.getElementById("active-tab-status");
const cspNonceLabel = document.getElementById("csp-nonce-label");
const cspNonceCheckbox = document.getElementById("csp-nonce-checkbox");
const injectOnLoadEnabledEl = document.getElementById("inject-on-load-enabled");
const networkArmEl = document.getElementById("network-arm");
const messageEl = document.getElementById("message");
const addScriptBtn = document.getElementById("add-script-btn");
const linkBuilderBtn = document.getElementById("link-builder-btn");
const addScriptSection = document.querySelector(".add-script");
const addScriptToggle = document.getElementById("add-script-toggle");
const addScriptChevron = document.querySelector(".add-script-chevron");
const addScriptPanel = document.getElementById("add-script-panel");
const scriptNameInput = document.getElementById("script-name");
const scriptCodeInput = document.getElementById("script-code");
const quickAddModeSelect = document.getElementById("quick-add-mode");
const searchInputEl = document.getElementById("search-input");

let cmApi = null;
let scriptCodeEditor = null;
let scriptEditorLoadFailed = false;

function readScriptCodeField() {
  if (cmApi) {
    return cmApi.getFieldValue(scriptCodeInput);
  }
  return scriptCodeInput?.value || "";
}

function writeScriptCodeField(value) {
  if (cmApi) {
    cmApi.setFieldValue(scriptCodeInput, value);
    return;
  }
  if (scriptCodeInput) {
    scriptCodeInput.value = value;
  }
}

function bindScriptCodeSubmit(target) {
  target.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      addQuickAction();
    }
  });
}

/**
 * Match the quick-add code field to the selected Type: scriptlets lint as
 * JavaScript, links lint as a URL/path.
 * @returns {void}
 */
function syncQuickAddCodeField() {
  const isScriptlet = quickAddModeSelect?.value === "scriptlet";
  const placeholder = isScriptlet ? "JS script" : "URL/path";
  if (cmApi) {
    cmApi.setFieldLanguage(scriptCodeInput, isScriptlet ? "javascript" : "url");
    cmApi.setFieldPlaceholder(scriptCodeInput, placeholder);
    return;
  }
  if (scriptCodeInput) {
    scriptCodeInput.placeholder = placeholder;
  }
}

async function ensureScriptEditor() {
  if (scriptCodeEditor || scriptEditorLoadFailed || !scriptCodeInput) {
    return scriptCodeEditor;
  }
  try {
    if (!document.querySelector("link[data-cm-fields]")) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "../lib/codemirror-fields.css";
      link.dataset.cmFields = "1";
      document.head.appendChild(link);
    }
    cmApi = await import("../lib/codemirror-fields.bundle.js");
    scriptCodeEditor = cmApi.attachCodeMirror(scriptCodeInput, {
      language: "javascript",
      minHeight: 80,
      // Attach as JavaScript so scriptlet completions survive Type switches;
      // syncQuickAddCodeField sets the language the current Type needs.
      completions: "javascript",
    });
    syncQuickAddCodeField();
    bindScriptCodeSubmit(scriptCodeEditor.view.dom);
    return scriptCodeEditor;
  } catch (error) {
    scriptEditorLoadFailed = true;
    console.error("CodeMirror failed to load:", error);
    return null;
  }
}

if (scriptCodeInput) {
  bindScriptCodeSubmit(scriptCodeInput);
}

quickAddModeSelect?.addEventListener("change", syncQuickAddCodeField);

let linkSections = null;
let catalogSnapshot = null;
let activeSectionName = null;
let shortcutSlots = {};

function updateStickyOffsets() {
  const header = document.querySelector("header");
  const root = document.documentElement;
  root.style.setProperty(
    "--sticky-header-height",
    `${header?.offsetHeight ?? 0}px`
  );
}

const { showMessage, hideMessage } = createUiMessage(messageEl, {
  onChange: updateStickyOffsets,
});

const activateLink = createActivateLink({ showMessage, hideMessage });
const copyLink = createCopyLink({ showMessage, hideMessage });

async function exportLinkJson(node) {
  hideMessage();
  try {
    await copyLinkNodeJson(node);
    showMessage("Link JSON copied to clipboard.");
  } catch (error) {
    showMessage(error.message || String(error));
  }
}

function editCustomLink(node) {
  openLinkBuilderWindow({ editId: node.id, sectionName: node.sectionName });
}

async function assignShortcut(node, commandName, row = null) {
  const key =
    row?.dataset?.stableKey ||
    node.stableKey ||
    (node.id
      ? `id:${node.id}`
      : linkStableKey(node.sectionName || getActiveSection()?.name, [], node));
  if (!commandName) {
    const map = await loadShortcutSlots();
    const current = slotForKey(map, key);
    if (current) {
      await assignSlot(current, null);
    }
  } else {
    await assignSlot(commandName, key);
  }
  shortcutSlots = await loadShortcutSlots();
  await renderAll();
  showMessage(
    commandName
      ? `Assigned Alt+${SLOT_LABELS[commandName]} to “${node.name}”.`
      : "Shortcut cleared."
  );
}

const linkUi = createLinkUi({
  activateLink,
  copyLink,
  exportLinkJson,
  editCustomLink,
  setInjectOnLoad,
  assignShortcut,
  getShortcutSlots: () => shortcutSlots,
  onReorderSiblings: persistSiblingOrder,
  onReparent: persistReparent,
});

function getVisibleSections() {
  return linkSections || [];
}

function getLinkSections() {
  return getVisibleSections();
}

function getActiveSection() {
  return linkSections?.find((section) => section.name === activeSectionName) || null;
}

function setActiveSectionName(name) {
  activeSectionName = name;
}

async function reloadLinkSections() {
  catalogSnapshot = await getCatalogSnapshot();
  linkSections = catalogSnapshot.sections;
}

/**
 * Persist DnD sibling order into catalogOrder.linkKeys.
 */
async function persistSiblingOrder(orderedStableKeys) {
  const order = await loadCatalogOrder();
  const linkKeys = moveKeysInOrder(order.linkKeys, orderedStableKeys);
  await saveCatalogOrder({
    ...order,
    linkKeys,
  });
  await renderAll();
}

async function persistSectionOrder(orderedSectionNames) {
  const order = await loadCatalogOrder();
  await saveCatalogOrder({
    ...order,
    sectionOrder: orderedSectionNames,
  });
  await renderAll();
}

async function persistReparent(fromKey, placement, destSiblingKeys) {
  try {
    await reparentCatalogKey(fromKey, placement, destSiblingKeys);
    await renderAll();
  } catch (error) {
    showMessage(error.message || String(error));
  }
}

async function deleteCustomLinkFromSidebar(linkId, displayName) {
  try {
    const snapshot = await removeCustomLinkById(linkId);
    const injectOnLoad = await loadInjectOnLoad();
    const hadInject = Boolean(injectOnLoad[linkId]);
    if (hadInject) {
      delete injectOnLoad[linkId];
      await browser.storage.local.set({ [INJECT_ON_LOAD_KEY]: injectOnLoad });
    }
    await renderAll();
    const name = displayName || snapshot.node?.name || "link";
    showMessage(`Deleted "${name}".`, {
      actionLabel: "Undo",
      timeoutMs: UNDO_DELETE_MS,
      onAction: async () => {
        await restoreCustomLinkAt(snapshot);
        if (hadInject) {
          const nextInject = await loadInjectOnLoad();
          nextInject[linkId] = true;
          await browser.storage.local.set({ [INJECT_ON_LOAD_KEY]: nextInject });
        }
        await renderAll();
      },
    });
  } catch (error) {
    showMessage(error.message || String(error));
  }
}

function appendEmptyPlaceholder(list, query) {
  const empty = document.createElement("p");
  empty.className = "search-empty";
  empty.textContent = query
    ? "No matching actions."
    : "No actions in this section.";
  list.appendChild(empty);
}

function renderSectionTabs() {
  if (!sectionTabsEl || !linkSections) {
    return;
  }

  const query = search.normalizeSearchQuery(search.getSearchQuery());
  sectionTabsEl.replaceChildren();
  for (const section of getVisibleSections()) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "section-tab";
    tab.draggable = true;
    tab.dataset.sectionName = section.name;
    tab.role = "tab";
    tab.textContent = section.name;
    tab.setAttribute(
      "aria-selected",
      section.name === activeSectionName ? "true" : "false"
    );
    tab.classList.toggle("active", section.name === activeSectionName);
    tab.classList.toggle(
      "search-exact-match",
      search.sectionHasExactMatch(section, query)
    );
    tab.addEventListener("click", async () => {
      activeSectionName = section.name;
      await browser.storage.local.set({ [SECTION_TAB_KEY]: activeSectionName });
      await renderAll({ reloadCatalog: false });
    });
    tab.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("text/section-name", section.name);
      event.dataTransfer.effectAllowed = "move";
      tab.classList.add("is-dragging");
    });
    tab.addEventListener("dragend", () => tab.classList.remove("is-dragging"));
    tab.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      tab.classList.add("is-drop-target");
    });
    tab.addEventListener("dragleave", () => tab.classList.remove("is-drop-target"));
    tab.addEventListener("drop", async (event) => {
      event.preventDefault();
      tab.classList.remove("is-drop-target");
      const itemKey = event.dataTransfer.getData("text/stable-key");
      if (itemKey) {
        const destKeys = (section.children || [])
          .map((node) => nodeCatalogKey(node, section.name, []))
          .filter((key) => key !== itemKey);
        destKeys.push(itemKey);
        await persistReparent(itemKey, {
          section: section.name,
          parentKey: null,
        }, destKeys);
        return;
      }
      const from = event.dataTransfer.getData("text/section-name");
      const to = section.name;
      if (!from || from === to) {
        return;
      }
      const names = getVisibleSections().map((s) => s.name);
      const fromIndex = names.indexOf(from);
      const toIndex = names.indexOf(to);
      if (fromIndex < 0 || toIndex < 0) {
        return;
      }
      names.splice(fromIndex, 1);
      names.splice(toIndex, 0, from);
      await persistSectionOrder(names);
    });
    sectionTabsEl.appendChild(tab);
  }
}

async function renderAll({ reloadCatalog = true } = {}) {
  if (!linksEl) {
    return;
  }

  try {
    if (reloadCatalog || !catalogSnapshot) {
      await reloadLinkSections();
    }
    shortcutSlots = await loadShortcutSlots();
    linksEl.replaceChildren();
    const savedParamValues = await loadParamValues();
    const injectOnLoad = await loadInjectOnLoad();
    const activeTab = await getActiveTab();
    const activeTabUrl = activeTab?.url || null;
    const section = getActiveSection();
    const overlayLinkIds = catalogSnapshot.overlayLinkIds;
    const showRemove = Boolean(section?.hasCustom);
    const showParams = Boolean(section?.hasParams);
    const showOnLoad = Boolean(section?.hasOnLoad);
    const query = search.normalizeSearchQuery(search.getSearchQuery());

    const list = document.createElement("div");
    list.className = "link-list";
    if (query) {
      list.classList.add("is-searching");
    }
    if (showRemove) {
      list.classList.add("has-remove");
    }
    if (showParams) {
      list.classList.add("has-params");
    }
    if (showOnLoad) {
      list.classList.add("has-on-load");
    }
    list.appendChild(linkUi.createLinkListHeader({ showRemove, showParams, showOnLoad }));

    if (section) {
      if (query) {
        const sortedLeaves = search.sortNodesBySearchScore(
          (catalogSnapshot.flatLeaves || [])
            .filter((leaf) => leaf.sectionName === section.name)
            .map((leaf) => ({ ...leaf.node, stableKey: leaf.stableKey })),
          (node, activeQuery) => search.nodeSearchScore(node, activeQuery)
        );
        if (!sortedLeaves.length) {
          appendEmptyPlaceholder(list, query);
        }
        for (const node of sortedLeaves) {
          list.appendChild(
            linkUi.createLinkRow(node, {
              savedParamValues,
              injectOnLoad,
              activeTabUrl,
              showRemove: showRemove,
              isCustom: isOverlayCustomLink(node, overlayLinkIds),
              stableKey: node.stableKey,
              enableDrag: false,
              onDelete: isOverlayCustomLink(node, overlayLinkIds)
                ? async (event) => {
                    event.stopPropagation();
                    await deleteCustomLinkFromSidebar(node.id, node.name);
                  }
                : null,
              ...search.getSearchRowHighlight(node, query),
            })
          );
        }
      } else {
        linkUi.renderNodes(
          section.children,
          list,
          savedParamValues,
          section.match,
          section.name,
          injectOnLoad,
          {
            showRemoveColumn: showRemove,
            enableDrag: true,
            inheritedExclude: section.exclude ?? null,
            activeTabUrl,
            pathParts: [],
            overlayLinkIds,
            onDeleteCustom: async (linkId, node) => {
              await deleteCustomLinkFromSidebar(linkId, node?.name);
            },
          }
        );
        if (
          !list.querySelector(".link-row") &&
          !list.querySelector(".folder")
        ) {
          appendEmptyPlaceholder(list, "");
        }
      }
    }

    linksEl.appendChild(list);
    renderSectionTabs();
    requestAnimationFrame(updateStickyOffsets);
  } catch (error) {
    showMessage(error.message || String(error));
  }
}

const search = createSearchController({
  searchInputEl,
  displayLabel: linkUi.displayLabel,
  getLinkSections,
  getActiveSection,
  setActiveSectionName,
  sectionTabKey: SECTION_TAB_KEY,
  renderAll: () => renderAll({ reloadCatalog: false }),
  getFlatLeaves: () => catalogSnapshot?.flatLeaves || [],
});

async function addQuickAction() {
  hideMessage();

  const section = getActiveSection();
  if (!section) {
    showMessage("Select a section tab before adding an action.");
    return;
  }

  try {
    const leafNodes = (catalogSnapshot.flatLeaves || [])
      .filter((leaf) => leaf.sectionName === section.name)
      .map((leaf) => leaf.node);
    const node = buildQuickLinkNode(
      readScriptCodeField(),
      scriptNameInput.value,
      leafNodes,
      quickAddModeSelect?.value || "link"
    );
    await addLinksToSection(section.name, [node]);
    scriptNameInput.value = "";
    writeScriptCodeField("");
    setAddScriptExpanded(false);
    await browser.storage.local.set({ [ADD_SCRIPT_EXPANDED_KEY]: false });
    await renderAll();
    showMessage(`Added "${node.name}" to ${section.name}.`);
  } catch (error) {
    showMessage(error.message || String(error));
    if (cmApi) {
      cmApi.focusField(scriptCodeInput);
    } else {
      scriptCodeInput?.focus();
    }
  }
}

async function initAddScriptCollapse() {
  const stored = await browser.storage.local.get(ADD_SCRIPT_EXPANDED_KEY);
  setAddScriptExpanded(stored[ADD_SCRIPT_EXPANDED_KEY] === true);

  addScriptToggle.addEventListener("click", async () => {
    const expanded = addScriptToggle.getAttribute("aria-expanded") !== "true";
    setAddScriptExpanded(expanded);
    await browser.storage.local.set({ [ADD_SCRIPT_EXPANDED_KEY]: expanded });
  });

  if (addScriptChevron) {
    addScriptChevron.addEventListener("click", () => {
      addScriptToggle.click();
    });
  }
}

function setAddScriptExpanded(expanded) {
  addScriptSection.classList.toggle("is-collapsed", !expanded);
  addScriptToggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  addScriptPanel.hidden = !expanded;
  if (expanded) {
    void ensureScriptEditor();
  }
}

async function syncCspNonceUi(tab) {
  if (!cspNonceCheckbox || !cspNonceLabel) {
    return;
  }

  const origin = originFromTabUrl(tab?.url);
  const usable = Boolean(origin) && Number.isInteger(tab?.id) && tab.id >= 0;

  cspNonceCheckbox.disabled = !usable;
  cspNonceLabel.classList.toggle("is-disabled", !usable);
  // Say "this tab" and "every frame": the scope is the part people get wrong,
  // and it now covers third-party frames, not just the site in the address bar.
  cspNonceLabel.title = usable
    ? `Let Hackery Lab scriptlets run in every frame of this tab (currently ${origin}), even where a Content-Security-Policy blocks scripts. ` +
      "Adds a one-time nonce to each document's own policy; the rest of that policy stays enforced, so this is not Disable CSP. " +
      "Covers cross-origin frames in this tab and no other tab. Turns off when the tab closes. Hard-reload (Ctrl+Shift+R) to apply."
    : "Only available on http(s) pages — open a site tab first.";

  if (!usable) {
    cspNonceCheckbox.checked = false;
    return;
  }

  const response = await browser.runtime.sendMessage({
    type: MessageTypes.GET_CSP_NONCE,
    tabId: tab.id,
  });
  cspNonceCheckbox.checked = Boolean(response?.enabled);
}

function originFromTabUrl(url) {
  try {
    if (typeof url === "string" && /^https?:\/\//i.test(url)) {
      return new URL(url).origin;
    }
  } catch {
    // ignore
  }
  return "";
}

/** @type {{ refresh: () => Promise<void>, render: (snapshot: object) => void } | null} */
let networkArm = null;

async function initExtensionSettingsControls() {
  const response = await browser.runtime.sendMessage({
    type: MessageTypes.GET_EXTENSION_SETTINGS,
  });
  const settings = response?.settings || {
    injectOnLoadEnabled: true,
  };

  if (injectOnLoadEnabledEl) {
    injectOnLoadEnabledEl.checked = settings.injectOnLoadEnabled !== false;
    injectOnLoadEnabledEl.addEventListener("change", async () => {
      await browser.runtime.sendMessage({
        type: MessageTypes.SET_EXTENSION_SETTINGS,
        settings: { injectOnLoadEnabled: injectOnLoadEnabledEl.checked },
      });
    });
  }
}

/**
 * Update the active-tab status line and green apply-dots without a full re-render.
 */
async function syncActiveTabChrome() {
  const activeTab = await getActiveTab();
  if (activeTabStatusEl) {
    if (activeTab?.url) {
      try {
        activeTabStatusEl.textContent = `Active tab: ${new URL(activeTab.url).origin}`;
      } catch {
        activeTabStatusEl.textContent = "Active tab";
      }
    } else {
      activeTabStatusEl.textContent = "No active tab";
    }
  }
  syncAppliesToTabDots(linksEl, activeTab?.url || null);
}

async function initCspNonceControl() {
  if (!cspNonceCheckbox) {
    return;
  }

  const syncFromActiveTab = async () => {
    await syncCspNonceUi(await getActiveTab());
  };

  await syncFromActiveTab();

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void syncFromActiveTab();
      void syncActiveTabChrome();
      void networkArm?.refresh();
    }
  });

  cspNonceCheckbox.addEventListener("change", async () => {
    const tab = await getActiveTab();
    if (!Number.isInteger(tab?.id) || tab.id < 0 || cspNonceCheckbox.disabled) {
      return;
    }

    await browser.runtime.sendMessage({
      type: MessageTypes.SET_CSP_NONCE,
      tabId: tab.id,
      enabled: cspNonceCheckbox.checked,
    });

    if (cspNonceCheckbox.checked) {
      showMessage(
        "Scriptlets allowed to run in every frame of this tab — hard-reload (Ctrl+Shift+R) to apply. Each document keeps its own CSP apart from the added nonce."
      );
    } else {
      hideMessage();
    }
  });
}

async function initNetworkArmControl() {
  if (!networkArmEl) {
    return;
  }
  networkArm = createNetworkArmControl(networkArmEl);
  await networkArm.refresh();
}

function initActiveTabListeners() {
  const refresh = () => {
    void syncActiveTabChrome();
    void getActiveTab().then((tab) => syncCspNonceUi(tab));
  };

  if (browser.tabs?.onActivated) {
    browser.tabs.onActivated.addListener(refresh);
  }
  if (browser.tabs?.onUpdated) {
    browser.tabs.onUpdated.addListener((_tabId, changeInfo) => {
      if (changeInfo.url || changeInfo.status === "complete") {
        refresh();
      }
    });
  }
  if (browser.windows?.onFocusChanged) {
    browser.windows.onFocusChanged.addListener(refresh);
  }
}

async function init() {
  await reloadLinkSections();
  const stored = await browser.storage.local.get(SECTION_TAB_KEY);
  const visibleSections = getVisibleSections();
  const storedTab = stored[SECTION_TAB_KEY];
  activeSectionName =
    (storedTab && visibleSections.some((section) => section.name === storedTab)
      ? storedTab
      : null) ||
    visibleSections.find((section) => section.name === "Reverse-engineering tools")
      ?.name ||
    visibleSections[0]?.name ||
    null;

  await syncActiveTabChrome();
  updateStickyOffsets();

  addScriptBtn.addEventListener("click", () => {
    addQuickAction();
  });
  linkBuilderBtn.addEventListener("click", () => {
    openLinkBuilderWindow({ sectionName: activeSectionName });
  });

  document.addEventListener("click", handleDocumentClickForCombobox);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeOpenContextMenu();
    }
  });

  initActiveTabListeners();
  browser.storage.onChanged.addListener((changes, area) => {
    if (
      area === "local" &&
      (changes[LINKS_OVERLAY_KEY] ||
        changes[CATALOG_ORDER_KEY] ||
        changes[LINK_SHORTCUT_SLOTS_KEY])
    ) {
      renderAll();
    }
  });

  browser.runtime.onMessage.addListener((message) => {
    if (isCatalogChangedMessage(message)) {
      void renderAll();
      return;
    }
    if (message?.type === MessageTypes.CSP_NONCE_CHANGED) {
      void getActiveTab().then((tab) => {
        if (!Number.isInteger(tab?.id) || tab.id === message.tabId) {
          void syncCspNonceUi(tab);
        }
      });
    }
  });

  const params = new URLSearchParams(location.search);
  if (params.get("q")) {
    search.setSearchQuery(params.get("q"));
  }

  search.initSearch();
  await renderAll();
  await initAddScriptCollapse();
  try {
    await initExtensionSettingsControls();
  } catch (error) {
    console.error("Failed to load extension settings:", error);
  }
  try {
    await initCspNonceControl();
  } catch (error) {
    console.error("Failed to init CSP nonce control:", error);
  }
  try {
    await initNetworkArmControl();
  } catch (error) {
    console.error("Failed to init network arm control:", error);
  }
}

init().catch((error) => {
  showMessage(error.message || String(error));
});
