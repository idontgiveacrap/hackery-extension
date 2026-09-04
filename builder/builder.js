import { attachCodeMirrorAll, getFieldValue } from "../lib/codemirror-fields.bundle.js";
import {
  addLinksToSection,
  getAllCustomLinks,
  findCustomLinkById,
  loadMergedLinkCatalog,
  removeCustomLinkById,
  restoreCustomLinkAt,
  reparentCatalogKey,
  updateCustomLink,
  getCatalogSectionNames,
  getLinksOverlayForExport,
  importLinksOverlay,
} from "../sidebar/link-storage.js";
import {
  buildLinkNodeFromForm,
  readBuilderForm,
  populateBuilderForm,
  clearBuilderForm,
  getBuilderFormElements,
  applyTabPrefill,
  initBuilderForm,
  updateBuilderFieldVisibility,
} from "../sidebar/link-builder.js";
import { consumeBuilderPrefill } from "../sidebar/link-quick-add.js";
import { readParameterFields } from "../sidebar/link-builder-fields.js";
import { downloadOverlayJson } from "../sidebar/link-export.js";
import { linkBadgeLabel } from "../lib/link-behaviors.js";
import { overlayExport } from "../lib/link-catalog.js";
import { nodeCatalogKey } from "../lib/catalog-order.js";
import { StorageKeys } from "../lib/storage-keys.js";
import { createUiMessage } from "../lib/ui-message.js";
import { loadInjectOnLoad } from "../sidebar/link-ui.js";

const { LINKS_OVERLAY_KEY, LINK_BUILDER_SECTION_KEY, INJECT_ON_LOAD_KEY } =
  StorageKeys;
const UNDO_DELETE_MS = 8000;

const linksListEl = document.getElementById("links-list");
const linkCountEl = document.getElementById("link-count");
const messageEl = document.getElementById("message");
const linkFormEl = document.getElementById("link-form");
const editorTitleEl = document.getElementById("editor-title");
const importFileInput = document.getElementById("import-file-input");
const importBtn = document.getElementById("import-btn");
const deleteLinkBtn = document.getElementById("delete-link-btn");

const builderElements = getBuilderFormElements();

/**
 * Collect scriptlet param names currently defined in the builder form.
 * @returns {string[]}
 */
function currentScriptletParamNames() {
  const fields = readParameterFields(builderElements.fieldElements);
  if (fields.parameter?.name) {
    return [fields.parameter.name];
  }
  const bag = fields.parameters || fields.params;
  return bag ? Object.keys(bag) : [];
}

attachCodeMirrorAll({
  linkCode: {
    element: builderElements.codeInput,
    language: "javascript",
    completions: "scriptlet",
    getParamNames: currentScriptletParamNames,
    minHeight: 120,
  },
  hostPattern: {
    element: builderElements.fieldElements.hostPatternCustomInput,
    language: "regex",
    compact: true,
    placeholder: "e.g. \\.example\\.com$",
  },
  framesMatch: {
    element: builderElements.fieldElements.framesMatchInput,
    language: "regex",
    compact: true,
    placeholder: "e.g. /edit$",
  },
});

let customLinks = [];
let sectionNames = [];
let selectedLinkId = null;
let defaultSectionName = null;
/** @type {string|null} */
let formSnapshot = null;

const { showMessage, hideMessage } = createUiMessage(messageEl);

function typeBadge(node) {
  return linkBadgeLabel(node);
}

function snapshotForm() {
  try {
    const form = readBuilderForm(builderElements);
    form.code = getFieldValue(builderElements.codeInput) || form.code || "";
    return JSON.stringify(form);
  } catch {
    return null;
  }
}

function markFormClean() {
  formSnapshot = snapshotForm();
}

function isFormDirty() {
  if (formSnapshot == null) {
    return false;
  }
  const current = snapshotForm();
  return current !== formSnapshot;
}

function confirmDiscardIfDirty() {
  if (!isFormDirty()) {
    return true;
  }
  return window.confirm("Discard unsaved changes?");
}

function getSelectedLink() {
  return customLinks.find((link) => link.id === selectedLinkId) || null;
}

function selectLink(linkId) {
  if (selectedLinkId !== linkId && !confirmDiscardIfDirty()) {
    return;
  }
  selectedLinkId = linkId;
  const link = getSelectedLink();
  if (!link) {
    editorTitleEl.textContent = "New link";
    deleteLinkBtn.disabled = true;
    renderLinksList();
    markFormClean();
    return;
  }

  populateBuilderForm(builderElements, link, link.sectionName, sectionNames);
  editorTitleEl.textContent = link.name;
  deleteLinkBtn.disabled = false;
  renderLinksList();
  markFormClean();
}

