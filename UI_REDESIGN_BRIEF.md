# CalloutAPI — Product & Feature Specification

> A functional description of what the product does, written as input for a new UI design.
> It deliberately contains no description of the current interface — layout, styling and
> component choices are open. Reflects the code as it stands (`manifest.json` v1.2.2).

---

## 1. What the product is

**CalloutAPI** is a Chrome extension (Manifest V3) that reveals the API traffic behind a
web page **without leaving the page**. It hooks `fetch`, `XMLHttpRequest` and `WebSocket`
inside the page's own JavaScript context and surfaces every network call the site makes,
in real time, over the site itself.

Its purpose is not to replace the DevTools Network tab feature-for-feature, but to answer
questions DevTools answers poorly:

- *Which element did I click to cause this call?*
- *Which part of what I'm looking at came from this response?*
- *What is this whole site's API surface, page by page?*

**Users:** frontend and full-stack developers, QA engineers, API integrators, and technical
users reverse-engineering an application's backend.

**Character:** a developer inspection tool. Dense with information, precise, safe to show on
a screen share (credentials are redacted before they are ever displayed).

---

## 2. Core features

### 2.1 Live request capture
Intercepts and records `fetch`, `XMLHttpRequest` and `WebSocket` traffic as it happens.
Captures URL, HTTP method, status, duration, request and response bodies, and request and
response headers. WebSocket connections additionally record their full lifecycle and a
running thread of sent and received frames.

### 2.2 Trigger attribution
Every request is linked to the DOM element the user interacted with immediately before it
fired (an 800ms attribution window over `mousedown` / `touchstart` / `keydown`). Requests
outside that window are classified as background/automatic. This produces a two-way link
between the page and the log:

- Selecting a captured request identifies and reveals the element that caused it.
- Interacting with an element on the page identifies the requests it produced.
- Elements that recently caused calls are marked in place on the page, showing the method,
  path and status of each. An element responsible for several calls presents them as a
  group; selecting one jumps to that request in the log.

### 2.3 Response inspection
Bodies are viewable in full. JSON is parsed and presented as a navigable tree; other
content types fall back to formatted text. Very large bodies are handled without freezing
the page, and a partially-recovered tree is produced when a body exceeds the capture limit.
Headers are shown for both directions. Request bodies are shown alongside responses.

### 2.4 Response-value ⇄ page-element linking
A signature capability. Individual values inside a JSON response can be traced to the
places on the page that display them:

- Previewing a single value reveals the matching elements on the page.
- Selecting a value pins those matches, brings the first into view, reports how many were
  found, and allows cycling through them one by one.
- Selecting an entire response reveals **every** value from it that appears on the page at
  once — an immediate answer to "which parts of this screen came from this call".

### 2.5 Search and filtering
- Free-text search across URL, request body and response body.
- Case-sensitive and regular-expression search modes (invalid patterns are reported).
- Filter by status class (2xx / 3xx / 4xx / 5xx), each with a live count of matches.
- Filter by HTTP method, including WebSocket.
- Filter by initiator: user-triggered versus background/automatic.
- Filter selections persist between sessions.

### 2.6 Pinning
Any request can be pinned to keep it accessible while the log scrolls. Pinned requests can
be viewed as a dedicated collection. Pins are stored by method and path rather than by
request instance, so they survive reloads and re-attach to matching requests when they
fire again.

### 2.7 Site map
An on-demand map of the whole site: **pages → the API endpoints each page uses**. Each
endpoint carries the confidence tier it was learned at, because the sources differ in what
they can be trusted to assert:

| Tier | Source | What it can tell you |
|---|---|---|
| **Observed** | The capture hook watched the call run | Method, status, latency, triggering element — facts |
| **Declared** | An OpenAPI/Swagger document the site publishes | Real methods and paths, but no page attribution |
| **Inferred** | Static analysis of page HTML and JS bundles, without executing them | Candidates, not facts — includes dead code and false positives |

Supporting behavior:

- **Page discovery** from in-page links, `sitemap.xml`, `robots.txt`, and links found while
  reading other pages.
- **Path templatization** — concrete URLs are collapsed into route templates
  (`/users/8123` → `/users/{id}`, plus UUID, date, hex and token forms), so one endpoint
  isn't listed a hundred times.
- **Verification on demand** — an inferred page can be loaded in a hidden background tab so
  its real calls are captured, upgrading it from inferred to observed. One at a time,
  user-initiated only.
- **Shared-bundle collapsing** — endpoints found in a bundle common to most pages are
  attributed to the site rather than duplicated onto every route.
- **First-party / third-party separation**, with third-party endpoints grouped by host.
- **Destructive-route protection** — paths that look like logout, delete, revoke, reset and
  similar are never loaded during scanning.
- Progress is reported while the map builds, and a build in progress can be stopped.

### 2.8 Export
- **HAR 1.2** export of all captured HTTP requests, importable into Chrome DevTools,
  Firefox, Postman, Charles and standard HAR analyzers. WebSocket connections are excluded.
- **Markdown** export of the site map, for documentation and issue reports.
- **Clipboard actions** on individual requests: copy URL, copy as `curl`, and copy the
  contents of whichever detail view is open (response, request, headers, timing, frames).

### 2.9 Allowlist-only activation
The extension is completely dormant everywhere by default. Hosts are added explicitly, and
only then does anything load, render, or listen on that site.

- Adding the current site activates capture **immediately, with no page reload**; removing
  it tears everything down just as immediately.
- Subdomains inherit their parent's allowance (`example.com` covers `sub.example.com`).
- The allowlist is managed from the extension's own surface, which also reports whether the
  current site is active and how many requests have been captured on it.

### 2.10 Capture control
- **Pause / resume** — freezes capture at the hook itself while keeping everything already
  captured available.
