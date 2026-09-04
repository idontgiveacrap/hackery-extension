import { matchBehavior, supportsOnLoad } from "./link-behaviors.js";
import { resolveExclude, resolveMatch, walkCatalogNodes } from "./catalog-walk.js";

export { resolveExclude, resolveMatch };

/** Names that must stay as JS identifiers, not `{name}` / `$name` rewrite tokens. */
const RESERVED_PARAM_NAMES = new Set(["arguments"]);

export const SANDBOX_MAIN = "main";
export const SANDBOX_ISOLATED = "isolated";
export const SANDBOX_READONLY_DOM = "readonly-dom";
export const SANDBOX_VALUES = new Set([
  SANDBOX_MAIN,
  SANDBOX_ISOLATED,
  SANDBOX_READONLY_DOM,
]);

/**
 * Canonical sandbox. Omitted / main means MAIN-world inject.
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function normalizeSandbox(value) {
  if (value == null || value === "") {
    return undefined;
  }
  const sandbox = String(value);
  if (!SANDBOX_VALUES.has(sandbox)) {
    throw new Error(
      `sandbox must be ${SANDBOX_MAIN}, ${SANDBOX_ISOLATED}, or ${SANDBOX_READONLY_DOM}.`
    );
  }
  if (sandbox === SANDBOX_MAIN) {
    return undefined;
  }
  return sandbox;
}

export const RUN_AT_START = "document_start";
export const RUN_AT_END = "document_end";
export const RUN_AT_IDLE = "document_idle";
export const RUN_AT_VALUES = new Set([RUN_AT_START, RUN_AT_END, RUN_AT_IDLE]);

/**
 * Canonical on-load timing. Omitted / start means document_start.
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function normalizeRunAt(value) {
  if (value == null || value === "") {
    return undefined;
  }
  const runAt = String(value);
  if (!RUN_AT_VALUES.has(runAt)) {
    throw new Error(
      `runAt must be ${RUN_AT_START}, ${RUN_AT_END}, or ${RUN_AT_IDLE}.`
    );
  }
  if (runAt === RUN_AT_START) {
    return undefined;
  }
  return runAt;
}

/**
 * Effective on-load runAt (default start).
 * @param {object} node
 */
export function resolveRunAt(node) {
  return node?.runAt === RUN_AT_END || node?.runAt === RUN_AT_IDLE
    ? node.runAt
    : RUN_AT_START;
}

const FRAMES_KEYS = new Set(["top", "nestingLevel", "match"]);

/**
 * Canonicalize a leaf `frames` object. Empty `{}` is kept so runtime can treat
 * it as top-only without looking like an absent field (on-load default).
 * @param {unknown} frames
 */
export function normalizeFrames(frames) {
  if (frames == null) {
    throw new Error("frames must be an object.");
  }
  if (typeof frames !== "object" || Array.isArray(frames)) {
    throw new Error("frames must be an object.");
  }

  for (const key of Object.keys(frames)) {
    if (!FRAMES_KEYS.has(key)) {
      throw new Error(`Unknown frames key: ${key}`);
    }
  }

  const out = {};

  if (Object.prototype.hasOwnProperty.call(frames, "top")) {
    out.top = Boolean(frames.top);
  }

  if (Object.prototype.hasOwnProperty.call(frames, "nestingLevel")) {
    const nestingLevel = frames.nestingLevel;
    if (typeof nestingLevel !== "number" || !Number.isInteger(nestingLevel) || nestingLevel < -1) {
      throw new Error("frames.nestingLevel must be an integer >= -1.");
    }
    if (nestingLevel !== 0) {
      out.nestingLevel = nestingLevel;
    }
  }

  if (Object.prototype.hasOwnProperty.call(frames, "match")) {
    const match = frames.match;
    if (!Array.isArray(match)) {
      throw new Error("frames.match must be an array of strings.");
    }
    const patterns = [];
    for (const pattern of match) {
      if (typeof pattern !== "string") {
        throw new Error("frames.match entries must be strings.");
      }
      try {
        void new RegExp(pattern, "i");
      } catch {
        throw new Error(`Invalid frames.match regex: ${pattern}`);
      }
      patterns.push(pattern);
    }
    if (patterns.length) {
      out.match = patterns;
    }
  }

  return out;
}

