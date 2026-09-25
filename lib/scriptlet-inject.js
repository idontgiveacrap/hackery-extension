import {
  createCspNonce,
  getCspNonce,
  getCspPunchReason,
  ownsCspNonceState,
} from "./csp-nonce.js";
import { MessageTypes } from "./message-types.js";

/**
 * Format an InjectionResult.error or thrown page value for display.
 * @param {unknown} error
 */
export function formatScriptletError(error) {
  if (error == null) {
    return "Script threw an error.";
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object" && error.message) {
    return String(error.message);
  }
  return String(error);
}

function framesHasDescendantBand(frames) {
  if (!frames) {
    return false;
  }
  const nesting = frames.nestingLevel;
  const hasMatch = Array.isArray(frames.match) && frames.match.length > 0;
  return nesting === -1 || (typeof nesting === "number" && nesting >= 1) || hasMatch;
}

function isEmptyFramesSpec(frames) {
  return Boolean(frames) && !frames.top && !framesHasDescendantBand(frames);
}

/**
 * Hops from the top document (frameId 0) via parentFrameId.
 * @param {number} frameId
 * @param {Map<number, { parentFrameId?: number }>} framesById
 */
export function frameDepth(frameId, framesById) {
  if (frameId === 0) {
    return 0;
  }
  let depth = 0;
  let id = frameId;
  const seen = new Set();
  while (id !== 0 && id != null && id !== -1) {
    if (seen.has(id)) {
      return Number.POSITIVE_INFINITY;
    }
    seen.add(id);
    const frame = framesById.get(id);
    if (!frame) {
      return Number.POSITIVE_INFINITY;
    }
    id = frame.parentFrameId;
    depth += 1;
    if (depth > 256) {
      return Number.POSITIVE_INFINITY;
    }
  }
  return depth;
}

/**
 * Whether a webNavigation frame record is in the leaf's frames target set.
 * Absent/empty `frames` means top document only.
 * @param {object | null | undefined} frames
 * @param {{ frameId: number, url?: string }} frame
 * @param {Array<{ frameId: number, parentFrameId?: number, url?: string }>} allFrames
 */
export function isFrameTargeted(frames, frame, allFrames) {
  if (!frames || isEmptyFramesSpec(frames)) {
    return frame.frameId === 0;
  }

  const framesById = new Map(allFrames.map((entry) => [entry.frameId, entry]));
  const depth = frameDepth(frame.frameId, framesById);
  const matchers = (frames.match || []).map((pattern) => new RegExp(pattern, "i"));
  const hasMatch = matchers.length > 0;
  const nesting = frames.nestingLevel;

  if (depth === 0) {
    return Boolean(frames.top);
  }

  let depthAllowed = false;
  if (nesting === -1) {
    depthAllowed = true;
  } else if (typeof nesting === "number" && nesting >= 1 && depth >= 1 && depth <= nesting) {
    depthAllowed = true;
  } else if ((nesting == null || nesting === 0) && hasMatch) {
    depthAllowed = true;
  }
  if (!depthAllowed) {
    return false;
  }
  if (!hasMatch) {
    return true;
  }
  return matchers.some((re) => re.test(frame.url || ""));
}

function metaFromFrameList(list) {
  const framesById = new Map(list.map((entry) => [entry.frameId, entry]));
  return list.map((entry) => ({
    frameId: entry.frameId,
    depth: frameDepth(entry.frameId, framesById),
    url: entry.url || "",
  }));
}

/**
 * Resolve executeScript target + per-frame metadata for a frames spec.
 * @param {number} tabId
 * @param {object | null | undefined} frames
 */
export async function resolveFrameTargets(tabId, frames) {
  const entireTree =
    Boolean(frames?.top) &&
    frames?.nestingLevel === -1 &&
    !(Array.isArray(frames.match) && frames.match.length);

  if (!frames || isEmptyFramesSpec(frames) || (frames.top && !framesHasDescendantBand(frames))) {
    let url = "";
    try {
      const list = await browser.webNavigation.getAllFrames({ tabId });
      url = list?.find((entry) => entry.frameId === 0)?.url || "";
    } catch {
      // restricted tab — table still logs frameId 0
    }
    return {
      allFrames: false,
      frameIds: [0],
      meta: [{ frameId: 0, depth: 0, url }],
    };
  }

  const list = await browser.webNavigation.getAllFrames({ tabId });
  const selected = (list || []).filter((entry) => isFrameTargeted(frames, entry, list));
  const meta = metaFromFrameList(selected);
  return {
    allFrames: entireTree,
    frameIds: meta.map((entry) => entry.frameId),
    meta,
  };
}

