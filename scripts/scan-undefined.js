/**
 * Smoke check for missing imports / deleted declarations.
 *
 * Flat (scope-insensitive) comparison: every identifier referenced in a file
 * must be declared *somewhere* in that file, imported, or a known global.
 * Over-approximating declarations means no false positives from shadowing,
 * at the cost of missing scope-only errors — enough to catch the
 * "X is not defined" class of bug after a refactor.
 */
const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");

const ROOT = path.resolve(__dirname, "..");

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "icons", "data"]);
const SKIP_FILES = new Set([
  // Generated / vendored bundles.
  "codemirror-fields.bundle.js",
  "network-hook-install.js",
  "network-hook-page.source.js",
]);

const EXTRA_GLOBALS = new Set([
  // Extension + DOM surface.
  "browser",
  "chrome",
  "window",
  "document",
  "location",
  "navigator",
  "history",
  "localStorage",
  "sessionStorage",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "requestIdleCallback",
  "getComputedStyle",
  "alert",
  "confirm",
  "ClipboardItem",
  "Node",
  "Element",
  "HTMLElement",
  "Image",
  "DOMParser",
  "MutationObserver",
  "ResizeObserver",
  "IntersectionObserver",
  "XMLHttpRequest",
  "CustomEvent",
  "Event",
  "KeyboardEvent",
  "MouseEvent",
  "DragEvent",
  "CSS",
  "getSelection",
  // CommonJS scripts under scripts/ and webpack config.
  "require",
  "module",
  "exports",
  "__dirname",
  "__filename",
]);

function collectFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        collectFiles(path.join(dir, entry.name), out);
      }
      continue;
    }
    if (entry.name.endsWith(".js") && !SKIP_FILES.has(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const declared = new Set();
const referenced = new Map();

function declarePattern(node) {
  if (!node || typeof node !== "object") {
    return;
  }
  switch (node.type) {
    case "Identifier":
      declared.add(node.name);
      return;
    case "ObjectPattern":
      for (const prop of node.properties) {
        if (prop.type === "RestElement") {
          declarePattern(prop.argument);
          continue;
        }
        if (prop.computed) {
          walk(prop.key);
        }
        declarePattern(prop.value);
      }
      return;
    case "ArrayPattern":
      for (const element of node.elements) {
        declarePattern(element);
      }
      return;
    case "AssignmentPattern":
      declarePattern(node.left);
      walk(node.right);
      return;
    case "RestElement":
      declarePattern(node.argument);
      return;
    default:
      walk(node);
  }
}

function walkAll(nodes) {
  for (const node of nodes || []) {
    walk(node);
  }
}

function walk(node) {
  if (!node || typeof node !== "object") {
    return;
  }
  if (Array.isArray(node)) {
    walkAll(node);
    return;
  }
  if (typeof node.type !== "string") {
    return;
  }

  switch (node.type) {
    case "Identifier":
      if (!referenced.has(node.name)) {
        referenced.set(node.name, node.loc.start.line);
      }
      return;

    case "ImportDeclaration":
      for (const spec of node.specifiers) {
        declared.add(spec.local.name);
      }
      return;

    case "VariableDeclarator":
      declarePattern(node.id);
      walk(node.init);
      return;

    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
    case "ClassDeclaration":
    case "ClassExpression":
      if (node.id) {
        declared.add(node.id.name);
      }
      if (node.params) {
        for (const param of node.params) {
          declarePattern(param);
        }
      }
      walk(node.superClass);
      walk(node.body);
      return;

    case "CatchClause":
      if (node.param) {
        declarePattern(node.param);
      }
      walk(node.body);
      return;

    case "MemberExpression":
      walk(node.object);
      if (node.computed) {
        walk(node.property);
      }
      return;

    case "Property":
    case "PropertyDefinition":
    case "MethodDefinition":
      if (node.computed) {
        walk(node.key);
      }
      walk(node.value);
      return;

    case "LabeledStatement":
      walk(node.body);
      return;

    case "BreakStatement":
    case "ContinueStatement":
      return;

    case "ExportNamedDeclaration":
      // `export { x } from "./m"` re-exports do not reference local bindings.
      if (node.source) {
        return;
      }
      walk(node.declaration);
      for (const spec of node.specifiers || []) {
        walk(spec.local);
      }
      return;

    case "ExportAllDeclaration":
      return;

    case "MetaProperty":
      return;

    default: {
      for (const key of Object.keys(node)) {
        if (key === "loc" || key === "range" || key === "type") {
          continue;
        }
        walk(node[key]);
      }
    }
  }
}

let problems = 0;

for (const file of collectFiles(ROOT)) {
  const rel = path.relative(ROOT, file).replace(/\\/g, "/");
  let code = fs.readFileSync(file, "utf8");
  if (code.startsWith("#!")) {
    code = code.slice(code.indexOf("\n") + 1);
  }
  const sourceType = /^\s*(import|export)\s/m.test(code) ? "module" : "script";

  declared.clear();
  referenced.clear();

  let ast;
  try {
    ast = acorn.parse(code, {
      ecmaVersion: 2022,
      sourceType,
      locations: true,
      allowReturnOutsideFunction: true,
    });
  } catch (error) {
    console.log(`${rel}: parse error — ${error.message}`);
    problems += 1;
    continue;
  }

  walk(ast);

  for (const [name, line] of referenced) {
    if (declared.has(name) || name in globalThis || EXTRA_GLOBALS.has(name)) {
      continue;
    }
    console.log(`${rel}:${line}: ${name} is not defined`);
    problems += 1;
  }
}

console.log(
  problems ? `\n${problems} problem(s)` : "no unresolved references"
);
process.exit(problems ? 1 : 0);
