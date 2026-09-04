import {
  attachCodeMirrorAll,
  getFieldValue,
  setFieldLanguage,
  setFieldPlaceholder,
  setFieldValue,
} from "../../lib/codemirror-fields.bundle.js";
import { MessageTypes } from "../../lib/message-types.js";
import { createNetworkArmControl } from "../../lib/network-arm-control.js";
import { createUiMessage } from "../../lib/ui-message.js";
import {
  createEmptyRule,
  defaultNetworkRulesState,
  HTTP_METHODS,
  normalizeNetworkRulesState,
  WEBREQUEST_RESOURCE_TYPES,
} from "../engine/network-rules-shared.js";
import {
  instantiateNetworkRuleTemplate,
  loadNetworkRuleTemplates,
} from "../engine/network-rule-templates.js";
import { NetworkMessageTypes } from "../message-types.js";
import {
  NETWORK_HOOKS_ENABLED_KEY,
  NETWORK_RULES_KEY,
  NETWORK_RULES_LOG_KEY,
} from "../storage-keys.js";

const NT = NetworkMessageTypes;
const HT = MessageTypes;

const rulesListEl = document.getElementById("rules-list");
const rulesLogEl = document.getElementById("rules-log");
const ruleCountEl = document.getElementById("rule-count");
const messageEl = document.getElementById("message");
const networkArmEl = document.getElementById("network-arm");
const ruleFormEl = document.getElementById("rule-form");
const editorTitleEl = document.getElementById("editor-title");
const editorPanelEl = document.getElementById("editor-panel");
const logPanelEl = document.getElementById("log-panel");
const logToolbarEl = document.getElementById("log-toolbar");
const logSearchEl = document.getElementById("log-search");
const editorTabEl = document.getElementById("editor-tab");
const logTabEl = document.getElementById("log-tab");
const recentMatchCountEl = document.getElementById("recent-match-count");

const ruleNameEl = document.getElementById("rule-name");
const rulePriorityEl = document.getElementById("rule-priority");
const ruleEnabledEl = document.getElementById("rule-enabled");
const ruleMethodsEl = document.getElementById("rule-methods");
const ruleResourceTypesEl = document.getElementById("rule-resource-types");
const phaseRequestEl = document.getElementById("phase-request");
const phaseResponseEl = document.getElementById("phase-response");
const ruleStatusMinEl = document.getElementById("rule-status-min");
const ruleStatusMaxEl = document.getElementById("rule-status-max");
const ruleActionEl = document.getElementById("rule-action");
const ruleRedirectUrlEl = document.getElementById("rule-redirect-url");
const ruleServeWithoutRequestEl = document.getElementById("rule-serve-without-request");
const ruleMockStatusEl = document.getElementById("rule-mock-status");
const ruleMockStatusTextEl = document.getElementById("rule-mock-status-text");
const ruleMockBodyEl = document.getElementById("rule-mock-body");
const urlReplacementsEl = document.getElementById("url-replacements");
const bodyReplacementsEl = document.getElementById("body-replacements");
const headerReplacementsEl = document.getElementById("header-replacements");
const setHeadersEl = document.getElementById("set-headers");
const ruleRequestScriptEl = document.getElementById("rule-request-script");
const ruleResponseScriptEl = document.getElementById("rule-response-script");
const ruleMatchHookOriginatedEl = document.getElementById("rule-match-hook-originated");
const ruleTestUrlEl = document.getElementById("rule-test-url");
const testRuleBtn = document.getElementById("test-rule-btn");
const networkStatusDotEl = document.getElementById("network-status-dot");
const networkStatusTooltipEl = document.getElementById("network-status-tooltip");
const deleteRuleBtn = document.getElementById("delete-rule-btn");
const ruleTemplateSelectEl = document.getElementById("rule-template-select");
const exportRulesBtn = document.getElementById("export-rules-btn");
const importRulesBtn = document.getElementById("import-rules-btn");
const importRulesFileEl = document.getElementById("import-rules-file");

const PATTERN_FIELDS = [
  {
    key: "pageUrlPattern",
    flagKey: "pageUrlPatternIsRegex",
    element: document.getElementById("rule-page-url-pattern"),
    regexEl: document.getElementById("rule-page-url-pattern-regex"),
    placeholders: { wildcard: "*/app/*", regex: "/app/.*" },
  },
  {
    key: "requestUrlPattern",
    flagKey: "requestUrlPatternIsRegex",
    element: document.getElementById("rule-request-url-pattern"),
    regexEl: document.getElementById("rule-request-url-pattern-regex"),
    placeholders: {
      wildcard: "*/api/v1/items/*",
      regex: "/api/v1/items/.*",
    },
  },
  {
    key: "requestBodyPattern",
    flagKey: "requestBodyPatternIsRegex",
    element: document.getElementById("rule-body-pattern"),
    regexEl: document.getElementById("rule-body-pattern-regex"),
    placeholders: {
      wildcard: "*q=*status=open*",
      regex: "q=.*status=open",
    },
  },
  {
    key: "requestContentTypePattern",
    flagKey: "requestContentTypePatternIsRegex",
    element: document.getElementById("rule-content-type-pattern"),
    regexEl: document.getElementById("rule-content-type-pattern-regex"),
    placeholders: {
      wildcard: "application/json*",
      regex: "^application/json",
    },
  },
];

