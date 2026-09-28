import {
  wireBuilderFieldUi,
  updateHostPatternFieldVisibility,
  updateParameterModeVisibility,
  readHostPattern,
  populateHostPattern,
  readExcludePattern,
  populateExcludePattern,
  readRunAt,
  populateRunAt,
  readSandbox,
  populateSandbox,
  readFramesFields,
  populateFramesFields,
  clearFramesFields,
  updateFramesFieldVisibility,
  readParameterFields,
  populateParameterFields,
  clearParameterFields,
  populateNavParamsFields,
  readNavParamsFields,
  clearNavParamsFields,
  getBuilderFieldElements,
  setFieldVisible,
} from "./link-builder-fields.js";
import {
  getFieldValue,
  setFieldValue,
  setFieldPlaceholder,
} from "../lib/codemirror-fields.bundle.js";
import { ensureLinkId } from "../lib/link-catalog.js";
import { normalizeLeafNode, normalizeScriptInput } from "../lib/link-model.js";
import { getBrowsingTabPrefill } from "./link-quick-add.js";

//run scriptlets have no `open`, so the only allowed value is empty
const NAV_OPTIONS = {
  scriptlet: [{ value: "", label: "Not applicable (runs in place)" }],
  "scriptlet-url": [
    { value: "same-tab", label: "Same tab" },
    { value: "tab", label: "New tab (foreground)" },
    { value: "background", label: "New tab (background)" },
    { value: "download", label: "Download" },
  ],
  navigate: [
    { value: "same-tab", label: "Same tab" },
    { value: "tab", label: "New tab (foreground)" },
    { value: "background", label: "New tab (background)" },
    { value: "download", label: "Download" },
  ],
  "derived-url": [
    { value: "same-tab", label: "Same tab" },
    { value: "tab", label: "New tab (foreground)" },
    { value: "background", label: "New tab (background)" },
    { value: "download", label: "Download" },
  ],
};

const TYPE_HINTS = {
  scriptlet:
    "Runs the script on the target page. Nothing is opened; use console output or page side effects. Eligible for inject on load.",
  "scriptlet-url":
    "Runs the script, then opens the URL it returns. The script must return (or evaluate to) a URL string. Not eligible for inject on load.",
  navigate: "Opens a fixed path or absolute URL.",
  "derived-url":
    "Opens a URL template, filling {tokens} from navParams derived from the page or typed in the popup.",
};

const CODE_LABELS = {
  scriptlet: "Script",
  "scriptlet-url": "Navigation script",
};

const CODE_PLACEHOLDERS = {
  scriptlet: "JS to run on the page",
  "scriptlet-url": "Must return a URL",
};

function paramsFromFormFields(parameterFields) {
  if (parameterFields.params) {
    return parameterFields.params;
  }
  return undefined;
}

function inferBuilderType(node) {
  if (node.code) {
    return node.open ? "scriptlet-url" : "scriptlet";
  }
  if (node.navParams || (node.url && /\{[^}]+\}/.test(node.url))) {
    return "derived-url";
  }
  return "navigate";
}

function openForBuilderSelect(node) {
  return node.open || "";
}

export function getBuilderFormElements(root = document) {
  return {
    editIdInput: root.getElementById("link-edit-id"),
    sectionSelect: root.getElementById("link-section"),
    sectionNewInput: root.getElementById("link-section-new"),
    sectionNewField: root.getElementById("link-section-new-field"),
    typeSelect: root.getElementById("link-type"),
    typeHint: root.getElementById("link-type-hint"),
    codeLabel: root.getElementById("link-code-label"),
    nameInput: root.getElementById("link-name"),
    tooltipInput: root.getElementById("link-tooltip"),
    codeInput: root.getElementById("link-code"),
    pathInput: root.getElementById("link-path"),
    urlInput: root.getElementById("link-url"),
    navSelect: root.getElementById("link-nav"),
    searchTagsInput: root.getElementById("link-search-tags"),
    codeField: root.getElementById("link-code-field"),
    pathField: root.getElementById("link-path-field"),
    urlField: root.getElementById("link-url-field"),
    navField: root.getElementById("link-nav-field"),
    hostPatternField: root.getElementById("host-pattern-field"),
    searchTagsField: root.getElementById("search-tags-field"),
    fieldElements: getBuilderFieldElements(root),
  };
}