function createLinkDeleteButton(link) {
  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "link-item-delete";
  deleteBtn.title = "Delete link";
  deleteBtn.setAttribute("aria-label", `Delete ${link.name}`);
  deleteBtn.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M6 1h4l1 1h3v2H2V2h3l1-1zM3 5h10l-1 9H4L3 5zm3 2v5h1V7H6zm3 0v5h1V7H9z"/></svg>';
  deleteBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    deleteLinkById(link.id);
  });
  return deleteBtn;
}

function renderLinksList() {
  linksListEl.replaceChildren();
  linkCountEl.textContent = `${customLinks.length} link${
    customLinks.length === 1 ? "" : "s"
  }`;

  if (customLinks.length === 0) {
    const empty = document.createElement("p");
    empty.className = "editor-empty";
    empty.textContent = "No user-added links yet.";
    linksListEl.appendChild(empty);
    return;
  }

  for (const link of customLinks) {
    const row = document.createElement("div");
    row.className = "link-item-row";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "link-item";
    button.classList.toggle("active", link.id === selectedLinkId);

    const badge = document.createElement("span");
    badge.className = "link-item-badge";
    badge.textContent = typeBadge(link);

    const labelWrap = document.createElement("span");
    labelWrap.className = "link-item-label-wrap";

    const label = document.createElement("span");
    label.className = "link-item-label";
    label.textContent = link.name;

    const sectionHint = document.createElement("span");
    sectionHint.className = "link-item-section";
    sectionHint.textContent = link.sectionName;

    labelWrap.appendChild(label);
    labelWrap.appendChild(sectionHint);

    button.appendChild(badge);
    button.appendChild(labelWrap);
    button.addEventListener("click", () => selectLink(link.id));

    row.appendChild(button);
    row.appendChild(createLinkDeleteButton(link));
    linksListEl.appendChild(row);
  }
}

async function reloadLinks() {
  customLinks = await getAllCustomLinks();
  sectionNames = await getCatalogSectionNames();

  if (selectedLinkId && !customLinks.some((link) => link.id === selectedLinkId)) {
    selectedLinkId = null;
    await startNewLink();
  } else if (selectedLinkId) {
    const link = getSelectedLink();
    populateBuilderForm(builderElements, link, link.sectionName, sectionNames);
  }

  renderLinksList();
}

async function saveCurrentLink(event) {
  event.preventDefault();
  hideMessage();

  try {
    const form = readBuilderForm(builderElements);
    const node = buildLinkNodeFromForm(form);

    if (form.editId) {
      const previousSection = getSelectedLink()?.sectionName;
      await updateCustomLink(form.editId, node, form.sectionName);
      if (form.sectionName !== previousSection) {
        const catalog = await loadMergedLinkCatalog();
        const movedKey = `id:${form.editId}`;
        const destKeys = (catalog[form.sectionName]?.children || [])
          .map((entry) => nodeCatalogKey(entry, form.sectionName, []))
          .filter((key) => key !== movedKey);
        destKeys.push(movedKey);
        await reparentCatalogKey(
          movedKey,
          { section: form.sectionName, parentKey: null },
          destKeys
        );
      }
      selectedLinkId = form.editId;
      showMessage(`Saved "${node.name}" in ${form.sectionName}.`);
    } else {
      await addLinksToSection(form.sectionName, [node]);
      selectedLinkId = node.id;
      builderElements.editIdInput.value = node.id;
      showMessage(`Added "${node.name}" to ${form.sectionName}.`);
    }

    await reloadLinks();
    formSnapshot = null;
    selectLink(selectedLinkId);
    markFormClean();
  } catch (error) {
    showMessage(error.message || String(error));
  }
}

async function deleteLinkById(linkId) {
  const link = customLinks.find((entry) => entry.id === linkId);
  if (!link?.id) {
    return;
  }

  hideMessage();
  let snapshot;
  try {
    snapshot = await removeCustomLinkById(link.id);
  } catch (error) {
    showMessage(error.message || String(error));
    return;
  }

  const injectOnLoad = await loadInjectOnLoad();
  const hadInject = Boolean(injectOnLoad[linkId]);
  if (hadInject) {
    delete injectOnLoad[linkId];
    await browser.storage.local.set({ [INJECT_ON_LOAD_KEY]: injectOnLoad });
  }

  if (selectedLinkId === linkId) {
    selectedLinkId = null;
    await startNewLink();
  }

  await reloadLinks();
  showMessage(`Deleted "${link.name}".`, {
    actionLabel: "Undo",
    timeoutMs: UNDO_DELETE_MS,
    onAction: async () => {
      await restoreCustomLinkAt(snapshot);
      if (hadInject) {
        const nextInject = await loadInjectOnLoad();
        nextInject[linkId] = true;
        await browser.storage.local.set({ [INJECT_ON_LOAD_KEY]: nextInject });
      }
      selectedLinkId = linkId;
      await reloadLinks();
      selectLink(linkId);
    },
  });
}

