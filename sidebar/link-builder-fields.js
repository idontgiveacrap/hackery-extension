import { attachCodeMirror, getFieldValue, setFieldValue } from "../lib/codemirror-fields.bundle.js";

export function setFieldVisible(el, visible) {
  if (!el) {
    return;
  }
  el.classList.toggle("is-hidden", !visible);
}

const STRING_SOURCE_OPTIONS = [
  { value: "textContent", label: "textContent" },
  { value: "innerHTML", label: "innerHTML" },
  { value: "id", label: "id" },
  { value: "attribute", label: "attribute" },
];

function parseChoices(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return undefined;
  }
  const choices = trimmed
    .split(",")
    .map((choice) => choice.trim())
    .filter(Boolean);
  return choices.length ? choices : undefined;
}

function readSingleParameter(container) {
  const name = container.querySelector('[data-field="param-name"]')?.value.trim();
  if (!name) {
    return undefined;
  }
  const parameter = { name };
  const placeholder = container.querySelector('[data-field="param-placeholder"]')?.value.trim();
  const defaultValue = container.querySelector('[data-field="param-default"]')?.value.trim();
  const optional = container.querySelector('[data-field="param-optional"]')?.checked;
  const choices = parseChoices(
    container.querySelector('[data-field="param-choices"]')?.value
  );
  if (placeholder) {
    parameter.placeholder = placeholder;
  }
  if (defaultValue) {
    parameter.default = defaultValue;
  }
  if (optional) {
    parameter.optional = true;
  }
  if (choices) {
    parameter.choices = choices;
  }
  return parameter;
}

function readMultipleParameters(listEl) {
  const parameters = {};
  for (const row of listEl.querySelectorAll(".parameter-row")) {
    const name = row.querySelector('[data-field="param-name"]')?.value.trim();
    if (!name) {
      continue;
    }
    const config = {};
    const placeholder = row.querySelector('[data-field="param-placeholder"]')?.value.trim();
    const defaultValue = row.querySelector('[data-field="param-default"]')?.value.trim();
    const optional = row.querySelector('[data-field="param-optional"]')?.checked;
    const choices = parseChoices(row.querySelector('[data-field="param-choices"]')?.value);
    if (placeholder) {
      config.placeholder = placeholder;
    }
    if (defaultValue) {
      config.default = defaultValue;
    }
    if (optional) {
      config.optional = true;
    }
    if (choices) {
      config.choices = choices;
    }
    parameters[name] = config;
  }
  return Object.keys(parameters).length ? parameters : undefined;
}

function readNavParamsList(listEl) {
  const navParams = {};
  for (const row of listEl.querySelectorAll(".nav-param-row")) {
    const paramName = row.querySelector('[data-field="nav-name"]')?.value.trim();
    if (!paramName) {
      continue;
    }
    const spec = {};
    const kind = row.querySelector('[data-field="nav-kind"]')?.value || "none";
    if (kind === "url") {
      const pattern = getFieldValue(
        row.querySelector('[data-field="nav-from-url"]')
      ).trim();
      if (pattern) {
        spec.fromUrl = pattern;
      }
    } else if (kind === "dom") {
      const selector = row.querySelector('[data-field="nav-from-selector"]')?.value.trim();
      if (selector) {
        spec.fromSelector = selector;
        const stringSource = row.querySelector('[data-field="nav-string-source"]')?.value;
        if (stringSource) {
          spec.stringSource = stringSource;
        }
        const attribute = row.querySelector('[data-field="nav-attribute"]')?.value.trim();
        if (attribute) {
          spec.attribute = attribute;
        }
      }
    }

    const showInput = row.querySelector('[data-field="nav-show-input"]')?.checked;
    if (showInput) {
      spec.placeholder =
        row.querySelector('[data-field="nav-placeholder"]')?.value ?? "";
    }
    const defaultValue = row.querySelector('[data-field="nav-default"]')?.value.trim();
    if (defaultValue) {
      spec.default = defaultValue;
    }
    if (row.querySelector('[data-field="nav-optional"]')?.checked) {
      spec.optional = true;
    }

    if (!spec.fromUrl && !spec.fromSelector && !showInput && !spec.default && !spec.optional) {
      continue;
    }
    navParams[paramName] = spec;
  }
  return Object.keys(navParams).length ? navParams : undefined;
}

