import { saveParamValue, readParamValuesFromRow } from "../lib/activate-link.js";
import { nodeCatalogKey } from "../lib/catalog-order.js";
import { isOverlayCustomLink } from "../lib/link-catalog.js";
import {
  displayHint,
  linkBadgeClass,
  linkBadgeLabel,
  linkBadgeTitle,
  matchBehavior,
} from "../lib/link-behaviors.js";
import {
  getEditableValueDefs,
  linkAppliesToUrl,
  linkStorageKey,
  nodeHasOnLoad,
  resolveExclude,
  resolveMatch,
  resolveParamValues,
  resolveRunAt,
  urlSkipReason,
} from "../lib/link-model.js";
import { buildLinkInspectSnapshot, dumpInspectSnapshotToTab } from "../lib/link-inspect.js";
import { slotForKey, SLOT_COMMANDS, SLOT_LABELS } from "../lib/link-shortcuts.js";
import { getActiveTab } from "../lib/tab-target.js";
import { StorageKeys } from "../lib/storage-keys.js";

const APPLIES_TO_TAB_TITLE = "Applies to this tab";

/**
 * True when the link's match/exclude pair targets the given tab URL.
 * No match pattern means the link always uses the active tab unless excluded.
 * @param {string|null|undefined} matchPattern
 * @param {string|null|undefined} tabUrl
 * @param {string|null|undefined} excludePattern
 */
export function linkAppliesToTab(matchPattern, tabUrl, excludePattern) {
  return linkAppliesToUrl(tabUrl, matchPattern, excludePattern);
}

/**
 * Short reason the apply-dot is hidden, or empty when the link applies.
 * @param {string|null|undefined} matchPattern
 * @param {string|null|undefined} tabUrl
 * @param {string|null|undefined} excludePattern
 */
export function applySkipReason(matchPattern, tabUrl, excludePattern) {
  return urlSkipReason(tabUrl, matchPattern, excludePattern);
}

/**
 * Show/hide apply-dots on rendered rows when the active tab changes.
 * @param {ParentNode|null|undefined} container
 * @param {string|null|undefined} tabUrl
 */
export function syncAppliesToTabDots(container, tabUrl) {
  if (!container) {
    return;
  }
  for (const row of container.querySelectorAll(".link-row")) {
    if (!Object.prototype.hasOwnProperty.call(row.dataset, "match")) {
      continue;
    }
    const pattern = row.dataset.match || null;
    const exclude = Object.prototype.hasOwnProperty.call(row.dataset, "exclude")
      ? row.dataset.exclude || null
      : null;
    const dot = row.querySelector(".link-applies-dot");
    if (dot) {
      const applies = linkAppliesToTab(pattern, tabUrl, exclude);
      dot.hidden = !applies;
      const reason = applySkipReason(pattern, tabUrl, exclude);
      dot.title = applies ? APPLIES_TO_TAB_TITLE : reason;
    }
  }
}

const { INJECT_ON_LOAD_KEY } = StorageKeys;

function placementForParentEl(parentEl, sectionName) {
  if (parentEl?.classList.contains("folder")) {
    return {
      section: sectionName,
      parentKey: parentEl.dataset.stableKey || null,
    };
  }
  return { section: sectionName, parentKey: null };
}

function childStableKeys(container) {
  return [...container.querySelectorAll(":scope > .link-row, :scope > .folder")]
    .map((el) => el.dataset.stableKey)
    .filter(Boolean);
}

let openCombobox = null;
let openContextMenu = null;

export function closeOpenContextMenu() {
  if (!openContextMenu) {
    return;
  }
  openContextMenu.remove();
  openContextMenu = null;
}

export function closeOpenCombobox() {
  if (!openCombobox) {
    return;
  }
  openCombobox.list.hidden = true;
  if (openCombobox.onScroll) {
    window.removeEventListener("scroll", openCombobox.onScroll, true);
  }
  openCombobox = null;
}

