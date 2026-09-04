/**
 * Parameter prompt window for activations that cannot collect values inline
 * (Alt+N shortcuts, omnibox entries missing a required value).
 *
 * The request arrives in session storage rather than the URL so partially
 * supplied values can prefill. Activation itself is delegated to the
 * background: `windowId` names the browser window that was focused before this
 * popup opened, which is what tab targeting must resolve against.
 */
import { loadParamValues } from "../lib/activate-link.js";
import { getCatalogSnapshot } from "../lib/catalog-service.js";
import { getEditableValueDefs, linkStorageKey } from "../lib/link-model.js";
import { MessageTypes } from "../lib/message-types.js";
import { StorageKeys } from "../lib/storage-keys.js";
import { createUiMessage } from "../lib/ui-message.js";

const { PARAM_PROMPT_KEY } = StorageKeys;

const form = document.getElementById("params-form");
const nameEl = document.getElementById("action-name");
const contextEl = document.getElementById("action-context");
const fieldsEl = document.getElementById("fields");
const runBtn = document.getElementById("run-btn");
const cancelBtn = document.getElementById("cancel-btn");
const { showMessage, hideMessage } = createUiMessage(
  document.getElementById("message")
);

let request = null;
let parameterDefs = [];

/**
 * @param {object} def editable value def (params or navParams)
 * @param {string} value prefilled value
 * @returns {HTMLElement} labelled input, with a datalist when the def has choices
 */
function createField(def, value) {
  const wrap = document.createElement("label");
  wrap.className = "field";

  const label = document.createElement("span");
  label.className = "field-label";
  label.textContent = def.label || def.name;
  if (def.optional) {
    const optional = document.createElement("span");
    optional.className = "field-optional";
    optional.textContent = " (optional)";
    label.appendChild(optional);
  }

  const input = document.createElement("input");
  input.type = "text";
  input.dataset.param = def.name;
  input.value = value;
  input.placeholder =
    def.placeholder !== undefined && def.placeholder !== ""
      ? def.placeholder
      : def.name;
  input.autocomplete = "off";

  wrap.append(label, input);

  if (def.choices?.length) {
    const listId = `choices-${def.name}`;
    const datalist = document.createElement("datalist");
    datalist.id = listId;
    for (const choice of def.choices) {
      const option = document.createElement("option");
      option.value = choice;
      datalist.appendChild(option);
    }
    input.setAttribute("list", listId);
    wrap.appendChild(datalist);
  }

  return wrap;
}

function readValues() {
  const values = {};
  for (const def of parameterDefs) {
    const input = fieldsEl.querySelector(
      `[data-param="${CSS.escape(def.name)}"]`
    );
    values[def.name] = input ? input.value.trim() : "";
  }
  return values;
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!request?.stableKey) {
    return;
  }

  hideMessage();
  runBtn.disabled = true;
  void browser.runtime
    .sendMessage({
      type: MessageTypes.ACTIVATE_LINK_WITH_PARAMS,
      stableKey: request.stableKey,
      windowId: request.windowId ?? null,
      rawValues: readValues(),
    })
    .then((response) => {
      if (response?.ok) {
        window.close();
        return;
      }
      runBtn.disabled = false;
      showMessage(
        response?.message || response?.error || "Could not run this action."
      );
    })
    .catch((error) => {
      runBtn.disabled = false;
      showMessage(error.message || String(error));
    });
});

cancelBtn.addEventListener("click", () => {
  window.close();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    window.close();
  }
});

async function init() {
  const stored = await browser.storage.session.get(PARAM_PROMPT_KEY);
  request = stored[PARAM_PROMPT_KEY] || null;
  if (!request?.stableKey) {
    runBtn.disabled = true;
    showMessage("No action to run.");
    return;
  }

  const snapshot = await getCatalogSnapshot();
  const leaf = snapshot.flatLeaves.find(
    (entry) => entry.stableKey === request.stableKey
  );
  if (!leaf) {
    runBtn.disabled = true;
    showMessage("This action is no longer in the catalog.");
    return;
  }

  const node = leaf.node;
  parameterDefs = getEditableValueDefs(node);
  nameEl.textContent = node.name;
  contextEl.textContent = [leaf.sectionName, ...(leaf.pathParts || [])]
    .filter(Boolean)
    .join(" › ");
  document.title = `${node.name} — parameters`;

  const savedValues =
    (await loadParamValues())[linkStorageKey(node)] || {};
  const prefill = request.rawValues || {};
  for (const def of parameterDefs) {
    const value = prefill[def.name] ?? savedValues[def.name] ?? def.default;
    fieldsEl.appendChild(createField(def, value ?? ""));
  }

  const firstInput = fieldsEl.querySelector("input");
  firstInput?.focus();
  firstInput?.select();
}

init().catch((error) => {
  runBtn.disabled = true;
  showMessage(error.message || String(error));
});