function parseSearchTags(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return undefined;
  }
  const tags = trimmed
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  return tags.length ? tags : undefined;
}

function setNavOptions(navSelect, type, selectedValue) {
  const options = NAV_OPTIONS[type] || NAV_OPTIONS.navigate;
  const current = selectedValue ?? navSelect.value;
  navSelect.replaceChildren();
  for (const option of options) {
    const el = document.createElement("option");
    el.value = option.value;
    el.textContent = option.label;
    navSelect.appendChild(el);
  }
  const allowed = options.some((option) => option.value === current);
  navSelect.value = allowed ? current : options[0]?.value || "";
}

export function buildLinkNodeFromForm(form) {
  const type = form.type;
  const name = form.name.trim();
  if (!name) {
    throw new Error("Name is required.");
  }

  const draft = { name };
  if (form.editId) {
    draft.id = form.editId;
  }
  if (form.tooltip.trim()) {
    draft.tooltip = form.tooltip.trim();
  }

  if (form.match !== undefined) {
    draft.match = form.match;
  }
  if (form.exclude !== undefined) {
    draft.exclude = form.exclude;
  }

  const searchTags = parseSearchTags(form.searchTags);
  if (searchTags) {
    draft.searchTags = searchTags;
  }

  const params = paramsFromFormFields(form);

  if (type === "scriptlet" || type === "scriptlet-url") {
    if (params) {
      draft.params = params;
    }
    const code = normalizeScriptInput(form.code);
    if (!code) {
      throw new Error("Script code is required.");
    }
    draft.code = code;
    if (type === "scriptlet-url") {
      const open = form.nav.trim();
      if (!open) {
        throw new Error("Open mode is required for navigation scriptlets.");
      }
      draft.open = open;
    }
    if (form.frames !== undefined) {
      draft.frames = form.frames;
    }
    if (type === "scriptlet" && form.runAt) {
      draft.runAt = form.runAt;
    }
    if (form.sandbox) {
      draft.sandbox = form.sandbox;
    }
  } else if (type === "navigate") {
    const url = form.url.trim() || form.path.trim();
    if (!url) {
      throw new Error("URL is required.");
    }
    draft.url = url;
    draft.open = form.nav.trim() || "same-tab";
    if (form.navParams) {
      draft.navParams = form.navParams;
    }
  } else if (type === "derived-url") {
    const open = form.nav.trim();
    if (!open) {
      throw new Error("Open mode is required for derived URLs.");
    }
    draft.open = open;
    const url = form.url.trim() || form.path.trim();
    if (!url) {
      throw new Error("URL template is required.");
    }
    draft.url = url;
    if (form.navParams) {
      draft.navParams = form.navParams;
    }
  } else {
    throw new Error(`Unknown link type: ${type}`);
  }

  return ensureLinkId(normalizeLeafNode(draft));
}

export function readTargetSection(elements) {
  const selected = elements.sectionSelect?.value || "";
  if (selected === "__new__") {
    const name = elements.sectionNewInput?.value.trim() || "";
    if (!name) {
      throw new Error("New section name is required.");
    }
    return name;
  }
  if (!selected) {
    throw new Error("Section is required.");
  }
  return selected;
}

export function populateSectionSelect(elements, sectionNames, selectedSection) {
  if (!elements.sectionSelect) {
    return;
  }

  elements.sectionSelect.replaceChildren();
  for (const name of sectionNames) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    elements.sectionSelect.appendChild(option);
  }

  const newOption = document.createElement("option");
  newOption.value = "__new__";
  newOption.textContent = "Create new section…";
  elements.sectionSelect.appendChild(newOption);

  const hasSelected =
    selectedSection && sectionNames.includes(selectedSection);
  if (hasSelected) {
    elements.sectionSelect.value = selectedSection;
    elements.sectionNewInput.value = "";
    setFieldVisible(elements.sectionNewField, false);
    return;
  }

  if (selectedSection) {
    elements.sectionSelect.value = "__new__";
    elements.sectionNewInput.value = selectedSection;
    setFieldVisible(elements.sectionNewField, true);
    return;
  }

  elements.sectionSelect.value = sectionNames[0] || "__new__";
  elements.sectionNewInput.value = "";
  setFieldVisible(elements.sectionNewField, elements.sectionSelect.value === "__new__");
}