export function normalizeOpenValue(value) {
  if (!value) {
    return undefined;
  }
  return value;
}

export function getLinkTemplate(node) {
  if (node.url) {
    return node.url;
  }
  if (node.code) {
    return node.code;
  }
  return "";
}

export function linkStorageKey(node) {
  if (node.id) {
    return node.id;
  }
  const sectionPrefix = node.sectionName ? `${node.sectionName}:` : "";
  const behaviorId = matchBehavior(node)?.id ?? "action";
  return `${sectionPrefix}${behaviorId}:${node.name}:${getLinkTemplate(node)}`;
}

/**
 * Script/function bindings (`params`).
 */
export function getParamsObject(node) {
  if (node.params && typeof node.params === "object") {
    return node.params;
  }
  return null;
}

export function getParameterConfig(node, paramName) {
  const params = getParamsObject(node);
  return params?.[paramName] ?? null;
}

/**
 * URL/URI substitution values (`navParams`).
 */
export function getNavParamsObject(node) {
  if (node.navParams && typeof node.navParams === "object" && !Array.isArray(node.navParams)) {
    return node.navParams;
  }
  return null;
}

export function getNavParamConfig(node, paramName) {
  const navParams = getNavParamsObject(node);
  return navParams?.[paramName] ?? null;
}

export function normalizeStringSource(source) {
  const key = String(source || "textContent")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase();
  if (key === "innerhtml" || key === "inner_html") {
    return "innerHTML";
  }
  if (key === "textcontent" || key === "text_content" || key === "text") {
    return "textContent";
  }
  if (key === "id") {
    return "id";
  }
  if (key === "attribute" || key === "otherattribute" || key === "other_attribute") {
    return "attribute";
  }
  throw new Error(`Unknown navParam stringSource: ${source}`);
}

/**
 * Normalize one navParam into a runtime derivation entry (or null if manual-only).
 */
export function normalizeNavParamDerivation(paramName, spec) {
  if (!spec || typeof spec !== "object") {
    throw new Error(`Invalid navParam spec for ${paramName}.`);
  }

  const fromUrl = spec.fromUrl || null;
  const fromSelector = spec.fromSelector || null;
  if (fromUrl && fromSelector) {
    throw new Error(
      `navParam "${paramName}" cannot have both fromUrl and fromSelector.`
    );
  }

  if (fromSelector) {
    const stringSource = normalizeStringSource(spec.stringSource);
    if (stringSource === "attribute" && !spec.attribute) {
      throw new Error(
        `navParam "${paramName}" requires attribute when stringSource is attribute.`
      );
    }
    return {
      paramName,
      kind: "dom",
      selector: fromSelector,
      stringSource,
      attribute: spec.attribute || null,
    };
  }

  if (fromUrl) {
    return { paramName, kind: "url", pattern: fromUrl };
  }

  return null;
}

export function normalizeNavParamDerivations(navParams) {
  if (!navParams) {
    return [];
  }
  if (typeof navParams !== "object" || Array.isArray(navParams)) {
    throw new Error("navParams must be an object mapping names to specs.");
  }
  return Object.entries(navParams)
    .map(([paramName, spec]) => normalizeNavParamDerivation(paramName, spec))
    .filter(Boolean);
}

function defFromConfig(paramName, config = {}) {
  return {
    name: paramName,
    label: config.label || paramName,
    placeholder: Object.prototype.hasOwnProperty.call(config, "placeholder")
      ? config.placeholder
      : undefined,
    showInput: Object.prototype.hasOwnProperty.call(config, "placeholder"),
    default: config.default ?? "",
    optional: Boolean(config.optional),
    choices: Array.isArray(config.choices) ? config.choices : null,
    source: config.source || null,
    fromUrl: config.fromUrl || null,
    fromSelector: config.fromSelector || null,
  };
}

export function getParameterDefNames(node) {
  const params = getParamsObject(node);
  return params ? Object.keys(params) : [];
}

/**
 * Script `params` definitions (not URL navParams).
 */
export function getParameterDefs(node) {
  return getParameterDefNames(node).map((paramName) => {
    const config = getParameterConfig(node, paramName) || {};
    return defFromConfig(paramName, config);
  });
}

export function getEditableParameterDefs(node) {
  return getParameterDefs(node).filter((def) => def.source !== "contextElement");
}

