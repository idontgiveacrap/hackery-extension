# Hackery Lab — Context

## Purpose

**Primary:** A Firefox extension for **reverse-engineering and interacting with arbitrary websites**. It stores reusable JavaScript actions (bookmarklets), runs them in the page's MAIN world, and supports persistent on-load injection — useful for debugging DOM behavior, intercepting events, disabling redirects, tracing network calls, and similar site interaction work.

**Secondary:** Host-pattern targeting so relative paths and scriptlets resolve against a matching tab (or the last origin remembered for that pattern). Support for matching all URL regex patterns in the json is required.

## Platform

- **Browser:** Firefox (Manifest V3 via `browser_specific_settings.gecko`)
- **Load:** Temporary add-on via `about:debugging` → Load Temporary Add-on → select `manifest.json`
- **Permissions:** `activeTab`, `scripting`, `storage`, `tabs`, `webNavigation`, `<all_urls>`

## Architecture

```
manifest.json
├── background.js            # Inject cache, omnibox, shortcuts, context menus, badges
├── lib/catalog-walk.js      # One catalog tree walk (keys, match, exclude, parents)
├── lib/link-model.js        # Shared link tree, parameters, match/exclude, runAt
├── lib/link-inspect.js      # Per-leaf inspect snapshot + page console dump
├── lib/link-activity-log.js # Activity log ring-buffer helper
├── lib/activate-link.js     # Shared leaf activation (sidebar / omnibox / shortcuts)
├── inject/on-load.js        # document_start CS; waits locally for end/idle
├── activity-log/            # DevTools Link log panel
├── sidebar/
│   ├── sidebar.html         # Firefox sidebar UI
│   ├── sidebar.js           # Bootstrap, settings, render, DnD
│   ├── link-ui.js           # Link rows, context menu, shortcuts
│   ├── search.js            # Explicit / / Ctrl+K search
│   └── …
├── builder/                 # Advanced link editor window
├── prompt/                  # Parameter prompt window (shortcuts / omnibox)
├── network/                 # Network-rules plugin (engine, UI, inject, host API)
│   ├── plugin.js            # ESM network-rules host API
│   ├── background.js        # Hook/webRequest orchestration
│   ├── ui/                  # DevTools rules editor
│   └── engine/              # Rule engine + page hook + webRequest
├── data/links.json          # Canonical bundled catalog
└── scripts/
```

### Module owners

| Concern | Owner |
|---|---|
| Catalog merge / import / export | `lib/link-catalog.js` |
| Catalog snapshot (merge + order + leaf index) | `lib/catalog-service.js` |
| Display / export order | `lib/catalog-order.js` |
| URL canonicalization | `lib/url-normalize.js` |
| Leaf activation | `lib/activate-link.js` + `lib/link-behaviors.js` |
| Parameter collection outside the sidebar | `prompt/params.js` |
| Search scoring | `lib/link-search.js` |
| Inspect snapshot | `lib/link-inspect.js` |
| Activity log | `lib/link-activity-log.js` + `activity-log/` |
| Shortcut slots | `lib/link-shortcuts.js` |
| Catalog change broadcast | `lib/catalog-events.js` |
| Sidebar UI | `sidebar/` |
| Builder dirty/import UX | `builder/builder.js` |

### Execution flow

1. User opens sidebar (toolbar or Ctrl+Period) → `sidebar.js` reads `getCatalogSnapshot()` (per-realm cache) and renders section tabs. Overlay load is one `storage.local.get` of `linksJsonOverlay`. Catalog reads never write `catalogOrder`.
2. **Omnibox `hl`** — page-focused search/run without focusing the sidebar. Parameters go inline after `|` (see Parameter prompt).
3. **Alt+1…0** — run assigned link slots (right-click a link → Assign Alt+N). Parameterized links prompt first.
4. **Run / Open / Derive** — via `lib/activate-link.js` + behaviors.
5. **On load / Network rules** — unchanged (see below).

### Parameter prompt (`prompt/params.html`)

The sidebar collects values in the link row. Callers without a row — Alt+N shortcuts, omnibox entries — use a popup window instead, opened by `openParamPrompt()` in `background.js` with the request in session `linkParamPrompt`.

| Caller | Behavior |
|---|---|
| Alt+1…0 | Always prompts when the link has editable values, prefilled with the saved value (or `default`); runs directly when it has none |
| Omnibox | Runs inline values straight away; prompts only when a required value is still missing, prefilled with what was supplied |

Inline omnibox syntax splits the input on `|`: the first segment is the action query, the rest are values — positional in declaration order, or `name=value` in any segment. Blank segments fall through to saved values and defaults instead of clearing them. Suggestion descriptions append the parameter state (`q=jsmith` / `q: username or name`), and typed values are carried in the suggestion `content` so selecting a suggestion does not drop them.

```
hl find user | jsmith
hl open item | id=67ee2538534501108135ddeeff7b121b
```

**Why a window, not the sidebar:** `sidebarAction.open()` only works inside an unbroken user-input handler, and Firefox counts `omnibox.onInputEntered` as user input only from 142. Resolving the catalog and stored values — needed to know whether a prompt is required at all — spends that status regardless. A window has no gesture requirement.

**Window targeting:** the prompt takes focus, so "current window" would resolve to the prompt itself. Callers capture the browser `windowId` **before** opening it and pass it through `activateLinkNode` → `getTargetTab`; `performNavigation` pins new tabs to the target tab's window for the same reason. A stale `windowId` (window closed meanwhile) falls back to the current window.

Activation outcomes on these paths are never silent: failures flash the toolbar badge (`?` unknown link, `!` failed) and log to the background console, and errors thrown during activation are returned to the prompt window rather than left as unhandled rejections.