- **Clear** — discards the log, pins, page markers, highlights, stored history and site map.
- **Show / hide** — the workspace can be dismissed without stopping capture.
- **Minimized mode** — a compact ambient state that stays out of the way while still
  reporting live activity (running total, error count, and a recent-activity trend).
  Expanding and minimizing both happen in place; positions are remembered independently.
- **Ghost mode** — holding `Alt` makes the interface temporarily see-through so the page
  underneath stays usable.

### 2.11 Log persistence across navigations
Captured requests are mirrored to the extension's service worker and survive in-tab
navigations — login redirects, logout flows and multi-step journeys keep their history
instead of resetting. History is discarded only when the user clears it or the tab closes.

### 2.12 Privacy and redaction
Because the tool is meant to be usable on a screen share, sensitive data is scrubbed at
capture time, before it is ever stored or displayed:

- Credential headers (`authorization`, `proxy-authorization`, `cookie`, `set-cookie`,
  `x-api-key`, `x-auth-token`, `x-csrf-token`).
- Sensitive JSON body keys (passwords, tokens, secrets, private keys, API keys, session
  identifiers).

### 2.13 Appearance preferences
User-selectable and persisted across sessions:

- **Theme** — dark and light.
- **Font family** — monospace, sans-serif, or serif.
- **Font size** — four steps spanning roughly 0.85× to 1.4× of the base size.

### 2.14 Placement
The workspace floats over the page: freely movable, freely resizable, and always above the
site's own content. Position and size persist across reloads.

---

## 3. Information available per entity

What the design has to find room for.

**Per request**
| Field | Notes |
|---|---|
| HTTP method | GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS, or WS |
| URL | Often long; the path is the useful part |
| Status | Numeric code, or pending / error / closed |
| Duration | Milliseconds, absent while pending |
| Kind | fetch, XHR, or WebSocket |
| Initiator | The triggering element (with a human-readable label), or background |
| Request body | Absent, text, or JSON |
| Response body | Absent, text, or JSON — can be multiple megabytes |
| Request headers | Key/value pairs, some redacted |
| Response headers | Key/value pairs, some redacted |
| WebSocket frames | Direction, timestamp and payload per frame |
| Timing breakdown | ⚠️ Only total duration is real; the DNS/TCP/download components are placeholder constants, and any visualization should not imply otherwise |
| Page URL | The page or SPA route that was active when the call fired |

**Per site-map endpoint**
Method (may be unknown), host, route template, confidence tier, call count, distribution of
observed statuses, mean latency, whether it was ever user-triggered, and the elements that
triggered it.

**Per site-map page**
Route template, a representative URL, how it was discovered, whether it has been observed
or only statically analyzed, its endpoint count, and any error encountered while reading it.

**Aggregate**
Total requests, error count, slow-request count (over 800ms), total transferred size,
pinned count, pages and endpoints discovered.

---

## 4. States that must be expressible

- **Not activated** — the current site is not on the allowlist.
- **Active and capturing**, and **active but paused**.
- **Nothing captured yet** — waiting for the user to interact with the page.
- **Nothing matches the current filter** — distinct from having captured nothing.
- **Request in flight** — status and duration unknown.
- **Capture blocked** — the page's Content-Security-Policy prevented the hook from loading;
  the site map still functions, the live log does not.
- **Response truncated** — only a partially recovered body is available.
- **Site map building** — long-running, with progress and a stop affordance.
- **Page being verified** — a single background scan in flight; others unavailable meanwhile.
- **Site-map page unreadable** — fetch failed, deny-listed, or produced no calls.
- **No site map built yet.**
- **Value search result** — no match on the page, one match, or a position within N matches.

---

## 5. Constraints on any design

1. **Injected into arbitrary third-party pages.** The interface renders inside sites whose
   CSS it does not control and must not inherit from. Complete style isolation is mandatory.
2. **No frameworks, no runtime dependencies.** TypeScript compiled to plain JavaScript; the
   UI is built from HTML strings and event delegation. Any design must be expressible
   without React, Vue, Tailwind or a bundler.
3. **No external assets.** Host-page CSP can block anything remote. Fonts must ship bundled;
   no CDNs, no remote images, no web requests for resources.
4. **Both themes are mandatory,** and both must stay legible floating above a page whose
   background is unknown.
5. **Font family and size are user-controlled** — layouts must survive a serif face at 1.4×
   scale without breaking.
6. **Resizable to a small footprint.** The workspace can be shrunk to roughly 360×240 and
   must degrade sensibly rather than break.
7. **High control density.** Capture controls, view switching, search with two modes,
   twelve filters, per-request actions, five detail views and site-map controls all need
   homes without crowding out the log itself.
8. **Performance ceilings.** Up to 1000 requests are retained and 200 rendered at a time,
   with throttled re-rendering and virtualized body rendering. The design cannot assume
   everything is on screen or cheaply re-drawn.
9. **Manifest V3 realities.** The service worker can be evicted at any time; the content
   script runs at `document_start`; only the top-level frame is instrumented.

---

## 6. Tech stack

TypeScript 5 (strict mode) · Chrome Manifest V3 · Vitest for unit tests · zero runtime
dependencies · build is a plain `tsc` compile.

| File | Role |
|---|---|
| `src/injected.ts` | Page-world hook: patches `fetch` / `XHR` / `WebSocket`, redacts, emits events |
| `src/content.ts` | The overlay: capture handling, rendering, highlighting, JSON virtualization, HAR export |
| `src/sitemap.ts` | Site-map model, discovery, static analysis, rendering, Markdown export |
| `src/background.ts` | Service worker: per-tab log persistence and background page scanning |
| `popup.html`, `src/popup.ts` | Extension popup: allowlist and global controls |