const patternEditors = {};
for (const field of PATTERN_FIELDS) {
  patternEditors[field.key] = {
    element: field.element,
    language: "plain",
    compact: true,
    placeholder: field.placeholders.wildcard,
  };
}

attachCodeMirrorAll({
  ...patternEditors,
  mockBody: {
    element: ruleMockBodyEl,
    language: "json",
    minHeight: 96,
    placeholder: '{"result":[]}',
  },
  requestScript: {
    element: ruleRequestScriptEl,
    language: "javascript",
    completions: "network-script",
    minHeight: 120,
    placeholder:
      "function(ctx, rule) { console.log(ctx.url, ctx.body); return ctx; }",
  },
  responseScript: {
    element: ruleResponseScriptEl,
    language: "javascript",
    completions: "network-script",
    minHeight: 120,
    placeholder: "function(ctx, rule) { return ctx; }",
  },
});

/**
 * Sync a filter field's checkbox, placeholder, and CodeMirror language.
 * @param {object} field Pattern field config.
 * @param {boolean} isRegex Whether the field is in regex mode.
 * @returns {void}
 */
function applyPatternFieldMode(field, isRegex) {
  field.regexEl.checked = Boolean(isRegex);
  const placeholder = isRegex
    ? field.placeholders.regex
    : field.placeholders.wildcard;
  setFieldPlaceholder(field.element, placeholder);
  setFieldLanguage(field.element, isRegex ? "regex" : "plain");
}

for (const field of PATTERN_FIELDS) {
  applyPatternFieldMode(field, false);
  field.regexEl.addEventListener("change", () => {
    applyPatternFieldMode(field, field.regexEl.checked);
  });
}

let rulesState = defaultNetworkRulesState();
let selectedRuleId = null;
let highlightedRuleId = null;
let ruleTemplates = [];
let lastPersistedRulesSnapshot = "";
let logEntries = [];
let logSearchQuery = "";

const { showMessage, hideMessage } = createUiMessage(messageEl);

/**
 * Select a workspace tab and synchronize its accessible state.
 * @param {"editor" | "log"} tabName Workspace view to display.
 * @returns {void}
 */
function selectWorkspaceTab(tabName) {
  const showLog = tabName === "log";
  editorTabEl.setAttribute("aria-selected", String(!showLog));
  editorTabEl.tabIndex = showLog ? -1 : 0;
  editorPanelEl.hidden = showLog;
  logTabEl.setAttribute("aria-selected", String(showLog));
  logTabEl.tabIndex = showLog ? 0 : -1;
  logPanelEl.hidden = !showLog;
  editorTitleEl.hidden = showLog;
  logToolbarEl.hidden = !showLog;
}

/**
 * Update the status indicator's contextual and accessible tooltip text.
 * @param {string} text Current network-hook status.
 * @returns {void}
 */
function setNetworkStatusText(text) {
  networkStatusDotEl.setAttribute("aria-label", text);
  networkStatusTooltipEl.textContent = text;
}

function summarizeRule(rule) {
  const filters = [];
  if (rule.pageUrlPattern) filters.push("page");
  if (rule.requestUrlPattern) filters.push("url");
  if (rule.requestBodyPattern) filters.push("body");
  if (rule.methods?.length) filters.push(rule.methods.join(","));
  if (rule.resourceTypes?.length) filters.push(rule.resourceTypes.join(","));
  return `${rule.action}${filters.length ? ` · ${filters.join(" · ")}` : ""}`;
}

function renderMethodChecks(selectedMethods) {
  ruleMethodsEl.replaceChildren();
  const selected = new Set((selectedMethods || []).map((method) => method.toUpperCase()));

  for (const method of HTTP_METHODS) {
    const label = document.createElement("label");
    label.className = "inline-check";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = method;
    input.checked = selected.has(method);

    const text = document.createElement("span");
    text.textContent = method;

    label.appendChild(input);
    label.appendChild(text);
    ruleMethodsEl.appendChild(label);
  }
}

function readSelectedMethods() {
  return [...ruleMethodsEl.querySelectorAll('input[type="checkbox"]:checked')].map(
    (input) => input.value
  );
}

function renderResourceTypeChecks(selectedTypes) {
  ruleResourceTypesEl.replaceChildren();
  const selected = new Set(selectedTypes || []);

  for (const type of WEBREQUEST_RESOURCE_TYPES) {
    const label = document.createElement("label");
    label.className = "inline-check";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = type;
    input.checked = selected.has(type);

    const text = document.createElement("span");
    text.textContent = type;

    label.appendChild(input);
    label.appendChild(text);
    ruleResourceTypesEl.appendChild(label);
  }
}

function readSelectedResourceTypes() {
  return [
    ...ruleResourceTypesEl.querySelectorAll('input[type="checkbox"]:checked'),
  ].map((input) => input.value);
}