### On-load + `match` / `exclude` / `runAt`

On-load reuses link `match`/`exclude` inheritance from `links.json` (same rules as tab targeting). Only **Run** actions (`code` without `open`) are eligible. Per-leaf `runAt` (`document_start` default, `document_end`, `document_idle`) is honored only on this path; the content script waits locally for end/idle. History API / hash changes do not re-inject.

### Tab / origin targeting

| `match` | Behavior |
|---|---|
| Set (e.g. `\.example\.com$`) | Find or create a tab matching the pattern; remember origin per pattern in `lastOrigins` |
| Set with path (e.g. `chromewebstore\.google\.com/detail/`) | Same; pattern can match full tab URL |
| `null` / absent on node | Use the **active tab** (overrides section inheritance when set explicitly on a link) |

Reverse-engineering tools have no section-level `match` — they run on the active tab.

Sidebar link rows show a **green apply-dot** (tooltip: “Applies to this tab”) when the active tab URL matches the link’s resolved `match` and is not excluded (or when the link has no `match` and therefore always targets the active tab unless excluded). Dots update on tab switch / URL change without a full catalog re-render. Skip reasons are also the apply-dot tooltip and DevTools Link log rows.

## Link data model (`data/links.json`) — schema v3

Top-level keys are **section names** (sidebar tabs):

```json
{
  "match": "\\.example\\.com$",
  "children": [ /* folders + leaves */ ]
}
```

`match` is optional and inherited by nested folders/leaves unless overridden. `exclude` is the same inherit-or-override model (explicit `null` clears). If `exclude` matches hostname or href, the leaf does not apply (on-load, apply-dot, inspect, tab targeting).

On-load Run scriptlets may set `runAt`: `document_start` (default), `document_end`, or `document_idle`. Clicks / shortcuts / omnibox ignore it.

**SPA / hash:** on-load runs at real document start, not `pushState`. If `match` includes a path or `#`, the load URL may miss; Inspect shows current URLs, DevTools **Link log** shows what ran at load.

Right-click a catalog row → **Inspect** for matching tabs, frames, cached origin, params, compiled URL/code, and skip reasons (sidebar popover + page `console.table`). Activation is recorded in DevTools → **Link log**.

### Leaf actions (no `type` field)

Discriminated by properties; [`lib/link-behaviors.js`](lib/link-behaviors.js) picks the first matching behavior:

| Behavior | Badge | Shape |
|---|---|---|
| `run` | Run | `code` only |
| `open-from-script` | Open | `code` + `open` (script returns URL, evaluated in the page) |
| `open-url` | Open / Web / Derive | `url` + `open`; optional `navParams` and/or `{…}` templates |

Popup badges: **Run**, **Open**, **Web** (absolute `url`), **Derive** (`navParams` or template tokens in `url`). Each badge has a descriptive hover tooltip (e.g. Run → “Runs a scriptlet on the page”).

### Common fields

| Field | Purpose |
|---|---|
| `id` | Stable leaf identity (UUID). New leaves get one at create/import via `ensureLinkId`. Order/shortcuts prefer `id`; leaves without one use a section/folder/`name` path key. Folders have no ids. |
| `name` | Display label (also used in path/order fallbacks when `id` is absent) |
| `code` | Script body; `params` keys are lexical bindings at runtime |
| `url` | Relative path, absolute URL, or template |
| `open` | How to open a resolved URL (see below) |
| `tooltip` | Optional hover text on the link label in the sidebar |
| `params` | Script/function bindings only (see below) |
| `navParams` | URL/URI substitution values only (see below) |
| `match` | Host/URL regex; `null` = active tab |
| `exclude` | Host/URL regex; matching URLs never apply |
| `runAt` | On-load only: `document_start` (default) / `document_end` / `document_idle` |
| `frames` | Optional scriptlet injection targets: `top`, `nestingLevel`, `match` (see below) |

Folders: `{ "name": "…", "children": [ … ] }` (no `id`).

### Frame targeting (`frames`)

Optional on `code` actions (`run`, `open-from-script`). Absent `frames` keeps today’s defaults: manual activation injects the **top** document only; on-load injects into **each reporting frame**.

```json
"frames": {
  "top": true,
  "nestingLevel": 1,
  "match": ["incident\\.do"]
}
```

| Key | Meaning |
|---|---|
| `top` | Include the tab’s outermost document (depth 0) |
| `nestingLevel` | Max iframe nesting depth. Omit / `0` = no descendants. `N` = every descendant with depth `1..N`. `-1` = unlimited descendant depth. Does **not** include top. |
| `match` | Regex strings (`i`) against each frame’s **document URL** (not iframe `name`/`id`). With no `match`, every frame in the `nestingLevel` band is included. When set, URL match **ANDs** with that band. If `nestingLevel` is omit/`0`, `match` applies at any descendant depth. |

Depth is hops from the top document via `parentFrameId`. `match` does not apply to top; `top: true` always includes frame 0.

Empty `{ }` is treated as top-only. Unknown keys are rejected. Integer `nestingLevel` only (no boolean aliases).

| Intent | Config |
|---|---|
| Top + first-level iframes | `{ "top": true, "nestingLevel": 1 }` |
| First-level iframes only | `{ "nestingLevel": 1 }` |
| Entire tree | `{ "top": true, "nestingLevel": -1 }` |
| Form iframe at any depth | `{ "match": ["incident\\.do"] }` |
| First-level form iframe | `{ "nestingLevel": 1, "match": ["incident\\.do"] }` |