export function handleDocumentClickForCombobox(event) {
  if (openCombobox && !openCombobox.root.contains(event.target)) {
    closeOpenCombobox();
  }
  if (openContextMenu && !openContextMenu.contains(event.target)) {
    closeOpenContextMenu();
  }
}

/**
 * One `label: value` pair in the inspect grid.
 * @param {HTMLElement} grid two-column grid so labels line up across rows
 * @param {string} label
 * @param {string | Array<string | { text: string, tone?: string }>} value
 *   an array renders one line per item
 * @param {string} [tone] `ok` / `warn` colors the value
 */
function appendInspectRow(grid, label, value, tone) {
  const key = document.createElement("span");
  key.className = "link-inspect-key";
  key.textContent = label;
  grid.appendChild(key);

  if (!Array.isArray(value)) {
    const valueEl = document.createElement("span");
    valueEl.className = "link-inspect-value";
    if (tone) {
      valueEl.classList.add(`is-${tone}`);
    }
    valueEl.textContent = value;
    grid.appendChild(valueEl);
    return;
  }

  const list = document.createElement("div");
  list.className = "link-inspect-list";
  for (const item of value) {
    const itemEl = document.createElement("div");
    itemEl.className = "link-inspect-item";
    const itemTone = typeof item === "string" ? tone : item.tone;
    if (itemTone) {
      itemEl.classList.add(`is-${itemTone}`);
    }
    itemEl.textContent = typeof item === "string" ? item : item.text;
    list.appendChild(itemEl);
  }
  grid.appendChild(list);
}

function buildInspectBody(snapshot) {
  const body = document.createDocumentFragment();

  const title = document.createElement("div");
  title.className = "link-inspect-title";
  title.textContent = snapshot.name;
  const behavior = document.createElement("span");
  behavior.className = "link-inspect-behavior";
  behavior.textContent = snapshot.behaviorId;
  title.appendChild(behavior);
  body.appendChild(title);

  const grid = document.createElement("div");
  grid.className = "link-inspect-grid";

  appendInspectRow(grid, "match", snapshot.match ?? "(none)");
  appendInspectRow(grid, "exclude", snapshot.exclude ?? "(none)");
  appendInspectRow(grid, "runAt", snapshot.runAt);
  appendInspectRow(grid, "sandbox", snapshot.sandbox);
  appendInspectRow(
    grid,
    "apply",
    snapshot.applySkip || "applies to current URL",
    snapshot.applySkip ? "warn" : "ok"
  );
  appendInspectRow(
    grid,
    "target",
    snapshot.target?.tab?.url || snapshot.targetError || "(none)",
    snapshot.targetError ? "warn" : undefined
  );
  appendInspectRow(grid, "cached origin", snapshot.cachedOrigin || "(none)");

  // Without match and exclude every tab qualifies, so the enumeration is noise
  // (and misleading: such a link targets the active tab).
  if (!snapshot.match && !snapshot.exclude) {
    appendInspectRow(grid, "matching tabs", "* (all tabs)");
  } else {
    appendInspectRow(
      grid,
      `matching tabs (${snapshot.matchingTabs.length})`,
      snapshot.matchingTabs.length
        ? snapshot.matchingTabs.map((tab) => tab.url)
        : "(none)"
    );
  }

  const onLoadText = snapshot.onLoad.eligible
    ? snapshot.onLoad.skipReason || "would run"
    : snapshot.onLoad.skipReason;
  appendInspectRow(
    grid,
    "on-load",
    onLoadText,
    snapshot.onLoad.eligible && !snapshot.onLoad.skipReason ? "ok" : "warn"
  );

  if (snapshot.frames.length) {
    appendInspectRow(
      grid,
      `frames (${snapshot.frames.filter((frame) => frame.targeted).length}/${
        snapshot.frames.length
      })`,
      snapshot.frames.map((frame) => ({
        text: `${frame.frameId}${frame.targeted ? "*" : " "} ${frame.url}`,
        tone: frame.targeted ? "ok" : undefined,
      }))
    );
  }

  if (snapshot.compiled?.kind === "url") {
    appendInspectRow(
      grid,
      "compiled URL",
      snapshot.compiled.url || snapshot.compiled.error || "(none)",
      snapshot.compiled.error || !snapshot.compiled.url ? "warn" : "ok"
    );
    const sources = snapshot.compiled.sources;
    if (sources && Object.keys(sources).length) {
      appendInspectRow(
        grid,
        "navParams",
        Object.entries(sources).map(
          ([name, source]) =>
            `${name}=${snapshot.compiled.values?.[name] || "(empty)"} (${source})`
        )
      );
    }
  }

  if (snapshot.compiled?.kind === "script") {
    const params = Object.entries(snapshot.compiled.paramValues || {});
    if (params.length) {
      appendInspectRow(
        grid,
        "params",
        params.map(([name, value]) => `${name}=${value || "(empty)"}`)
      );
    }
  }

  body.appendChild(grid);

  if (snapshot.compiled?.kind === "script" && snapshot.compiled.source) {
    const source = document.createElement("pre");
    source.className = "link-inspect-pre";
    source.textContent = snapshot.compiled.source;
    body.appendChild(source);
  }

  return body;
}

