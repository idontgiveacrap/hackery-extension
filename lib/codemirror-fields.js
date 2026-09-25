import { EditorState, Compartment } from "@codemirror/state";
import {
  EditorView,
  keymap,
  placeholder as placeholderExt,
  lineNumbers,
  drawSelection,
  highlightActiveLine,
  highlightSpecialChars,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  StreamLanguage,
  bracketMatching,
  foldGutter,
  indentOnInput,
  syntaxTree,
} from "@codemirror/language";
import {
  javascript,
  javascriptLanguage,
  completionPath,
  scopeCompletionSource,
} from "@codemirror/lang-javascript";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { simpleMode } from "./simple-mode.js";
import { linter, lintGutter, lintKeymap } from "@codemirror/lint";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  snippetCompletion,
} from "@codemirror/autocomplete";

const editors = new WeakMap();

/** Languages that lint by default when `options.lint` is not set. */
const LINTED_LANGUAGES = new Set(["javascript", "json", "regex", "url"]);

const regexHighlightMode = simpleMode({
  start: [
    { regex: /\\./, token: "escape" },
    { regex: /\(\?:|\(\?[=!<:]/, token: "meta" },
    { regex: /[[\](){}|]/, token: "bracket" },
    { regex: /[*+?]|\{\d+(?:,\d*)?\}/, token: "operator" },
    { regex: /[$^]/, token: "atom" },
    { regex: /./, token: "variable" },
  ],
  languageData: { name: "regexp" },
});

const regexLanguage = StreamLanguage.define(regexHighlightMode);

const languageCompartment = new Compartment();
const placeholderCompartment = new Compartment();
const lintCompartment = new Compartment();

/** Scope object for network request/response script property completions. */
const NETWORK_SCRIPT_SCOPE = {
  ctx: {
    phase: "",
    method: "",
    url: "",
    pageUrl: "",
    headers: {},
    body: "",
    status: 0,
    statusText: "",
    resourceType: "",
    sharedState: {},
    tabState: {},
    logDetail: "",
  },
  rule: {
    id: "",
    name: "",
    enabled: true,
    action: "",
    priority: 0,
  },
  decodeBasicAuth() {
    return [];
  },
};

const NETWORK_SCRIPT_SNIPPETS = [
  snippetCompletion(
    "function(ctx, rule) {\n\t${}\n\treturn ctx;\n}",
    {
      label: "function(ctx, rule) → ctx",
      detail: "network script",
      type: "snippet",
      boost: 10,
    }
  ),
  snippetCompletion(
    "function(ctx, rule) {\n\t${}\n\treturn null;\n}",
    {
      label: "function(ctx, rule) → null",
      detail: "block request",
      type: "snippet",
      boost: 9,
    }
  ),
  snippetCompletion(
    "function(ctx, rule, decodeBasicAuth) {\n\tvar creds = decodeBasicAuth(ctx);\n\t${}\n\treturn ctx;\n}",
    {
      label: "function(ctx, rule, decodeBasicAuth)",
      detail: "basic auth",
      type: "snippet",
      boost: 8,
    }
  ),
  snippetCompletion("ctx.logDetail = ${};", {
    label: "ctx.logDetail = …",
    detail: "recent matches",
    type: "snippet",
    boost: 7,
  }),
];

const networkScriptScopeSource = scopeCompletionSource(NETWORK_SCRIPT_SCOPE);

/**
 * Offer network-script snippet templates at identifier positions.
 * @param {import("@codemirror/autocomplete").CompletionContext} context Completion context.
 * @returns {import("@codemirror/autocomplete").CompletionResult | null}
 */
function networkScriptSnippetSource(context) {
  const path = completionPath(context);
  if (!path || path.path.length) {
    return null;
  }
  if (!path.name && !context.explicit) {
    return null;
  }
  return {
    from: context.pos - path.name.length,
    options: NETWORK_SCRIPT_SNIPPETS,
    validFor: /^[\w.]*$/,
  };
}

/**
 * Complete scriptlet param names as top-level identifiers.
 * @param {() => string[]} getParamNames Live param-name getter from the form.
 * @returns {import("@codemirror/autocomplete").CompletionSource}
 */
function scriptletParamCompletionSource(getParamNames) {
  return (context) => {
    const path = completionPath(context);
    if (!path || path.path.length) {
      return null;
    }
    const names = (getParamNames?.() || []).filter(Boolean);
    if (!names.length) {
      return null;
    }
    if (!path.name && !context.explicit) {
      return null;
    }
    return {
      from: context.pos - path.name.length,
      options: names.map((name) => ({
        label: name,
        type: "variable",
        detail: "param",
        boost: 20,
      })),
      validFor: /^\w*$/,
    };
  };
}

/**
 * Build autocomplete extensions for a JS editor mode.
 * @param {false | "javascript" | "network-script" | "scriptlet"} mode Completion mode.
 * @param {(() => string[]) | undefined} getParamNames Param names for scriptlet mode.
 * @returns {import("@codemirror/state").Extension[]}
 */
function autocompleteExtensions(mode, getParamNames) {
  if (!mode) {
    return [];
  }

  const extensions = [autocompletion()];

  if (mode === "network-script") {
    extensions.push(
      javascriptLanguage.data.of({ autocomplete: networkScriptScopeSource }),
      javascriptLanguage.data.of({ autocomplete: networkScriptSnippetSource })
    );
  } else if (mode === "scriptlet") {
    extensions.push(
      javascriptLanguage.data.of({
        autocomplete: scriptletParamCompletionSource(getParamNames),
      })
    );
  }

  return extensions;
}

/**
 * Return the language extension for a field language id.
 * @param {string} language Language id (`javascript`, `json`, `regex`, `url`, `plain`, `wildcard`).
 * @returns {import("@codemirror/state").Extension}
 */
function languageExtension(language) {
  if (language === "json") {
    return json();
  }
  if (language === "regex") {
    return regexLanguage;
  }
  if (language === "url" || language === "plain" || language === "wildcard") {
    return [];
  }
  return javascript();
}

/**
 * Lint a regex pattern field by compiling it with `RegExp`.
 * @param {EditorView} view Editor view to lint.
 * @returns {import("@codemirror/lint").Diagnostic[]}
 */
function regexLinter(view) {
  const text = view.state.doc.toString();
  if (!text) {
    return [];
  }
  try {
    // Pattern fields store the source only; flags are configured elsewhere.
    new RegExp(text);
    return [];
  } catch (error) {
    const message = String(error?.message || error).replace(
      /^Invalid regular expression[:\s]*/i,
      ""
    );
    return [
      {
        from: 0,
        to: text.length,
        severity: "error",
        message: message || "Invalid regular expression",
        source: "regex",
      },
    ];
  }
}

/**
 * Lint an absolute URL or instance-relative path field with the URL parser.
 * Template tokens (`{param}`) are stubbed before parsing so templates validate.
 * Relative paths resolve against a throwaway origin, matching runtime
 * resolution against the target tab/origin.
 * @param {EditorView} view Editor view to lint.
 * @returns {import("@codemirror/lint").Diagnostic[]}
 */
function urlLinter(view) {
  const text = view.state.doc.toString();
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const whole = { from: 0, to: text.length, source: "url" };

  if (/[\r\n]/.test(trimmed)) {
    return [
      {
        ...whole,
        severity: "error",
        message: "A URL must be a single line.",
      },
    ];
  }
  if (/\s/.test(trimmed)) {
    return [
      {
        ...whole,
        severity: "error",
        message: "URLs cannot contain spaces; encode them as %20.",
      },
    ];
  }

  const probe = trimmed.replace(/\{[^}]*\}/g, "token");
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(probe);

  try {
    // Relative paths resolve against the active tab or remembered origin at
    // runtime; any absolute base parses the same set of paths.
    new URL(probe, "https://url-lint.invalid/");
  } catch (error) {
    return [
      {
        ...whole,
        severity: "error",
        message: String(error?.message || error).replace(/^TypeError:\s*/, ""),
      },
    ];
  }

  if (scheme && !/^https?$/i.test(scheme[1])) {
    return [
      {
        ...whole,
        severity: "warning",
        message:
          scheme[1].toLowerCase() === "javascript"
            ? "Bookmarklet, not a URL — set Type to Scriptlet."
            : `Only http(s) links open reliably; "${scheme[1]}:" may not.`,
      },
    ];
  }

  return [];
}

/**
 * Lint JavaScript by reporting Lezer parse Error nodes.
 * @param {EditorView} view Editor view to lint.
 * @returns {import("@codemirror/lint").Diagnostic[]}
 */
function javascriptSyntaxLinter(view) {
  const text = view.state.doc.toString();
  if (!text.trim()) {
    return [];
  }

  const diagnostics = [];
  syntaxTree(view.state).iterate({
    enter(node) {
      if (!node.type.isError) {
        return;
      }
      const from = node.from;
      const to = Math.max(node.to, from + 1);
      diagnostics.push({
        from,
        to: Math.min(to, view.state.doc.length),
        severity: "error",
        message: "Syntax error",
        source: "javascript",
      });
    },
  });
  return diagnostics;
}

/**
 * Build lint extensions for the active language.
 * @param {string} language Language id.
 * @param {boolean} compact Whether this is a single-line compact field.
 * @param {boolean} enabled Whether linting is enabled for this editor.
 * @returns {import("@codemirror/state").Extension}
 */
function lintExtension(language, compact, enabled) {
  if (!enabled) {
    return [];
  }

  let source = null;
  if (language === "json") {
    source = jsonParseLinter();
  } else if (language === "regex") {
    source = regexLinter;
  } else if (language === "url") {
    source = urlLinter;
  } else if (language === "javascript") {
    source = javascriptSyntaxLinter;
  } else {
    return [];
  }

  const extensions = [linter(source, { delay: 400 })];
  if (!compact) {
    extensions.push(lintGutter());
  }
  return extensions;
}

/**
 * Theme the editor to match extension CSS variables.
 * @param {boolean} compact Compact single-line layout.
 * @returns {import("@codemirror/state").Extension}
 */
function editorTheme(compact) {
  return EditorView.theme(
    {
      "&": {
        backgroundColor: "var(--bg)",
        color: "var(--text)",
      },
      ".cm-content": {
        caretColor: "var(--text)",
        padding: compact ? "4px 8px" : "6px 8px",
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: "12px",
        lineHeight: "1.4",
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: "var(--text)",
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        {
          backgroundColor: "color-mix(in srgb, var(--accent) 35%, transparent)",
        },
      ".cm-activeLine": {
        backgroundColor: "color-mix(in srgb, var(--border) 35%, transparent)",
      },
      ".cm-gutters": {
        backgroundColor: "var(--panel)",
        color: "var(--muted)",
        border: "none",
      },
      ".cm-placeholder": {
        color: "var(--muted)",
      },
    },
    { dark: false }
  );
}

/**
 * Extra extensions for compact single-line fields.
 * @returns {import("@codemirror/state").Extension[]}
 */
function compactExtensions() {
  return [
    keymap.of([
      {
        key: "Enter",
        run: () => true,
      },
    ]),
    EditorView.theme({
      ".cm-scroller": {
        overflow: "auto",
      },
      ".cm-content, .cm-line": {
        minHeight: "1.4em",
      },
    }),
  ];
}

/**
 * Assemble the base extension set for a field editor.
 * @param {object} options Editor options.
 * @param {string} options.language Language id.
 * @param {boolean} options.compact Compact layout.
 * @param {number} [options.minHeight] Minimum scroller height in px.
 * @param {string} [options.placeholder] Placeholder text.
 * @param {boolean} options.lint Whether to enable language linting.
 * @param {false | "javascript" | "network-script" | "scriptlet"} options.completions Autocomplete mode.
 * @param {(() => string[]) | undefined} options.getParamNames Scriptlet param-name getter.
 * @returns {import("@codemirror/state").Extension[]}
 */
function createExtensions({
  language,
  compact,
  minHeight,
  placeholder,
  lint,
  completions,
  getParamNames,
}) {
  // autocompletion() installs its own completion keymap, and applying a snippet
  // appends the snippet-field keymap, so neither is listed here.
  const keyBindings = [
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...historyKeymap,
    indentWithTab,
    ...lintKeymap,
  ];
  if (!compact) {
    keyBindings.push(...searchKeymap);
  }

  const extensions = [
    highlightSpecialChars(),
    history(),
    drawSelection(),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    bracketMatching(),
    closeBrackets(),
    editorTheme(compact),
    languageCompartment.of(languageExtension(language)),
    lintCompartment.of(lintExtension(language, compact, lint)),
    ...autocompleteExtensions(completions, getParamNames),
    keymap.of(keyBindings),
    EditorView.updateListener.of((update) => {
      const element = update.view.dom.closest(".cm-field")?.previousElementSibling;
      if (!update.docChanged || !element) {
        return;
      }
      element.value = update.state.doc.toString();
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }),
  ];

  if (!compact) {
    extensions.push(
      lineNumbers(),
      highlightActiveLine(),
      foldGutter(),
      highlightSelectionMatches()
    );
  } else {
    extensions.push(...compactExtensions());
  }

  if (minHeight) {
    extensions.push(
      EditorView.theme({
        ".cm-scroller": {
          minHeight: `${minHeight}px`,
        },
      })
    );
  }

  if (placeholder) {
    extensions.push(placeholderCompartment.of(placeholderExt(placeholder)));
  } else {
    extensions.push(placeholderCompartment.of([]));
  }

  return extensions;
}

/**
 * Replace a textarea/input with a CodeMirror editor synced back to the element.
 * @param {HTMLTextAreaElement | HTMLInputElement | null} element Host form control.
 * @param {object} [options] Editor options.
 * @param {string} [options.language="javascript"] Language id.
 * @param {boolean} [options.compact=false] Single-line compact layout.
 * @param {number} [options.minHeight] Minimum scroller height in px.
 * @param {string} [options.placeholder] Placeholder text.
 * @param {boolean} [options.lint] Override lint enablement (default: on for json/regex/url/javascript).
 * @param {false | "javascript" | "network-script" | "scriptlet"} [options.completions] Autocomplete mode (default: `"javascript"` for JS fields).
 * @param {() => string[]} [options.getParamNames] Live scriptlet param names for `"scriptlet"` completions.
 * @returns {object | null} Editor API, or null when element is missing.
 */
export function attachCodeMirror(element, options = {}) {
  if (!element) {
    return null;
  }

  const existing = editors.get(element);
  if (existing) {
    return existing;
  }

  const {
    language = "javascript",
    compact = false,
    minHeight,
    placeholder,
    getParamNames,
  } = options;
  const lintEnabled = options.lint ?? LINTED_LANGUAGES.has(language);
  const completions =
    options.completions ?? (language === "javascript" ? "javascript" : false);

  element.style.display = "none";
  element.setAttribute("aria-hidden", "true");
  element.tabIndex = -1;

  const wrapper = document.createElement("div");
  wrapper.className = `cm-field${compact ? " cm-field-compact" : ""}`;
  element.insertAdjacentElement("afterend", wrapper);

  const view = new EditorView({
    state: EditorState.create({
      doc: element.value,
      extensions: createExtensions({
        language,
        compact,
        minHeight,
        placeholder,
        lint: lintEnabled,
        completions,
        getParamNames,
      }),
    }),
    parent: wrapper,
  });

  const api = {
    view,
    getValue() {
      return view.state.doc.toString();
    },
    setValue(value) {
      const next = value ?? "";
      const current = view.state.doc.toString();
      if (current === next) {
        return;
      }
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: next },
      });
      element.value = next;
    },
    setLanguage(nextLanguage) {
      const nextLint = options.lint ?? LINTED_LANGUAGES.has(nextLanguage);
      view.dispatch({
        effects: [
          languageCompartment.reconfigure(languageExtension(nextLanguage)),
          lintCompartment.reconfigure(
            lintExtension(nextLanguage, compact, nextLint)
          ),
        ],
      });
    },
    setPlaceholder(nextPlaceholder) {
      view.dispatch({
        effects: placeholderCompartment.reconfigure(
          nextPlaceholder ? placeholderExt(nextPlaceholder) : []
        ),
      });
    },
    focus() {
      view.focus();
    },
    destroy() {
      view.destroy();
      wrapper.remove();
      element.style.display = "";
      element.removeAttribute("aria-hidden");
      element.tabIndex = 0;
      editors.delete(element);
    },
  };

  editors.set(element, api);
  return api;
}