async function logFrameResultTable(tabId, rows) {
  const tableRows = rows.map((row) => ({
    frameId: row.frameId,
    depth: row.depth,
    url: row.url,
    ok: row.ok,
    error: row.error || "",
  }));
  try {
    await browser.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: "MAIN",
      injectImmediately: true,
      func: (entries) => {
        console.table(entries);
      },
      args: [tableRows],
    });
  } catch {
    // top frame may be restricted; results still drive throw/return
  }
}

function rowFromInjection(injection, metaById) {
  const frameId = injection?.frameId ?? 0;
  const meta = metaById.get(frameId) || {};
  if (injection?.error != null) {
    return {
      frameId,
      depth: meta.depth,
      url: meta.url || "",
      ok: false,
      error: formatScriptletError(injection.error),
      value: undefined,
    };
  }
  const payload = injection?.result;
  if (payload && payload.ok === false) {
    return {
      frameId,
      depth: meta.depth,
      url: meta.url || "",
      ok: false,
      error: formatScriptletError(payload.error),
      value: undefined,
    };
  }
  const value = payload && payload.ok === true ? payload.value : payload;
  return {
    frameId,
    depth: meta.depth,
    url: meta.url || "",
    ok: true,
    error: "",
    value,
  };
}

export const SANDBOX_MAIN = "main";
export const SANDBOX_ISOLATED = "isolated";
export const SANDBOX_READONLY_DOM = "readonly-dom";

/**
 * executeScript world for a leaf sandbox value.
 * readonly-dom uses ISOLATED until the clone-iframe design exists — live DOM, not read-only.
 * @param {string | null | undefined} sandbox
 * @returns {"MAIN" | "ISOLATED"}
 */
export function scriptletWorld(sandbox) {
  if (sandbox === SANDBOX_ISOLATED || sandbox === SANDBOX_READONLY_DOM) {
    return "ISOLATED";
  }
  return "MAIN";
}

/**
 * Serialized into the page. Do not close over module state.
 *
 * Each method reports `ran` separately from `ok`: `ran: false` means CSP (or the
 * missing nonce) stopped the method before the scriptlet executed, so the next
 * method may be tried. `ran: true, ok: false` means the scriptlet itself threw —
 * retrying would run partially-applied code a second time.
 *
 * @param {{ source: string, nonce: string, token: string, diag: string }} config
 *   `source` is a compileScriptletSource IIFE; `nonce` is the composed-policy
 *   nonce for this frame, falling back to the document's own nonce; `diag` is
 *   the background's punch reason, shown when neither is available.
 */
