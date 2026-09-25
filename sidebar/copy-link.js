import {
  readParamValuesFromRow,
  saveParamValue,
  validateParamValues,
} from "../lib/activate-link.js";
import { reportActivity } from "../lib/link-inspect.js";
import { matchBehavior } from "../lib/link-behaviors.js";
import {
  getEditableValueDefs,
  getRuntimeValueDefs,
  linkStorageKey,
  resolveParamValues,
  seedNavParamValues,
} from "../lib/link-model.js";
import {
  coerceScriptletNavigationUrl,
  resolveUrlActionTraced,
} from "../lib/navigation-shared.js";
import {
  compileScriptletSource,
  executeScriptletWithBindings,
} from "../lib/scriptlet-inject.js";
import { getTargetTab } from "../lib/tab-target.js";

async function resolveCopyText(node, row) {
  const behavior = matchBehavior(node);
  if (!behavior) {
    throw new Error(`No behavior matched for "${node.name}".`);
  }

  const isUrlAction = behavior.id === "open-url";
  const runtimeDefs = getRuntimeValueDefs(node);
  const editableDefs = getEditableValueDefs(node);
  const rawValues =
    row && editableDefs.length > 0
      ? readParamValuesFromRow(row, editableDefs)
      : {};

  const paramValues = isUrlAction
    ? seedNavParamValues(runtimeDefs, rawValues)
    : resolveParamValues(runtimeDefs, rawValues);

  const validationError = validateParamValues(
    runtimeDefs,
    {
      ...Object.fromEntries(
        runtimeDefs.map((def) => [def.name, paramValues[def.name] ?? ""])
      ),
      ...rawValues,
    },
    { isUrlAction }
  );
  if (validationError) {
    throw new Error(validationError);
  }

  const linkKey = linkStorageKey(node);
  for (const def of editableDefs) {
    await saveParamValue(linkKey, def.name, rawValues[def.name] ?? "");
  }

  if (behavior.id === "open-from-script") {
    const matchPattern = node.match ?? null;
    const { tab, origin } = await getTargetTab(matchPattern, {
      excludePattern: node.exclude ?? null,
    });
    // Nav scripts read page globals and the page DOM, so only the page can
    // produce the URL. Same injection path as activation, so copying succeeds
    // exactly when Run does.
    const outcome = await executeScriptletWithBindings(tab.id, node.code, paramValues, {
      frames: node.frames,
      sandbox: node.sandbox,
    });
    const urls = [];
    for (const item of outcome.successes) {
      const url = coerceScriptletNavigationUrl(item.value, tab, origin);
      if (url) {
        urls.push(url);
      }
    }
    if (!urls.length) {
      throw new Error("Navigation script did not resolve to a URL.");
    }
    const copied = urls.join("\n");
    return {
      text: copied,
      someFailed: outcome.someFailed,
      behaviorId: behavior.id,
      paramValues,
    };
  }

  if (behavior.id === "run") {
    return {
      text: compileScriptletSource(node.code || "", paramValues),
      behaviorId: behavior.id,
      paramValues,
    };
  }

  const matchPattern = node.match ?? null;
  const { tab, origin } = await getTargetTab(matchPattern, {
    excludePattern: node.exclude ?? null,
  });
  const traced = await resolveUrlActionTraced(node, tab, origin, paramValues);

  if (traced.url === null) {
    throw new Error("Could not derive URL from the current tab.");
  }

  return {
    text: traced.url,
    behaviorId: behavior.id,
    paramValues,
    derivation: traced,
  };
}

function writeClipboardText(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (!document.execCommand("copy")) {
      throw new Error("Clipboard copy failed.");
    }
  } finally {
    textarea.remove();
  }
}

function writeClipboardTextFromPromise(textPromise) {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    return navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": textPromise.then(
          (text) => new Blob([text], { type: "text/plain" })
        ),
      }),
    ]);
  }
  return textPromise.then((text) => writeClipboardText(text));
}

export function createCopyLink({ showMessage, hideMessage }) {
  return function copyLink(node, row = null) {
    hideMessage();

    resolveCopyText(node, row)
      .then((result) => {
        const { text, behaviorId, paramValues, derivation } = result;
        const someFailed = Boolean(result.someFailed);
        return writeClipboardTextFromPromise(Promise.resolve(text)).then(() => {
          void reportActivity({
            trigger: "copy-link",
            name: node.name,
            linkKey: linkStorageKey(node),
            behaviorId,
            outcome: someFailed ? "ran-partial" : "ran",
            copied: String(text || "").slice(0, 500),
            paramValues,
            derivation: derivation || null,
          });
          if (someFailed) {
            showMessage("failed in some frames");
            return;
          }
          showMessage("Copied to clipboard.");
        });
      })
      .catch((error) => showMessage(error.message || String(error)));
  };
}