function createReplacementRow(replacement, options = {}) {
  const row = document.createElement("div");
  row.className = "replacement-row";
  if (options.header) {
    row.classList.add("header-row");
  }

  if (options.header) {
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "Header";
    nameInput.value = replacement.name || "";
    nameInput.dataset.field = "name";
    row.appendChild(nameInput);
  }

  const findInput = document.createElement("input");
  findInput.type = "text";
  findInput.placeholder = "Find";
  findInput.value = replacement.find || "";
  findInput.dataset.field = "find";
  row.appendChild(findInput);

  const replaceInput = document.createElement("input");
  replaceInput.type = "text";
  replaceInput.placeholder = "Replace";
  replaceInput.value = replacement.replace || "";
  replaceInput.dataset.field = "replace";
  row.appendChild(replaceInput);

  const regexLabel = document.createElement("label");
  regexLabel.className = "inline-check";
  const regexInput = document.createElement("input");
  regexInput.type = "checkbox";
  regexInput.checked = Boolean(replacement.isRegex);
  regexInput.dataset.field = "isRegex";
  regexLabel.appendChild(regexInput);
  regexLabel.appendChild(document.createTextNode("regex"));
  row.appendChild(regexLabel);

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "secondary icon-btn";
  removeBtn.textContent = "×";
  removeBtn.addEventListener("click", () => row.remove());
  row.appendChild(removeBtn);

  return row;
}

function createSetHeaderRow(header) {
  const row = document.createElement("div");
  row.className = "set-header-row";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "Header name";
  nameInput.value = header.name || "";
  nameInput.dataset.field = "name";

  const valueInput = document.createElement("input");
  valueInput.type = "text";
  valueInput.placeholder = "Value";
  valueInput.value = header.value || "";
  valueInput.dataset.field = "value";

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "secondary icon-btn";
  removeBtn.textContent = "×";
  removeBtn.addEventListener("click", () => row.remove());

  row.appendChild(nameInput);
  row.appendChild(valueInput);
  row.appendChild(removeBtn);
  return row;
}

function renderReplacementList(container, replacements, { header = false } = {}) {
  container.replaceChildren();
  for (const replacement of replacements || []) {
    container.appendChild(createReplacementRow(replacement, { header }));
  }
}

function renderSetHeaders(container, headers) {
  container.replaceChildren();
  for (const header of headers || []) {
    container.appendChild(createSetHeaderRow(header));
  }
}

function readReplacementList(container, { header = false } = {}) {
  return [...container.querySelectorAll(".replacement-row")].map((row) => {
    const item = {
      find: row.querySelector('[data-field="find"]')?.value ?? "",
      replace: row.querySelector('[data-field="replace"]')?.value ?? "",
      isRegex: row.querySelector('[data-field="isRegex"]')?.checked ?? false,
    };
    if (header) {
      item.name = row.querySelector('[data-field="name"]')?.value ?? "";
    }
    return item;
  });
}

function readSetHeaders(container) {
  return [...container.querySelectorAll(".set-header-row")].map((row) => ({
    name: row.querySelector('[data-field="name"]')?.value ?? "",
    value: row.querySelector('[data-field="value"]')?.value ?? "",
  }));
}

/**
 * Whether the current resource-type filter can hit the page hook (fetch/XHR).
 * Empty selection means all types, including XHR.
 * @param {string[]} resourceTypes Selected resource types.
 * @returns {boolean}
 */
function allowsPageHook(resourceTypes) {
  if (!resourceTypes?.length) {
    return true;
  }
  return resourceTypes.includes("xmlhttprequest");
}

/**
 * Hide form sections that do not apply to the current action, phases, and
 * resource-type selection. Values stay in the form and reappear when options change.
 * @returns {void}
 */
function updateFormVisibility() {
  const action = ruleActionEl.value;
  const requestPhase = phaseRequestEl.checked;
  const responsePhase = phaseResponseEl.checked;
  const isModify = action === "modify";
  const isMock = action === "mock";
  const isRedirect = action === "redirect";
  const pageHook = allowsPageHook(readSelectedResourceTypes());
  const serveWithout = Boolean(ruleServeWithoutRequestEl?.checked);
  const showMockFields =
    isMock || (isModify && serveWithout && pageHook);
  const scriptsVisible =
    isModify && pageHook && (requestPhase || responsePhase);

  const visibility = {
    "request-phase": requestPhase,
    "response-phase": responsePhase,
    modify: isModify,
    redirect: isRedirect,
    "page-hook": pageHook,
    "mock-fields": showMockFields,
    "serve-without-toggle": isModify && pageHook,
    "hook-behavior": isModify && pageHook,
    "scripts-hint": scriptsVisible,
    "untested-intent": isModify || isRedirect,
  };

  for (const el of ruleFormEl.querySelectorAll("[data-show]")) {
    const keys = el.dataset.show.trim().split(/\s+/).filter(Boolean);
    const visible = keys.every((key) => visibility[key] !== false);
    el.classList.toggle("hidden", !visible);
  }

  if (ruleServeWithoutRequestEl) {
    ruleServeWithoutRequestEl.disabled = !(isModify && pageHook);
  }
}

function getSelectedRule() {
  return rulesState.rules.find((rule) => rule.id === selectedRuleId) || null;
}