/**
 * Read the current value from a CodeMirror-backed field or raw control.
 * @param {HTMLTextAreaElement | HTMLInputElement | null} element Host form control.
 * @returns {string}
 */
export function getFieldValue(element) {
  if (!element) {
    return "";
  }
  return editors.get(element)?.getValue() ?? element.value ?? "";
}

/**
 * Write a value into a CodeMirror-backed field or raw control.
 * @param {HTMLTextAreaElement | HTMLInputElement | null} element Host form control.
 * @param {string} value Next document text.
 * @returns {void}
 */
export function setFieldValue(element, value) {
  if (!element) {
    return;
  }
  const editor = editors.get(element);
  const next = value ?? "";
  if (editor) {
    editor.setValue(next);
    return;
  }
  element.value = next;
}

/**
 * Switch language (and matching lint) on an attached editor.
 * @param {HTMLTextAreaElement | HTMLInputElement | null} element Host form control.
 * @param {string} language Language id.
 * @returns {void}
 */
export function setFieldLanguage(element, language) {
  if (!element) {
    return;
  }
  editors.get(element)?.setLanguage(language);
}

/**
 * Update placeholder text on an attached editor and its host control.
 * @param {HTMLTextAreaElement | HTMLInputElement | null} element Host form control.
 * @param {string} placeholder Placeholder text.
 * @returns {void}
 */
export function setFieldPlaceholder(element, placeholder) {
  if (!element) {
    return;
  }
  element.placeholder = placeholder || "";
  editors.get(element)?.setPlaceholder(placeholder || "");
}

/**
 * Focus a CodeMirror-backed field or raw control.
 * @param {HTMLTextAreaElement | HTMLInputElement | null} element Host form control.
 * @returns {void}
 */
export function focusField(element) {
  if (!element) {
    return;
  }
  const editor = editors.get(element);
  if (editor) {
    editor.focus();
    return;
  }
  element.focus();
}

/**
 * Attach CodeMirror to multiple named fields.
 * @param {Record<string, object>} entries Map of key → `{ element, ...options }`.
 * @returns {Record<string, object>} Map of key → editor API for attached fields.
 */
export function attachCodeMirrorAll(entries) {
  const attached = {};
  for (const [key, config] of Object.entries(entries)) {
    const { element, ...options } = config;
    if (!element) {
      continue;
    }
    attached[key] = attachCodeMirror(element, options);
  }
  return attached;
}
