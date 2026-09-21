/**
 * Multi-select combobox for regex flags, paired with a "regex" checkbox.
 *
 * Used by every regex-capable field in the rules editor (filter patterns and
 * find/replace rows) so the flag surface is identical everywhere. The control
 * hides itself while its field is in wildcard mode rather than disabling, so a
 * wildcard field shows no regex affordance at all.
 */
import {
  normalizeRegexFlags,
  REGEX_REPLACEMENT_FLAGS,
} from "../engine/network-rules-shared.js";

/** Flag → menu label. Order follows `REGEX_REPLACEMENT_FLAGS`. */
const FLAG_LABELS = {
  g: "global — replace every match",
  i: "ignore case",
  m: "multiline — ^ and $ match line breaks",
  s: "dotall — . matches newlines",
  u: "unicode",
};

/** `g` decides how many matches are replaced, which a filter test never uses. */
const FILTER_FLAG_LABELS = { ...FLAG_LABELS, g: "global — no effect on filters" };

let openMenu = null;

document.addEventListener("click", (event) => {
  if (openMenu && !openMenu.root.contains(event.target)) {
    openMenu.close();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && openMenu) {
    openMenu.close();
    openMenu.toggle.focus();
  }
});

/**
 * Build a regex-flags combobox.
 * @param {object} [options]
 * @param {string} [options.value] Initial flags.
 * @param {string} [options.fallback] Flags used when the selection is cleared.
 * @param {boolean} [options.visible] Whether the control starts shown.
 * @param {boolean} [options.filter] Use filter-field wording for `g`.
 * @param {(flags: string) => void} [options.onChange] Called after each edit.
 * @returns {{ root: HTMLElement, getValue: () => string,
 *   setValue: (flags: string) => void, setVisible: (visible: boolean) => void }}
 */
export function createRegexFlagsSelect(options = {}) {
  const {
    value,
    fallback,
    visible = true,
    filter = false,
    onChange = () => {},
  } = options;
  const labels = filter ? FILTER_FLAG_LABELS : FLAG_LABELS;

  const root = document.createElement("div");
  root.className = "regex-flags";
  root.hidden = !visible;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "regex-flags-toggle";
  toggle.setAttribute("aria-haspopup", "true");
  toggle.setAttribute("aria-expanded", "false");
  toggle.title = "Regex flags";

  const menu = document.createElement("div");
  menu.className = "regex-flags-menu";
  menu.hidden = true;

  const boxes = new Map();
  for (const flag of REGEX_REPLACEMENT_FLAGS) {
    const label = document.createElement("label");
    label.className = "inline-check";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = flag;
    const text = document.createElement("span");
    text.textContent = `${flag} — ${labels[flag]}`;
    label.appendChild(box);
    label.appendChild(text);
    menu.appendChild(label);
    boxes.set(flag, box);
  }

  const current = () =>
    REGEX_REPLACEMENT_FLAGS.filter((flag) => boxes.get(flag).checked).join("");

  function setValue(flags) {
    const normalized = normalizeRegexFlags(flags, fallback);
    for (const [flag, box] of boxes) {
      box.checked = normalized.includes(flag);
    }
    toggle.textContent = normalized || "none";
  }

  function close() {
    menu.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    if (openMenu?.root === root) {
      openMenu = null;
    }
  }

  toggle.addEventListener("click", () => {
    const willOpen = menu.hidden;
    if (openMenu && openMenu.root !== root) {
      openMenu.close();
    }
    menu.hidden = !willOpen;
    toggle.setAttribute("aria-expanded", String(willOpen));
    openMenu = willOpen ? { root, close, toggle } : null;
  });

  menu.addEventListener("change", () => {
    // Clearing every box falls back rather than compiling a flagless regex the
    // user did not ask for; the button text shows what actually applies.
    const picked = current();
    setValue(picked);
    onChange(normalizeRegexFlags(picked, fallback));
  });

  setValue(value);
  root.appendChild(toggle);
  root.appendChild(menu);

  return {
    root,
    getValue: () => normalizeRegexFlags(current(), fallback),
    setValue,
    setVisible(nextVisible) {
      root.hidden = !nextVisible;
      if (!nextVisible) {
        close();
      }
    },
  };
}