async function deleteCurrentLink() {
  const link = getSelectedLink();
  if (!link?.id) {
    return;
  }
  await deleteLinkById(link.id);
}

async function startNewLink(sectionName = defaultSectionName) {
  if (!confirmDiscardIfDirty()) {
    return;
  }
  hideMessage();
  selectedLinkId = null;
  clearBuilderForm(builderElements, sectionNames, sectionName);
  editorTitleEl.textContent = "New link";
  deleteLinkBtn.disabled = true;

  const prefill = await consumeBuilderPrefill();
  if (prefill) {
    applyTabPrefill(
      builderElements,
      prefill,
      prefill.builderType || (prefill.fromSelector ? "derived-url" : "navigate")
    );
  } else {
    updateBuilderFieldVisibility(builderElements);
  }

  builderElements.nameInput.focus();
  renderLinksList();
  markFormClean();
}

async function importLinksFromJson(raw) {
  hideMessage();

  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    showMessage("Choose a JSON file to import.");
    return;
  }

  if (importBtn) {
    importBtn.disabled = true;
  }
  showMessage("Importing…");

  try {
    const { importedLeafCount, sectionNames: importedSections } =
      await importLinksOverlay(trimmed);
    await reloadLinks();
    showMessage(
      `Imported ${importedLeafCount} link(s) into ${importedSections.join(", ")}.`
    );
  } catch (error) {
    showMessage(error.message || String(error));
  } finally {
    if (importBtn) {
      importBtn.disabled = false;
    }
  }
}

async function importLinksFromFile(file) {
  if (!file) {
    return;
  }

  try {
    await importLinksFromJson(await file.text());
  } catch (error) {
    showMessage(error.message || String(error));
  }
}

async function exportCustomLinks() {
  hideMessage();
  try {
    const overlay = await getLinksOverlayForExport();
    const exported = overlayExport(overlay);
    if (!Object.keys(exported).length) {
      showMessage("No user-added links to export.");
      return;
    }
    downloadOverlayJson(overlay);
    showMessage("Downloaded custom-links.json.");
  } catch (error) {
    showMessage(error.message || String(error));
  }
}

function readEditIdFromQuery() {
  return new URLSearchParams(window.location.search).get("edit");
}

function readSectionFromQuery() {
  return new URLSearchParams(window.location.search).get("section");
}

async function readDefaultSectionName() {
  const fromQuery = readSectionFromQuery();
  if (fromQuery) {
    return fromQuery;
  }

  const stored = await browser.storage.session.get(LINK_BUILDER_SECTION_KEY);
  const fromSession = stored[LINK_BUILDER_SECTION_KEY];
  if (fromSession) {
    await browser.storage.session.remove(LINK_BUILDER_SECTION_KEY);
    return fromSession;
  }

  return sectionNames[0] || "Misc";
}

async function init() {
  sectionNames = await getCatalogSectionNames();
  defaultSectionName = await readDefaultSectionName();
  if (!sectionNames.includes(defaultSectionName)) {
    sectionNames = [...sectionNames, defaultSectionName].sort((a, b) =>
      a.localeCompare(b)
    );
  }

  initBuilderForm(builderElements, {
    sectionNames,
    defaultSection: defaultSectionName,
  });

  linkFormEl.addEventListener("submit", saveCurrentLink);
  deleteLinkBtn.addEventListener("click", deleteCurrentLink);
  document.getElementById("clear-form-btn").addEventListener("click", async () => {
    if (!confirmDiscardIfDirty()) {
      return;
    }
    formSnapshot = null;
    if (selectedLinkId) {
      selectLink(selectedLinkId);
      return;
    }
    await startNewLink(defaultSectionName);
  });
  document.getElementById("new-link-btn").addEventListener("click", () => {
    startNewLink(defaultSectionName);
  });
  document.getElementById("export-custom-btn").addEventListener("click", exportCustomLinks);
  document.getElementById("import-btn").addEventListener("click", () => {
    importFileInput.click();
  });
  importFileInput.addEventListener("change", async () => {
    const file = importFileInput.files?.[0];
    importFileInput.value = "";
    await importLinksFromFile(file);
  });

  window.addEventListener("beforeunload", (event) => {
    if (isFormDirty()) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[LINKS_OVERLAY_KEY]) {
      reloadLinks().catch((error) => {
        showMessage(error.message || String(error));
      });
    }
  });

  await reloadLinks();

  const editId = readEditIdFromQuery();
  if (editId) {
    const found = await findCustomLinkById(editId);
    if (found) {
      selectedLinkId = editId;
      selectLink(editId);
      return;
    }
  }

  await startNewLink(defaultSectionName);
}

init().catch((error) => {
  showMessage(error.message || String(error));
});