function fillSingleParameter(container, parameter = {}) {
  container.querySelector('[data-field="param-name"]').value = parameter.name || "";
  container.querySelector('[data-field="param-placeholder"]').value =
    parameter.placeholder || "";
  container.querySelector('[data-field="param-default"]').value = parameter.default ?? "";
  container.querySelector('[data-field="param-optional"]').checked = Boolean(
    parameter.optional
  );
  container.querySelector('[data-field="param-choices"]').value = Array.isArray(
    parameter.choices
  )
    ? parameter.choices.join(", ")
    : "";
}

function createParameterRow(values = {}) {
  const row = document.createElement("div");
  row.className = "parameter-row builder-row";
  row.innerHTML = `
    <input data-field="param-name" type="text" placeholder="name" />
    <input data-field="param-placeholder" type="text" placeholder="placeholder" />
    <input data-field="param-default" type="text" placeholder="default" />
    <label class="inline-check"><input data-field="param-optional" type="checkbox" /> Optional (may run empty)</label>
    <input data-field="param-choices" type="text" placeholder="choices, comma, separated" />
    <button type="button" class="row-remove secondary" title="Remove">×</button>
  `;
  row.querySelector('[data-field="param-name"]').value = values.name || "";
  row.querySelector('[data-field="param-placeholder"]').value = values.placeholder || "";
  row.querySelector('[data-field="param-default"]').value = values.default ?? "";
  row.querySelector('[data-field="param-optional"]').checked = Boolean(values.optional);
  row.querySelector('[data-field="param-choices"]').value = Array.isArray(values.choices)
    ? values.choices.join(", ")
    : "";
  row.querySelector(".row-remove").addEventListener("click", () => row.remove());
  return row;
}

function updateNavParamRowVisibility(row) {
  const kind = row.querySelector('[data-field="nav-kind"]')?.value || "none";
  setFieldVisible(
    row.querySelector('[data-field="nav-from-url"]')?.closest(".nav-url-field"),
    kind === "url"
  );
  setFieldVisible(row.querySelector(".nav-dom-fields"), kind === "dom");
  const stringSource = row.querySelector('[data-field="nav-string-source"]')?.value;
  setFieldVisible(
    row.querySelector('[data-field="nav-attribute"]')?.closest(".nav-attribute-field"),
    kind === "dom" && stringSource === "attribute"
  );
  const showInput = row.querySelector('[data-field="nav-show-input"]')?.checked;
  setFieldVisible(
    row.querySelector('[data-field="nav-placeholder"]')?.closest(".nav-placeholder-field"),
    showInput
  );
}