Do not add `{ "top": true }` alone as a stand-in for “default”: present `frames` changes on-load to the resolved set (top only), instead of every reporting frame.

After a run, a `console.table` of `{ frameId, depth, url, ok, error }` is injected into the top document. Mixed results throw `failed in some frames`; zero successes throw `failed in all frames`. Copy writes successful `open-from-script` URLs, then surfaces the partial-failure message. `open-from-script` with `tab` / `background` / `download` navigates each successful URL; `same-tab` uses the first successful URL only.

On-load: if `frames` is set, the reporting frame is injected only when it is in that target set. Bundled reverse-engineering tools that set `frames`: blur (`nestingLevel: 1`); unmask passwords, disable form validation, background overlay, restore context menu, disable clipboard tampering (`nestingLevel: -1`); all with `top: true`.

### Navigation (`open`)

Required on URL actions. On scriptlets, only when the script returns a URL (`code` + `open`).

| Value | Behavior |
|---|---|
| `same-tab` | Replace the target tab’s URL |
| `tab` | Open in a new focused tab |
| `background` | Open in a new background tab |
| `download` | Trigger `browser.downloads.download` |

### params vs navParams

Mutual exclusion by behavior (see [ADR 0001](docs/adr/0001-params-vs-navparams.md)):

| | `params` | `navParams` |
|---|---|---|
| **Owns** | Script/function bindings | URL `{name}` / `{encode:name}` substitution |
| **Used on** | `code` actions (`run`, `open-from-script`) | `url` actions (`open-url`) |
| **Runtime** | `new Function(...names, code)(...values)` | Applied to `url` template after resolve |

A leaf should not declare both. URL actions use `navParams`; script actions use `params`.

#### `params` fields

```json
"params": {
  "limit": {
    "placeholder": "limit",
    "default": "100",
    "optional": false,
    "choices": ["50", "100", "200"]
  }
}
```

| Key | Purpose |
|---|---|
| `placeholder` | Popup input hint (also implies the input is shown) |
| `default` | Used when the input is blank |
| `optional` | Allow running with an empty value |
| `choices` | Optional combobox suggestions |

Script code uses bare names (`limit`), not `{limit}` or `$limit`.

#### `navParams` fields

```json
"navParams": {
  "target": { "fromUrl": "^https?://[^/]+/(.+)$" },
  "id": {
    "fromUrl": "\\/detail\\/([a-p]{32})",
    "placeholder": "extension id",
    "optional": true
  },
  "id": {
    "placeholder": "id",
    "default": "67ee2538534501108135ddeeff7b121b"
  }
}
```

| Key | Purpose |
|---|---|
| `fromUrl` | Regex against the tab URL; capture group 1 is the value |
| `fromSelector` | CSS selector on the tab DOM (mutually exclusive with `fromUrl`) |
| `stringSource` | With `fromSelector`: `textContent` (default), `innerHTML`, `id`, or `attribute` |
| `attribute` | Required when `stringSource` is `attribute` |
| `placeholder` | **UI opt-in:** presence (including `""`) shows a popup input; never used as a value |
| `default` | Used after derivation if still empty |
| `optional` | Allow navigating with an empty value; otherwise missing required → no-op |
| `choices` / `label` | Same semantics as `params` when an input is shown |

**Resolve order** per key: non-empty manual input → `fromUrl` / `fromSelector` → `default`. Blank input means “no manual value” (fall through). At most one derivation source per key.

URL templates also support `{origin}` (target tab origin), independent of `navParams`.

### Schema

Current catalog shape is schema **v3** (`code` / `url` / `open` / `match` / `params` / `navParams` / optional `sandbox`). Overlay is a single `linksJsonOverlay` get — no on-read migrations, id backfill, or `customScripts` / `Custom` section remaps. Import requires this shape; pre-v3 stored data and imports are unsupported.

### Sandbox (`sandbox` on `code` actions)

| Value | Eval world | Notes |
|---|---|---|
| omit / `"main"` | MAIN | Default. User source is `compileScriptletSource`, then the first method that is not blocked: nonce inline `<script>`, nonce+blob, `new Function(\`return ${source}\`)()`, plain inline `<script>`, plain blob |
| `"isolated"` | ISOLATED | Live DOM, no page globals. Page CSP does not apply. |
| `"readonly-dom"` | ISOLATED **for now** | Same as isolated. **Not read-only** — can still mutate the live DOM. Clone-iframe design below remains the real readonly mechanism. |

Builder exposes Sandbox for scriptlet types.

#### MAIN CSP: DNR strip + one listener-added policy

Firefox MV3 **merges** any in-place CSP rewrite from `webRequest`, so [lib/csp-nonce.js](lib/csp-nonce.js) `punchCspPolicy` is only applied after DNR **remove** and a listener **add** of a single header ([network/engine/network-webrequest.js](network/engine/network-webrequest.js)).

**Allow scriptlets (CSP) checkbox** (sidebar): scoped to the **tab**, not the origin (`cspNonceTabs` in `storage.session`, no timer). One DNR rule per enabled tab, `condition: { tabIds: [tabId], resourceTypes: ["main_frame", "sub_frame"] }` and **no** domain filter, so every document in the tab is covered — including origins that had not loaded when the box was ticked. The listener re-adds each document's own CSP + `'nonce-…'` even when network rules are disarmed. Hard-reload after toggling.

**Why the tab and not the origin.** Frame targets in a scriptlet are chosen by depth and URL across origins, so an origin-keyed gate covered the address-bar origin and left every third-party frame enforcing while the checkbox read "on". DNR has no `frameId` condition, so the tab is the narrowest unit that can cover a frame tree; `tabIds` is valid only in session rules, which is what `updateSessionRules` installs. Listing the tab also excludes tabId `-1` for free. `tabs.onRemoved` drops the entry — tab ids are reused, and a stale one would strip CSP in whatever tab inherits the id.