function showInspectPopover(anchorEvent, snapshot) {
  closeOpenContextMenu();
  const popover = document.createElement("div");
  popover.className = "link-inspect-popover";
  popover.setAttribute("role", "dialog");
  popover.appendChild(buildInspectBody(snapshot));
  document.body.appendChild(popover);
  openContextMenu = popover;

  const rect = popover.getBoundingClientRect();
  const left = Math.max(
    8,
    Math.min(anchorEvent.clientX, window.innerWidth - rect.width - 8)
  );
  const top = Math.max(
    8,
    Math.min(anchorEvent.clientY, window.innerHeight - rect.height - 8)
  );
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

async function inspectCatalogLink(node, row, event) {
  const activeTab = await getActiveTab();
  const paramValues = row
    ? readParamValuesFromRow(row, getEditableValueDefs(node))
    : {};
  const snapshot = await buildLinkInspectSnapshot(node, {
    activeTab,
    paramValues,
    windowId: activeTab?.windowId ?? null,
  });
  showInspectPopover(event, snapshot);
  const tabId = snapshot.target?.tab?.id;
  if (tabId) {
    try {
      await dumpInspectSnapshotToTab(tabId, snapshot);
    } catch {
      // restricted tab
    }
  }
}

function addMenuItem(menu, label, onClick) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "link-context-menu-item";
  item.setAttribute("role", "menuitem");
  item.textContent = label;
  item.addEventListener("mousedown", (mousedownEvent) => {
    mousedownEvent.preventDefault();
    mousedownEvent.stopPropagation();
  });
  item.addEventListener("click", (clickEvent) => {
    clickEvent.preventDefault();
    clickEvent.stopPropagation();
    closeOpenContextMenu();
    onClick();
  });
  menu.appendChild(item);
  return item;
}