function createNavParamRow(values = {}) {
  const row = document.createElement("div");
  row.className = "nav-param-row";
  row.innerHTML = `
    <div class="nav-param-head">
      <label class="field nav-name-field">
        <span class="field-label">Param name</span>
        <input data-field="nav-name" type="text" placeholder="id" />
      </label>
      <label class="field nav-kind-field">
        <span class="field-label">Value source</span>
        <select data-field="nav-kind">
          <option value="none">Manual / default only</option>
          <option value="url">fromUrl (regex)</option>
          <option value="dom">fromSelector (DOM)</option>
        </select>
      </label>
      <button type="button" class="row-remove secondary" title="Remove navParam" aria-label="Remove navParam">×</button>
    </div>
    <label class="field nav-url-field is-hidden">
      <span class="field-label">fromUrl regex (capture group 1)</span>
      <textarea data-field="nav-from-url" rows="1" spellcheck="false" placeholder="e.g. /items/([^/?#]+)"></textarea>
    </label>
    <div class="nav-dom-fields is-hidden">
      <label class="field nav-selector-field">
        <span class="field-label">CSS selector</span>
        <input data-field="nav-from-selector" type="text" placeholder="e.g. #record-title" />
      </label>
      <label class="field nav-string-source-field">
        <span class="field-label">String source</span>
        <select data-field="nav-string-source">
          ${STRING_SOURCE_OPTIONS.map(
            (option) =>
              `<option value="${option.value}">${option.label}</option>`
          ).join("")}
        </select>
      </label>
      <label class="field nav-attribute-field is-hidden">
        <span class="field-label">Attribute name</span>
        <input data-field="nav-attribute" type="text" placeholder="e.g. data-value" />
      </label>
    </div>
    <div class="nav-value-fields">
      <label class="field nav-default-field">
        <span class="field-label">Default value</span>
        <input data-field="nav-default" type="text" />
      </label>
      <label class="field nav-placeholder-field is-hidden">
        <span class="field-label">Input placeholder (may be empty)</span>
        <input data-field="nav-placeholder" type="text" />
      </label>
    </div>
    <div class="nav-param-toggles">
      <label class="inline-check">
        <input data-field="nav-show-input" type="checkbox" />
        Show input on activate
      </label>
      <label class="inline-check">
        <input data-field="nav-optional" type="checkbox" />
        Optional (may run empty)
      </label>
    </div>
  `;

  const kindSelect = row.querySelector('[data-field="nav-kind"]');
  const sourceSelect = row.querySelector('[data-field="nav-string-source"]');
  const showInput = row.querySelector('[data-field="nav-show-input"]');
  kindSelect.addEventListener("change", () => updateNavParamRowVisibility(row));
  sourceSelect.addEventListener("change", () => updateNavParamRowVisibility(row));
  showInput.addEventListener("change", () => updateNavParamRowVisibility(row));
  row.querySelector(".row-remove").addEventListener("click", () => row.remove());

  if (values.fromUrl) {
    kindSelect.value = "url";
    setFieldValue(
      row.querySelector('[data-field="nav-from-url"]'),
      values.fromUrl
    );
  } else if (values.fromSelector) {
    kindSelect.value = "dom";
    row.querySelector('[data-field="nav-from-selector"]').value =
      values.fromSelector;
    sourceSelect.value = values.stringSource || "textContent";
    row.querySelector('[data-field="nav-attribute"]').value = values.attribute || "";
  } else {
    kindSelect.value = "none";
  }

  if (values.paramName) {
    row.querySelector('[data-field="nav-name"]').value = values.paramName;
  }
  if (Object.prototype.hasOwnProperty.call(values, "placeholder")) {
    showInput.checked = true;
    row.querySelector('[data-field="nav-placeholder"]').value = values.placeholder ?? "";
  }
  row.querySelector('[data-field="nav-default"]').value = values.default ?? "";
  row.querySelector('[data-field="nav-optional"]').checked = Boolean(values.optional);

  updateNavParamRowVisibility(row);
  attachCodeMirror(row.querySelector('[data-field="nav-from-url"]'), {
    language: "regex",
    compact: true,
    placeholder: "e.g. /items/([^/?#]+)",
  });
  return row;
}

export function wireBuilderFieldUi(fieldElements) {
  fieldElements.hostPatternModeSelect.addEventListener("change", () => {
    updateHostPatternFieldVisibility(fieldElements);
  });
  fieldElements.excludePatternModeSelect?.addEventListener("change", () => {
    updateExcludePatternFieldVisibility(fieldElements);
  });
  fieldElements.framesModeSelect.addEventListener("change", () => {
    updateFramesFieldVisibility(fieldElements);
  });
  fieldElements.parameterModeSelect.addEventListener("change", () => {
    updateParameterModeVisibility(fieldElements);
  });
  fieldElements.addParameterBtn.addEventListener("click", () => {
    fieldElements.multipleParametersList.appendChild(createParameterRow());
  });
  fieldElements.addNavParamBtn.addEventListener("click", () => {
    fieldElements.navParamsList.appendChild(createNavParamRow());
  });
}

export function updateHostPatternFieldVisibility(fieldElements) {
  const mode = fieldElements.hostPatternModeSelect.value;
  setFieldVisible(fieldElements.hostPatternCustomField, mode === "custom");
}

export function updateExcludePatternFieldVisibility(fieldElements) {
  if (!fieldElements.excludePatternModeSelect) {
    return;
  }
  const mode = fieldElements.excludePatternModeSelect.value;
  setFieldVisible(fieldElements.excludePatternCustomField, mode === "custom");
}

/**
 * Show custom frame-target fields only when the user opted out of the default.
 * @param {ReturnType<typeof getBuilderFieldElements>} fieldElements
 */
export function updateFramesFieldVisibility(fieldElements) {
  const mode = fieldElements.framesModeSelect.value;
  setFieldVisible(fieldElements.framesCustomFields, mode === "custom");
}

/**
 * Read a leaf `frames` spec from the builder, or `undefined` to omit the field.
 * @param {ReturnType<typeof getBuilderFieldElements>} fieldElements
 * @returns {object | undefined}
 */