export function readBuilderForm(elements) {
  const parameterFields = readParameterFields(elements.fieldElements);
  const navParams = readNavParamsFields(elements.fieldElements);
  const match = readHostPattern(elements.fieldElements);
  const exclude = readExcludePattern(elements.fieldElements);
  const runAt = readRunAt(elements.fieldElements);
  const sandbox = readSandbox(elements.fieldElements);
  const frames = readFramesFields(elements.fieldElements);

  return {
    editId: elements.editIdInput.value.trim() || null,
    sectionName: readTargetSection(elements),
    type: elements.typeSelect.value,
    name: elements.nameInput.value,
    tooltip: elements.tooltipInput?.value || "",
    match,
    exclude,
    runAt,
    sandbox,
    frames,
    searchTags: elements.searchTagsInput.value,
    code: getFieldValue(elements.codeInput),
    path: elements.pathInput.value,
    url: elements.urlInput.value,
    nav: elements.navSelect.value,
    navParams,
    ...parameterFields,
  };
}

export function populateBuilderForm(elements, node, sectionName, sectionNames) {
  const normalized = normalizeLeafNode(node);
  elements.editIdInput.value = normalized.id || "";
  populateSectionSelect(elements, sectionNames, sectionName);
  elements.typeSelect.value = inferBuilderType(normalized);
  elements.nameInput.value = normalized.name || "";
  if (elements.tooltipInput) {
    elements.tooltipInput.value = normalized.tooltip || "";
  }
  populateHostPattern(elements.fieldElements, normalized.match);
  populateExcludePattern(elements.fieldElements, normalized.exclude);
  populateRunAt(elements.fieldElements, normalized.runAt);
  populateSandbox(elements.fieldElements, normalized.sandbox);
  populateFramesFields(elements.fieldElements, normalized.frames);
  elements.searchTagsInput.value = Array.isArray(normalized.searchTags)
    ? normalized.searchTags.join(", ")
    : "";
  setFieldValue(elements.codeInput, normalized.code || "");
  elements.pathInput.value = "";
  elements.urlInput.value = normalized.url || "";
  populateParameterFields(elements.fieldElements, normalized);
  populateNavParamsFields(elements.fieldElements, normalized.navParams);
  setNavOptions(
    elements.navSelect,
    elements.typeSelect.value,
    openForBuilderSelect(normalized)
  );
  updateBuilderFieldVisibility(elements);
}

export function clearBuilderForm(elements, sectionNames, defaultSection) {
  elements.editIdInput.value = "";
  populateSectionSelect(elements, sectionNames, defaultSection);
  elements.typeSelect.value = "scriptlet";
  elements.nameInput.value = "";
  if (elements.tooltipInput) {
    elements.tooltipInput.value = "";
  }
  populateHostPattern(elements.fieldElements, undefined);
  populateExcludePattern(elements.fieldElements, undefined);
  populateRunAt(elements.fieldElements, undefined);
  populateSandbox(elements.fieldElements, undefined);
  clearFramesFields(elements.fieldElements);
  elements.searchTagsInput.value = "";
  setFieldValue(elements.codeInput, "");
  elements.pathInput.value = "";
  elements.urlInput.value = "";
  clearParameterFields(elements.fieldElements);
  clearNavParamsFields(elements.fieldElements);
  setNavOptions(elements.navSelect, "scriptlet", "");
  updateBuilderFieldVisibility(elements);
}

export function applyTabPrefill(elements, prefill, type = "navigate") {
  if (!prefill) {
    return;
  }
  const resolvedType = prefill.builderType || type;
  elements.typeSelect.value = resolvedType;
  elements.nameInput.value = prefill.name || "";
  elements.urlInput.value =
    prefill.url ||
    prefill.path ||
    (resolvedType === "derived-url" ? "{origin}/{value}" : prefill.absoluteUrl) ||
    "";
  elements.pathInput.value = "";

  if (prefill.match) {
    populateHostPattern(elements.fieldElements, prefill.match);
  }

  if (resolvedType === "navigate" || resolvedType === "derived-url") {
    clearParameterFields(elements.fieldElements);
    if (prefill.fromSelector) {
      populateNavParamsFields(elements.fieldElements, {
        value: {
          fromSelector: prefill.fromSelector,
          placeholder: "value",
          optional: true,
        },
      });
      if (!elements.urlInput.value.trim()) {
        elements.urlInput.value = "{origin}/{value}";
      }
    } else if (prefill.navParams) {
      populateNavParamsFields(elements.fieldElements, prefill.navParams);
    } else {
      clearNavParamsFields(elements.fieldElements);
    }
  }

  const defaultOpen =
    resolvedType === "derived-url"
      ? "tab"
      : /^https?:\/\//i.test(prefill.absoluteUrl || prefill.url || prefill.path || "")
        ? "tab"
        : "same-tab";
  setNavOptions(elements.navSelect, resolvedType, defaultOpen);
  updateBuilderFieldVisibility(elements);
}

