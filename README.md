# CallOut Api - API Endpoint Overlay

A Chrome extension that intercepts and displays all API calls made by a web page — overlaid directly on the site in a floating panel. Instantly see which network requests are happening, what triggered them, and inspect request/response payloads without opening DevTools.

## Features

- **Allowlist-only activation** — the overlay is completely dormant on all sites by default; you explicitly add hostnames you want to inspect
- **Live request capture** — intercepts `fetch`, `XMLHttpRequest`, and `WebSocket` traffic in real time
- **Trigger element linking** — identifies which DOM element the user interacted with that caused each request, with hover-to-highlight on page
- **Floating overlay panel** — draggable, dark/light-themed panel rendered on top of any allowed site; no DevTools required
- **Request/response body preview** — click any row to expand and see payload; JSON is auto-pretty-printed
- **WebSocket support** — tracks connection lifecycle and shows a scrollable sent/received message thread
- **Filtering** — search URL and request/response bodies (plain or regex, case toggle) and narrow by status class, HTTP method (GET, POST, PUT, PATCH, DELETE, WS), origin (page element vs. background) and the footer's `err` / `slow` flags
- **Domain grouping** — toggle to group requests by hostname, with first-party vs third-party distinction
- **HAR export** — export all captured HTTP requests as a standard `.har` file compatible with browser DevTools and analysis tools
- **Pause / Resume** — freeze capture while keeping the current list visible
- **Float badges** — short-lived method+path badges that appear near the trigger element on the page

## Project Structure

```
api-overlay-extension/
├── src/
│   ├── content.ts      # Content script: builds overlay panel, renders UI, handles messages
│   ├── injected.ts     # Page-world script: monkey-patches fetch/XHR/WebSocket, emits events
│   ├── popup.ts        # Extension popup: toggle, pause, export, clear controls
│   └── utils.ts        # Shared pure utilities (escHtml, formatBody, getHostname, extractBody)
├── tests/
│   └── utils.test.ts   # Unit tests for utils
├── dist/               # Compiled JS output (gitignored)
├── popup.html          # Popup markup
├── manifest.json       # Extension manifest (Manifest V3)
├── tsconfig.json       # TypeScript config
├── tsconfig.test.json  # TypeScript config for tests
├── vitest.config.ts    # Vitest config
└── package.json
```

## How It Works

The extension uses a two-script architecture — Manifest V3 keeps content scripts in an isolated world, so patching the page's own `fetch` needs a second script that lives in the page's world:

1. **`injected.ts`** runs in the **page world** (same JS context as the site). It is registered in the manifest as a `"world": "MAIN"` content script at `document_start`, so it is installed synchronously before any of the page's own scripts run and sees load-time requests (this key needs Chrome 111+, hence `minimum_chrome_version`). It monkey-patches `window.fetch`, `XMLHttpRequest.prototype.open/send`, and `window.WebSocket` to intercept all outgoing network requests. When a request starts or completes, it posts a message to `window` with full metadata.

2. **`content.ts`** runs in the **content script world** (isolated from the page). It listens for those `window.postMessage` events and builds the overlay panel into the page DOM. It also tracks interaction state (hover → highlight, expand/collapse rows) and responds to commands from the popup.

3. **`popup.ts`** controls the extension popup, which sends `chrome.tabs.sendMessage` commands (`activate`, `deactivate`, `toggle`, `pause`, `clear`, `export-har`) to the content script. It also manages the `ovAllowedHosts` allowlist in `chrome.storage.local`.

```
Page JS ──postMessage──▶ content.ts ──renders──▶ overlay panel
                                  ◀──sendMessage── popup.ts
                   chrome.storage (ovAllowedHosts) ──▶ content.ts init
```

## Installation

### From source

1. Clone the repository:
   ```bash
   git clone <repo-url>
   cd api-overlay-extension
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build:
   ```bash
   npm run build
   ```

4. Load in Chrome:
   - Open `chrome://extensions`
   - Enable **Developer mode** (top-right toggle)
   - Click **Load unpacked**
   - Select the `api-overlay-extension/` directory