export function readFramesFields(fieldElements) {
  if (fieldElements.framesModeSelect.value !== "custom") {
    return undefined;
  }

  const frames = {};
  if (fieldElements.framesTopInput.checked) {
    frames.top = true;
  }

  const nestingRaw = fieldElements.framesNestingInput.value.trim();
  if (nestingRaw) {
    const nestingLevel = Number(nestingRaw);
    if (!Number.isInteger(nestingLevel) || nestingLevel < -1) {
      throw new Error("Frame nesting level must be an integer >= -1.");
    }
    if (nestingLevel !== 0) {
      frames.nestingLevel = nestingLevel;
    }
  }

  const patterns = getFieldValue(fieldElements.framesMatchInput)
    .split(/\r?\n/)
    .map((pattern) => pattern.trim())
    .filter(Boolean);
  if (patterns.length) {
    frames.match = patterns;
  }

  return frames;
}

/**
 * Fill iframe-target controls from a stored leaf `frames` object.
 * @param {ReturnType<typeof getBuilderFieldElements>} fieldElements
 * @param {object | undefined} frames
 */
export function populateFramesFields(fieldElements, frames) {
  if (!frames || typeof frames !== "object") {
    clearFramesFields(fieldElements);
    return;
  }

  fieldElements.framesModeSelect.value = "custom";
  fieldElements.framesTopInput.checked = Boolean(frames.top);
  fieldElements.framesNestingInput.value =
    typeof frames.nestingLevel === "number" ? String(frames.nestingLevel) : "";
  setFieldValue(
    fieldElements.framesMatchInput,
    Array.isArray(frames.match) ? frames.match.join("\n") : ""
  );
  updateFramesFieldVisibility(fieldElements);
}

/**
 * Reset iframe-target controls to omit `frames` (runtime default).
 * @param {ReturnType<typeof getBuilderFieldElements>} fieldElements
 */
export function clearFramesFields(fieldElements) {
  fieldElements.framesModeSelect.value = "default";
  fieldElements.framesTopInput.checked = true;
  fieldElements.framesNestingInput.value = "";
  setFieldValue(fieldElements.framesMatchInput, "");
  updateFramesFieldVisibility(fieldElements);
}

export function updateParameterModeVisibility(fieldElements) {
  const mode = fieldElements.parameterModeSelect.value;
  setFieldVisible(fieldElements.singleParameterFields, mode === "single");
  setFieldVisible(fieldElements.multipleParametersPanel, mode === "multiple");
}

export function readHostPattern(fieldElements) {
  const mode = fieldElements.hostPatternModeSelect.value;
  if (mode === "inherit") {
    return undefined;
  }
  if (mode === "none") {
    return null;
  }
  const custom = getFieldValue(fieldElements.hostPatternCustomInput).trim();
  if (!custom) {
    throw new Error("Enter a host pattern regex or choose inherit/none.");
  }
  return custom;
}

export function populateHostPattern(fieldElements, hostPattern) {
  if (hostPattern === null) {
    fieldElements.hostPatternModeSelect.value = "none";
  } else if (hostPattern === undefined) {
    fieldElements.hostPatternModeSelect.value = "inherit";
    setFieldValue(fieldElements.hostPatternCustomInput, "");
  } else {
    fieldElements.hostPatternModeSelect.value = "custom";
    setFieldValue(fieldElements.hostPatternCustomInput, hostPattern);
  }
  updateHostPatternFieldVisibility(fieldElements);
}

export function readExcludePattern(fieldElements) {
  if (!fieldElements.excludePatternModeSelect) {
    return undefined;
  }
  const mode = fieldElements.excludePatternModeSelect.value;
  if (mode === "inherit") {
    return undefined;
  }
  if (mode === "none") {
    return null;
  }
  const custom = getFieldValue(fieldElements.excludePatternCustomInput).trim();
  if (!custom) {
    throw new Error("Enter an exclude regex or choose inherit/none.");
  }
  return custom;
}

export function populateExcludePattern(fieldElements, excludePattern) {
  if (!fieldElements.excludePatternModeSelect) {
    return;
  }
  if (excludePattern === null) {
    fieldElements.excludePatternModeSelect.value = "none";
  } else if (excludePattern === undefined) {
    fieldElements.excludePatternModeSelect.value = "inherit";
    setFieldValue(fieldElements.excludePatternCustomInput, "");
  } else {
    fieldElements.excludePatternModeSelect.value = "custom";
    setFieldValue(fieldElements.excludePatternCustomInput, excludePattern);
  }
  updateExcludePatternFieldVisibility(fieldElements);
}

export function readRunAt(fieldElements) {
  const value = fieldElements.runAtSelect?.value;
  if (!value || value === "document_start") {
    return undefined;
  }
  return value;
}