function showLinkContextMenu(
  event,
  node,
  row,
  { copyLink, exportLinkJson, editCustomLink, assignShortcut, getShortcutSlots }
) {
  event.preventDefault();
  event.stopPropagation();
  closeOpenCombobox();
  closeOpenContextMenu();

  const menu = document.createElement("div");
  menu.className = "link-context-menu";
  menu.setAttribute("role", "menu");

  addMenuItem(menu, "Copy", () => copyLink(node, row));
  addMenuItem(menu, "Inspect", () => {
    void inspectCatalogLink(node, row, event);
  });
  addMenuItem(menu, "Export JSON", () => exportLinkJson(node));

  if (editCustomLink && node.id) {
    addMenuItem(menu, "Edit in builder", () => editCustomLink(node));
  }

  if (assignShortcut) {
    const slots = getShortcutSlots?.() || {};
    const current = slotForKey(slots, row.dataset.stableKey);
    const sep = document.createElement("div");
    sep.className = "link-context-menu-sep";
    sep.setAttribute("role", "separator");
    menu.appendChild(sep);
    for (const cmd of SLOT_COMMANDS) {
      const label = SLOT_LABELS[cmd];
      const assigned = slots[cmd]
        ? cmd === current
          ? `Alt+${label} (this)`
          : `Alt+${label} (taken)`
        : `Assign Alt+${label}`;
      addMenuItem(menu, assigned, () => assignShortcut(node, cmd, row));
    }
    if (current) {
      addMenuItem(menu, "Clear shortcut", () => assignShortcut(node, null, row));
    }
  }

  document.body.appendChild(menu);

  const menuRect = menu.getBoundingClientRect();
  const left = Math.max(
    8,
    Math.min(event.clientX, window.innerWidth - menuRect.width - 8)
  );
  const top = Math.max(
    8,
    Math.min(event.clientY, window.innerHeight - menuRect.height - 8)
  );
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  openContextMenu = menu;
}

function buildParameterDef(def) {
  return {
    ...def,
    placeholder:
      def.placeholder !== undefined && def.placeholder !== ""
        ? def.placeholder
        : def.name,
  };
}

function getUiParameterDefs(node) {
  return getEditableValueDefs(node).map((def) => buildParameterDef(def));
}

function displayLabel(node) {
  return node.name;
}

function bindParamInput(input, def, linkKey, onEnter) {
  input.classList.add("param-input");
  input.dataset.param = def.name;
  input.placeholder = def.placeholder;
  input.title = def.label;
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      onEnter();
    }
  });
  input.addEventListener("change", async () => {
    await saveParamValue(linkKey, def.name, input.value.trim());
  });
}

function positionComboboxList(root, list) {
  const rect = root.getBoundingClientRect();
  const width = Math.max(176, rect.width + 72);
  const left = Math.max(8, rect.right - width);

  list.style.width = `${width}px`;
  list.style.left = `${left}px`;
  list.style.top = `${rect.bottom + 2}px`;
  list.style.right = "auto";
}

function createChoiceCombobox(def, savedValues, linkKey, onEnter) {
  const root = document.createElement("div");
  root.className = "param-combobox";

  const field = document.createElement("div");
  field.className = "param-combobox-field";

  const input = document.createElement("input");
  input.type = "text";
  const saved = savedValues[def.name];
  input.value = saved !== undefined ? saved : def.default;
  bindParamInput(input, def, linkKey, onEnter);
  input.classList.add("param-combobox-input");

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "param-combobox-toggle";
  toggle.setAttribute("aria-label", `Choose ${def.label}`);
  toggle.textContent = "▾";

  const list = document.createElement("ul");
  list.className = "param-combobox-list";
  list.hidden = true;
  list.setAttribute("role", "listbox");

  function renderList() {
    const query = input.value.trim().toLowerCase();
    list.replaceChildren();
    const matches = def.choices.filter(
      (choice) => !query || choice.toLowerCase().includes(query)
    );
    if (matches.length === 0) {
      list.hidden = true;
      if (openCombobox?.root === root) {
        openCombobox = null;
      }
      return;
    }

    for (const choice of matches) {
      const item = document.createElement("li");
      item.className = "param-combobox-option";
      item.textContent = choice;
      item.setAttribute("role", "option");
      item.addEventListener("mousedown", (event) => event.preventDefault());
      item.addEventListener("click", (event) => {
        event.stopPropagation();
        input.value = choice;
        closeOpenCombobox();
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      list.appendChild(item);
    }
  }

  function openList() {
    renderList();
    if (list.children.length === 0) {
      return;
    }
    closeOpenCombobox();
    positionComboboxList(root, list);
    list.hidden = false;
    const onScroll = () => closeOpenCombobox();
    window.addEventListener("scroll", onScroll, true);
    openCombobox = { root, list, onScroll };
  }

  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    if (list.hidden) {
      input.focus();
      openList();
    } else {
      closeOpenCombobox();
    }
  });

  input.addEventListener("focus", openList);
  input.addEventListener("input", () => {
    if (!list.hidden || document.activeElement === input) {
      openList();
    }
  });
  input.addEventListener("blur", () => {
    window.setTimeout(closeOpenCombobox, 120);
  });

  field.appendChild(input);
  field.appendChild(toggle);
  root.appendChild(field);
  root.appendChild(list);
  return root;
}