**Network rules:** the **Arm rules 10m** button arms hooks. It is one shared widget ([lib/network-arm-control.js](lib/network-arm-control.js) + `.css`) mounted in the sidebar header and in the rules panel header, where it replaced the old global **Enabled** checkbox; armed, it shows the countdown and splits into extend (left, green) and disable (right, red) halves under a label spanning both. Arming from the panel first flips `networkRules.enabled` back to true if an imported rule set disabled it, since no checkbox exposes that flag anymore.

The 10-minute `alarms` countdown starts only when at least one rule is **enabled**. Empty list = armed/waiting, label reads `Ready`, no countdown, extend half disabled. Disabling the last enabled rule cancels the alarm and stays ready. Expiry or the disable half turns hooks off; nonce-origin DNR stays if that origin’s checkbox is on.

Nuclear disable is the **Disable CSP** network-rule template (empty policy / omit header), so it is timer-gated. Isolation headers are not stripped unless a rule says so.

**Do not touch CSP** when the origin nonce toggle is off and no armed CSP-touching rule matches. Regex / undigestible patterns fail closed (no DNR strip).

Compose: seed original when nonce is on or `cspSeed === "original"`; apply matching CSP-touching rules in priority; empty / `cspMode: "disable"` → no header; else punch nonce unless the composed policy is empty. Skip nonce on bare `'unsafe-inline'` without nonce/hash.

**Seeding is passive.** `onHeadersReceived` already runs for every document, so it caches each observed enforcing policy whether or not the toggle is on (`cacheCspPolicy` from `sitePolicy`, before compose). The seed therefore comes from the load you were already looking at, and no extra request is made. Three options were weighed:

| Source | Cost | Correctness |
| --- | --- | --- |
| Passive observation (current) | zero requests | exactly the policy the browser enforced |
| Cache only after enabling | zero requests | chicken-and-egg: the strip rule is in place, so there is nothing left to observe |
| Duplicate background `fetch` (removed) | a second request per origin | worst: `Sec-Fetch-Dest: empty` and cookie-gated apps answer differently |

The duplicate fetch is gone, along with `prefetchCspPolicy` and `cacheCspFromHeaders`. It was what made the toggle feel like a browser-wide stall, and it was also why Slack seeded empty — a background `fetch` is not a navigation. Responses with `tabId < 0` are no longer cached at all for the same reason.

**Empty is never cached.** `cacheCspPolicy` ignores a blank value, so a stripped response cannot overwrite a policy already observed, and a missing entry stays distinguishable from a site that genuinely sends none.

**Seed order:** a policy still on the response wins over the cache — DNR has not stripped that one.

**Empty seed still gets a nonce.** When the toggle is on and no header policy composes, the document may still carry an enforcing `<meta>` CSP — the only policy on plenty of app shells. That case mints a nonce, records it for the frame, and punches the meta tag. With no policy anywhere the nonce attribute is ignored. Bailing without a nonce here made the toggle a silent no-op.

`punchMetaCspTags` returns `{ html, reason }`, and the body filter writes that reason back over the header-stage one, so `getCspPunchReason` (Inspect, and the `nonce`/`diag` args in `scriptlet-inject.js`) distinguishes `meta-nonce-punched`, `no-csp-anywhere`, and refusals like `meta-unsafe-inline-without-nonce`. Compose logs one `CSP compose <url>: reason=… meta=… header=…` line per top-level document in a nonce tab.

**One rejected DNR condition used to drop every strip rule** (`updateSessionRules` is all-or-nothing), which reads as "the toggle does nothing" while a CSP network rule still works. The sync now retries rule-by-rule and logs the rejected rule; a success line names the installed count and nonce tabs in the background console.

`getCspPunchReason` records outcomes (`cache-miss`, `csp-rule-disable`, punch reasons).

**Hydration race (pre-existing, now wider).** DNR session rules live in the browser and keep stripping while the event page is suspended, but `isCspNonceTab` reads an in-memory set that `whenCspComposeReady()` refills asynchronously. A document that lands between wake-up and hydration reads as "toggle off", so nothing re-adds the stripped policy. `initCspCompose()` starts hydration at module load to keep the window to a single storage read; closing it properly needs a promise-returning `onHeadersReceived`, which would also change when `filterResponseData` attaches.

**Cache miss is fail-open, and the tab scope widens the window.** A frame origin appearing for the first time *after* the tab's strip rule was installed gets stripped with no policy restored — the document ends up with no CSP rather than original + nonce. Frames present on the pre-toggle load are already cached, which covers the ordinary flow (open page → tick box → hard-reload). The remaining cases log `CSP cache miss <url> (frame <id>): stripped with no policy restored` so it is not silent. Third-party frames in a nonce tab lose XSS protection for the life of the tab; that is the price of covering them, and it is why the scope is the tab and not the window.

Does not punch meta-only documents that send no CSP header. Report-only CSP is left alone.

Every composed document records a punch reason per tab+frame.

#### Method fallback: blocked vs threw

Each MAIN method reports `ran` separately from `ok`. `ran: false` (CSP refused the element, `EvalError` / "blocked by CSP", missing nonce) means no user code executed, so the next method is tried. `ran: true, ok: false` means the scriptlet itself threw and the chain **stops** — retrying would re-run partially-applied code.

Plain (non-nonce) inline and blob are the last resorts: they only succeed where the policy already allows them (the `'unsafe-inline'` class the nonce punch skips).