export function getNavParamDefNames(node) {
  const navParams = getNavParamsObject(node);
  return navParams ? Object.keys(navParams) : [];
}

export function getNavParamDefs(node) {
  return getNavParamDefNames(node).map((paramName) => {
    const config = getNavParamConfig(node, paramName) || {};
    return defFromConfig(paramName, config);
  });
}

/**
 * navParams opted into the popup UI via an explicit `placeholder` key.
 */
export function getEditableNavParamDefs(node) {
  return getNavParamDefs(node).filter((def) => def.showInput);
}

/**
 * Runtime value defs for the node's primary value channel.
 * URL actions use navParams; script actions use params.
 */
export function getRuntimeValueDefs(node) {
  if (node.url) {
    return getNavParamDefs(node);
  }
  return getParameterDefs(node);
}

export function getEditableValueDefs(node) {
  if (node.url) {
    return getEditableNavParamDefs(node);
  }
  return getEditableParameterDefs(node);
}

export function applyTemplate(template, values, { encode = false } = {}) {
  let result = template;
  if (encode) {
    result = result.replace(
      /\{encode:([a-zA-Z_][a-zA-Z0-9_]*)\}/g,
      (_, name) => encodeURIComponent(values[name] ?? "")
    );
  }
  for (const [name, value] of Object.entries(values)) {
    result = result.split(`{${name}}`).join(value ?? "");
  }
  return result;
}

/**
 * Resolve script params: non-empty manual, else default.
 */
export function resolveParamValues(parameterDefs, rawValues) {
  const values = {};
  for (const def of parameterDefs) {
    const raw = rawValues[def.name];
    values[def.name] = raw !== "" && raw !== undefined ? raw : def.default;
  }
  return values;
}

/**
 * Seed navParam values from manual input only.
 * Blank input is omitted so derivation can run before defaults.
 */
export function seedNavParamValues(navParamDefs, rawValues) {
  const values = {};
  for (const def of navParamDefs) {
    const raw = rawValues[def.name];
    if (raw !== "" && raw !== undefined) {
      values[def.name] = raw;
    }
  }
  return values;
}

export function createHostPatternMatcher(regexCache) {
  const cache = regexCache || new Map();
  return function matchesHostPattern(urlString, pattern) {
    if (!pattern) {
      return true;
    }
    try {
      const url = new URL(urlString);
      if (!cache.has(pattern)) {
        cache.set(pattern, new RegExp(pattern, "i"));
      }
      const re = cache.get(pattern);
      return re.test(url.hostname) || re.test(url.href);
    } catch {
      return false;
    }
  };
}

export const matchesHostPattern = createHostPatternMatcher();

/**
 * Whether `url` is a target for this match/exclude pair.
 * No match pattern means every URL; a matching exclude always wins.
 * @param {string|null|undefined} url
 * @param {string|null|undefined} matchPattern
 * @param {string|null|undefined} excludePattern
 */
export function linkAppliesToUrl(url, matchPattern, excludePattern) {
  if (!url) {
    return false;
  }
  if (excludePattern && matchesHostPattern(url, excludePattern)) {
    return false;
  }
  return matchesHostPattern(url, matchPattern ?? null);
}

/**
 * True when a match regex looks like it depends on path or hash, so SPA
 * navigations can miss on-load (document_start href is often the entry URL).
 * @param {string|null|undefined} pattern
 */
export function matchLooksPathOrHash(pattern) {
  if (!pattern) {
    return false;
  }
  return /#|\//.test(String(pattern));
}

/**
 * Why this URL would not apply, or empty when it would.
 * @param {string|null|undefined} url
 * @param {string|null|undefined} matchPattern
 * @param {string|null|undefined} excludePattern
 */
export function urlSkipReason(url, matchPattern, excludePattern) {
  if (!url) {
    return "No tab URL";
  }
  if (excludePattern && matchesHostPattern(url, excludePattern)) {
    return "Excluded for this URL";
  }
  if (matchPattern && !matchesHostPattern(url, matchPattern)) {
    if (matchLooksPathOrHash(matchPattern)) {
      return "spa-or-hash: match uses path/hash not present at document_start";
    }
    return "URL does not match";
  }
  return "";
}