The extension is now installed. No sites are active yet — see [Usage](#usage) to add your first site.

## Development

| Command | Description |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run watch` | Watch mode — recompiles on file change |
| `npm test` | Run unit tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Run tests with coverage report |

After each `build`, reload the extension in `chrome://extensions` (click the refresh icon on the extension card) and reload the target tab.

## Usage

The overlay is opt-in — it only activates on sites you explicitly allow.

### Adding a site

1. Click the **CalloutAPI** extension icon to open the popup.
2. The **Allowed Sites** input is pre-filled with the current tab's hostname.
3. Press **Add** (or Enter) to enable the overlay on that site — the panel appears immediately without a page reload.
4. To remove a site, click the **×** next to it in the list — the panel disappears live on that tab.

> The panel controls (Hide, Pause, Export HAR, Clear) are greyed out when the current site is not in the allowlist. The **Theme** toggle is always available.

### Panel controls

| Action | How |
|---|---|
| Expand a request | Click any row |
| Highlight the trigger element | Hover a row |
| Filter by text | Type in the filter box (matches URL and request/response bodies); **Aa** toggles case sensitivity, **.\*** toggles regex |
| Filter by status / method / origin | Click the chips under the search box; chip selections persist across sites |
| Filter errors / slow requests | Click **err** / **slow** in the footer (per page, not persisted) |
| Group by domain | Click **Group** button |
| Copy a URL | Click the **copy** button on a row |
| Pause/resume capture | Click **Pause** / **Resume** in the panel or popup |
| Clear all requests | Click **Clear** in the panel or popup |
| Export as HAR | Click **Export HAR** in the panel or popup |
| Hide/show panel | Click **Hide Panel** / **Show Panel** in the popup |
| Switch theme | Click **Light Theme** / **Dark Theme** in the popup |
| Move the panel | Drag the header bar |

## HAR Export

The **Export HAR** action generates a [HTTP Archive (HAR 1.2)](https://w3c.github.io/web-performance/specs/HAR/Overview.html) file containing all captured HTTP requests (WebSocket connections are excluded). The file can be imported into:

- Chrome DevTools → Network tab → Import HAR
- Firefox DevTools
- [HAR Analyzer](https://toolbox.googleapps.com/apps/har_analyzer/) by Google
- Postman, Charles Proxy, and other HTTP inspection tools

## Permissions

| Permission | Purpose |
|---|---|
| `tabs` | Read the active tab URL and ID to pre-fill the hostname input and send messages from the popup |
| `activeTab` | Scope message sending to the current tab |
| `storage` | Persist the `ovAllowedHosts` allowlist, UI preferences (theme, font, visibility, pause state, panel/pill position and dock state) and the status/method/origin chip filters across sessions — the chip filters are global, not per site |
| `host_permissions: <all_urls>` | Allow the content script to load on all sites so it can receive an `activate` message when a hostname is added to the allowlist |

## Technical Notes

- **Allowlist storage key:** `ovAllowedHosts` (`string[]`) in `chrome.storage.local` — matched against `location.hostname` on every page load.
- On pages not in the allowlist the capture hook is still installed (it has to be, to see load-time requests) but nothing is rendered: captured requests are held in a bounded in-memory buffer and replayed if the site is activated later. No DOM modification, no event listeners beyond the message handler.
- When a hostname is added via the popup while that tab is open, an `activate` message is sent and the overlay appears live; no page reload required. Removing a hostname sends `deactivate`, which tears down the panel immediately.
- The page-world hook is guarded by `window.__apiOverlayActive` so it installs once per document; `activate` / `deactivate` only start and stop its emission.
- XHR responses are only read as text when `responseType` is `''` or `'text'`; binary types (`arraybuffer`, `blob`) are captured as no body to avoid `InvalidStateError`.
- Trigger element detection uses an 800 ms window from the last `mousedown`/`touchstart`/`keydown` event. Requests made outside that window are attributed to "background / auto".
- CSS is injected with `!important` on every rule to avoid style bleed from the host page overriding the panel.
- Request/response bodies are capped at 50 000 characters; WebSocket messages at 10 000 characters.
- The panel renders at most 200 requests at a time (newest first) to keep the DOM lightweight.
- The overlay uses `z-index: 2147483647` (the maximum 32-bit integer) to stay on top of all page content.

## Tech Stack

- TypeScript 5 (strict mode)
- Manifest V3 Chrome Extension APIs
- Vitest for unit testing
- No runtime dependencies
