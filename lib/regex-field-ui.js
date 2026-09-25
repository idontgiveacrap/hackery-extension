/**
 * A UI component that groups a CodeMirror editor with a mode toggle (plain/regex)
 * and a regex flag selector.
 */
import { attachCodeMirror, setFieldLanguage, setFieldPlaceholder } from "./codemirror-fields.bundle.js";
import { createRegexFlagsSelect } from "./regex-flags-select.js";

/**
 * @param {object} options
 * @param {HTMLElement} options.container The element to append the group to.
 * @param {object} options.editorConfig CodeMirror configuration.
 * @param {string} options.placeholder Placeholder for plain mode.
 * @param {string} options.regexPlaceholder Placeholder for regex mode.
 * @param {boolean} [options.isMultiline=false] Whether the editor is multiline.
 * @param {boolean} [options.compact=false] Whether to use a single-line compact layout.
 * @param {string} [options.initialMode="plain"] "plain" or "regex".
 * @param {string} [options.initialFlags=""] Initial flags if in regex mode.
 * @param {(mode: string, pattern: string, flags: string) => void} options.onChange Callback on change.
 * @returns {{ getValue: () => { mode: string, pattern: string, flags: string }, setValue: (mode: string, pattern: string, flags: string) => void, destroy: () => void }}
 */
export function createRegexFieldGroup({
  container,
  editorConfig,
  placeholder,
  regexPlaceholder,
  isMultiline = false,
  compact = false,
  initialMode = "plain",
  initialFlags = "",
  onChange,
}) {
  const root = document.createElement("div");
  root.className = "regex-field-group" + (compact ? " regex-field-group-compact" : "");

  // 1. Create the mode toggle (checkbox)
  const modeToggleLabel = document.createElement("label");
  modeToggleLabel.className = "inline-check";
  const modeToggle = document.createElement("input");
  modeToggle.type = "checkbox";
  modeToggle.title = "Use regex mode";
  const modeText = document.createElement("span");
  modeText.textContent = "regex";
  modeToggleLabel.appendChild(modeToggle);
  modeToggleLabel.appendChild(modeText);
  root.appendChild(modeToggleLabel);

  // 2. Create the flag selector
  const flagsSelect = createRegexFlagsSelect({
    value: initialFlags,
    visible: false,
    onChange: (flags) => {
      if (modeToggle.checked) {
        onChange("regex", getEditorValue(), flags);
      }
    },
  });
  root.appendChild(flagsSelect.root);

  // 3. Create the editor element
  const input = document.createElement(isMultiline ? "textarea" : "input");
  if (!isMultiline) {
    input.type = "text";
  }
  input.className = "regex-field-input";
  root.appendChild(input);

  // 4. Attach CodeMirror
  const editor = attachCodeMirror(input, {
    ...editorConfig,
    language: initialMode === "regex" ? "regex" : "plain",
    compact: compact && !isMultiline,
  });

  function getEditorValue() {
    return input.value.trim();
  }

  function setEditorValue(val) {
    input.value = val;
  }

  // 5. Handle mode changes
  modeToggle.addEventListener("change", () => {
    const isRegex = modeToggle.checked;
    flagsSelect.setVisible(isRegex);
    setFieldLanguage(input, isRegex ? "regex" : "plain");
    setFieldPlaceholder(input, isRegex ? regexPlaceholder : placeholder);
    
    if (onChange) {
      onChange(isRegex ? "regex" : "plain", getEditorValue(), flagsSelect.getValue());
    }
  });

  // 6. Handle input changes
  input.addEventListener("input", () => {
    if (onChange) {
      const mode = modeToggle.checked ? "regex" : "plain";
      onChange(mode, getEditorValue(), flagsSelect.getValue());
    }
  });

  // 7. Handle flag changes
  flagsSelect.root.addEventListener("change", () => {
    if (onChange && modeToggle.checked) {
      onChange("regex", getEditorValue(), flagsSelect.getValue());
    }
  });

  // Initialize state
  modeToggle.checked = initialMode === "regex";
  flagsSelect.setVisible(modeToggle.checked);
  setFieldLanguage(input, initialMode === "regex" ? "regex" : "plain");
  setFieldPlaceholder(input, initialMode === "regex" ? regexPlaceholder : placeholder);

  container.appendChild(root);

  return {
    getValue: () => ({
      mode: modeToggle.checked ? "regex" : "plain",
      pattern: getEditorValue(),
      flags: flagsSelect.getValue(),
    }),
    setValue: (mode, pattern, flags) => {
      const isRegex = mode === "regex";
      modeToggle.checked = isRegex;
      flagsSelect.setVisible(isRegex);
      setFieldLanguage(input, isRegex ? "regex" : "plain");
      setFieldPlaceholder(input, isRegex ? regexPlaceholder : placeholder);
      setEditorValue(pattern);
      flagsSelect.setValue(flags);
    },
    destroy: () => {
      editor.destroy();
      root.remove();
    },
  };
}