export function flattenLinkNodes(
  nodes,
  inheritedMatch = null,
  sectionName = null,
  inheritedExclude = null
) {
  const results = [];
  walkCatalogNodes(
    nodes,
    {
      sectionName,
      inheritedMatch,
      inheritedExclude,
      parentList: nodes || [],
    },
    (entry) => {
      if (entry.kind !== "leaf") {
        return;
      }
      results.push({
        ...entry.node,
        match: entry.match,
        exclude: entry.exclude,
        sectionName: entry.sectionName,
      });
    }
  );
  return results;
}

export function collectScriptlets(
  nodes,
  inheritedMatch,
  sectionName,
  out,
  inheritedExclude = null
) {
  walkCatalogNodes(
    nodes,
    {
      sectionName,
      inheritedMatch,
      inheritedExclude,
      parentList: nodes || [],
    },
    (entry) => {
      if (entry.kind !== "leaf") {
        return;
      }
      const node = {
        ...entry.node,
        match: entry.match,
        exclude: entry.exclude,
        sectionName: entry.sectionName,
      };
      if (!supportsOnLoad?.(node)) {
        return;
      }
      out.push({
        linkKey: linkStorageKey(node),
        node,
      });
    }
  );
}

export function parseLinkSections(raw) {
  return Object.entries(raw).map(([name, section]) => ({
    name,
    match: section?.match ?? null,
    exclude: section?.exclude ?? null,
    children: section?.children || [],
  }));
}

export function normalizeScriptInput(raw) {
  let code = raw.trim();
  if (!code) {
    return "";
  }

  if (code.toLowerCase().startsWith("javascript:")) {
    code = code.slice("javascript:".length);
  }

  try {
    code = decodeURIComponent(code);
  } catch {
    // keep literal pasted text when it is not URI-encoded
  }

  if (code.startsWith("void(") && code.endsWith(")")) {
    code = code.slice(5, -1);
  }

  return code.trim();
}

/**
 * Preview helper: substitute known navParam values into the URL template.
 * Does not run page derivation.
 */
export function resolveNode(node, paramValues) {
  if (!node.url) {
    return node;
  }

  const defs = getNavParamDefs(node);
  if (defs.length === 0) {
    return node;
  }

  const values = {};
  for (const def of defs) {
    const value = paramValues[def.name];
    if (value !== "" && value !== undefined) {
      values[def.name] = value;
    } else if (!def.optional) {
      values[def.name] = value ?? def.default ?? "";
    }
  }
  if (Object.keys(values).length === 0) {
    return node;
  }

  return { ...node, url: applyTemplate(node.url, values, { encode: false }) };
}

export function nodeHasOnLoad(node) {
  return supportsOnLoad?.(node) ?? false;
}

export function defaultScriptName(_code, scripts) {
  return `Custom script ${scripts.length + 1}`;
}

function collectParamNamesForRewrite(node) {
  const names = new Set(getParameterDefNames(node));
  return [...names].filter((name) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name));
}

export function rewriteScriptletPlaceholders(code, paramNames) {
  let result = code;
  for (const name of paramNames) {
    if (RESERVED_PARAM_NAMES.has(name)) {
      continue;
    }
    result = result.split(`{${name}}`).join(name);
    result = result.replace(
      new RegExp(`(?<!\\\\)\\$${name}(?![a-zA-Z0-9_])`, "g"),
      name
    );
  }
  return result;
}

function normalizeParamsMap(node) {
  const params = getParamsObject(node);
  if (!params) {
    return undefined;
  }
  const out = {};
  for (const [name, config] of Object.entries(params)) {
    if (!config || typeof config !== "object") {
      out[name] = {};
      continue;
    }
    const { name: _drop, ...rest } = config;
    out[name] = rest;
  }
  return Object.keys(out).length ? out : undefined;
}

function canonicalizeNavParamSpec(spec) {
  if (!spec || typeof spec !== "object") {
    return {};
  }

  const out = {};
  const fromUrl = spec.fromUrl;
  const fromSelector = spec.fromSelector;
  if (fromUrl && fromSelector) {
    throw new Error("navParam cannot have both fromUrl and fromSelector.");
  }
  if (fromUrl) {
    out.fromUrl = fromUrl;
  }
  if (fromSelector) {
    out.fromSelector = fromSelector;
    if (spec.stringSource) {
      out.stringSource = normalizeStringSource(spec.stringSource);
    }
    if (spec.attribute) {
      out.attribute = spec.attribute;
    }
  }

  if (Object.prototype.hasOwnProperty.call(spec, "placeholder")) {
    out.placeholder = spec.placeholder;
  }
  if (Object.prototype.hasOwnProperty.call(spec, "default")) {
    out.default = spec.default;
  }
  if (spec.optional) {
    out.optional = true;
  }
  if (Array.isArray(spec.choices) && spec.choices.length) {
    out.choices = spec.choices;
  }
  if (spec.label) {
    out.label = spec.label;
  }
  if (spec.source) {
    out.source = spec.source;
  }

  return out;
}