export function populateRunAt(fieldElements, runAt) {
  if (!fieldElements.runAtSelect) {
    return;
  }
  fieldElements.runAtSelect.value = runAt || "document_start";
}

export function readSandbox(fieldElements) {
  const value = fieldElements.sandboxSelect?.value;
  if (!value || value === "main") {
    return undefined;
  }
  return value;
}

export function populateSandbox(fieldElements, sandbox) {
  if (!fieldElements.sandboxSelect) {
    return;
  }
  fieldElements.sandboxSelect.value = sandbox || "main";
}

export function readParameterFields(fieldElements) {
  const mode = fieldElements.parameterModeSelect.value;
  if (mode === "single") {
    const parameter = readSingleParameter(fieldElements.singleParameterFields);
    if (!parameter) {
      return {};
    }
    const { name, ...rest } = parameter;
    return { params: { [name || "value"]: rest } };
  }
  if (mode === "multiple") {
    const parameters = readMultipleParameters(fieldElements.multipleParametersList);
    return parameters ? { params: parameters } : {};
  }
  return {};
}

export function populateParameterFields(fieldElements, node) {
  fieldElements.multipleParametersList.replaceChildren();
  const params =
    node.params && typeof node.params === "object" ? node.params : null;

  if (params) {
    const entries = Object.entries(params);
    if (entries.length === 1) {
      fieldElements.parameterModeSelect.value = "single";
      fillSingleParameter(fieldElements.singleParameterFields, {
        name: entries[0][0],
        ...entries[0][1],
      });
    } else {
      fieldElements.parameterModeSelect.value = "multiple";
      for (const [name, config] of entries) {
        fieldElements.multipleParametersList.appendChild(
          createParameterRow({ name, ...config })
        );
      }
    }
  } else {
    fieldElements.parameterModeSelect.value = "none";
    fillSingleParameter(fieldElements.singleParameterFields, {});
  }
  updateParameterModeVisibility(fieldElements);
}

export function clearParameterFields(fieldElements) {
  fieldElements.parameterModeSelect.value = "none";
  fillSingleParameter(fieldElements.singleParameterFields, {});
  fieldElements.multipleParametersList.replaceChildren();
  updateParameterModeVisibility(fieldElements);
}

export function populateNavParamsFields(fieldElements, navParams) {
  fieldElements.navParamsList.replaceChildren();
  if (!navParams || typeof navParams !== "object") {
    return;
  }
  for (const [paramName, spec] of Object.entries(navParams)) {
    fieldElements.navParamsList.appendChild(
      createNavParamRow({ paramName, ...spec })
    );
  }
}

export function readNavParamsFields(fieldElements) {
  return readNavParamsList(fieldElements.navParamsList);
}

export function clearNavParamsFields(fieldElements) {
  fieldElements.navParamsList.replaceChildren();
}

export function getBuilderFieldElements(root = document) {
  return {
    hostPatternModeSelect: root.getElementById("host-pattern-mode"),
    hostPatternCustomInput: root.getElementById("host-pattern-custom"),
    hostPatternCustomField: root.getElementById("host-pattern-custom-field"),
    excludePatternModeSelect: root.getElementById("exclude-pattern-mode"),
    excludePatternCustomInput: root.getElementById("exclude-pattern-custom"),
    excludePatternCustomField: root.getElementById("exclude-pattern-custom-field"),
    runAtField: root.getElementById("run-at-field"),
    runAtSelect: root.getElementById("link-run-at"),
    sandboxField: root.getElementById("sandbox-field"),
    sandboxSelect: root.getElementById("link-sandbox"),
    framesSection: root.getElementById("frames-section"),
    framesModeSelect: root.getElementById("frames-mode"),
    framesCustomFields: root.getElementById("frames-custom-fields"),
    framesTopInput: root.getElementById("frames-top"),
    framesNestingInput: root.getElementById("frames-nesting-level"),
    framesMatchInput: root.getElementById("frames-match"),
    parameterModeSelect: root.getElementById("parameter-mode"),
    singleParameterFields: root.getElementById("single-parameter-fields"),
    multipleParametersPanel: root.getElementById("multiple-parameters-panel"),
    multipleParametersList: root.getElementById("multiple-parameters-list"),
    addParameterBtn: root.getElementById("add-parameter-btn"),
    navParamsSection: root.getElementById("nav-params-section"),
    navParamsList: root.getElementById("nav-params-list"),
    addNavParamBtn: root.getElementById("add-nav-param-btn"),
    parametersSection: root.getElementById("parameters-section"),
  };
}