function createParamInputs(parameterDefs, savedValues, linkKey, onEnter) {
  if (parameterDefs.length === 0) {
    return null;
  }

  const wrap = document.createElement("div");
  wrap.className = "param-inputs";

  for (const def of parameterDefs) {
    if (def.choices?.length) {
      wrap.appendChild(createChoiceCombobox(def, savedValues, linkKey, onEnter));
      continue;
    }

    const input = document.createElement("input");
    input.type = "text";
    const saved = savedValues[def.name];
    input.value = saved !== undefined ? saved : def.default;
    bindParamInput(input, def, linkKey, onEnter);
    wrap.appendChild(input);
  }

  return wrap;
}

function nodeHasParams(node) {
  return getUiParameterDefs(node).length > 0;
}

function treeHasParams(nodes) {
  for (const node of nodes) {
    if (node.children) {
      if (treeHasParams(node.children)) {
        return true;
      }
      continue;
    }
    if (nodeHasParams(node)) {
      return true;
    }
  }
  return false;
}

function treeHasOnLoad(nodes) {
  for (const node of nodes) {
    if (node.children) {
      if (treeHasOnLoad(node.children)) {
        return true;
      }
      continue;
    }
    if (nodeHasOnLoad(node)) {
      return true;
    }
  }
  return false;
}

function createLinkListHeader({
  showRemove = false,
  showParams = false,
  showOnLoad = false,
} = {}) {
  const header = document.createElement("div");
  header.className = "link-list-header";
  header.setAttribute("role", "row");

  const actionHeader = document.createElement("span");
  actionHeader.className = "col-action";
  actionHeader.textContent = "Action";
  header.appendChild(actionHeader);

  if (showParams) {
    const paramsHeader = document.createElement("span");
    paramsHeader.className = "col-params";
    paramsHeader.textContent = "Params";
    header.appendChild(paramsHeader);
  }

  if (showOnLoad) {
    const onLoadHeader = document.createElement("span");
    onLoadHeader.className = "col-on-load";
    onLoadHeader.textContent = "On load";
    header.appendChild(onLoadHeader);
  }

  if (showRemove) {
    const removeHeader = document.createElement("span");
    removeHeader.className = "col-remove";
    removeHeader.textContent = "Remove";
    header.appendChild(removeHeader);
  }

  return header;
}