async function evaluateCompiledInPage(config) {
  const { source, nonce, token, diag } = config;
  const errorText = (error) =>
    error && typeof error === "object" && "message" in error
      ? String(error.message)
      : String(error);

  // A policy that already carries its own nonce needs no header rewrite: nonce
  // hiding blanks the content attribute, but the IDL property stays readable
  // from page-realm script, which MAIN world is. Without this the chain falls
  // through to eval and plain inline first, logging a CSP violation for each
  // before landing on whatever the policy happens to allow.
  let effectiveNonce = nonce;
  if (!effectiveNonce) {
    try {
      for (const element of document.querySelectorAll("script[nonce]")) {
        if (element.nonce) {
          effectiveNonce = element.nonce;
          break;
        }
      }
    } catch {
      // no document access — leave the nonce empty
    }
  }
  const nonceSource = nonce ? "extension" : effectiveNonce ? "page" : "none";

  const slotWrap = `try{window[${JSON.stringify(token)}]={ok:true,value:${source}};}catch(e){window[${JSON.stringify(token)}]={ok:false,error:String(e&&e.message||e)};}`;

  const takeSlot = () => {
    const slot = window[token];
    try {
      delete window[token];
    } catch {
      window[token] = undefined;
    }
    return slot;
  };

  const runEval = () => {
    const t0 = performance.now();
    try {
      const value = new Function(`return ${source}`)();
      return { ran: true, ok: true, value, error: "", ms: Math.round(performance.now() - t0) };
    } catch (error) {
      const message = errorText(error);
      // EvalError / "blocked by CSP" is the policy refusing eval, not the
      // scriptlet failing, so the caller may fall through to another method.
      const blocked =
        (error && error.name === "EvalError") || /blocked by csp/i.test(message);
      return {
        ran: !blocked,
        ok: false,
        value: undefined,
        error: message,
        ms: Math.round(performance.now() - t0),
      };
    }
  };

  /**
   * Inject the scriptlet as a real <script> element, optionally nonced and/or
   * blob-backed. Used for all four nonce/blob combinations.
   * @param {{ useNonce: boolean, useBlob: boolean }} mode
   */
  const runElement = ({ useNonce, useBlob }) =>
    new Promise((resolve) => {
      const t0 = performance.now();
      const ms = () => Math.round(performance.now() - t0);
      if (useNonce && !effectiveNonce) {
        resolve({ ran: false, ok: false, value: undefined, error: `no nonce (${diag})`, ms: 0 });
        return;
      }
      const script = document.createElement("script");
      if (useNonce) {
        // CSP checks the internal nonce slot; set both spellings so the check
        // sees it regardless of which one the engine keeps in sync.
        script.setAttribute("nonce", effectiveNonce);
        try {
          script.nonce = effectiveNonce;
        } catch {
          // older engines expose the content attribute only
        }
      }
      let url = "";
      if (useBlob) {
        url = URL.createObjectURL(new Blob([slotWrap], { type: "text/javascript" }));
        script.src = url;
      } else {
        script.textContent = slotWrap;
      }
      const finish = (row) => {
        if (url) {
          URL.revokeObjectURL(url);
        }
        script.remove();
        resolve(row);
      };
      const settle = (blockedError) => {
        const slot = takeSlot();
        if (!slot) {
          finish({ ran: false, ok: false, value: undefined, error: blockedError, ms: ms() });
          return;
        }
        finish({
          ran: true,
          ok: Boolean(slot.ok),
          value: slot.value,
          error: slot.error || "",
          ms: ms(),
        });
      };
      if (useBlob) {
        script.onload = () => settle("loaded but did not execute");
        script.onerror = () => finish({
          ran: false,
          ok: false,
          value: undefined,
          error: "blob script blocked",
          ms: ms(),
        });
        (document.documentElement || document.head).appendChild(script);
        return;
      }
      // Inline scripts execute synchronously on append; no slot means CSP
      // refused the element.
      (document.documentElement || document.head).appendChild(script);
      settle("blocked by CSP");
    });

  const methods = [
    { id: "nonce-inline", run: () => runElement({ useNonce: true, useBlob: false }) },
    { id: "nonce-blob", run: () => runElement({ useNonce: true, useBlob: true }) },
    { id: "eval", run: async () => runEval() },
    { id: "inline", run: () => runElement({ useNonce: false, useBlob: false }) },
    { id: "blob", run: () => runElement({ useNonce: false, useBlob: true }) },
  ];

  const attempts = [`nonce: ${nonceSource}`];
  for (const method of methods) {
    const result = await method.run();
    attempts.push(`${method.id}: ${result.error || "ok"}`);
    if (result.ran) {
      return result.ok
        ? { ok: true, value: result.value }
        : { ok: false, error: result.error };
    }
  }
  return { ok: false, error: `no injection method available — ${attempts.join("; ")}` };
}

function evalCompiledWithNewFunction(source) {
  try {
    const value = new Function(`return ${source}`)();
    return { ok: true, value };
  } catch (error) {
    return {
      ok: false,
      error:
        error && typeof error === "object" && "message" in error
          ? String(error.message)
          : String(error),
    };
  }
}

const PARAM_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Compile scriptlet `code` and param bindings into a self-executing function.
 * Run and Copy-as-script share this string so a paste matches injection.
 * @param {string} code
 * @param {Record<string, unknown>} [paramValues]
 * @returns {string}
 */
export function compileScriptletSource(code, paramValues = {}) {
  const names = Object.keys(paramValues);
  for (const name of names) {
    if (!PARAM_NAME_RE.test(name)) {
      throw new Error(`Invalid scriptlet param name: ${name}`);
    }
  }
  const paramList = names.join(", ");
  const argList = names
    .map((name) => {
      const value = paramValues[name];
      return value === undefined ? "undefined" : JSON.stringify(value);
    })
    .join(", ");
  return `(function(${paramList}) {\n${code}\n})(${argList})`;
}

/**
 * Run scriptlet source in a tab with param keys as lexical bindings.
 * Always logs a per-frame console.table in the top document.
 * @param {number} tabId
 * @param {string} code
 * @param {Record<string, unknown>} paramValues
 * @param {{ frameId?: number, frames?: object, sandbox?: string }} [options]
 * @returns {Promise<{ successes: Array<{ frameId: number, value: unknown }>, someFailed: boolean }>}
 */