**The page's own nonce comes first.** When the background has no nonce for the frame, `evaluateCompiledInPage` reads one from an existing `script[nonce]` element. Nonce hiding blanks the content attribute, but the IDL property stays readable from page-realm script, which MAIN world is — so **a policy that already carries a nonce needs no header rewrite at all**. Slack is the worked example: `script-src 'self' … 'nonce-…' blob:` with no `'unsafe-inline'` or `'unsafe-eval'`. Without the fallback the chain reached eval and plain inline first, logging a CSP violation for each before succeeding on `blob:` — visible failure noise around an injection that worked. The sidebar toggle still earns its keep on policies with **no** nonce to borrow (`script-src 'self'`), where one has to be added to the policy itself.

`attempts` records the nonce source (`extension`, `page`, `none`), so Inspect shows which path ran.

**Identifying a policy is per frame; stripping one is not.** `onHeadersReceived` fires for every `main_frame` and `sub_frame` with `tabId`, `frameId`, `url`, and the response headers, so the background records `{ url, origin, type, sitePolicy, policy, meta }` per tab+frame (`rememberCspFramePolicy`) for every document — composed or untouched. `GET_FRAME_CSP` returns that alongside the nonce and punch reason, so a caller can tell a same-host frame that got a composed policy from a third-party frame still carrying its own.

The strip is what cannot be per frame: DNR conditions have no `frameId`, so two same-host iframes in one tab cannot be gated apart, and an origin must be enabled *before* its document loads. DNR does support `condition.tabIds` on session rules, so per-**tab** scoping is available; the current nonce rules use `requestDomains` alone and therefore apply to that origin in every tab.

**The nonce lives in the background realm.** `nonceByFrame` / `punchReasonByFrame` are module state filled by the `onHeadersReceived` listener. A sidebar or prompt run imports `scriptlet-inject.js` into its *own* realm, where those maps are permanently empty — so every sidebar-triggered injection passed `nonce: ""` and `diag: "not-seen"`, skipped both nonce methods, and fell through to eval/inline/blob no matter what the toggle said. Only background-triggered runs (commands, on-load, context menu, param prompt) ever saw a minted nonce. `ownsCspNonceState()` distinguishes the realms; non-owners fetch per-frame `{ nonce, diag }` over `GET_FRAME_CSP` before injecting.

#### Firefox verdict: the in-place punch cannot work in MV3 (but DNR strip + re-add can)

**Rewriting the server's policy is a dead end on this manifest version.** Measured on Firefox 153.0.4 against a local `script-src 'self'` fixture: the nonce *does* reach the document, but the original policy is enforced **alongside** it, and multiple policies AND together, so the un-punched copy still forbids inline, blob, and eval. Two policies were observed on one document:

```
default-src 'self'; script-src 'self'
default-src 'self'; script-src 'self' 'nonce-yNd4j9j8VqiJWOJL5fdsTw'
```