function applyPrefillIfEmpty(elements, prefill, type) {
  if (!prefill || (type !== "navigate" && type !== "derived-url")) {
    return;
  }

  if (!elements.nameInput.value.trim()) {
    elements.nameInput.value = prefill.name || "";
  }
  if (!elements.urlInput.value.trim()) {
    elements.urlInput.value = prefill.url || prefill.path || "";
  }

  //template tokens are useless without the matching navParam rows
  const hasNavParamRows =
    elements.fieldElements.navParamsList.querySelector(".nav-param-row") !== null;
  if (prefill.navParams && !hasNavParamRows) {
    populateNavParamsFields(elements.fieldElements, prefill.navParams);
  }

  if (
    prefill.match &&
    elements.fieldElements.hostPatternModeSelect.value === "inherit"
  ) {
    populateHostPattern(elements.fieldElements, prefill.match);
  }
}

export function updateBuilderFieldVisibility(elements) {
  const type = elements.typeSelect.value;
  const isRunScriptlet = type === "scriptlet";
  const isNavScriptlet = type === "scriptlet-url";
  const isScriptlet = isRunScriptlet || isNavScriptlet;
  const isNavigate = type === "navigate";
  const isDerived = type === "derived-url";
  const isUrlType = isNavigate || isDerived;

  setFieldVisible(elements.codeField, isScriptlet);
  setFieldVisible(elements.pathField, false);
  setFieldVisible(elements.urlField, isUrlType);
  setFieldVisible(elements.navField, isNavScriptlet || isUrlType);
  setFieldVisible(elements.fieldElements.parametersSection, isScriptlet);
  setFieldVisible(elements.fieldElements.framesSection, isScriptlet);
  setFieldVisible(elements.fieldElements.runAtField, isRunScriptlet);
  setFieldVisible(elements.fieldElements.sandboxField, isScriptlet);
  setFieldVisible(elements.fieldElements.navParamsSection, isUrlType);

  if (elements.typeHint) {
    elements.typeHint.textContent = TYPE_HINTS[type] || "";
  }
  if (isScriptlet) {
    if (elements.codeLabel) {
      elements.codeLabel.textContent = CODE_LABELS[type];
    }
    setFieldPlaceholder(elements.codeInput, CODE_PLACEHOLDERS[type]);
  }

  //re-running this on every type change is what drops a stale `open` from a run scriptlet
  const fallbackOpen = isNavScriptlet || isNavigate ? "same-tab" : "";
  setNavOptions(elements.navSelect, type, elements.navSelect.value || fallbackOpen);
  elements.navSelect.required = isNavScriptlet || isDerived;

  updateHostPatternFieldVisibility(elements.fieldElements);
  updateFramesFieldVisibility(elements.fieldElements);
  updateParameterModeVisibility(elements.fieldElements);
}

export function initBuilderForm(elements, { sectionNames = [], defaultSection } = {}) {
  wireBuilderFieldUi(elements.fieldElements);
  populateSectionSelect(elements, sectionNames, defaultSection);

  elements.sectionSelect?.addEventListener("change", () => {
    setFieldVisible(
      elements.sectionNewField,
      elements.sectionSelect.value === "__new__"
    );
  });

  elements.typeSelect.addEventListener("change", async () => {
    const type = elements.typeSelect.value;
    if (type === "navigate" || type === "derived-url") {
      applyPrefillIfEmpty(elements, await getBrowsingTabPrefill(), type);
    }
    updateBuilderFieldVisibility(elements);
  });

  updateBuilderFieldVisibility(elements);
}