export async function executeScriptletWithBindings(tabId, code, paramValues = {}, options = {}) {
  if (!tabId) {
    throw new Error("No target tab for script injection.");
  }

  const compiled = compileScriptletSource(code, paramValues);
  const target = { tabId };
  let meta = [];

  if (options.frameId != null) {
    target.frameIds = [options.frameId];
    try {
      const list = await browser.webNavigation.getAllFrames({ tabId });
      meta = metaFromFrameList((list || []).filter((entry) => entry.frameId === options.frameId));
    } catch {
      meta = [{ frameId: options.frameId, depth: options.frameId === 0 ? 0 : undefined, url: "" }];
    }
  } else if (options.frames) {
    const resolved = await resolveFrameTargets(tabId, options.frames);
    meta = resolved.meta;
    if (resolved.allFrames) {
      target.allFrames = true;
    } else if (resolved.frameIds.length) {
      target.frameIds = resolved.frameIds;
    }
  } else {
    const resolved = await resolveFrameTargets(tabId, { top: true });
    meta = resolved.meta;
    target.frameIds = [0];
  }

  const metaById = new Map(meta.map((entry) => [entry.frameId, entry]));

  if (!target.allFrames && (!target.frameIds || target.frameIds.length === 0)) {
    const emptyRows = [{ frameId: null, depth: undefined, url: "", ok: false, error: "No matching frames." }];
    await logFrameResultTable(tabId, emptyRows);
    throw new Error("failed in all frames");
  }

  const world = scriptletWorld(options.sandbox);
  let injections = [];
  try {
    if (world === "ISOLATED") {
      injections = await browser.scripting.executeScript({
        target,
        world: "ISOLATED",
        injectImmediately: true,
        func: evalCompiledWithNewFunction,
        args: [compiled],
      });
    } else {
      let frameIds = target.frameIds;
      if (target.allFrames) {
        try {
          const list = await browser.webNavigation.getAllFrames({ tabId });
          frameIds = (list || []).map((entry) => entry.frameId);
        } catch {
          frameIds = [0];
        }
      }
      // Sidebar and prompt runs import this module in their own realm, where
      // the nonce maps are always empty; the background fills them from its
      // webRequest listener. Reading them locally there sent every injection
      // in with an empty nonce, so the chain skipped both nonce methods.
      let frameCsp = null;
      if (!ownsCspNonceState()) {
        const response = await browser.runtime
          .sendMessage({
            type: MessageTypes.GET_FRAME_CSP,
            tabId,
            frameIds: frameIds || [],
          })
          .catch(() => null);
        frameCsp = response?.frames || null;
      }

      injections = [];
      for (const frameId of frameIds || []) {
        const batch = await browser.scripting.executeScript({
          target: { tabId, frameIds: [frameId] },
          world: "MAIN",
          injectImmediately: true,
          func: evaluateCompiledInPage,
          args: [
            {
              source: compiled,
              nonce: frameCsp
                ? frameCsp[frameId]?.nonce || ""
                : getCspNonce(tabId, frameId),
              token: `hl${createCspNonce()}`,
              diag: frameCsp
                ? frameCsp[frameId]?.diag || "not-seen"
                : getCspPunchReason(tabId, frameId),
            },
          ],
        });
        if (batch?.[0]) {
          injections.push(batch[0]);
        }
      }
    }
  } catch (error) {
    const rows = [
      {
        frameId: target.frameIds?.[0] ?? 0,
        depth: meta[0]?.depth,
        url: meta[0]?.url || "",
        ok: false,
        error: formatScriptletError(error),
        value: undefined,
      },
    ];
    await logFrameResultTable(tabId, rows);
    throw new Error("failed in all frames");
  }

  if (target.allFrames && injections?.length) {
    try {
      const list = await browser.webNavigation.getAllFrames({ tabId });
      meta = metaFromFrameList(list || []);
      for (const entry of meta) {
        metaById.set(entry.frameId, entry);
      }
    } catch {
      // keep whatever meta we had
    }
  }

  const rows = (injections || []).map((injection) => rowFromInjection(injection, metaById));
  await logFrameResultTable(tabId, rows);

  const successes = rows
    .filter((row) => row.ok)
    .map((row) => ({ frameId: row.frameId, value: row.value }));
  const someFailed = rows.some((row) => !row.ok);

  if (!successes.length) {
    throw new Error("failed in all frames");
  }

  return { successes, someFailed };
}
