# Hackery Lab

Firefox extension for reusable page actions: run JavaScript in the page MAIN world, open derived or declared URLs, and optionally inject scriptlets at document start. The bundled catalog in `data/links.json` includes reverse-engineering tools plus other sections.

## Install (temporary)

1. Open Firefox and go to `about:debugging`.
2. Click **This Firefox**.
3. Click **Load Temporary Add-on…**
4. Select `manifest.json` in this folder.

Temporary add-ons are removed when Firefox closes.

## Install (signed / persistent)

Package the folder as a `.zip` and submit to Mozilla Add-ons, or use Firefox Developer Edition with unsigned extensions enabled.

## Usage

1. Open a tab on the site the action targets (for any item with a regex `match` that matches the URL, the active tab will switch automatically).
2. Open the **sidebar** via the toolbar button or **Ctrl+Period** (toggle).
3. Choose an action (badge indicates type):
   - **Run** — script injected into the target tab (top frame by default; optional `frames` can include nested iframes)
   - **Derive** — URL built from the tab (`navParams` / template)
   - **Open** — relative path on the target tab
   - **Web** — absolute URL

**Search without focusing the sidebar:** type `hl` in the address bar (omnibox), then a query; Enter runs the top match.

**In-sidebar search:** focus the search field with `/` or **Ctrl+K** (no type-anywhere capture — the page keeps keyboard focus when the sidebar is open but unfocused).

**Shortcuts:** right-click a link → Assign Alt+1…0. Those keys run the link globally.

**Create from page:** right-click the page/link/selection → **Create Hackery Lab action** (opens the advanced builder; clicked elements prefill a `fromSelector` navParam).

Drag links/folders/section tabs to reorder; order is saved and used for export.

The sidebar shows the active tab origin. **Allow scriptlets (CSP)** lets scriptlets run in **every frame of the active tab** — cross-origin frames included — by adding a nonce to each document's own Content-Security-Policy. The rest of each policy stays enforced, no other tab is affected, and it stays on until you turn it off or close the tab (hard-reload to apply).

Because it covers third-party frames, those frames lose CSP protection for as long as the tab is open. A frame origin loading for the first time *after* you tick the box can end up with no policy at all, logged as `CSP cache miss …` in the background console; reload once more to seed it.

**Arm rules 10m** (sidebar header and the rules panel header are the same control) arms network rules; the countdown starts when at least one rule is enabled. While it counts down, the left half extends the timer and the right half disables the rules.

When a link has a `match` pattern, the extension prefers the active tab if it matches and is not excluded, otherwise the nearest matching tab in the current window.

Right-click a catalog row → **Inspect** for matching tabs, frames, cached origin, params, compiled URL/code, and skip reasons (sidebar popover plus `console.table` in the target page). Activations and on-load skips appear in DevTools → **Link log**.

Reload the extension in `about:debugging` after editing `data/links.json`.

**Schema v3 note:** updating to the `params` / `navParams` split clears saved parameter values and on-load preferences once. Re-enable on-load checkboxes and re-enter saved values after reload.

## Recommended complementary tools

This extension does not reimplement capabilities that existing add-ons or Firefox itself already cover well. Pair it with:

| Tool | Role |
|---|---|
| [Wappalyzer](https://www.wappalyzer.com/) | Identify CMS, frameworks, CDNs, and other stack fingerprints |
| [React Developer Tools](https://addons.mozilla.org/firefox/addon/react-devtools/) | Inspect React component trees and props |
| [Angular DevTools](https://addons.mozilla.org/firefox/addon/angular-devtools/) | Inspect Angular component trees and change detection |
| [CSP Evaluator](https://addons.mozilla.org/firefox/addon/csp-evaluator/) | Review Content-Security-Policy headers |
| [uBlock Origin](https://addons.mozilla.org/firefox/addon/ublock-origin/) | Network/filter blocking |
| [NoScript](https://addons.mozilla.org/firefox/addon/noscript/) | Per-site script allowlisting |
| [uMatrix](https://addons.mozilla.org/firefox/addon/umatrix/) | Per-request-type matrix blocking (**abandoned**, still useful) |
| [Stylus](https://addons.mozilla.org/firefox/addon/styl-us/) | User stylesheets per site, without touching the profile `chrome` folder |
| [Video DownloadHelper](https://addons.mozilla.org/firefox/addon/video-downloadhelper/) | Download videos and streams (HLS/DASH) from the page |
| [DownThemAll](https://addons.mozilla.org/firefox/addon/downthemall/) | Select, filter, and queue bulk downloads of page links and media |

### Firefox built-in (Developer Tools)

Open with **F12** / **Ctrl+Shift+I**. These are the inspectors this extension does not duplicate:

- **Inspector** — HTML/CSS: select nodes, search, live-edit markup and styles, pretty-print
- **Debugger** — JS: sources, breakpoints, pretty-print minified files, search
- **Console** — runtime JS against the page (and selected iframe)
- **Network** — request/response headers, bodies, timing, replay
- **Storage** — cookies, local/session storage, IndexedDB, Cache Storage (view and edit)

### Firefox user CSS (profile `chrome` folder)

Persistent CSS without an extension. Create a `chrome` directory in the **profile folder** (`about:support` → **Profile Folder** → Open Folder):

| File | Applies to |
|---|---|
| `chrome/userChrome.css` | Firefox chrome (toolbars, sidebar, menus, DevTools chrome) |
| `chrome/userContent.css` | Page content (web pages, `about:` documents) |

Firefox 69+ ignores these unless `toolkit.legacyUserProfileCustomizations.stylesheets` is `true` in `about:config`. Restart after changing the pref or the CSS files. Stylus is the easier per-site alternative; `userContent.css` is global to the profile.

### Custom software (control Firefox / offload analysis)

Hackery Lab does not implement a local-app bridge. Use one of the Firefox-supported channels below. Pick by who should own the session: **this extension** (native messaging), **an automation client** (WebDriver BiDi), or **the network path** (local proxy).

| Channel | Best for | How it attaches |
|---|---|---|
| [Native messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging) | Dumping page/network data from an extension into Python/Go/etc. for parsing, graphs, export | Extension `runtime.connectNative` / `sendNativeMessage` ↔ host process **stdin/stdout** |
| [WebDriver BiDi](https://developer.mozilla.org/en-US/docs/Web/WebDriver/How_to/Create_BiDi_connection) | Driving tabs, executing JS, subscribing to network/console/DOM events from Playwright, Selenium, or a raw WebSocket client | Launch with `--remote-debugging-port`; WebSocket at `ws://127.0.0.1:PORT/session` |
| [geckodriver](https://firefox-source-docs.mozilla.org/testing/geckodriver/) / Marionette | Classic WebDriver HTTP (navigate, click, screenshot); BiDi can ride on the same session via `webSocketUrl` | Client → geckodriver → Firefox Marionette |
| Local MITM proxy (mitmproxy, Burp, …) | Full HTTP(S) bodies and WebSockets without writing an extension | Firefox proxy settings / PAC; install the proxy CA for HTTPS |

**Native messaging (extension → local app).** Requires `"nativeMessaging"` on the extension and a **host manifest** JSON whose `allowed_extensions` lists this add-on’s gecko id (`punk@local.dev`). On Windows the browser finds the host via `HKCU`/`HKLM` `\Software\Mozilla\NativeMessagingHosts\<name>` pointing at that JSON; on Linux/macOS the JSON lives under a Mozilla native-messaging directory. Messages are length-prefixed JSON (host → extension max **1 MB** per message). Content scripts cannot talk to the host directly — the background script is the pipe. This is the path if you want Hackery Lab (or a thin companion add-on) to collect DOM/HAR-like data and hand it to heavier analysis code. Not implemented here.

**WebDriver BiDi (external client → Firefox).** Does not need this extension. Firefox CDP support is gone (removed after deprecation in 129+); do not target CDP. Example:

```text
firefox --remote-debugging-port 9222
```

Then connect to `ws://127.0.0.1:9222/session` (Firefox binds `127.0.0.1`, not `localhost`). BiDi can execute scripts, inspect browsing contexts, and stream network/log events — enough for custom analysis pipelines that also need to *control* the browser. Playwright and current Selenium speak BiDi; a custom client can send the JSON protocol directly.

**Proxy.** Complements (and can overlap) this extension’s network rules. Use it when you need durable capture, replay, or tooling that already exists outside Firefox. Proxy TLS interception is a separate trust decision from add-on permissions.

**Do not** expose `--remote-debugging-port` on a non-loopback interface. Native hosts run with the user’s OS privileges; treat the host binary like any local installer.

## Link catalog (`data/links.json`)

Top-level keys are **section names** (sidebar tabs). Each section has optional `match` and a `children` array (folders and leaf actions). Leaves have **no `type` field** — behavior is inferred from properties.

```json
{
  "Example": {
    "match": "\\.example\\.com$",
    "children": [ ]
  },
  "Reverse-engineering tools": {
    "children": [ ]
  }
}
```

### Folders

`{ "name": "…", "children": [ … ] }` — may override `match` / `exclude` for descendants.

### `match` / `exclude`

Optional regex inherited from section or parent unless overridden. Matched against tab hostname and full href (case-insensitive). Explicit `null` clears inheritance.

| Value | Tab selection |
|---|---|
| `match` set (e.g. `\\.example\\.com$`) | Active tab if it applies; else nearest match; else remembered origin |
| `"match": null` on a link | Active tab only (overrides section inheritance) |
| `exclude` set | URLs matching this regex never apply (on-load, apply-dot, targeting) |
| Absent on section | Active tab in the current window |

On-load Run scriptlets may set `runAt`: `document_start` (default), `document_end`, `document_idle`. Sidebar clicks always run immediately.

On-load injects at real document start, not SPA `pushState`. If `match` includes a path or `#`, Inspect (current URL) vs DevTools **Link log** (what ran at load) is how you see a miss.

Right-click a catalog row → **Inspect** (popover + page console). Activations appear in DevTools → **Link log**.

### Leaf actions

| Shape | Badge | Fields |
|---|---|---|
| `code` only | Run | Script runs in MAIN world; optional `frames` and on-load |
| `code` + `open` | Open | Script returns URL; extension navigates |
| `url` + `open` | Open / Web / Derive | Optional `navParams`, `{…}` templates |

#### Run (`code`)

```json
{
  "name": "Set list item limit",
  "code": "list.setPageSize(limit);",
  "params": {
    "limit": { "placeholder": "limit", "default": "100" }
  }
}
```

Script `params` are **lexical bindings** — use bare names in `code` (`limit`), not `{limit}` or `$limit`.

Optional `frames` selects which documents the script runs in (see below).

#### Open URL (`url` + `open`)

```json
{
  "name": "Open settings",
  "open": "tab",
  "url": "/settings"
}
```

Derived URL with `navParams` + template:

```json
{
  "name": "Open item",
  "open": "same-tab",
  "navParams": {
    "id": {
      "fromUrl": "/items/([^/?#]+)"
    }
  },
  "url": "{origin}/items/{encode:id}"
}
```

URL templates support `{paramName}`, `{encode:paramName}`, and `{origin}`. Resolve order for each navParam: non-empty manual input → `fromUrl`/`fromSelector` → `default`. Blank input means no manual value. When a required navParam cannot be filled, the action is a **no-op**. Set `"optional": true` only when the action should still run with that value empty. Presence of `placeholder` (including `""`) shows a popup input; `placeholder` is never a value source.

#### Navigation (`open`)

Required on URL actions. On scriptlets only when returning a URL (`code` + `open`).

| `open` | Behavior |
|---|---|
| `same-tab` | Replace the target tab’s URL |
| `tab` | New focused tab |
| `background` | New background tab |
| `download` | `browser.downloads.download` |

### `params` (scripts) vs `navParams` (URLs)

Mutual exclusion: `params` on `code` actions, `navParams` on `url` actions. Do not declare both on one leaf.

**`params`** — script bindings only (bare names in `code`):

```json
"params": {
  "limit": { "default": "100", "placeholder": "limit", "choices": ["50", "100"] }
}
```

**`navParams`** — URL substitution only:

```json
"navParams": {
  "id": {
    "fromUrl": "\\/detail\\/([a-p]{32})",
    "placeholder": "extension id",
    "optional": true
  },
  "id": {
    "placeholder": "id",
    "default": "abc123"
  }
}
```

| `navParams` key | Role |
|---|---|
| `fromUrl` | Regex on tab URL (capture group 1); xor `fromSelector` |
| `fromSelector` | CSS selector on tab DOM |
| `placeholder` | Show popup input (including `""`); never a value |
| `default` | After derivation if still empty |
| `optional` | Allow empty; else missing required → no-op |

Resolve order: non-empty manual → derive → `default`. Blank input = no manual value.

Saved values live under `linkParamValues`. See `CONTEXT.md` and [ADR 0001](docs/adr/0001-params-vs-navparams.md).

### Frame targeting (`frames`)

Optional on `code` actions (`run` and `code` + `open`). URL actions ignore it.

**Defaults when `frames` is omitted**

| How you run | Where it injects |
|---|---|
| Sidebar / omnibox / Alt+N / Copy | Top document only |
| On-load | Each frame that loads (current content-script path) |

Do not add `"frames": { "top": true }` just to mean “default”: that object is present, so on-load then **only** injects the top frame.

```json
"frames": {
  "top": true,
  "nestingLevel": 1,
  "match": ["/edit$"]
}
```

| Key | Meaning |
|---|---|
| `top` | Include the tab’s outermost document (depth 0) |
| `nestingLevel` | Max **iframe** depth. Omit / `0` = no descendants. `N` = every descendant with depth `1..N`. `-1` = unlimited. Does **not** include top — set `top` for that. |
| `match` | Regex strings (case-insensitive) against each frame’s **document URL** (`location.href`), not the iframe `name` / `id`. With no `match`, every frame in the `nestingLevel` band is included. When set, URL match **ANDs** with that band. If `nestingLevel` is omit/`0`, `match` applies at any descendant depth. |

Depth is hops from the top document (a direct `<iframe>` is 1). `match` does not apply to top; `top: true` always includes frame 0. Unknown keys are rejected. `nestingLevel` is an integer only.

| Intent | Config |
|---|---|
| Top + first-level iframes | `{ "top": true, "nestingLevel": 1 }` |
| First-level iframes only | `{ "nestingLevel": 1 }` |
| Entire tree | `{ "top": true, "nestingLevel": -1 }` |
| Form iframe at any depth | `{ "match": ["/edit$"] }` |
| First-level form iframe | `{ "nestingLevel": 1, "match": ["/edit$"] }` |

After a run, the **page** console (top document) logs a table of `frameId`, `depth`, `url`, `ok`, `error`. Mixed results: `failed in some frames`. Zero successes: `failed in all frames`. Copy still writes successful `open-from-script` URLs, then shows the partial-failure message.

`open-from-script`: `tab` / `background` / `download` open each successful URL; `same-tab` uses the first successful URL only.

On-load with `frames` set: that frame is injected only if it is in the target set.

In the bundled catalog, **Remove blur & overflow hidden** uses `nestingLevel: 1`; **Unmask passwords**, **Disable form validation**, **Give everything a background**, **Restore context menu**, and **Disable clipboard tampering** use `nestingLevel: -1` (all with `top: true`).

### `sandbox` (scriptlets)

Optional on `code` actions. Omitted / `"main"` injects in the page MAIN world. `"isolated"` and `"readonly-dom"` use `executeScript` `world: "ISOLATED"` (live DOM, no page globals, not subject to page CSP). `readonly-dom` is **not** a cloned document yet — it can still write the live DOM.

MAIN scriptlets compile to an IIFE, then use the first method the page does not block: nonce `<script>` inline, nonce + blob URL, `new Function`, plain inline `<script>`, plain blob. A method whose scriptlet ran and threw stops the chain. The sidebar **Allow scriptlets (CSP)** checkbox rewrites the CSP of every document in that tab (DNR strip scoped by `tabIds` + one header with `'nonce-…'` per document). **Disable CSP** is a timed network-rule template that omits the header. Firefox MV3 cannot rewrite CSP in place (it merges); do not rely on in-place punch.

### Sections in the current catalog

See `data/links.json` for the full list. `CONTEXT.md` has architecture detail, network rules, and sandbox notes.

## Updating links from bookmarks

Legacy import for bookmarks html:

```bash
node scripts/parse-bookmarks.js
```

Output is normalized to schema v3 on catalog load. Prefer editing `data/links.json` directly for reverse-engineering tools and new links.

Then reload the extension in `about:debugging`.