Cause is deliberate Gecko behavior, not a bug here. `ResponseHeaderChanger.setHeader` in `toolkit/components/extensions/webrequest/WebRequest.sys.mjs` forces `merge = true` for any non-empty CSP value from a `manifest_version: 3` extension, and treats clearing the header as a no-op ([bug 1785821](https://bugzilla.mozilla.org/show_bug.cgi?id=1785821), [bug 1462989](https://bugzilla.mozilla.org/show_bug.cgi?id=1462989)). webRequest can therefore only make CSP **stricter** in MV3. There is no in-place rewrite and no relaxation.

This is also why CSP rewrite uses **declarativeNetRequest** `modifyHeaders`/`remove`, the one path MV3 leaves open for dropping security headers.

**DNR remove + webRequest re-add: the page's own policy is unrecoverable.** Firefox applies DNR response `modifyHeaders` in `ExtensionDNR.beforeWebRequestEvent`, and only afterwards builds the header snapshot passed to `onHeadersReceived` listeners (`WebRequest.sys.mjs` `runChannelListener`). A listener therefore cannot read a policy that DNR has already stripped, and DNR `set` takes a literal value so it cannot forward the server's policy into a scratch header either.

**DNR strip + listener-added policy works, and is verified.** Measured on the fixture (Firefox 153.0.4) with a DNR `remove` for the fixture host plus a listener that *appends* a new `Content-Security-Policy` header. Adding a header the snapshot lacks takes the `!original` branch of `applyChanges`, and MV3's forced `merge = true` on a header-less channel is a plain set:

```
policies: [ "default-src 'self'; script-src 'self' 'nonce-<per-document>'" ]   one policy
inline-with-policy-nonce   ran: true
blob-with-policy-nonce     ran: true
control-bogus-nonce        ran: false   CSP still enforced
evalAllowed: false
```

So nonced `<script>` (inline *and* blob) executes in MAIN without `'unsafe-eval'`, and eval stays blocked — the original goal of the nonce plan.

Two constraints remain for a real implementation:

- **The replacement text has to come from somewhere.** DNR strips before any listener reads the response, so the page's own directives are unrecoverable from that request. Extension-initiated requests carry `tabId -1` and DNR conditions support `excludedTabIds`, so a strip rule that excludes `-1` lets the background `fetch` the URL itself to read the unstripped policy and cache it.
- **Fail-open.** DNR keeps stripping while the event page is suspended, so a document loading in that window with no cached seed gets no CSP. Site+nonce is still stronger than the Disable CSP template (which omits the header on purpose).

Consequences:

- MAIN-world scriptlets on a CSP’d page use the **Nonce** origin toggle (site policy + nonce) or an armed CSP network-rule template. `new Function` still needs `'unsafe-eval'` or a disable template. In-place header punch is not used.
- `sandbox: "isolated"` / `"readonly-dom"` are unaffected — ISOLATED world is not subject to page CSP.
- A DNR `modifyHeaders`/`set` rule alone cannot help: rule values are literals, so it cannot generate a per-document nonce or preserve a policy it never read.

#### `readonly-dom` clone (still planned)

**Mechanism:** snapshot page markup into a dedicated iframe document with its own browsing context and JS realm. Preferred shape:

1. Serialize a best-effort DOM snapshot (`documentElement.outerHTML` and/or tree walk; open shadow roots included when reachable; closed shadows / cross-origin iframes omitted).
2. Create an iframe under a host the extension controls for teardown (extension page preferred; page-inserted frame only if needed for packaging).
3. Load the snapshot via `srcdoc` (or equivalent) into that iframe.
4. Evaluate the scriptlet only inside that frame’s `contentWindow` — never rebind the live tab’s `document`.

**Own scope / origin:** give the frame an **opaque origin** so it is neither the page origin nor a privileged extension principal for same-origin access:

- `sandbox` attribute **without** `allow-same-origin` (scripts allowed via `allow-scripts` only as needed to run the scriptlet).
- Result: unique opaque (`null`) origin — separate security principal from the tab and from `moz-extension://` same-origin privileges.

This is still not a hard security boundary against a hostile scriptlet if the host document mishandles results; treat it as **best-effort isolation** for “don’t mutate the live page,” not as a threat model for untrusted code with extension APIs.

**Lift CSP inside the clone (not the live page):**

- Strip CSP **from the snapshot only** before load: remove `<meta http-equiv="Content-Security-Policy">` (and report-only variants) from serialized HTML; do not rely on the live tab’s nonce toggle or Disable CSP template for this path.
- Prefer loading via `srcdoc` / controlled document so the clone does not inherit the page’s HTTP CSP headers.
- Optionally set a permissive policy on the clone document only if a default opaque-frame policy still blocks `new Function` / inline evaluation — scoped to the iframe, never written back to the tab.
- Live-page CSP rewrite is `lib/csp-compose.js` + `network-webrequest.js` (nonce toggle and CSP-touching network rules).

**Prevent interaction with the main page:**

| Guard | Purpose |
|---|---|
| Omit `allow-same-origin` | Opaque origin — no `parent.document` / page DOM access |
| Omit `allow-top-navigation` / `allow-top-navigation-by-user-activation` | No replacing the tab URL |
| Omit `allow-popups` / `allow-popups-to-escape-sandbox` (unless explicitly required later) | No window.open side channels |
| Omit `allow-forms` if navigation-via-form is a concern | No form submit to the parent’s network context |
| Do not pass live `window` / node references into the frame | Avoid bridging the realm via arguments |
| Return values via structured-cloneable postMessage (or inject-and-read once) | Results cross the boundary as data only |
| Tear down the iframe after the run | No lingering frame with a copy of page HTML |
| No `parent` / `top` helpers injected into the scriptlet bindings | Scriptlet sees clone `document` / `window` only |

The clone iframe is not built yet. Until it is, `"readonly-dom"` uses ISOLATED eval on the **live** document (CSP-safe, no page globals, **not** write-proof).

**Known fidelity limits (clone):** closed shadow DOM, cross-origin iframe trees, framework instance state, and any object graph beyond markup are out of scope — HTML/DOM snapshot only.

### Planned: userscripts + user CSS UI

Add a dedicated management surface (sidebar section and/or builder mode) for **persistent userscripts and user stylesheets**, closer to Greasemonkey / Stylus than one-shot catalog actions.

**Intent**

| Kind | Behavior |
|---|---|
| Userscript | Stored JS with `@match`-style host patterns, enable/disable, optional on-load inject (`document_start` / `document_end` / `document_idle`) |
| User CSS | Stored CSS injected into matching pages (same match model); no page JS |

**UI sketch**

- List installed scripts/styles with enable toggle, match summary, edit, delete (soft-delete/undo welcome)
- Editor (CodeMirror already in-tree) for source + metadata: name, match patterns, run-at, notes
- Install/import paths: paste source, import file, optional “save current Run action as userscript”
- Clear separation from the action catalog: userscripts/CSS are always-on page customizations; catalog links remain explicit activate / optional on-load tools

**Out of scope for v1 of this feature:** `@grant`-style capability menus (only relevant once sandboxed / untrusted install is a goal), `@require` / `@resource`, remote auto-update.

**Relation to today:** on-load Run actions already cover “inject this JS on matching tabs.” Userscripts/CSS would generalize that into a first-class library with stylesheets and a management UI, without requiring each item to be a catalog leaf.

### Idea: page-context clipboard (Greasemonkey `GM_setClipboard`)

Sidebar copy today uses the extension page clipboard APIs (`sidebar/copy-link.js`). That is enough for Copy from the sidebar.

If a **scriptlet running in the page** later needs to write the clipboard (e.g. “copy derived URL from inside the page”), prefer Greasemonkey’s page-context approach: dispatch a synthetic `copy` event / use `document.execCommand('copy')` in MAIN world, rather than assuming `navigator.clipboard` or extension `clipboardWrite` reach the injected realm. Only implement when a concrete action needs in-page copy; do not bridge clipboard through background by default.

### Bookmark sync contract (future)

Canonical export/import fields: `code`, `url`, `open`, `match`, `params`, `navParams`, `frames`. Scriptlet bookmarklets should use the same binding model as the extension, not string substitution into `code`.

### Network rules (`network/`)

| Action | Behavior |
|---|---|
| `modify` | URL/body/header replacements + request/response scripts |
| `mock` | Return mock status/body without calling the network (fetch/XHR) |
| `block` | Abort matching requests |
| `redirect` | Replace request URL |

**Filters:** page URL, request URL, Content-Type, request body — `*` wildcards by default, optional per-field **regex** mode; HTTP methods; resource types; response status range.

**Shared state:** request/response scripts receive `ctx.sharedState` (persisted in `networkSharedState`) and `ctx.tabState` (per-tab session). Mutations from page hooks sync back via `NETWORK_SHARED_STATE` messages.

**Mock:** use action `mock`, or `modify` + **Serve without request** with mock status/body fields.

**Rule visibility:** recent matches log to session storage (FIFO cap of 100); toolbar badge `●` on tabs where a rule fired; rules UI highlights the last matched rule. Log entries include `tabId` when known.

**Pattern compilation:** filter regexes compile once on rules refresh in the background and once per hook install in the page. Rule refresh is debounced (300ms).

**Scripts vs webRequest:** request/response scripts run in the page hook (fetch/XHR). webRequest applies declarative block/redirect/header/body actions only — Firefox MV3 CSP blocks `new Function()` in extension pages. A CSP-safe interpreter can be wired later in `network-webrequest.js`.

**Hook reentrancy:** fetch/XHR triggered from inside a rule script skips other rules unless they set **`matchHookOriginated: true`**. A rule never matches its own request while its script is running.

**Event-page listener registration:** `webRequest` listeners register at module load in `network-webrequest.js`, and `initCspCompose()` runs at the top level of `background.js`. Firefox only wakes an event page for listeners added during the background script's first synchronous run, so anything registered after an `await` stops firing once the background suspends.

**CSP compose (`lib/csp-compose.js`, `lib/csp-disable.js` for meta strip):** DNR session rules strip enforcing `Content-Security-Policy` for nonce tabs (`tabIds`, all origins) and for armed DNR-representable CSP-touching rules (`excludedTabIds: [-1]`). The webRequest listener adds **one** composed policy (or none for disable). Meta tags are rewritten or stripped via `filterResponseData`. Isolation headers stay unless a network rule removes them. Hard-reload (`Ctrl+Shift+R`) is required for already-parsed documents.

Network arm uses `alarms` (`network-rules-expire`), not `setTimeout`. `NETWORK_ARM_CHANGED` / `CSP_NONCE_CHANGED` keep the sidebar in sync.

`filterResponseData` must be called synchronously from the webRequest listener — a request id is only accepted while that request's listener is on the stack.

**Compose cost.** Two things made the nonce toggle feel like a browser-wide stall, and both are load-bearing:

- **No seed fetch at all.** Seeding is passive, from the `onHeadersReceived` pass every document already makes. The earlier once-per-origin `fetch` (deduped, body cancelled, `cache: "no-store"`) still meant a second request per origin and read the wrong policy on cookie-gated apps. `policyByUrl` is capped (`POLICY_URL_CACHE_MAX`); `policyByOrigin` carries the fallback.
- **Meta-CSP editing streams.** An enforcing meta policy only applies inside `<head>`, so the filter holds back the head (`HEAD_END_PATTERN`, capped at `HEAD_SCAN_LIMIT`), rewrites it, then passes the rest through with a streaming `TextDecoder`. Only text **body rules** buffer the whole response; doing that for meta CSP blocked first paint on every document.

**Hook idempotency:** re-install restores native `fetch`/XHR from the first install before re-wrapping, so in-tab re-inject does not stack wrappers.

**Rule test:** DevTools rules editor **Test** opens a URL in a new tab and shows an in-page toast when that rule matches (8s timeout).

**DevTools status:** the Network Rules panel header dot reflects hooks disabled (grey), enabled (teal), or a recent match on the inspected tab (green). The toolbar badge `●` tooltip explains active hooks / recent match / inject-on-load.

**Auto re-inject:** saving rules or toggling hooks re-runs the page hook on open http(s) tabs (manual **Re-inject** still available).

### Untested intent: header forwarding on redirect (#10)

When a page-hook **redirect** changes an XHR/fetch URL, sensitive headers (e.g. `Authorization`) may not carry the way Requestly’s session DNR rules do. Header **modify** rules on fetch/XHR apply in the page hook; **webRequest** header rules apply to other resource types. Preserving auth across redirect rewritten URLs is **not implemented** — documented for future work in `network/ui/rules.html`.

**Privileged request headers (Cookie / Origin / Referer / User-Agent):** page JS cannot set these on fetch/XHR. The page hook encodes them as `x-hackerylab-{name}` (legacy `x-complexlinker-*` is still rewritten); `network-webrequest.js` always rewrites those dummies to the real header names in `onBeforeSendHeaders` (even when rule matching defers to the page hook). Add more names to `PRIVILEGED_REQUEST_HEADER_NAMES` in `network-rule-engine-core.js` if needed. The **User-Agent Switcher** network rule template relies on this path for fetch/XHR; navigations and other resource types get `setHeaders` from webRequest directly.

When matching tabs in the target window (the current window unless a caller passed a `windowId`): the **active tab** wins if it matches; otherwise the nearest tab to the active tab (searching outward in the tab strip). Among tabs sharing a remembered origin, the nearest to the active tab is preferred.

Values persist in `browser.storage.local` under `linkParamValues`, keyed by a stable **link key**: `id` when present, otherwise section + behavior + name + template.

## Sections (current)

### Reverse-engineering tools

General-purpose page interaction scriptlets — no host restriction. Examples:

- Compare `window` to a clean iframe (non-default attributes)
- Remove blur / `overflow: hidden`
- Intercept or hook events (`addEventListener`, `postMessage`, capture-phase click)
- Disable redirects, beforeunload, auto-refresh throttling
- Enable disabled form controls
- Trace button clicks (fetch/XHR logging)
- Performance watcher (`window.__perfWatch`)

These are the **primary** reason the extension exists; extend this section when adding new debugging/interaction tools.

The bundled catalog in `data/links.json` also contains other host-scoped sections. Treat that file as the source of those entries.

## User-added actions

Sidebar **Add action** panel quick-adds scriptlets or URLs. **Advanced…** opens `builder/builder.html`. Page context menu **Create Hackery Lab action** opens the builder with tab URL / clicked-element `fromSelector` prefill.

- The quick-add **Type** selector drives the code field: Scriptlet → `JS script` placeholder with JavaScript lint; Link → `URL/path` placeholder with URL lint (`url` language in `lib/codemirror-fields.js`, resolved like runtime paths)
- The builder **Type** selector maps one-to-one onto behaviors, with a hint line per type: `scriptlet` → `run` (no `open`, on-load eligible), `scriptlet-url` → `open-from-script` (`open` required, script returns the URL), `navigate` / `derived-url` → `open-url`. Navigation mode is only offered for types that carry `open`, so a Run scriptlet cannot pick one up by switching types.
- Both scriptlet types expose **Iframe targets** (leaf `frames`): default omits the field; *Specify frames* writes `top`, `nestingLevel`, and URL `match` regexes (one per line)
- Drag-and-drop in the sidebar reorders items and can reparent them onto a section tab or subsection folder title; arrangement is stored in `catalogOrder` (`linkKeys`, `sectionOrder`, `parentByKey`) and used for display and custom-link export
- Custom links stored in `linksJsonOverlay`; export follows catalog order
- Edit / Remove are offered only for links **stored in the overlay** (`collectOverlayCustomLinkIds()`), not merely because a leaf has an `id`. Removing a bundled link means editing `data/links.json`.
- Right-click → Assign Alt+1…0 for global shortcuts

## Storage keys (`browser.storage.local`)

| Key | Purpose |
|---|---|
| `lastOrigins` | Map of match pattern → last seen origin |
| `linkParamValues` | Saved parameter values per link key |
| `injectOnLoad` | Map of link key → true for on-load scriptlets |
| `injectOnLoadEnabled` | Master switch for on-load injection (default true) |
| `networkRules` | Network rules editor state (`enabled` + `rules[]`) |
| `networkHooksEnabled` | Whether network rules are armed (default **false**; Arm rules 10m button) |
| `networkSharedState` | Persistent key/value for network rule scripts (`ctx.sharedState`) |
| `linksJsonOverlay` | Custom section links in `links.json` format (merged at load; no on-read writes) |
| `activeSectionTab` | Last selected section tab |
| `addScriptExpanded` | Add-action panel collapsed state |
| `catalogOrder` | `{ linkKeys[], sectionOrder[], parentByKey }` display/export order and parent overrides |
| `linkShortcutSlots` | Map of `run_link_N` → stable link key |
| `lastActivatedLinkKey` | Last activated stable key |
| `preferredOpenDefault` | Preferred `open` default for new links |

### Session storage

| Key | Purpose |
|---|---|
| `cspNonceTabs` | Tab ids with the CSP nonce toggle on (tab ids are meaningless after a restart, so never `storage.local`) |
| `networkRulesLog` | Recent network rule matches (cap 100) |
| `linkActivityLog` | Catalog activity ring buffer for DevTools Link log (cap 100) |
| `networkTabState` | Per-tab objects for `ctx.tabState` keyed by tab id |
| `linkBuilderPrefill` | Tab/context prefill for new builder links |
| `linkParamPrompt` | Pending parameter prompt: `{ stableKey, windowId, rawValues }` |
| `linkBuilderSection` | Default section for builder |
| `networkArmExpiresAt` | Epoch ms when the armed network session ends (0 if waiting / disarmed) |

## Conventions for changes

- **New reverse-engineering tools:** add to `Reverse-engineering tools` in `data/links.json`; prefer scriptlets that log to `console` and are idempotent where possible (many check a `window.__…` guard).
- **Other bundled catalog entries:** edit `data/links.json`.
- **Scriptlet execution:** always MAIN world — required to touch page globals. This includes `open-from-script` navigation scripts: activation and copy-link both inject them, and no code path evaluates them in an extension realm (extension pages have no `unsafe-eval` under MV3, and the page globals would be missing anyway). Row hints therefore never show a resolved URL for them. Optional `frames` selects top and/or nested documents; see Frame targeting.
- **On-load inject:** only for Run actions (`code` without `open`); respects per-link `match`/`exclude` and `runAt`; background re-registers and re-injects on open tabs when `injectOnLoad` or `injectOnLoadEnabled` changes.
- **Match patterns:** regex tested against tab `URL.hostname` and `URL.href` (case-insensitive). Hostname-only patterns (e.g. `\.example\.com$`) still work; include path segments to restrict to specific pages.
- Reload extension after changing `links.json` or background logic.

## Known limitations

- Firefox-only (uses `browser.*` APIs, gecko manifest settings).
- Temporary add-ons do not persist across browser restarts unless signed/packaged.
- `parse-bookmarks.js` reads `../../bookmarks.html` relative to the script — path assumes a sibling bookmarks export outside this repo.
- Duplicate activation/search logic belongs in `lib/activate-link.js` / `lib/link-search.js` — not sidebar-only copies.
- README describes an older, smaller link set; `data/links.json` is authoritative.

## Related tooling

- **Bookmarks source:** legacy import path; manual `links.json` edits are now the normal workflow for reverse-engineering tools.