function loadRuleIntoForm(rule) {
  if (!rule) {
    ruleFormEl.classList.add("hidden");
    editorTitleEl.textContent = "No rule selected";
    deleteRuleBtn.disabled = true;
    return;
  }

  ruleFormEl.classList.remove("hidden");
  deleteRuleBtn.disabled = false;
  editorTitleEl.textContent = rule.name || "Rule editor";

  ruleNameEl.value = rule.name || "";
  rulePriorityEl.value = String(rule.priority ?? 100);
  ruleEnabledEl.checked = Boolean(rule.enabled);
  for (const field of PATTERN_FIELDS) {
    setFieldValue(field.element, rule[field.key] || "");
    applyPatternFieldMode(field, Boolean(rule[field.flagKey]));
  }
  renderMethodChecks(rule.methods);
  renderResourceTypeChecks(rule.resourceTypes);
  phaseRequestEl.checked = (rule.phases || ["request"]).includes("request");
  phaseResponseEl.checked = (rule.phases || []).includes("response");
  ruleStatusMinEl.value =
    rule.responseStatusMin != null ? String(rule.responseStatusMin) : "";
  ruleStatusMaxEl.value =
    rule.responseStatusMax != null ? String(rule.responseStatusMax) : "";
  ruleActionEl.value = rule.action || "modify";
  ruleRedirectUrlEl.value = rule.redirectUrl || "";
  ruleServeWithoutRequestEl.checked = Boolean(rule.modify?.serveWithoutRequest);
  ruleMockStatusEl.value = String(rule.modify?.mockStatus ?? 200);
  ruleMockStatusTextEl.value = rule.modify?.mockStatusText || "OK";
  setFieldValue(ruleMockBodyEl, rule.modify?.mockBody || "");
  renderReplacementList(urlReplacementsEl, rule.modify?.urlReplacements);
  renderReplacementList(bodyReplacementsEl, rule.modify?.bodyReplacements);
  renderReplacementList(headerReplacementsEl, rule.modify?.headerReplacements, {
    header: true,
  });
  renderSetHeaders(setHeadersEl, rule.modify?.setHeaders);
  setFieldValue(ruleRequestScriptEl, rule.modify?.requestScript || "");
  setFieldValue(ruleResponseScriptEl, rule.modify?.responseScript || "");
  if (ruleMatchHookOriginatedEl) {
    ruleMatchHookOriginatedEl.checked = Boolean(rule.matchHookOriginated);
  }
  updateFormVisibility();
}

function createRuleDeleteButton(rule) {
  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "rule-item-delete";
  deleteBtn.title = "Delete rule";
  deleteBtn.setAttribute("aria-label", `Delete ${rule.name || "rule"}`);
  deleteBtn.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M6 1h4l1 1h3v2H2V2h3l1-1zM3 5h10l-1 9H4L3 5zm3 2v5h1V7H6zm3 0v5h1V7H9z"/></svg>';
  deleteBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    deleteRuleById(rule.id);
  });
  return deleteBtn;
}