export function createLinkUi({
  activateLink,
  copyLink,
  exportLinkJson,
  editCustomLink,
  setInjectOnLoad,
  assignShortcut,
  getShortcutSlots,
  onReorderSiblings,
  onReparent,
}) {
  function createLinkRow(node, options = {}) {
    const parameterDefs = getUiParameterDefs(node);
    const linkKey = linkStorageKey(node);
    const savedValues = options.savedParamValues?.[linkKey] || {};
    const stableKey =
      options.stableKey ||
      nodeCatalogKey(node, node.sectionName, options.pathParts || []) ||
      linkKey;

    const row = document.createElement("div");
    row.className = "link-row";
    if (options.showRemove) {
      row.classList.add("has-remove");
    }
    if (options.searchMatch) {
      row.classList.add("search-match");
    }
    if (options.searchExactMatch) {
      row.classList.add("search-exact-match");
    }
    row.dataset.linkKey = linkKey;
    row.dataset.stableKey = stableKey;
    row.dataset.match = node.match ?? "";
    row.dataset.exclude = node.exclude ?? "";
    if (options.enableDrag && (onReorderSiblings || onReparent)) {
      row.draggable = true;
      row.addEventListener("dragstart", (event) => {
        event.dataTransfer.setData("text/stable-key", stableKey);
        event.dataTransfer.effectAllowed = "move";
        row.classList.add("is-dragging");
      });
      row.addEventListener("dragend", () => row.classList.remove("is-dragging"));
      row.addEventListener("dragover", (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      });
      row.addEventListener("drop", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const fromKey = event.dataTransfer.getData("text/stable-key");
        if (!fromKey || fromKey === stableKey) {
          return;
        }
        const parent = row.parentElement;
        if (!parent) {
          return;
        }
        const siblings = [
          ...parent.querySelectorAll(":scope > .link-row, :scope > .folder"),
        ]
          .map((el) => el.dataset.stableKey)
          .filter(Boolean);
        const fromIndex = siblings.indexOf(fromKey);
        const toIndex = siblings.indexOf(stableKey);
        if (toIndex < 0) {
          return;
        }
        if (fromIndex >= 0) {
          siblings.splice(fromIndex, 1);
          siblings.splice(toIndex, 0, fromKey);
          await onReorderSiblings?.(siblings);
          return;
        }
        if (!onReparent) {
          return;
        }
        siblings.splice(toIndex, 0, fromKey);
        await onReparent(
          fromKey,
          placementForParentEl(parent, node.sectionName || options.sectionName),
          siblings
        );
      });
    }

    const actionCell = document.createElement("div");
    actionCell.className = "link-row-action";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "link-item";
    if (options.isCustom) {
      button.classList.add("is-custom");
    }
    button.dataset.behavior = matchBehavior(node)?.id || "";

    const applyDot = document.createElement("span");
    applyDot.className = "link-applies-dot";
    applyDot.title = APPLIES_TO_TAB_TITLE;
    applyDot.setAttribute("aria-label", APPLIES_TO_TAB_TITLE);
    applyDot.hidden = !linkAppliesToTab(
      node.match,
      options.activeTabUrl,
      node.exclude
    );
    const skipReason = applySkipReason(
      node.match,
      options.activeTabUrl,
      node.exclude
    );
    if (applyDot.hidden && skipReason) {
      applyDot.title = skipReason;
      applyDot.setAttribute("aria-label", skipReason);
    }

    const badge = document.createElement("span");
    badge.className = linkBadgeClass(node);
    badge.textContent = linkBadgeLabel(node);
    const badgeTitle = linkBadgeTitle(node);
    if (badgeTitle) {
      badge.title = badgeTitle;
      badge.setAttribute("aria-label", badgeTitle);
    }

    const labelWrap = document.createElement("span");
    labelWrap.className = "link-label";
    labelWrap.appendChild(document.createTextNode(displayLabel(node)));
    if (node.tooltip) {
      labelWrap.title = node.tooltip;
    }

    const slotCmd = slotForKey(getShortcutSlots?.() || {}, stableKey);
    if (slotCmd) {
      const slotBadge = document.createElement("span");
      slotBadge.className = "link-shortcut-badge";
      slotBadge.textContent = `Alt+${SLOT_LABELS[slotCmd]}`;
      slotBadge.title = "Keyboard shortcut";
      labelWrap.prepend(slotBadge);
    }

    const hint = document.createElement("span");
    hint.className = "link-hint";
    const updateHint = () => {
      hint.textContent = displayHint(
        node,
        resolveParamValues(parameterDefs, readParamValuesFromRow(row, parameterDefs))
      );
    };
    updateHint();
    labelWrap.appendChild(hint);

    button.appendChild(applyDot);
    button.appendChild(badge);
    button.appendChild(labelWrap);
    button.addEventListener("click", () => activateLink(node, row));
    row.addEventListener("contextmenu", (event) => {
      showLinkContextMenu(event, node, row, {
        copyLink,
        exportLinkJson,
        editCustomLink: options.isCustom ? editCustomLink : null,
        assignShortcut,
        getShortcutSlots,
      });
    });
    actionCell.appendChild(button);

    const paramsCell = document.createElement("div");
    paramsCell.className = "link-row-params";

    const paramInputs = createParamInputs(
      parameterDefs,
      savedValues,
      linkKey,
      () => activateLink(node, row)
    );
    if (paramInputs) {
      for (const input of paramInputs.querySelectorAll(".param-input")) {
        input.addEventListener("input", updateHint);
      }
      paramsCell.appendChild(paramInputs);
      row.classList.add("has-params");
    }

    row.appendChild(actionCell);
    if (paramInputs) {
      row.appendChild(paramsCell);
    }

    const onLoadCell = document.createElement("div");
    onLoadCell.className = "link-row-on-load";
    const hasOnLoad = nodeHasOnLoad(node);

    if (hasOnLoad) {
      row.classList.add("has-on-load");
      const injectLabel = document.createElement("label");
      injectLabel.className = "inject-load";
      const timing = resolveRunAt(node);
      const when =
        timing === "document_end"
          ? "after DOM ready"
          : timing === "document_idle"
            ? "after load"
            : "at document start";
      const hostHint = node.match
        ? `Inject ${when} when tab URL matches /${node.match}/${node.exclude ? ` and not /${node.exclude}/` : ""}`
        : `Inject ${when} on every page${node.exclude ? ` except /${node.exclude}/` : ""}`;
      injectLabel.title = hostHint;

      const injectCheck = document.createElement("input");
      injectCheck.type = "checkbox";
      injectCheck.className = "inject-load-checkbox";
      injectCheck.checked = Boolean(options.injectOnLoad?.[linkKey]);
      injectCheck.addEventListener("click", (event) => event.stopPropagation());
      injectCheck.addEventListener("change", async () => {
        await setInjectOnLoad(linkKey, injectCheck.checked);
      });

      injectLabel.appendChild(injectCheck);
      onLoadCell.appendChild(injectLabel);
      row.appendChild(onLoadCell);
    }

    if (options.showRemove) {
      const removeCell = document.createElement("div");
      removeCell.className = "link-row-remove";

      if (options.onDelete) {
        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "delete-btn";
        deleteBtn.title = "Remove action";
        deleteBtn.textContent = "×";
        deleteBtn.addEventListener("click", options.onDelete);
        removeCell.appendChild(deleteBtn);
      }

      row.appendChild(removeCell);
    }

    return row;
  }

  function renderNodes(
    nodes,
    container,
    savedParamValues,
    inheritedMatch = null,
    sectionName = null,
    injectOnLoad = {},
    options = {}
  ) {
    const pathParts = options.pathParts || [];
    const inheritedExclude = options.inheritedExclude ?? null;

    for (const node of nodes) {
      const matchPattern = resolveMatch(node, inheritedMatch);
      const excludePattern = resolveExclude(node, inheritedExclude);
      if (node.children) {
        const folder = document.createElement("section");
        folder.className = "folder";
        const folderKey = nodeCatalogKey(node, sectionName, pathParts);
        if (folderKey) {
          folder.dataset.stableKey = folderKey;
        }
        if (options.enableDrag && (onReorderSiblings || onReparent)) {
          folder.draggable = true;
          folder.addEventListener("dragstart", (event) => {
            if (event.target !== folder && event.target !== folder.firstChild) {
              return;
            }
            event.dataTransfer.setData("text/stable-key", folderKey);
            event.dataTransfer.effectAllowed = "move";
            folder.classList.add("is-dragging");
          });
          folder.addEventListener("dragend", () =>
            folder.classList.remove("is-dragging")
          );
          folder.addEventListener("dragover", (event) => {
            event.preventDefault();
          });
          folder.addEventListener("drop", async (event) => {
            if (event.target.closest(".link-row")) {
              return;
            }
            if (event.target.closest(".folder-title")) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            const fromKey = event.dataTransfer.getData("text/stable-key");
            if (!fromKey || fromKey === folderKey) {
              return;
            }
            const siblings = childStableKeys(container);
            const fromIndex = siblings.indexOf(fromKey);
            const toIndex = siblings.indexOf(folderKey);
            if (toIndex < 0) {
              return;
            }
            if (fromIndex >= 0) {
              siblings.splice(fromIndex, 1);
              siblings.splice(toIndex, 0, fromKey);
              await onReorderSiblings?.(siblings);
              return;
            }
            if (!onReparent) {
              return;
            }
            siblings.splice(toIndex, 0, fromKey);
            await onReparent(
              fromKey,
              placementForParentEl(container, sectionName),
              siblings
            );
          });
        }

        const title = document.createElement("div");
        title.className = "folder-title";
        title.textContent = node.name;
        if (options.enableDrag && onReparent) {
          title.addEventListener("dragover", (event) => {
            event.preventDefault();
            event.stopPropagation();
            title.classList.add("is-drop-target");
          });
          title.addEventListener("dragleave", () =>
            title.classList.remove("is-drop-target")
          );
          title.addEventListener("drop", async (event) => {
            event.preventDefault();
            event.stopPropagation();
            title.classList.remove("is-drop-target");
            const fromKey = event.dataTransfer.getData("text/stable-key");
            if (!fromKey || fromKey === folderKey) {
              return;
            }
            const destKeys = childStableKeys(folder).filter(
              (key) => key !== fromKey
            );
            destKeys.push(fromKey);
            await onReparent(
              fromKey,
              { section: sectionName, parentKey: folderKey },
              destKeys
            );
          });
        }
        folder.appendChild(title);

        renderNodes(
          node.children,
          folder,
          savedParamValues,
          matchPattern,
          sectionName,
          injectOnLoad,
          {
            ...options,
            pathParts: [...pathParts, node.name],
            sectionName,
            inheritedExclude: excludePattern,
          }
        );
        container.appendChild(folder);
        continue;
      }

      container.appendChild(
        createLinkRow(
          { ...node, match: matchPattern, exclude: excludePattern, sectionName },
          {
            savedParamValues,
            injectOnLoad,
            activeTabUrl: options.activeTabUrl,
            showRemove: options.showRemoveColumn,
            isCustom: isOverlayCustomLink(node, options.overlayLinkIds),
            enableDrag: options.enableDrag,
            pathParts,
            stableKey: nodeCatalogKey(node, sectionName, pathParts),
            onDelete:
              isOverlayCustomLink(node, options.overlayLinkIds) &&
              options.onDeleteCustom
                ? async (event) => {
                    event.stopPropagation();
                    await options.onDeleteCustom(node.id, node);
                  }
                : null,
          }
        )
      );
    }
  }

  return {
    displayLabel,
    createLinkListHeader,
    createLinkRow,
    renderNodes,
    nodeHasParams,
    treeHasParams,
    treeHasOnLoad,
  };
}

export async function loadInjectOnLoad() {
  const stored = await browser.storage.local.get(INJECT_ON_LOAD_KEY);
  return stored[INJECT_ON_LOAD_KEY] || {};
}

export async function setInjectOnLoad(linkKey, enabled) {
  const injectOnLoad = await loadInjectOnLoad();
  if (enabled) {
    injectOnLoad[linkKey] = true;
  } else {
    delete injectOnLoad[linkKey];
  }
  await browser.storage.local.set({ [INJECT_ON_LOAD_KEY]: injectOnLoad });
  await browser.runtime.sendMessage({ type: "REFRESH_INJECT" }).catch(() => {});
}