function normalizeNavParamsMap(rawMap) {
  if (!rawMap || typeof rawMap !== "object" || Array.isArray(rawMap)) {
    return undefined;
  }
  const out = {};
  for (const [name, spec] of Object.entries(rawMap)) {
    out[name] = canonicalizeNavParamSpec(spec);
  }
  return Object.keys(out).length ? out : undefined;
}

export function normalizeLeafNode(node) {
  const out = {};

  if (node.id) {
    out.id = node.id;
  }
  if (node.name) {
    out.name = node.name;
  }
  if (typeof node.tooltip === "string" && node.tooltip.trim()) {
    out.tooltip = node.tooltip.trim();
  }
  if (Array.isArray(node.searchTags) && node.searchTags.length) {
    out.searchTags = node.searchTags;
  }

  if (Object.prototype.hasOwnProperty.call(node, "match")) {
    out.match = node.match;
  }
  if (Object.prototype.hasOwnProperty.call(node, "exclude")) {
    const exclude = node.exclude;
    if (exclude == null || exclude === "") {
      out.exclude = null;
    } else {
      if (typeof exclude !== "string") {
        throw new Error("exclude must be a regex string or null.");
      }
      try {
        void new RegExp(exclude, "i");
      } catch {
        throw new Error(`Invalid exclude regex: ${exclude}`);
      }
      out.exclude = exclude;
    }
  }

  const open = normalizeOpenValue(node.open);
  if (open) {
    out.open = open;
  }

  if (node.url) {
    out.url = node.url;
  }

  if (node.code) {
    out.code = node.code;
  }

  if (out.code && Object.prototype.hasOwnProperty.call(node, "frames")) {
    out.frames = normalizeFrames(node.frames);
  }

  const runAt = normalizeRunAt(node.runAt);
  if (out.code && !out.open && runAt) {
    out.runAt = runAt;
  }

  const sandbox = normalizeSandbox(node.sandbox);
  if (out.code && sandbox) {
    out.sandbox = sandbox;
  }

  const params = normalizeParamsMap(node);
  const navParams = normalizeNavParamsMap(node.navParams);
  const isUrlAction = Boolean(out.url);
  const isScriptAction = Boolean(out.code);

  if (isUrlAction && !isScriptAction) {
    if (navParams && Object.keys(navParams).length) {
      out.navParams = navParams;
    }
  } else if (params) {
    out.params = params;
  }

  if (out.code) {
    const paramNames = collectParamNamesForRewrite({ ...node, params: out.params });
    out.code = rewriteScriptletPlaceholders(out.code, paramNames);
  }

  return out;
}

export function normalizeTreeNode(node) {
  if (node.children) {
    const folder = { name: node.name, children: node.children.map(normalizeTreeNode) };
    if (Object.prototype.hasOwnProperty.call(node, "match")) {
      folder.match = node.match;
    }
    if (Object.prototype.hasOwnProperty.call(node, "exclude")) {
      folder.exclude = node.exclude == null || node.exclude === "" ? null : node.exclude;
    }
    return folder;
  }
  return normalizeLeafNode(node);
}

export function normalizeCatalog(raw) {
  if (!raw || typeof raw !== "object") {
    return raw;
  }
  const out = {};
  for (const [sectionName, section] of Object.entries(raw)) {
    if (!section || typeof section !== "object") {
      continue;
    }
    const normalized = {
      children: (section.children || []).map(normalizeTreeNode),
    };
    if (Object.prototype.hasOwnProperty.call(section, "match")) {
      normalized.match = section.match;
    }
    if (Object.prototype.hasOwnProperty.call(section, "exclude")) {
      normalized.exclude = section.exclude == null || section.exclude === "" ? null : section.exclude;
    }
    out[sectionName] = normalized;
  }
  return out;
}