function renderRulesList() {
  rulesListEl.replaceChildren();
  ruleCountEl.textContent = `${rulesState.rules.length} rule${
    rulesState.rules.length === 1 ? "" : "s"
  }`;

  if (rulesState.rules.length === 0) {
    const empty = document.createElement("p");
    empty.className = "log-empty";
    empty.style.padding = "12px";
    empty.textContent = "No rules yet.";
    rulesListEl.appendChild(empty);
    selectedRuleId = null;
    loadRuleIntoForm(null);
    return;
  }

  const sorted = [...rulesState.rules].sort(
    (a, b) => (a.priority ?? 100) - (b.priority ?? 100)
  );

  if (selectedRuleId && !sorted.some((rule) => rule.id === selectedRuleId)) {
    selectedRuleId = sorted[0]?.id || null;
  }

  for (const rule of sorted) {
    const row = document.createElement("div");
    row.className = "rule-item-row";
    if (rule.id === highlightedRuleId) {
      row.classList.add("matched");
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "rule-item";
    if (!rule.enabled) {
      button.classList.add("disabled");
    }
    if (rule.id === selectedRuleId) {
      button.classList.add("active");
    }

    const title = document.createElement("span");
    title.className = "rule-item-title";
    title.textContent = rule.name || "Untitled rule";

    const meta = document.createElement("span");
    meta.className = "rule-item-meta";
    meta.textContent = summarizeRule(rule);

    button.appendChild(title);
    button.appendChild(meta);
    button.addEventListener("click", () => {
      selectedRuleId = rule.id;
      renderRulesList();
      loadRuleIntoForm(rule);
      selectWorkspaceTab("editor");
      defaultTestUrl().then((url) => {
        if (ruleTestUrlEl && url && !ruleTestUrlEl.value.trim()) {
          ruleTestUrlEl.value = url;
        }
      });
    });

    row.appendChild(button);
    row.appendChild(createRuleDeleteButton(rule));
    rulesListEl.appendChild(row);
  }

  if (!selectedRuleId && sorted.length) {
    selectedRuleId = sorted[0].id;
    loadRuleIntoForm(sorted[0]);
    renderRulesList();
  }
}

/**
 * Build the searchable text for a recent-match entry.
 * @param {object} entry Recent network rule match.
 * @returns {string}
 */
function logEntrySearchText(entry) {
  return [
    entry.ruleName,
    entry.ruleId,
    entry.outcome,
    entry.method,
    entry.url,
    entry.resourceType,
    entry.via,
    entry.detail,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/**
 * Open a matched rule in the Rule editor tab.
 * @param {string} ruleId Rule id from a log entry.
 * @returns {void}
 */
function openRuleFromLog(ruleId) {
  if (!ruleId) {
    return;
  }
  const rule = rulesState.rules.find((item) => item.id === ruleId);
  if (!rule) {
    showMessage("That rule is no longer in this rule set.");
    return;
  }
  selectedRuleId = rule.id;
  renderRulesList();
  loadRuleIntoForm(rule);
  selectWorkspaceTab("editor");
  defaultTestUrl().then((url) => {
    if (ruleTestUrlEl && url && !ruleTestUrlEl.value.trim()) {
      ruleTestUrlEl.value = url;
    }
  });
}

/**
 * Render recent rule matches and update the tab's count.
 * @param {Array<object>} [entries] Recent network rule matches; omit to re-render the cached list.
 * @returns {void}
 */
function renderLog(entries) {
  const entriesUpdated = entries != null;
  if (entriesUpdated) {
    logEntries = entries;
  }

  rulesLogEl.replaceChildren();
  const hasEntries = Boolean(logEntries.length);
  recentMatchCountEl.textContent = hasEntries ? String(logEntries.length) : "";
  recentMatchCountEl.hidden = !hasEntries;

  if (!hasEntries) {
    const empty = document.createElement("p");
    empty.className = "log-empty";
    empty.textContent = "No matches yet.";
    rulesLogEl.appendChild(empty);
    return;
  }

  if (entriesUpdated) {
    const newest = logEntries[logEntries.length - 1];
    if (newest?.ruleId) {
      highlightedRuleId = newest.ruleId;
      renderRulesList();
    }
  }

  const query = logSearchQuery.trim().toLowerCase();
  const visible = query
    ? logEntries.filter((entry) => logEntrySearchText(entry).includes(query))
    : logEntries;

  if (!visible.length) {
    const empty = document.createElement("p");
    empty.className = "log-empty";
    empty.textContent = "No matches for this search.";
    rulesLogEl.appendChild(empty);
    return;
  }

  for (const entry of [...visible].reverse()) {
    const line = document.createElement("div");
    line.className = "log-entry";
    if (entry.ruleId && entry.ruleId === highlightedRuleId) {
      line.classList.add("log-entry-recent");
    }
    if (entry.ruleId && entry.ruleId === selectedRuleId) {
      line.classList.add("log-entry-selected");
    }

    const time = new Date(entry.ts || Date.now()).toLocaleTimeString();
    const ruleLabel = entry.ruleName || entry.ruleId || "rule";
    const ruleBtn = document.createElement("button");
    ruleBtn.type = "button";
    ruleBtn.className = "log-entry-rule";
    ruleBtn.textContent = ruleLabel;
    if (entry.ruleId) {
      ruleBtn.title = `Open "${ruleLabel}" in Rule editor`;
      ruleBtn.addEventListener("click", () => openRuleFromLog(entry.ruleId));
    } else {
      ruleBtn.disabled = true;
    }

    const suffix = document.createElement("span");
    const detail = entry.detail ? ` · ${entry.detail}` : "";
    suffix.textContent = ` · ${entry.outcome} · ${entry.method || "?"} ${
      entry.url || ""
    }${entry.resourceType ? ` · ${entry.resourceType}` : ""}${
      entry.via ? ` · ${entry.via}` : ""
    }${detail}`;

    line.append(`[${time}] `, ruleBtn, suffix);
    rulesLogEl.appendChild(line);
  }
}

async function persistRulesState() {
  const response = await browser.runtime.sendMessage({
    type: NT.SAVE_NETWORK_RULES,
    state: rulesState,
  });
  if (!response?.ok) {
    throw new Error(response?.error || "Save failed.");
  }
  lastPersistedRulesSnapshot = JSON.stringify(rulesState);
}

/**
 * Download the current rules state as network-rules.json.
 */
function exportRulesToFile() {
  hideMessage();
  const payload = {
    enabled: rulesState.enabled !== false,
    rules: Array.isArray(rulesState.rules) ? rulesState.rules : [],
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "network-rules.json";
  anchor.click();
  URL.revokeObjectURL(url);
  showMessage(
    `Downloaded network-rules.json (${payload.rules.length} rule${
      payload.rules.length === 1 ? "" : "s"
    }).`
  );
}

/**
 * Parse imported JSON into a normalized network rules state.
 * Accepts `{ enabled?, rules }` or a bare rules array.
 * @param {string} raw File text.
 * @returns {{ enabled: boolean, rules: object[] }}
 */
function parseNetworkRulesImport(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    throw new Error("Choose a JSON file to import.");
  }
  let data;
  try {
    data = JSON.parse(trimmed);
  } catch {
    throw new Error("Invalid JSON.");
  }
  if (Array.isArray(data)) {
    return normalizeNetworkRulesState({ enabled: true, rules: data });
  }
  if (data && typeof data === "object" && Array.isArray(data.rules)) {
    return normalizeNetworkRulesState(data);
  }
  throw new Error('Invalid network rules JSON (expected { "rules": [...] }).');
}

/**
 * Replace the current rule set with JSON from a file and persist.
 * @param {File|null|undefined} file Selected JSON file.
 */
async function importRulesFromFile(file) {
  if (!file) {
    return;
  }
  hideMessage();
  if (importRulesBtn) {
    importRulesBtn.disabled = true;
  }
  try {
    const next = parseNetworkRulesImport(await file.text());
    const currentCount = rulesState.rules.length;
    if (
      currentCount > 0 &&
      !confirm(
        `Replace ${currentCount} current rule(s) with ${next.rules.length} from "${file.name}"?`
      )
    ) {
      return;
    }
    rulesState = next;
    selectedRuleId = rulesState.rules[0]?.id || null;
    await persistRulesState();
    renderRulesList();
    loadRuleIntoForm(getSelectedRule());
    updateNetworkStatusDot();
    showMessage(
      `Imported ${rulesState.rules.length} rule${
        rulesState.rules.length === 1 ? "" : "s"
      } from "${file.name}".`
    );
  } catch (error) {
    showMessage(error.message || String(error));
  } finally {
    if (importRulesBtn) {
      importRulesBtn.disabled = false;
    }
  }
}

async function deleteRuleById(ruleId) {
  hideMessage();
  const existing = rulesState.rules.find((rule) => rule.id === ruleId);
  if (!existing) {
    return;
  }

  rulesState.rules = rulesState.rules.filter((rule) => rule.id !== ruleId);
  if (selectedRuleId === ruleId) {
    const sorted = [...rulesState.rules].sort(
      (a, b) => (a.priority ?? 100) - (b.priority ?? 100)
    );
    selectedRuleId = sorted[0]?.id || null;
  }

  renderRulesList();
  loadRuleIntoForm(getSelectedRule());

  try {
    await persistRulesState();
    showMessage(`Deleted "${existing.name}".`);
  } catch (error) {
    showMessage(error.message || String(error));
  }
}

async function insertRuleFromTemplate(templateId) {
  if (!templateId) {
    return;
  }

  const template = ruleTemplates.find((item) => item.id === templateId);
  if (!template) {
    showMessage("Unknown template.");
    return;
  }

  hideMessage();
  try {
    const rule = instantiateNetworkRuleTemplate(template);
    rulesState.rules.push(rule);
    selectedRuleId = rule.id;
    renderRulesList();
    loadRuleIntoForm(rule);
    await persistRulesState();
    showMessage(`Added "${rule.name}" from template.`);
  } catch (error) {
    showMessage(error.message || String(error));
  } finally {
    if (ruleTemplateSelectEl) {
      ruleTemplateSelectEl.value = "";
    }
  }
}

function readRuleFromForm(existingRule) {
  const phases = [];
  if (phaseRequestEl.checked) phases.push("request");
  if (phaseResponseEl.checked) phases.push("response");
  if (!phases.length) {
    throw new Error("Select at least one phase.");
  }

  const statusMinRaw = ruleStatusMinEl.value.trim();
  const statusMaxRaw = ruleStatusMaxEl.value.trim();

  const patterns = {};
  for (const field of PATTERN_FIELDS) {
    patterns[field.key] = getFieldValue(field.element).trim();
    patterns[field.flagKey] = field.regexEl.checked;
  }

  return {
    ...existingRule,
    name: ruleNameEl.value.trim() || "Untitled rule",
    enabled: ruleEnabledEl.checked,
    priority: Number(rulePriorityEl.value) || 100,
    ...patterns,
    methods: readSelectedMethods(),
    resourceTypes: readSelectedResourceTypes(),
    phases,
    responseStatusMin: statusMinRaw ? Number(statusMinRaw) : null,
    responseStatusMax: statusMaxRaw ? Number(statusMaxRaw) : null,
    action: ruleActionEl.value,
    redirectUrl: ruleRedirectUrlEl.value.trim(),
    matchHookOriginated: Boolean(ruleMatchHookOriginatedEl?.checked),
    modify: {
      urlReplacements: readReplacementList(urlReplacementsEl),
      bodyReplacements: readReplacementList(bodyReplacementsEl),
      headerReplacements: readReplacementList(headerReplacementsEl, {
        header: true,
      }),
      setHeaders: readSetHeaders(setHeadersEl),
      requestScript: getFieldValue(ruleRequestScriptEl),
      responseScript: getFieldValue(ruleResponseScriptEl),
      serveWithoutRequest: ruleServeWithoutRequestEl.checked,
      mockStatus: Number(ruleMockStatusEl.value) || 200,
      mockStatusText: ruleMockStatusTextEl.value.trim() || "OK",
      mockBody: getFieldValue(ruleMockBodyEl),
      cspSeed: existingRule?.modify?.cspSeed || "",
      cspMode: existingRule?.modify?.cspMode || "",
    },
  };
}

async function loadState() {
  const response = await browser.runtime.sendMessage({ type: NT.GET_NETWORK_RULES });
  if (response?.ok) {
    rulesState = normalizeNetworkRulesState(
      response.state || defaultNetworkRulesState()
    );
    lastPersistedRulesSnapshot = JSON.stringify(rulesState);
  }
  renderRulesList();
}

async function loadLog() {
  const stored = await browser.storage.session.get(NETWORK_RULES_LOG_KEY);
  const entries = stored[NETWORK_RULES_LOG_KEY] || [];
  renderLog(entries);
  selectWorkspaceTab(entries.length ? "log" : "editor");
  updateNetworkStatusDot(entries);
}

function getInspectedTabId() {
  return browser.devtools?.inspectedWindow?.tabId ?? null;
}

async function updateNetworkStatusDot(logEntries = null) {
  if (!networkStatusDotEl) {
    return;
  }

  const settingsResponse = await browser.runtime.sendMessage({
    type: HT.GET_EXTENSION_SETTINGS,
  });
  const hooksEnabled =
    settingsResponse?.ok &&
    (settingsResponse.settings?.networkArm?.armed === true ||
      settingsResponse.settings?.networkHooksEnabled === true);

  networkStatusDotEl.classList.remove("is-disabled", "is-matched");

  if (!hooksEnabled || rulesState.enabled === false) {
    networkStatusDotEl.classList.add("is-disabled");
    setNetworkStatusText(
      rulesState.enabled === false
        ? "This rule set is disabled (imported that way). Click Arm rules to re-enable it and start the session."
        : "Network rules are not armed. Click Arm rules to start a session."
    );
    return;
  }

  const tabId = getInspectedTabId();
  let entries = logEntries;
  if (!entries) {
    const stored = await browser.storage.session.get(NETWORK_RULES_LOG_KEY);
    entries = stored[NETWORK_RULES_LOG_KEY] || [];
  }

  const hasTabMatch =
    tabId != null &&
    entries.some((entry) => {
      if (entry.tabId !== tabId || !entry?.ts) {
        return false;
      }
      return Date.now() - entry.ts < 60000;
    });

  if (hasTabMatch) {
    networkStatusDotEl.classList.add("is-matched");
    setNetworkStatusText(
      "Network hooks are enabled. A rule matched on this inspected tab within the last 60 seconds."
    );
  } else {
    setNetworkStatusText(
      "Network hooks are enabled. No rule has matched on this inspected tab within the last 60 seconds."
    );
  }
}

async function defaultTestUrl() {
  const tabId = getInspectedTabId();
  if (tabId == null) {
    return "";
  }
  try {
    const tab = await browser.tabs.get(tabId);
    return tab.url?.startsWith("http") ? tab.url : "";
  } catch {
    return "";
  }
}

function syncTemplateSelectWidth() {
  if (!ruleTemplateSelectEl) {
    return;
  }

  const select = ruleTemplateSelectEl;
  const style = getComputedStyle(select);
  const measure = document.createElement("span");
  measure.style.position = "absolute";
  measure.style.visibility = "hidden";
  measure.style.whiteSpace = "nowrap";
  measure.style.font = style.font;
  document.body.appendChild(measure);

  let maxWidth = 0;
  for (const option of select.options) {
    measure.textContent = option.text;
    maxWidth = Math.max(maxWidth, measure.offsetWidth);
  }
  measure.remove();

  const horizontalPadding =
    (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const border =
    (parseFloat(style.borderLeftWidth) || 0) +
    (parseFloat(style.borderRightWidth) || 0);
  select.style.width = `${Math.ceil(maxWidth + horizontalPadding + border + 22)}px`;
}

function renderRuleTemplateSelect() {
  if (!ruleTemplateSelectEl) {
    return;
  }

  ruleTemplateSelectEl.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Insert from template…";
  ruleTemplateSelectEl.appendChild(placeholder);

  for (const template of ruleTemplates) {
    const option = document.createElement("option");
    option.value = template.id;
    option.textContent = template.name;
    option.title = template.description || "";
    ruleTemplateSelectEl.appendChild(option);
  }

  syncTemplateSelectWidth();
}

async function loadRuleTemplates() {
  try {
    ruleTemplates = await loadNetworkRuleTemplates();
  } catch (error) {
    ruleTemplates = [];
    showMessage(error.message || String(error));
  }
  renderRuleTemplateSelect();
}

document.getElementById("add-rule-btn").addEventListener("click", () => {
  hideMessage();
  const rule = createEmptyRule();
  rulesState.rules.push(rule);
  selectedRuleId = rule.id;
  renderRulesList();
  loadRuleIntoForm(rule);
});

if (ruleTemplateSelectEl) {
  ruleTemplateSelectEl.addEventListener("change", () => {
    insertRuleFromTemplate(ruleTemplateSelectEl.value);
  });
}

document.getElementById("reinject-btn").addEventListener("click", async () => {
  hideMessage();
  const response = await browser.runtime.sendMessage({
    type: NT.REFRESH_NETWORK_RULES,
  });
  if (response?.ok) {
    showMessage("Re-injected network hook on open tabs.");
  } else {
    showMessage(response?.error || "Re-inject failed.");
  }
});

if (exportRulesBtn) {
  exportRulesBtn.addEventListener("click", exportRulesToFile);
}

if (importRulesBtn && importRulesFileEl) {
  importRulesBtn.addEventListener("click", () => {
    importRulesFileEl.click();
  });
  importRulesFileEl.addEventListener("change", async () => {
    const file = importRulesFileEl.files?.[0];
    importRulesFileEl.value = "";
    await importRulesFromFile(file);
  });
}

const networkArm = networkArmEl
  ? createNetworkArmControl(networkArmEl, {
      // The arm control is the only global switch left in this panel, so an
      // imported rule set that disabled itself must not silently swallow it.
      async beforeArm() {
        if (rulesState.enabled === false) {
          rulesState.enabled = true;
          await persistRulesState();
          renderRulesList();
        }
      },
    })
  : null;

ruleActionEl.addEventListener("change", updateFormVisibility);
phaseRequestEl.addEventListener("change", updateFormVisibility);
phaseResponseEl.addEventListener("change", updateFormVisibility);
if (ruleServeWithoutRequestEl) {
  ruleServeWithoutRequestEl.addEventListener("change", updateFormVisibility);
}
ruleResourceTypesEl.addEventListener("change", updateFormVisibility);

ruleFormEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideMessage();

  const existing = getSelectedRule();
  if (!existing) {
    showMessage("Select or add a rule first.");
    return;
  }

  try {
    const nextRule = readRuleFromForm(existing);
    rulesState.rules = rulesState.rules.map((rule) =>
      rule.id === existing.id ? nextRule : rule
    );
    await persistRulesState();
    selectedRuleId = nextRule.id;
    renderRulesList();
    loadRuleIntoForm(nextRule);
    showMessage(`Saved "${nextRule.name}".`);
  } catch (error) {
    showMessage(error.message || String(error));
  }
});

deleteRuleBtn.addEventListener("click", () => {
  const existing = getSelectedRule();
  if (!existing) {
    return;
  }
  deleteRuleById(existing.id);
});

if (testRuleBtn) {
  testRuleBtn.addEventListener("click", async () => {
    hideMessage();
    const rule = getSelectedRule();
    if (!rule) {
      showMessage("Select a rule first.");
      return;
    }
    const url = ruleTestUrlEl?.value.trim() || (await defaultTestUrl());
    if (!url) {
      showMessage("Enter a test URL.");
      return;
    }
    const response = await browser.runtime.sendMessage({
      type: NT.TEST_NETWORK_RULE,
      ruleId: rule.id,
      url,
    });
    if (response?.ok) {
      showMessage(`Testing "${rule.name}" in a new tab…`);
    } else {
      showMessage(response?.error || "Test failed.");
    }
  });
}

document.getElementById("clear-log-btn").addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: NT.CLEAR_NETWORK_RULE_LOG });
  logSearchQuery = "";
  logSearchEl.value = "";
  renderLog([]);
  selectWorkspaceTab("editor");
});

