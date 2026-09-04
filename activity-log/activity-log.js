import { MessageTypes } from "../lib/message-types.js";

const logEl = document.getElementById("activity-log");
const searchEl = document.getElementById("log-search");
const clearBtn = document.getElementById("clear-log-btn");

let entries = [];
let query = "";

/**
 * Parameter bindings for one entry as `name=value (source)`.
 * Derived values supersede the seeded ones: `derivation.values` is the set the
 * URL was actually built from, and `sources` says which channel filled each key
 * (manual / fromUrl / fromSelector / default / empty).
 * @param {object} entry
 * @returns {string} empty when the link takes no parameters
 */
function formatParams(entry) {
  const seeded = entry.paramValues || {};
  const sources = entry.derivation?.sources || {};
  const values = { ...seeded, ...(entry.derivation?.values || {}) };

  return Object.entries(values)
    .filter(([name]) => {
      // resolveDerivedUrlTraced injects `origin` for templates; the summary line
      // already shows the target origin. Keep it only if the link declared it.
      return name !== "origin" || Object.hasOwn(seeded, "origin");
    })
    .map(([name, value]) => {
      const empty = value === "" || value == null;
      const source = sources[name];
      if (empty) {
        return `${name}=(empty)`;
      }
      return source ? `${name}=${value} (${source})` : `${name}=${value}`;
    })
    .join(", ");
}

function entrySearchText(entry) {
  return [
    entry.name,
    entry.trigger,
    entry.outcome,
    entry.reason,
    entry.tabUrl,
    entry.pageUrl,
    entry.navigatedTo,
    entry.linkKey,
    entry.behaviorId,
    formatParams(entry),
  ]
    .flat()
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function formatEntry(entry) {
  const time = new Date(entry.ts || Date.now()).toLocaleTimeString();
  const dest = Array.isArray(entry.navigatedTo)
    ? entry.navigatedTo.join(" ")
    : entry.navigatedTo || "";
  return `[${time}] ${entry.trigger || "?"} · ${entry.outcome || "?"} · ${
    entry.name || entry.linkKey || "link"
  } · ${entry.tabUrl || entry.pageUrl || ""}${dest ? ` → ${dest}` : ""}${
    entry.reason ? ` · ${entry.reason}` : ""
  }`;
}

function renderLog() {
  logEl.replaceChildren();
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? entries.filter((entry) => entrySearchText(entry).includes(needle))
    : entries;

  if (!visible.length) {
    const empty = document.createElement("p");
    empty.className = "log-empty";
    empty.textContent = entries.length
      ? "No matches for this search."
      : "No link activity yet.";
    logEl.appendChild(empty);
    return;
  }

  for (const entry of [...visible].reverse()) {
    const line = document.createElement("div");
    line.className = "log-entry";
    if (entry.outcome === "skipped") {
      line.classList.add("log-entry-skipped");
    }
    if (entry.outcome === "failed") {
      line.classList.add("log-entry-failed");
    }
    const summary = document.createElement("div");
    summary.textContent = formatEntry(entry);
    line.appendChild(summary);

    const params = formatParams(entry);
    if (params) {
      const paramsEl = document.createElement("div");
      paramsEl.className = "log-entry-params";
      paramsEl.textContent = `params: ${params}`;
      line.appendChild(paramsEl);
    }

    logEl.appendChild(line);
  }
}

async function loadLog() {
  try {
    const response = await browser.runtime.sendMessage({
      type: MessageTypes.GET_ACTIVITY_LOG,
    });
    entries = response?.entries || [];
  } catch {
    entries = [];
  }
  renderLog();
}

searchEl.addEventListener("input", () => {
  query = searchEl.value;
  renderLog();
});

clearBtn.addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: MessageTypes.CLEAR_ACTIVITY_LOG });
  entries = [];
  renderLog();
});

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === MessageTypes.ACTIVITY_LOG_CHANGED) {
    void loadLog();
  }
});

void loadLog();