logSearchEl.addEventListener("input", () => {
  logSearchQuery = logSearchEl.value;
  renderLog();
});

editorTabEl.addEventListener("click", () => selectWorkspaceTab("editor"));
logTabEl.addEventListener("click", () => {
  selectWorkspaceTab("log");
  logSearchEl.focus();
});

for (const tab of [editorTabEl, logTabEl]) {
  tab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    event.preventDefault();
    const nextTab = tab === editorTabEl ? logTabEl : editorTabEl;
    selectWorkspaceTab(nextTab === logTabEl ? "log" : "editor");
    nextTab.focus();
  });
}

document.querySelectorAll("[data-add-replacement]").forEach((button) => {
  button.addEventListener("click", () => {
    const key = button.dataset.addReplacement;
    const container =
      key === "urlReplacements"
        ? urlReplacementsEl
        : key === "bodyReplacements"
          ? bodyReplacementsEl
          : headerReplacementsEl;
    container.appendChild(
      createReplacementRow(
        { find: "", replace: "", isRegex: false, name: "" },
        { header: key === "headerReplacements" }
      )
    );
  });
});

document.querySelector("[data-add-set-header]").addEventListener("click", () => {
  setHeadersEl.appendChild(createSetHeaderRow({ name: "", value: "" }));
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes[NETWORK_RULES_LOG_KEY]) {
    const entries = changes[NETWORK_RULES_LOG_KEY].newValue || [];
    renderLog(entries);
    updateNetworkStatusDot(entries);
  }
  if (area === "local" && changes[NETWORK_HOOKS_ENABLED_KEY]) {
    updateNetworkStatusDot();
  }
  if (area === "local" && changes[NETWORK_RULES_KEY]) {
    const incoming = changes[NETWORK_RULES_KEY].newValue;
    if (!incoming) {
      return;
    }
    const incomingSnapshot = JSON.stringify(incoming);
    if (
      incomingSnapshot === lastPersistedRulesSnapshot ||
      incomingSnapshot === JSON.stringify(rulesState)
    ) {
      return;
    }
    rulesState = normalizeNetworkRulesState(incoming);
    lastPersistedRulesSnapshot = JSON.stringify(rulesState);
    renderRulesList();
    loadRuleIntoForm(getSelectedRule());
    updateNetworkStatusDot();
  }
});

loadRuleTemplates();
loadState().then(() => {
  void networkArm?.refresh();
  loadLog();
  defaultTestUrl().then((url) => {
    if (ruleTestUrlEl && url) {
      ruleTestUrlEl.value = url;
    }
  });
});
