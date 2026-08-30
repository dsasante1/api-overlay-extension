/// <reference types="chrome" />

interface ElementInfo { selector: string; label: string; }
interface WsMessage { dir: 'sent' | 'recv'; body: string; ts: number; }
type RequestStatus = number | 'pending' | 'error' | 'closed';
type HeaderPair = [string, string];
type DetailTab = 'response' | 'request' | 'headers' | 'timing' | 'frames';
type DockState = 'panel' | 'pill' | 'hidden';
// Which collection the log area is showing. 'map' is the site-map surface; its
// discovery engine does not ship in this build, so it renders its empty state only.
type OverlayView = 'log' | 'pinned' | 'map';

// Keep the non-cache fields in sync with PreservedRequest in src/background.ts —
// every wire field below crosses the messaging boundary for the preserve-log feature.
interface ApiRequest {
  id: number;
  url: string;
  method: string;
  kind: 'fetch' | 'xhr' | 'ws';
  status: RequestStatus;
  element?: ElementInfo | null;
  ts: number;
  // The page (or SPA route) that was loaded when this call fired. Stamped by the
  // content script rather than the injected hook, so it tracks in-page route
  // changes for free — location.href is read once per captured request.
  pageUrl?: string;
  // Set once the site map has counted this request; the capture path emits
  // several times per request (pending → status → body) and only the first
  // terminal emit should increment a call count.
  _smFolded?: boolean;
  reqBody?: string | null;
  resBody?: string | null;
  reqHeaders?: HeaderPair[] | null;
  resHeaders?: HeaderPair[] | null;
  messages?: WsMessage[];
  ms?: number;
  _lcUrl?: string;
  _lcReqBody?: string;
  _lcResBody?: string;
}

interface OverlayMessage extends Partial<ApiRequest> {
  __apiOverlay?: boolean;
  __wsMsg?: boolean;
  wsId?: number;
  dir?: 'sent' | 'recv';
  body?: string;
}



const MAX_REQUESTS = 1000;
const MAX_WS_MESSAGES_PER_CONN = 500;
const WS_TRIM_TRIGGER = MAX_WS_MESSAGES_PER_CONN + 50;
const RENDER_LIMIT = 200;
const RENDER_THROTTLE_MS = 100;
const MAX_JSON_LEAF_LEN = 1000;
const MAX_VALUE_HIGHLIGHTS = 50;
// Display/scan bounds for very large bodies (the captured-body cap in injected.ts
// is now high enough to admit multi-MB JSON). flattenJsonRows and collectJsonLeaves
// both materialize their whole output eagerly on the main thread, so cap them to
// keep expanding a huge response from janking the UI.
const MAX_JSON_ROWS = 20_000;
const MAX_JSON_LEAVES = 2_000;
// Per-body cap for the preserve-log copy only (display keeps the full body).
// chrome.storage.session has a ~10MB quota; one oversized body would make the
// whole tab's persist fail, dropping every preserved request — so trim the copy.
const MAX_PRESERVED_BODY_BYTES = 256_000;
const MIN_VALUE_LEN = 2;
const MIN_SUBSTRING_LEN = 4;

const requests = new Map<number, ApiRequest>();
const expandedIds = new Set<number>();
const selectorBadges = new Map<string, HTMLDivElement>();
const selectorReqIds = new Map<string, number[]>();
const selectorTimers = new Map<string, number>();

// Reverse highlight: hover any page element that ever triggered a request →
// flash its overlay row(s). selectorIndex maps each triggering element to every
// request id captured for it. Selectors are resolved to elements once per
// (lazy) rebuild, so the hover path is an O(DOM-depth) ancestor walk rather than
// an O(selectors) closest() scan. A WeakMap so removed nodes aren't pinned.
// The index is rebuilt only when the request set structurally changes, tracked
// by comparing requestsRev (bumped on add/remove/selector-change) to the rev the
// index was last built at — so pure mouse movement triggers no rebuilds.
let selectorIndex = new WeakMap<Element, number[]>();
let selectorIndexRev = -1;
let requestsRev = 0;
let revHighlightRows: HTMLElement[] = [];
let revHoverActiveEl: Element | null = null;
let revHoverTarget: Element | null = null;
let revHoverRaf = 0;
let pageHoverHandler: ((e: MouseEvent) => void) | null = null;
let pageHoverOutHandler: ((e: MouseEvent) => void) | null = null;
const detailTabs = new Map<number, DetailTab>();

// filter state — multi-select sets (empty = pass-through)
const activeStatus = new Set<string>();
const activeMethods = new Set<string>();
const activeInitiators = new Set<string>();
const activeFlags = new Set<string>();   // 'err' | 'slow' — derived footer filters

// Same-origin target for the page ↔ injected-hook channel. Opaque origins
// (file://, sandboxed frames) serialize as the string "null", which is not a
// valid targetOrigin and makes postMessage throw, so fall back to '*' there.
// Kept in sync with TARGET_ORIGIN in src/injected.ts.
const TARGET_ORIGIN = location.origin && location.origin !== 'null' ? location.origin : '*';

// Reading chrome.runtime.lastError is what suppresses the "Unchecked
// runtime.lastError" console warning; the value itself is never needed.
function swallowLastError(): void {
  if (chrome.runtime.lastError) { /* intentionally ignored */ }
}

// pin state
const pinnedIds = new Set<number>();
const pinnedKeys = new Set<string>(); // `${method}|${urlNoQuery}`

let panelVisible = true;
let activeHighlight: HTMLElement | null = null;
let paused = false;
let currentTheme: 'dark' | 'light' = 'dark';

// ── Font preferences ──
// Family/size are exposed in the popup as named keys; these maps resolve them to
// the actual CSS values applied via the --ov-font-* custom properties. Defaults
// preserve the original look (mono stack at scale 1).
type FontFamilyKey = 'mono' | 'sans' | 'serif';
type FontSizeKey = 's' | 'm' | 'l' | 'xl';

const FONT_FAMILIES: Record<FontFamilyKey, string> = {
  mono:  "'JetBrains Mono','IBM Plex Mono',ui-monospace,monospace",
  sans:  "system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  serif: "Georgia,Cambria,'Times New Roman',Times,serif",
};
const FONT_SCALES: Record<FontSizeKey, number> = { s: 0.85, m: 1, l: 1.2, xl: 1.4 };

let currentFontFamily: FontFamilyKey = 'mono';
let currentFontSize: FontSizeKey = 'm';

let activated = false;
let renderScheduled = false;
let renderTimer: number | null = null;
let lastRenderTime = 0;
let filterInput: HTMLInputElement | null = null;
let caseSensitiveSearch = false;
let regexSearch = false;
let dockState: DockState = 'panel';
const DEFAULT_PANEL_WIDTH = 520;
const DEFAULT_PANEL_HEIGHT = 640;
const DEFAULT_PILL_WIDTH = 120;
// Bars in the ambient pill's activity band.
const PILL_RAIL_TICKS = 22;
type PanelGeom = { left: number; top: number; width: number; height: number };
type PillGeom = { left: number; top: number };
let savedPanelGeom: PanelGeom | null = null;
let savedPillGeom: PillGeom | null = null;
let currentView: OverlayView = 'log';
let ghostHeld = false;
let ghostTimer: number | null = null;
let clusterOutsideClickHandler: ((e: MouseEvent) => void) | null = null;
let dismissPressHandler: ((e: MouseEvent) => void) | null = null;
let dismissClickHandler: ((e: MouseEvent) => void) | null = null;
// Whether the press in flight began on overlay UI. A drag that starts inside the
// panel (selecting response text, resizing) must not read as a click-away.
let pressStartedOnOverlay = false;

let valueHighlightEls: HTMLElement[] = [];
let valueHighlightIndex = 0;
let valueHighlightKey = '';
let bulkHighlightEls: HTMLElement[] = [];
let bulkHighlightRowId = -1;
let jvHoverEls: HTMLElement[] = [];
let jvHoverKey = '';
let jvHoverTimer: ReturnType<typeof setTimeout> | null = null;

// ── Preserve log (per-tab, survives in-tab navigations) ──────────────────────

const PRESERVE_DEBOUNCE_MS = 250;
const dirtyPreserveIds = new Set<number>();
// Buffered WS message deltas waiting to be flushed. Sent as a separate payload
// so chatty connections don't force a full request re-serialize per message.
const pendingWsMessages = new Map<number, WsMessage[]>();
let preserveTimer: number | null = null;
let nextPreservedLocalId = -1;

function schedulePreserveFlush(): void {
  if (preserveTimer !== null) return;
  preserveTimer = window.setTimeout(flushPreserve, PRESERVE_DEBOUNCE_MS);
}

function markPreserveDirty(id: number): void {
  dirtyPreserveIds.add(id);
  schedulePreserveFlush();
}

function markWsMessagePending(wsId: number, m: WsMessage): void {
  let pending = pendingWsMessages.get(wsId);
  if (!pending) { pending = []; pendingWsMessages.set(wsId, pending); }
  pending.push(m);
  schedulePreserveFlush();
}

// The display copy keeps the full captured body, but the persisted copy goes to
// chrome.storage.session (~10MB quota for the whole tab). A single oversized body
// would make the whole set() fail and drop every preserved request, so return a
// shallow clone with over-cap bodies trimmed. Also drops the derived lowercase
// search caches — hydrateFromPreserved rebuilds them, and they'd otherwise double
// the persisted body size.
function trimForPreserve(r: ApiRequest): ApiRequest {
  const copy: ApiRequest = { ...r };
  delete copy._lcUrl;
  delete copy._lcReqBody;
  delete copy._lcResBody;
  delete copy._smFolded;
  if (copy.resBody != null && copy.resBody.length > MAX_PRESERVED_BODY_BYTES) {
    copy.resBody = `${copy.resBody.slice(0, MAX_PRESERVED_BODY_BYTES)}…[trimmed for storage]`;
  }
  if (copy.reqBody != null && copy.reqBody.length > MAX_PRESERVED_BODY_BYTES) {
    copy.reqBody = `${copy.reqBody.slice(0, MAX_PRESERVED_BODY_BYTES)}…[trimmed for storage]`;
  }
  return copy;
}

function flushPreserve(): void {
  preserveTimer = null;
  if (!dirtyPreserveIds.size && !pendingWsMessages.size) return;

  const reqs: ApiRequest[] = [];
  for (const id of dirtyPreserveIds) {
    const r = requests.get(id);
    if (r) reqs.push(trimForPreserve(r));
  }
  dirtyPreserveIds.clear();

  // A full record already includes its messages array, so any WS deltas for
  // that same id are redundant — drop them to avoid double-appending in the SW.
  const sentFullIds = new Set(reqs.map(r => r.id));
  const wsDeltas: Record<string, WsMessage[]> = {};
  for (const [id, msgs] of pendingWsMessages) {
    if (sentFullIds.has(id)) continue;
    wsDeltas[String(id)] = msgs;
  }
  pendingWsMessages.clear();

  if (!reqs.length && !Object.keys(wsDeltas).length) return;

  try {
    chrome.runtime.sendMessage(
      { action: 'ov-preserve', reqs, wsDeltas },
      // Read lastError to silence the "Unchecked runtime.lastError" warning when
      // the SW is briefly unavailable (cold start, eviction, or unload race).
      swallowLastError,
    );
  } catch {
    // chrome.runtime.sendMessage throws when the extension context has been
    // invalidated (extension reloaded/uninstalled). Nothing to recover; the
    // content script will be torn down imminently.
  }
}

function clearPreserved(): void {
  dirtyPreserveIds.clear();
  pendingWsMessages.clear();
  if (preserveTimer !== null) { clearTimeout(preserveTimer); preserveTimer = null; }
  try {
    chrome.runtime.sendMessage(
      { action: 'ov-clear-preserved' },
      swallowLastError,
    );
  } catch { /* see flushPreserve */ }
}

function hydrateFromPreserved(onDone: () => void): void {
  try {
    chrome.runtime.sendMessage({ action: 'ov-get-preserved' }, (resp: { ok?: boolean; reqs?: ApiRequest[] } | undefined) => {
      swallowLastError();
      const list = resp?.reqs;
      if (Array.isArray(list) && list.length) {
        // Sort by capture time so the restored slice keeps chronological order
        // regardless of the SW's storage-roundtrip ordering.
        list.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
        // Remap to negative local IDs so they never collide with the per-page
        // injected counter (which restarts at 1 after navigation).
        for (const r of list) {
          const localId = nextPreservedLocalId--;
          const copy: ApiRequest = { ...r, id: localId };
          refreshSearchCache(copy, copy as OverlayMessage);
          if (pinnedKeys.has(pinKey(copy))) pinnedIds.add(localId);
          requests.set(localId, copy);
          // Restored rows carry their original pageUrl, so they rebuild the map
          // for pages visited earlier in this tab's history.
          copy._smFolded = false;
          smFoldRequest(copy);
          // Restored rows carry their original pageUrl, so they rebuild the map
          // for pages visited earlier in this tab's history.
          copy._smFolded = false;
          smFoldRequest(copy);
        }
        requestsRev++;   // restored rows add new triggering-element mappings
        trimRequests();
      }
      onDone();
    });
  } catch {
    onDone();
  }
}

// ── Render scheduling ─────────────────────────────────────────────────────────

function scheduleRender(): void {
  if (renderScheduled) return;
  renderScheduled = true;
  const elapsed = Date.now() - lastRenderTime;
  const delay = Math.max(0, RENDER_THROTTLE_MS - elapsed);
  renderTimer = window.setTimeout(() => {
    renderTimer = null;
    renderScheduled = false;
    lastRenderTime = Date.now();
    renderList();
  }, delay);
}

function scheduleRenderUnlessPaused(): void {
  if (paused) return;
  scheduleRender();
}

function cancelScheduledRender(): void {
  if (renderTimer !== null) { clearTimeout(renderTimer); renderTimer = null; }
  renderScheduled = false;
}

// ── Request management ────────────────────────────────────────────────────────

function trimRequests(): void {
  if (requests.size <= MAX_REQUESTS) return;
  requestsRev++;   // evicting rows changes the triggering-element → id mapping
  const overflow = requests.size - MAX_REQUESTS;
  const iter = requests.keys();
  for (let i = 0; i < overflow; i++) {
    const k = iter.next().value;
    if (k === undefined) break;
    const trimmed = requests.get(k);
    requests.delete(k);
    expandedIds.delete(k);
    detailTabs.delete(k);
    pinnedIds.delete(k);
    if (trimmed?.element?.selector) removeSelectorReqId(trimmed.element.selector, k);
  }
}

function refreshSearchCache(req: ApiRequest, msg: OverlayMessage): void {
  if (msg.url !== undefined) req._lcUrl = (req.url || '').toLowerCase();
  if (msg.reqBody !== undefined) req._lcReqBody = req.reqBody ? req.reqBody.toLowerCase() : '';
  if (msg.resBody !== undefined) req._lcResBody = req.resBody ? req.resBody.toLowerCase() : '';
}

// ── Message handling ──────────────────────────────────────────────────────────

function isSafeId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < Number.MAX_SAFE_INTEGER;
}

// Requests intercepted by the injected hook before the overlay is activated. The
// hook is installed at document_start (a MAIN-world content script) so it captures load-time
// requests, but there is no UI to show them until the user activates. Buffer them
// (bounded, oldest dropped on overflow) and replay via drainPreActivationBuffer
// once the panel/pill is built.
const preActivationBuffer: OverlayMessage[] = [];
const MAX_PREACTIVATION_BUFFER = 2000;

function bufferPreActivation(msg: OverlayMessage): void {
  preActivationBuffer.push(msg);
  if (preActivationBuffer.length > MAX_PREACTIVATION_BUFFER) preActivationBuffer.shift();
}

function drainPreActivationBuffer(): void {
  if (!preActivationBuffer.length) return;
  const pending = preActivationBuffer.splice(0, preActivationBuffer.length);
  for (const m of pending) handleOverlayMessage(m);
  scheduleRenderUnlessPaused();
}

// Append one frame to its parent connection. Frames whose connection is gone
// (evicted, or never captured) are dropped.
function applyWsFrame(msg: OverlayMessage): void {
  if (!isSafeId(msg.wsId)) return;
  const conn = requests.get(msg.wsId);
  if (!conn) return;
  conn.messages ??= [];
  if (msg.dir && msg.body != null && msg.ts != null) {
    const wsmsg: WsMessage = { dir: msg.dir, body: msg.body, ts: msg.ts };
    conn.messages.push(wsmsg);
    // Send as a delta so the SW appends instead of re-serializing the
    // entire (growing) messages array on every chatty-WS tick.
    markWsMessagePending(conn.id, wsmsg);
  }
  if (conn.messages.length > WS_TRIM_TRIGGER) {
    conn.messages.splice(0, conn.messages.length - MAX_WS_MESSAGES_PER_CONN);
  }
  if (expandedIds.has(conn.id)) scheduleRenderUnlessPaused();
}

// Merge an update into the row it belongs to. Updates land even while paused —
// pause only gates *new* entries (see updateExistingRequest's counterpart).
function updateExistingRequest(existing: ApiRequest, msg: OverlayMessage): void {
  // element is re-evaluated on updates (e.g. the response emit), so the
  // selector can change or drop — invalidate the index when it does.
  const prevSel = existing.element?.selector;
  Object.assign(existing, msg);
  if (msg.element !== undefined && existing.element?.selector !== prevSel) requestsRev++;
  refreshSearchCache(existing, msg);
  // sync pin by key
  if (pinnedKeys.has(pinKey(existing))) pinnedIds.add(existing.id);
  markPreserveDirty(existing.id);
}

function insertNewRequest(msg: OverlayMessage): void {
  // Stamped here rather than in the injected hook, so an SPA route change is
  // reflected without the hook needing to watch history.
  const fresh = { ...msg, pageUrl: location.href } as ApiRequest;
  refreshSearchCache(fresh, msg);
  requests.set(fresh.id, fresh);
  requestsRev++;   // new triggering-element → id mapping
  // restore pin state from persisted keys
  if (pinnedKeys.has(pinKey(fresh))) pinnedIds.add(fresh.id);
  trimRequests();
  markPreserveDirty(fresh.id);
}

function handleOverlayMessage(msg: OverlayMessage): void {
  if (msg.__wsMsg) { applyWsFrame(msg); return; }
  if (!isSafeId(msg.id)) return;

  const existing = requests.get(msg.id);
  if (existing) {
    updateExistingRequest(existing, msg);
  } else {
    if (paused) return;
    const fresh = { ...msg, pageUrl: location.href } as ApiRequest;
    refreshSearchCache(fresh, msg);
    requests.set(msg.id, fresh);
    requestsRev++;   // new triggering-element → id mapping
    // restore pin state from persisted keys
    if (pinnedKeys.has(pinKey(fresh))) pinnedIds.add(fresh.id);
    trimRequests();
    markPreserveDirty(fresh.id);
    if (paused) return;   // pause gates new entries only
    insertNewRequest(msg);
  }

  // Fold into the site map as calls land, not on demand: the aggregate has to
  // outlive trimRequests(), which drops the oldest entries out of `requests`.
  const folded = requests.get(msg.id);
  if (folded) smFoldRequest(folded);

  scheduleRenderUnlessPaused();

  if (!paused && msg.element?.selector && msg.status !== 'pending') {
    const req = requests.get(msg.id);
    if (req) flashBadge(req);
  }
}

window.addEventListener('message', (e: MessageEvent<OverlayMessage>) => {
  if (e.source !== window) return;
  if (TARGET_ORIGIN !== '*' && e.origin !== TARGET_ORIGIN) return;
  if (!e.data?.__apiOverlay) return;
  const msg = e.data;
  // Before activation there is no UI; hold captured requests so they can be
  // replayed once the overlay opens (drainPreActivationBuffer).
  if (!activated) { bufferPreActivation(msg); return; }
  handleOverlayMessage(msg);
});

chrome.runtime.onMessage.addListener((msg: { action: string; value?: unknown }, _sender, sendResponse) => {
  switch (msg.action) {
    case 'get-state':
      sendResponse({ visible: panelVisible, paused, theme: currentTheme, fontFamily: currentFontFamily, fontSize: currentFontSize, activated, count: requests.size });
      break;
    case 'activate':
      activateOverlay();
      sendResponse({ activated });
      break;
    case 'deactivate':
      deactivateOverlay();
      sendResponse({ activated });
      break;
    case 'toggle': {
      panelVisible = !panelVisible;
      chrome.storage.local.set({ ovVisible: panelVisible });
      const panel = $('ov-panel');
      if (panel) panel.style.setProperty('display', panelVisible ? 'flex' : 'none', 'important');
      sendResponse({ visible: panelVisible });
      break;
    }
    case 'pause': {
      const next = (msg.value as boolean) ?? false;
      setPaused(next);
      sendResponse({ paused });
      break;
    }
    case 'clear':
      requests.clear();
      requestsRev++;
      expandedIds.clear();
      detailTabs.clear();
      pinnedIds.clear();
      clearAllBadges();
      clearValueHighlights();
      clearBulkHighlights();
      clearJvHover();
      clearRevHighlight();
      clearPreserved();
      smReset();
      renderList();
      sendResponse({ ok: true });
      break;
    case 'export-har':
      exportHAR();
      sendResponse({ ok: true });
      break;
    case 'theme': {
      const theme = msg.value as 'dark' | 'light';
      if (theme === 'dark' || theme === 'light') {
        chrome.storage.local.set({ ovTheme: theme });
        applyTheme(theme);
      }
      sendResponse({ theme: currentTheme });
      break;
    }
    case 'font-family': {
      const family = msg.value as FontFamilyKey;
      if (family in FONT_FAMILIES) {
        chrome.storage.local.set({ ovFontFamily: family });
        applyFont(family, currentFontSize);
      }
      sendResponse({ fontFamily: currentFontFamily });
      break;
    }
    case 'font-size': {
      const size = msg.value as FontSizeKey;
      if (size in FONT_SCALES) {
        chrome.storage.local.set({ ovFontSize: size });
        applyFont(currentFontFamily, size);
      }
      sendResponse({ fontSize: currentFontSize });
      break;
    }
    default:
      sendResponse({ ok: false });
  }
});

// ── Core UI helpers ───────────────────────────────────────────────────────────

function setPaused(next: boolean): void {
  if (next === paused) return;
  const wasPaused = paused;
  paused = next;
  chrome.storage.local.set({ ovPaused: paused });
  signalInjected(paused ? 'pause' : 'resume');
  const btn = $('ov-pause');
  if (btn) btn.textContent = paused ? '▶ rec' : '⏸ pause';
  // Drives the live badge's paused colouring and the footer's capture note.
  $('ov-panel')?.classList.toggle('ov-paused', paused);
  refreshPill();
  renderFooter();
  if (wasPaused && !paused) renderList();
}

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function applyTheme(theme: 'dark' | 'light'): void {
  currentTheme = theme;
  const panel = $('ov-panel');
  if (panel) panel.dataset.theme = theme;
  const pill = $('ov-pill');
  if (pill) pill.dataset.theme = theme;
  const btn = $('ov-theme');
  if (btn) btn.textContent = theme === 'dark' ? 'light' : 'dark';
  for (const b of selectorBadges.values()) b.dataset.theme = theme;
}

function loadTheme(): Promise<'dark' | 'light'> {
  return new Promise(resolve => {
    chrome.storage.local.get('ovTheme', result => {
      resolve((result.ovTheme as 'dark' | 'light') || 'dark');
    });
  });
}

// Font preferences are applied as custom properties on the document root. The
// `all: initial` reset on #ov-panel does NOT reset custom properties, so these
// inherit into the panel, pill, and dynamically-created badges alike.
function applyFont(family: FontFamilyKey, size: FontSizeKey): void {
  currentFontFamily = FONT_FAMILIES[family] ? family : 'mono';
  currentFontSize = FONT_SCALES[size] ? size : 'm';
  const root = document.documentElement;
  root.style.setProperty('--ov-font-family', FONT_FAMILIES[currentFontFamily]);
  root.style.setProperty('--ov-font-scale', String(FONT_SCALES[currentFontSize]));
}

function loadFont(): Promise<{ family: FontFamilyKey; size: FontSizeKey }> {
  return new Promise(resolve => {
    chrome.storage.local.get(['ovFontFamily', 'ovFontSize'], result => {
      const family = (result.ovFontFamily as FontFamilyKey) in FONT_FAMILIES
        ? (result.ovFontFamily as FontFamilyKey) : 'mono';
      const size = (result.ovFontSize as FontSizeKey) in FONT_SCALES
        ? (result.ovFontSize as FontSizeKey) : 'm';
      resolve({ family, size });
    });
  });
}

// ── String / URL helpers ──────────────────────────────────────────────────────

// JSON string values can carry literal control characters (e.g. newlines in a
// commit message body). The JSON virtualizer gives every row a fixed-height,
// white-space:pre line, so an unescaped "\n" splits one row across several
// physical lines that overflow and overlap the rows below. Escape control chars
// the way JSON.stringify renders them so each value stays on a single line.
function escJsonControl(s: string): string {
  return s.replace(/[\\\x00-\x1f]/g, (c) => {
    switch (c) {
      case '\\': return '\\\\';
      case '\n': return '\\n';
      case '\r': return '\\r';
      case '\t': return '\\t';
      case '\b': return '\\b';
      case '\f': return '\\f';
      default: return `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
    }
  });
}

function escHtml(str: unknown): string {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Malformed % escapes throw in decodeURIComponent and can break a delegated handler
// for the rest of an event loop tick. Returning '' on failure keeps the UI alive.
function safeDecodeURIComponent(s: string): string {
  try { return decodeURIComponent(s); } catch { return ''; }
}

const VALID_HTTP_METHODS = new Set(['GET','POST','PUT','DELETE','PATCH','HEAD','OPTIONS','WS']);

function safeMethodClass(method: string | null | undefined): string {
  const m = String(method ?? 'GET').toUpperCase();
  return VALID_HTTP_METHODS.has(m) ? m.toLowerCase() : 'unknown';
}

function urlPath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + (u.search.length > 30 ? u.search.slice(0, 30) + '…' : u.search);
  } catch { return url?.slice(0, 60) || ''; }
}

function middleTruncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return s.slice(0, half) + '…' + s.slice(s.length - (max - half - 1));
}

function stripQuery(url: string): string {
  try { const u = new URL(url); return u.origin + u.pathname; } catch { return url; }
}

function pinKey(req: ApiRequest): string {
  return `${req.method}|${stripQuery(req.url)}`;
}

function formatBody(text: string | null | undefined): string {
  if (!text) return '';
  const parsed = parseJsonBody(text);
  if (parsed !== undefined) return JSON.stringify(parsed.value, null, 2);
  return text;
}

function tryParseJsonContainer(text: string | null | undefined): unknown {
  return parseJsonBody(text)?.value;
}

// Parse a response/request body that is a JSON object or array. Returns the
// value plus a `truncated` flag. injected.ts caps bodies at MAX_BODY_BYTES (a
// high ceiling that shows full API responses); a body large enough to hit it is
// cut mid-token and breaks strict JSON.parse — in that case we fall back to a
// tolerant parser that recovers the largest well-formed prefix, so the response
// still renders as the indented tree instead of a compact raw blob.
function parseJsonBody(text: string | null | undefined): { value: unknown; truncated: boolean } | undefined {
  if (!text) return undefined;
  const t = text.trimStart();
  if (!t.startsWith('{') && !t.startsWith('[')) return undefined;
  try { return { value: JSON.parse(text), truncated: false }; } catch { /* fall through */ }
  const partial = parsePartialJson(t);
  return partial === undefined ? undefined : { value: partial, truncated: true };
}

const SIMPLE_ESCAPES = new Map<string, string>([
  ['"', '"'], ['\\', '\\'], ['/', '/'],
  ['b', '\b'], ['f', '\f'], ['n', '\n'], ['r', '\r'], ['t', '\t'],
]);

// Recursive-descent JSON parser that tolerates end-of-input at any point: an
// unfinished string is kept as far as it was read, an unfinished object/array
// drops only its incomplete trailing element, and an unfinished value is
// discarded. Used only as a fallback for truncated bodies.
function parsePartialJson(src: string): unknown {
  let i = 0;
  const n = src.length;
  const EOF = Symbol('eof');

  function skipWs(): void {
    while (i < n) {
      const c = src.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) i++;
      else break;
    }
  }

  // Decode the escape whose backslash was just consumed. Advances `i` past the
  // sequence. A \\u that runs past end-of-input consumes the rest (the string is
  // truncated); a malformed \\u yields nothing and leaves `i` on the digits, so
  // they are re-read as literals — matching the original switch exactly.
  function parseEscape(): string {
    const e = src[i++];
    if (e !== 'u') return SIMPLE_ESCAPES.get(e) ?? e;
    if (i + 4 > n) { i = n; return ''; }
    const code = parseInt(src.slice(i, i + 4), 16);
    if (Number.isNaN(code)) return '';
    i += 4;
    return String.fromCharCode(code);
  }

  function parseString(): string {
    i++; // opening quote
    let out = '';
    while (i < n) {
      const ch = src[i++];
      if (ch === '"') return out;
      if (ch !== '\\') { out += ch; continue; }
      if (i >= n) break; // truncated escape
      out += parseEscape();
    }
    return out; // truncated mid-string
  }

  function parseNumber(): number | typeof EOF {
    const start = i;
    if (src[i] === '-') i++;
    while (i < n && '0123456789.eE+-'.includes(src[i])) i++;
    // A number that runs right up to end-of-input has no delimiter after it, so
    // it was cut mid-token (e.g. "12345" truncated to "123") — drop it rather
    // than surface a wrong value.
    if (i >= n) return EOF;
    const num = Number(src.slice(start, i));
    return Number.isNaN(num) ? EOF : num;
  }

  function parseKeyword(word: string, value: unknown): unknown {
    if (!src.startsWith(word, i)) return EOF;
    i += word.length;
    return value;
  }

  function parseValue(): unknown {
    skipWs();
    if (i >= n) return EOF;
    const ch = src[i];
    if (ch === '{') return parseObject();
    if (ch === '[') return parseArray();
    if (ch === '"') return parseString();
    if (ch === '-' || (ch >= '0' && ch <= '9')) return parseNumber();
    if (ch === 't') return parseKeyword('true', true);
    if (ch === 'f') return parseKeyword('false', false);
    if (ch === 'n') return parseKeyword('null', null);
    return EOF; // unexpected/truncated token
  }

  function parseObject(): Record<string, unknown> {
    i++; // '{'
    const obj: Record<string, unknown> = {};
    while (true) {
      skipWs();
      if (i >= n) return obj;
      if (src[i] === '}') { i++; return obj; }
      if (src[i] === ',') { i++; continue; }
      if (src[i] !== '"') return obj; // truncated/malformed key
      const key = parseString();
      skipWs();
      if (i >= n || src[i] !== ':') return obj; // no colon → drop incomplete pair
      i++; // ':'
      const val = parseValue();
      if (val === EOF) return obj; // truncated value → drop incomplete pair
      obj[key] = val;
    }
  }

  function parseArray(): unknown[] {
    i++; // '['
    const arr: unknown[] = [];
    while (true) {
      skipWs();
      if (i >= n) return arr;
      if (src[i] === ']') { i++; return arr; }
      if (src[i] === ',') { i++; continue; }
      const val = parseValue();
      if (val === EOF) return arr; // truncated element
      arr.push(val);
    }
  }

  const root = parseValue();
  if (root === EOF) return undefined;
  // A clean truncation consumes everything up to the cut point. Leftover
  // non-whitespace means the parser stopped on mid-body garbage (malformed,
  // not truncated) — reject so the caller shows the raw body instead of a
  // misleadingly "recovered" empty/partial tree.
  skipWs();
  if (i < n) return undefined;
  return root;
}

function isError(r: ApiRequest): boolean {
  const b = statusBucket(r);
  return b === 'err' || b === '4xx' || b === '5xx';
}

function byteSize(r: ApiRequest): number {
  const enc = new TextEncoder();
  return (r.resBody ? enc.encode(r.resBody).length : 0)
       + (r.reqBody ? enc.encode(r.reqBody).length : 0);
}

// ── Status bucket ─────────────────────────────────────────────────────────────

// A websocket row is only "successful" as a completed handshake (101) or a
// clean close; any other status on a ws row is a failure.
function wsStatusBucket(s: RequestStatus): string {
  return s === 'closed' || s === 101 ? '2xx' : 'err';
}

function httpStatusBucket(s: number): string {
  if (s >= 500) return '5xx';
  if (s >= 400) return '4xx';
  if (s >= 300) return '3xx';
  if (s >= 200) return '2xx';
  return 'err';   // 1xx and anything below
}

// Structural rather than ApiRequest: the site map folds its own lighter record
// shape through here, and status + kind is all the bucketing actually reads.
function statusBucket(req: { status: RequestStatus; kind?: string }): string {
  const s = req.status;
  if (s === 'pending') return 'pending';
  if (s === 'error') return 'err';
  if (req.kind === 'ws') return wsStatusBucket(s);
  return typeof s === 'number' ? httpStatusBucket(s) : 'err';
}

// ── JSON rendering ────────────────────────────────────────────────────────────

function collectJsonLeaves(root: unknown, out: Array<{value: string; kind: string}>): void {
  const seen = new Set<string>();
  function walk(value: unknown): void {
    if (out.length >= MAX_JSON_LEAVES) return; // bound work on very large bodies
    if (value === null || typeof value === 'boolean') return;
    const t = typeof value;
    if (t === 'string') {
      const s = (value as string).trim();
      if (s.length >= 6 && !seen.has(s)) { seen.add(s); out.push({ value: s, kind: 'string' }); }
      return;
    }
    if (t === 'number') {
      const s = String(value);
      if (!seen.has(s)) { seen.add(s); out.push({ value: s, kind: 'number' }); }
      return;
    }
    if (Array.isArray(value)) { for (const item of value) { walk(item); } return; }
    if (t === 'object') { for (const v of Object.values(value as Record<string, unknown>)) walk(v); }
  }
  walk(root);
}

// Each rendered JSON line is a JsonRow: a depth + an ordered list of segments.
// Segments are either inert HTML (keys, brackets, commas) or interactive value
// leaves (the .ov-jv spans the click handler needs to find).
type JsonLeafKind = 'string' | 'number' | 'boolean' | 'null';
interface JsonLeafSeg { kind: 'leaf'; vkind: JsonLeafKind; display: string; raw: string }
interface JsonTextSeg { kind: 'text'; html: string }
type JsonSeg = JsonLeafSeg | JsonTextSeg;
interface JsonRow { depth: number; segs: JsonSeg[] }

function flattenJsonRows(value: unknown): JsonRow[] {
  const rows: JsonRow[] = [];
  const leafSeg = (vkind: JsonLeafKind, display: string, raw: string): JsonLeafSeg =>
    ({ kind: 'leaf', vkind, display, raw });
  const textSeg = (html: string): JsonTextSeg => ({ kind: 'text', html });
  const commaSeg = (trailing: boolean): JsonSeg[] => trailing ? [textSeg(',')] : [];
  const keySeg = (k: string | null): JsonSeg[] =>
    k === null ? [] : [textSeg(`<span class="ov-jk">"${escHtml(k)}"</span>: `)];

  let capped = false;
  // One row for a scalar leaf. Returns false when `v` is not a scalar, so the
  // caller falls through to the container / fallback handling.
  function pushScalar(v: unknown, depth: number, key: string | null, trailing: boolean): boolean {
    if (v === null) {
      rows.push({ depth, segs: [...keySeg(key), leafSeg('null', 'null', 'null'), ...commaSeg(trailing)] });
      return true;
    }
    const t = typeof v;
    if (t === 'string') {
      const str = v as string;
      const cut = str.length > MAX_JSON_LEAF_LEN ? str.slice(0, MAX_JSON_LEAF_LEN) : str;
      const ell = cut.length < str.length ? '…' : '';
      rows.push({ depth, segs: [...keySeg(key), leafSeg('string', `"${escHtml(escJsonControl(cut))}${ell}"`, cut), ...commaSeg(trailing)] });
      return true;
    }
    if (t === 'number' || t === 'boolean') {
      const display = String(v);
      rows.push({ depth, segs: [...keySeg(key), leafSeg(t as JsonLeafKind, display, display), ...commaSeg(trailing)] });
      return true;
    }
    return false;
  }

  // Open/child-rows/close for an array or object; empty containers stay inline.
  function pushContainer(
    entries: Array<[string | null, unknown]>, open: string, close: string,
    depth: number, key: string | null, trailing: boolean,
  ): void {
    if (entries.length === 0) {
      rows.push({ depth, segs: [...keySeg(key), textSeg(open + close), ...commaSeg(trailing)] });
      return;
    }
    rows.push({ depth, segs: [...keySeg(key), textSeg(open)] });
    for (let i = 0; i < entries.length; i++) {
      walk(entries[i][1], depth + 1, entries[i][0], i < entries.length - 1);
    }
    rows.push({ depth, segs: [textSeg(close), ...commaSeg(trailing)] });
  }

  function walk(v: unknown, depth: number, key: string | null, trailing: boolean): void {
    if (rows.length >= MAX_JSON_ROWS) { capped = true; return; }
    if (pushScalar(v, depth, key, trailing)) return;
    if (Array.isArray(v)) {
      pushContainer(v.map(item => [null, item]), '[', ']', depth, key, trailing);
      return;
    }
    if (typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      pushContainer(Object.keys(obj).map(k => [k, obj[k]]), '{', '}', depth, key, trailing);
      return;
    }
    // Anything left (functions, symbols, undefined) — render whatever JSON can.
    try {
      const fallback = JSON.stringify(v);
      if (fallback !== undefined) rows.push({ depth, segs: [...keySeg(key), textSeg(escHtml(fallback)), ...commaSeg(trailing)] });
    } catch { /* skip */ }
  }
  walk(value, 0, null, false);
  if (capped) {
    rows.push({ depth: 0, segs: [textSeg(`<span class="ov-jk">… ${MAX_JSON_ROWS.toLocaleString()}+ lines — display capped</span>`)] });
  }
  return rows;
}

function jsonRowToHtml(row: JsonRow, activeKey: string): string {
  let out = '  '.repeat(row.depth);
  for (const seg of row.segs) {
    if (seg.kind === 'text') { out += seg.html; continue; }
    const enc = encodeURIComponent(seg.raw);
    const isActive = activeKey?.endsWith(`|${seg.vkind}|${enc}`);
    out += `<span class="ov-jv ov-jv-${seg.vkind}${isActive ? ' ov-jv-active' : ''}" data-ov-val="${enc}" data-ov-kind="${seg.vkind}">${seg.display}</span>`;
  }
  return out;
}

interface JvVirt {
  host: HTMLElement;
  reqId: number;
  rows: JsonRow[];
  render: () => void;
  destroy: () => void;
  scrollToRow: (idx: number) => void;
  findRowIdx: (vkind: string, encVal: string) => number;
}

const JSON_LINE_HEIGHT = 14;
const JSON_VIEW_OVERSCAN = 8;
const JSON_VIEW_PAD = 6;
// Keyed by host element so duplicate placeholders for the same request (e.g.
// a row that appears in both the main list and the pin tray) each get their
// own mount and their own scroll listener cleanup.
const jvVirtMounts = new Map<HTMLElement, JvVirt>();
const jvScrollByReq = new Map<number, number>();

function captureJvScrollState(): void {
  for (const v of jvVirtMounts.values()) jvScrollByReq.set(v.reqId, v.host.scrollTop);
}

function destroyAllJvVirt(): void {
  for (const v of jvVirtMounts.values()) v.destroy();
  jvVirtMounts.clear();
}

function findJvVirtByReqId(id: number): JvVirt | undefined {
  for (const v of jvVirtMounts.values()) if (v.reqId === id) return v;
  return undefined;
}

function mountJsonVirtualizer(host: HTMLElement, rows: JsonRow[], reqId: number): JvVirt {
  const total = rows.length;
  const spacerH = total * JSON_LINE_HEIGHT + JSON_VIEW_PAD * 2;
  host.classList.add('ov-jv-virt');
  host.innerHTML = `<div class="ov-jv-spacer" style="height:${spacerH}px"></div><div class="ov-jv-window"></div>`;
  const winEl = host.querySelector<HTMLElement>('.ov-jv-window');
  if (!winEl) {
    return {
      host, reqId, rows,
      render() { /* no-op */ },
      destroy() { /* no-op */ },
      scrollToRow() { /* no-op */ },
      findRowIdx() { return -1; }
    };
  }
  const win: HTMLElement = winEl;

  let lastStart = -1, lastEnd = -1;
  function render(): void {
    const scrollTop = host.scrollTop;
    const hostH = host.clientHeight || 220;
    const visStart = Math.max(0, Math.floor((scrollTop - JSON_VIEW_PAD) / JSON_LINE_HEIGHT) - JSON_VIEW_OVERSCAN);
    const visEnd = Math.min(total, Math.ceil((scrollTop + hostH - JSON_VIEW_PAD) / JSON_LINE_HEIGHT) + JSON_VIEW_OVERSCAN);
    if (visStart === lastStart && visEnd === lastEnd) return;
    lastStart = visStart; lastEnd = visEnd;
    win.style.transform = `translateY(${JSON_VIEW_PAD + visStart * JSON_LINE_HEIGHT}px)`;
    const parts: string[] = [];
    for (let i = visStart; i < visEnd; i++) {
      parts.push(`<div class="ov-jv-line">${jsonRowToHtml(rows[i], valueHighlightKey)}</div>`);
    }
    win.innerHTML = parts.join('');
  }

  host.addEventListener('scroll', render, { passive: true });
  const initial = jvScrollByReq.get(reqId) ?? 0;
  host.scrollTop = Math.min(initial, Math.max(0, spacerH - host.clientHeight));
  render();

  return {
    host, reqId, rows,
    render,
    destroy() {
      host.removeEventListener('scroll', render);
      host.classList.remove('ov-jv-virt');
    },
    scrollToRow(idx: number) {
      const target = idx * JSON_LINE_HEIGHT - Math.max(0, host.clientHeight - JSON_LINE_HEIGHT) / 2;
      host.scrollTop = Math.max(0, target);
      lastStart = -1; lastEnd = -1;
      render();
    },
    findRowIdx(vkind: string, encVal: string): number {
      for (let i = 0; i < rows.length; i++) {
        for (const s of rows[i].segs) {
          if (s.kind === 'leaf' && s.vkind === vkind && encodeURIComponent(s.raw) === encVal) return i;
        }
      }
      return -1;
    }
  };
}

// ── DOM value search / highlight ──────────────────────────────────────────────

function normalizeNumber(s: string): string {
  const m = /-?\d+(?:\.\d+)?/.exec(s.replace(/,/g, ''));
  if (!m) return '';
  const n = Number(m[0]);
  return Number.isFinite(n) ? String(n) : '';
}

interface SearchTerm { lower: string; value: string; kind: string; numNorm: string }

function makeSearchTerm(value: string, kind: string): SearchTerm {
  return {
    lower: value.toLowerCase(), value, kind,
    numNorm: kind === 'number' ? normalizeNumber(value) : '',
  };
}

// Numbers match on normalized numeric value; strings match whole-text (either
// case) or, once long enough to be unambiguous, as a substring.
function textMatchesTerm(text: string, textLower: string, term: SearchTerm): boolean {
  if (term.kind === 'number') {
    return term.numNorm !== '' && normalizeNumber(text) === term.numNorm;
  }
  return text === term.value || textLower === term.lower
    || (term.value.length >= MIN_SUBSTRING_LEN && textLower.includes(term.lower));
}

// Text nodes worth searching: skips the overlay's own DOM and non-rendered tags.
function createPageTextWalker(): TreeWalker {
  return document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || isOverlayOwned(parent)) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
}

function findMultipleValuesInDom(queries: Array<{value: string; kind: string}>): HTMLElement[] {
  if (queries.length === 0) return [];
  const termSeen = new Set<string>();
  const terms: SearchTerm[] = [];
  for (const q of queries) {
    const key = `${q.kind}:${q.value}`;
    if (termSeen.has(key)) continue;
    termSeen.add(key);
    terms.push(makeSearchTerm(q.value, q.kind));
  }
  if (terms.length === 0) return [];

  const results: HTMLElement[] = [];
  const seenEls = new Set<HTMLElement>();
  const walker = createPageTextWalker();
  for (let node = walker.nextNode(); node && results.length < MAX_VALUE_HIGHLIGHTS; node = walker.nextNode()) {
    const text = (node.nodeValue ?? '').trim();
    if (!text) continue;
    const textLower = text.toLowerCase();
    if (!terms.some(term => textMatchesTerm(text, textLower, term))) continue;
    const parent = (node as Text).parentElement;
    if (parent && !seenEls.has(parent)) { seenEls.add(parent); results.push(parent); }
  }
  return results;
}

// Each scan takes a `collect` sink that returns false once the result cap is
// reached, so a scan can stop early exactly as the original inline loops did.
type CollectFn = (el: HTMLElement | null) => boolean;

function scanTextNodes(term: SearchTerm, collect: CollectFn): void {
  const walker = createPageTextWalker();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.nodeValue ?? '').trim();
    if (!text) continue;
    if (!textMatchesTerm(text, text.toLowerCase(), term)) continue;
    if (!collect((node as Text).parentElement)) break;
  }
}

function scanInputValues(term: SearchTerm, collect: CollectFn): void {
  const inputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
  for (const el of inputs) {
    const v = (el.value ?? '').trim();
    if (!v) continue;
    const matches = v === term.value
      || (term.value.length >= MIN_SUBSTRING_LEN && v.toLowerCase().includes(term.lower));
    if (matches && !collect(el)) break;
  }
}

function scanUrlAttributes(term: SearchTerm, collect: CollectFn): void {
  const urlEls = document.querySelectorAll<HTMLElement>('img[src], a[href], source[src], video[src], audio[src], iframe[src]');
  for (const el of urlEls) {
    const src = el.getAttribute('src') ?? el.getAttribute('href') ?? '';
    if (!src) continue;
    const matches = src === term.value || src.endsWith(term.value)
      || (term.value.length >= MIN_SUBSTRING_LEN && src.includes(term.value));
    if (matches && !collect(el)) break;
  }
}

function isUrlLikeValue(value: string, kind: string): boolean {
  return kind === 'string'
    && (/^https?:\/\//i.test(value) || value.startsWith('/') || value.startsWith('data:'));
}

function findValuesInDom(value: string, kind: string): HTMLElement[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (kind === 'boolean' || kind === 'null') return [];
  // Numbers match by normalized numeric value, not substring, so single-digit
  // counts (e.g. "5 Branches") are unambiguous and exempt from the length floor
  // that suppresses noisy short-string matches.
  if (kind !== 'number' && trimmed.length < MIN_VALUE_LEN) return [];

  const results: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  const collect: CollectFn = el => {
    if (!el || seen.has(el) || isOverlayOwned(el)) return true;
    seen.add(el);
    results.push(el);
    return results.length < MAX_VALUE_HIGHLIGHTS;
  };
  const term = makeSearchTerm(trimmed, kind);

  scanTextNodes(term, collect);
  if (kind === 'string' && results.length < MAX_VALUE_HIGHLIGHTS) scanInputValues(term, collect);
  if (isUrlLikeValue(trimmed, kind) && results.length < MAX_VALUE_HIGHLIGHTS) {
    scanUrlAttributes(term, collect);
  }
  return results;
}

function focusValueHighlight(): void {
  for (const el of valueHighlightEls) el.classList.remove('ov-value-current');
  const el = valueHighlightEls[valueHighlightIndex];
  if (!el) return;
  el.classList.add('ov-value-current');
  const rect = el.getBoundingClientRect();
  const margin = 60;
  const visible = rect.top >= margin && rect.bottom <= window.innerHeight - margin;
  if (!visible) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  positionValueCycler();
}

// Park the cycler above the current match, flipping below it when the match sits
// too close to the top of the viewport.
function positionValueCycler(): void {
  const cycler = document.getElementById('ov-value-cycler');
  const el = valueHighlightEls[valueHighlightIndex];
  if (!cycler || !el) return;
  const rect = el.getBoundingClientRect();
  const below = rect.top < 48;
  cycler.classList.toggle('ov-vc-below', below);
  cycler.style.top = `${window.scrollY + (below ? rect.bottom + 10 : rect.top - 10)}px`;
  cycler.style.left = `${Math.max(window.scrollX + 4, window.scrollX + rect.left)}px`;
}

function clearValueHighlights(): void {
  for (const el of valueHighlightEls) {
    el.classList.remove('ov-value-match');
    el.classList.remove('ov-value-current');
  }
  valueHighlightEls = [];
  valueHighlightIndex = 0;
  valueHighlightKey = '';
  for (const el of document.querySelectorAll('.ov-jv-active')) el.classList.remove('ov-jv-active');
  document.getElementById('ov-value-cycler')?.remove();
}

function clearBulkHighlights(): void {
  for (const el of bulkHighlightEls) el.classList.remove('ov-value-match');
  bulkHighlightEls = [];
  bulkHighlightRowId = -1;
}

function clearJvHover(): void {
  if (jvHoverTimer !== null) { clearTimeout(jvHoverTimer); jvHoverTimer = null; }
  for (const el of jvHoverEls) el.classList.remove('ov-value-hover');
  jvHoverEls = [];
  jvHoverKey = '';
}

// Preview-highlight the page elements matching a JSON value on hover. Kept
// separate from the click selection (ov-value-match / valueHighlightEls) so
// hovering never disturbs a pinned selection. Debounced because findValuesInDom
// walks the DOM and the pointer can sweep across many .ov-jv spans.
// The request a JSON value belongs to. Keyed off the tree host rather than a
// row, because the tree is rendered in the docked inspector, not inside .ov-row.
function jvRequestId(jv: HTMLElement): string {
  return jv.closest<HTMLElement>('.ov-body-json')?.dataset.id ?? '';
}

function runJvHover(jv: HTMLElement): void {
  const rowId = jvRequestId(jv);
  const encVal = jv.dataset.ovVal ?? '';
  const kind = jv.dataset.ovKind ?? 'string';
  const key = `${rowId}|${kind}|${encVal}`;
  if (key === jvHoverKey) return;            // already previewing this value
  clearJvHover();
  if (key === valueHighlightKey) return;     // already shown via click selection
  jvHoverKey = key;
  jvHoverTimer = setTimeout(() => {
    jvHoverTimer = null;
    if (jvHoverKey !== key) return;          // moved on before the timer fired
    const matches = findValuesInDom(safeDecodeURIComponent(encVal), kind);
    jvHoverEls = matches;
    for (const el of matches) el.classList.add('ov-value-hover');
  }, 120);
}

function runBulkHighlight(rowId: number): void {
  clearBulkHighlights();
  const req = requests.get(rowId);
  if (!req?.resBody) return;
  const parsed = tryParseJsonContainer(req.resBody);
  if (parsed === undefined) return;
  const leaves: Array<{value: string; kind: string}> = [];
  collectJsonLeaves(parsed, leaves);
  const matches = findMultipleValuesInDom(leaves);
  bulkHighlightEls = matches;
  bulkHighlightRowId = rowId;
  for (const el of matches) el.classList.add('ov-value-match');
}

// The value-trace cycler: floats over the page beside the current match, naming
// the traced value and offering ‹ › to step through the rest. A zero-match state
// still shows, anchored to the panel, so "not on this screen" is an answer too.
function setValueStatusBadge(jv: HTMLElement, total: number, index: number): void {
  let el = document.getElementById('ov-value-cycler');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ov-value-cycler';
    el.className = 'ov-value-cycler';
    el.addEventListener('click', onValueCyclerClick);
    document.documentElement.appendChild(el);
  }
  const label = middleTruncate(safeDecodeURIComponent(jv.dataset.ovVal ?? ''), 28);
  const nav = total > 1
    ? `<span class="ov-vc-nav"><button class="ov-vc-btn" data-step="-1">‹</button><span class="ov-vc-pos">${index + 1} / ${total}</span><button class="ov-vc-btn" data-step="1">›</button></span>`
    : `<span class="ov-vc-pos">${total === 1 ? '1 match' : 'not on this screen'}</span>`;
  el.dataset.empty = total === 0 ? '1' : '';
  el.innerHTML = `<span class="ov-vc-val">${escHtml(label)}</span><span class="ov-vc-lbl">match</span>${nav}`;
  if (total === 0) {
    // No anchor to sit beside — park it against the panel's top-left corner.
    const panel = $('ov-panel')?.getBoundingClientRect();
    el.classList.remove('ov-vc-below');
    el.style.top = `${window.scrollY + (panel ? panel.top - 34 : 12)}px`;
    el.style.left = `${window.scrollX + (panel ? panel.left : 12)}px`;
    return;
  }
  positionValueCycler();
}

function onValueCyclerClick(e: Event): void {
  const btn = (e.target as Element).closest<HTMLElement>('.ov-vc-btn');
  const step = Number(btn?.dataset.step);
  const total = valueHighlightEls.length;
  if (!Number.isFinite(step) || total < 2) return;
  e.stopPropagation();
  valueHighlightIndex = (valueHighlightIndex + step + total) % total;
  focusValueHighlight();
  const pos = document.querySelector('#ov-value-cycler .ov-vc-pos');
  if (pos) pos.textContent = `${valueHighlightIndex + 1} / ${total}`;
}

function handleJsonValueClick(jv: HTMLElement): void {
  clearJvHover();
  clearBulkHighlights();
  const rowId = jvRequestId(jv);
  const encVal = jv.dataset.ovVal ?? '';
  const kind = jv.dataset.ovKind ?? 'string';
  const key = `${rowId}|${kind}|${encVal}`;
  const value = safeDecodeURIComponent(encVal);
  if (key === valueHighlightKey && valueHighlightEls.length > 1) {
    valueHighlightIndex = (valueHighlightIndex + 1) % valueHighlightEls.length;
    focusValueHighlight();
    setValueStatusBadge(jv, valueHighlightEls.length, valueHighlightIndex);
    return;
  }
  clearValueHighlights();
  const matches = findValuesInDom(value, kind);
  valueHighlightKey = key;
  valueHighlightEls = matches;
  valueHighlightIndex = 0;
  for (const el of matches) el.classList.add('ov-value-match');
  if (matches.length > 0) focusValueHighlight();
  jv.classList.add('ov-jv-active');
  setValueStatusBadge(jv, matches.length, 0);
}

function reattachValueHighlight(): void {
  if (!valueHighlightKey) return;
  const parts = valueHighlightKey.split('|');
  if (parts.length < 3) return;
  const [rowIdStr, kind, encVal] = parts;
  const rowId = Number(rowIdStr);

  // Virtualized path: target row may not be in the DOM window. Scroll the
  // virtualizer to bring it in, then look up the (now rendered) span.
  const v = findJvVirtByReqId(rowId);
  if (v) {
    const idx = v.findRowIdx(kind, encVal);
    if (idx < 0) { clearValueHighlights(); return; }
    const lineTop = JSON_VIEW_PAD + idx * JSON_LINE_HEIGHT;
    const viewTop = v.host.scrollTop;
    const viewBot = viewTop + v.host.clientHeight;
    if (lineTop < viewTop || lineTop + JSON_LINE_HEIGHT > viewBot) v.scrollToRow(idx);
    const span = v.host.querySelector<HTMLElement>(`.ov-jv[data-ov-kind="${kind}"][data-ov-val="${encVal}"]`);
    if (span) setValueStatusBadge(span, valueHighlightEls.length, valueHighlightIndex);
    return;
  }

  // Non-virtualized path (kept as a fallback, e.g. plain-text or empty bodies).
  const span = document.querySelector<HTMLElement>(
    `#ov-dock .ov-body-json[data-id="${rowIdStr}"] .ov-jv[data-ov-kind="${kind}"][data-ov-val="${encVal}"]`
  );
  if (!span) { clearValueHighlights(); return; }
  span.classList.add('ov-jv-active');
  setValueStatusBadge(span, valueHighlightEls.length, valueHighlightIndex);
}

// ── Row + detail HTML ─────────────────────────────────────────────────────────

function headerRowsHtml(label: string, headers: HeaderPair[] | null | undefined): string {
  if (!headers || headers.length === 0) {
    return `<div class="ov-detail-section"><div class="ov-detail-label">${label}</div><div class="ov-body-none">No headers</div></div>`;
  }
  const rows = headers.map(([n, v]) =>
    `<div class="ov-hdr-row"><span class="ov-hdr-name">${escHtml(n)}</span><span class="ov-hdr-val">${escHtml(v)}</span></div>`
  ).join('');
  return `<div class="ov-detail-section">
    <div class="ov-detail-label">${label}</div>
    <div class="ov-hdr-table">${rows}</div>
  </div>`;
}

function detailPanelHtml(req: ApiRequest): string {
  const isWs = req.kind === 'ws';
  const activeTab: DetailTab = detailTabs.get(req.id) ?? (isWs ? 'frames' : 'response');
  const tabs: DetailTab[] = isWs ? ['frames', 'headers', 'request'] : ['response', 'request', 'headers', 'timing'];

  const tabIsCopyable = (
    (activeTab === 'response' && req.resBody != null) ||
    (activeTab === 'request' && req.reqBody != null) ||
    (activeTab === 'headers' && ((req.reqHeaders?.length ?? 0) > 0 || (req.resHeaders?.length ?? 0) > 0)) ||
    (activeTab === 'timing' && req.ms != null) ||
    (activeTab === 'frames' && (req.messages?.length ?? 0) > 0)
  );
  const copyTabBtn = tabIsCopyable
    ? `<button class="ov-copy-tab-btn" data-id="${req.id}" data-tab="${activeTab}" title="Copy ${activeTab}">copy</button>`
    : '';

  const tabsHtml = `<div class="ov-tabs" data-id="${req.id}">
    ${tabs.map(t => `<button class="ov-tab${activeTab === t ? ' ov-tab-active' : ''}" data-tab="${t}">${t}</button>`).join('')}
    <div class="ov-tab-spacer"></div>
    ${copyTabBtn}
    <button class="ov-copy-btn" data-url="${encodeURIComponent(req.url || '')}">copy curl</button>
  </div>`;

  return `<div class="ov-detail" data-id="${req.id}">${detailHeadHtml(req)}${tabsHtml}${detailPaneHtml(req, activeTab)}</div>`;
}

// Identity block above the tabs: method, outcome, origin + path, and — when the
// request was attributed to an element — the trigger banner that reveals it.
function detailHeadHtml(req: ApiRequest): string {
  const method = req.method || 'GET';
  const bucket = statusBucket(req);
  const statusLabel = req.status === 'pending'
    ? '<span class="ov-dh-status s-pending"><span class="ov-spinner"></span>pending</span>'
    : `<span class="ov-dh-status s-${bucket}">${escHtml(String(req.status))}</span>`;

  const meta = [req.ms != null ? formatDuration(req.ms) : null, req.kind]
    .filter(Boolean).join(' · ');

  let origin = '';
  let path = req.url;
  try {
    const u = new URL(req.url);
    origin = u.origin;
    path = u.pathname + u.search;
  } catch { /* relative or malformed — show the whole thing as the path */ }

  const isPinned = pinnedIds.has(req.id);
  const trigger = req.element
    ? `<button class="ov-dh-trigger" data-sel="${encodeURIComponent(req.element.selector)}">
        <span class="ov-dh-trigger-lbl">◍ triggered by</span>
        <span class="ov-dh-trigger-el">${escHtml(middleTruncate(req.element.label || req.element.selector, 44))}</span>
        <span class="ov-dh-trigger-hint">→ reveal on page</span>
      </button>`
    : '<div class="ov-dh-trigger ov-dh-trigger-bg"><span class="ov-dh-trigger-lbl">◌ background</span><span class="ov-dh-trigger-hint">no element attributed</span></div>';

  return `<div class="ov-dh">
    <div class="ov-dh-top">
      <span class="ov-dh-method m-${safeMethodClass(method)}">${escHtml(method)}</span>
      ${statusLabel}
      <span class="ov-dh-meta">${escHtml(meta)}</span>
      <span class="ov-dh-spacer"></span>
      <button class="ov-pin-btn ov-dh-pin${isPinned ? ' on' : ''}" data-id="${req.id}" title="Pin">${isPinned ? '★ pinned' : '☆ pin'}</button>
      <button class="ov-dh-close" data-id="${req.id}" title="Close inspector">✕</button>
    </div>
    <div class="ov-dh-url"><span class="ov-dh-origin">${escHtml(origin)}</span><span class="ov-dh-path">${escHtml(path)}</span></div>
    ${trigger}
  </div>`;
}

function detailPaneHtml(req: ApiRequest, activeTab: DetailTab): string {
  switch (activeTab) {
    case 'response': return `<div class="ov-panel">${responseBodyHtml(req)}</div>`;
    case 'request':  return `<div class="ov-panel">${requestBodyHtml(req)}</div>`;
    case 'headers':  return headersPaneHtml(req);
    case 'timing':   return timingPaneHtml(req);
    case 'frames':   return framesPaneHtml(req);
    default:         return '';
  }
}

function responseBodyHtml(req: ApiRequest): string {
  if (req.resBody == null) {
    return req.status === 'pending'
      ? '<div class="ov-body-none">Waiting…</div>'
      : '<div class="ov-body-none">No response body</div>';
  }
  const parsed = parseJsonBody(req.resBody);
  if (parsed === undefined) {
    return `<pre class="ov-body-pre">${escHtml(formatBody(req.resBody).slice(0, 3000))}</pre>`;
  }
  const truncNote = parsed.truncated
    ? '<div class="ov-trunc-note">⚠ response truncated — showing recovered partial body</div>'
    : '';
  const bytes = req.resBody.length;
  const size = bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
  const bar = `<div class="ov-body-bar">
      <span class="ov-body-meta">json · ${size}</span>
      <button class="ov-reveal-all${bulkHighlightRowId === req.id ? ' on' : ''}" data-id="${req.id}">⊹ reveal all values on page</button>
    </div>`;
  // The tree itself is mounted by the virtualizer once the pane is in the DOM.
  return `${truncNote}${bar}<div class="ov-body-json" data-id="${req.id}"></div>`;
}

function requestBodyHtml(req: ApiRequest): string {
  return req.reqBody
    ? `<pre class="ov-body-pre">${escHtml(formatBody(req.reqBody).slice(0, 3000))}</pre>`
    : '<div class="ov-body-none">No request body</div>';
}

function headersPaneHtml(req: ApiRequest): string {
  return `<div class="ov-panel">
      <div class="ov-detail-label" style="margin-bottom:4px">Request</div>
      ${headerRowsHtml('', req.reqHeaders)}
      <div class="ov-detail-label" style="margin:10px 0 4px">Response</div>
      ${headerRowsHtml('', req.resHeaders)}
    </div>`;
}

// Everything here is measured. The hook times the call from the page's own
// context, so start-to-finish is all it can see — there is no DNS/TCP/TTFB
// breakdown to show, and inventing one would be worse than omitting it.
function timingPaneHtml(req: ApiRequest): string {
  const pending = req.status === 'pending';
  const started = req.ts ? new Date(req.ts).toLocaleTimeString(undefined, { hour12: false }) : '—';
  return `<div class="ov-panel">
    <div class="ov-kv">
      <div class="ov-kv-k">Duration</div><div class="ov-kv-v">${pending ? 'measuring…' : formatDuration(req.ms)}</div>
      <div class="ov-kv-k">Started</div><div class="ov-kv-v">${escHtml(started)}</div>
      <div class="ov-kv-k">Kind</div><div class="ov-kv-v">${escHtml(req.kind ?? 'fetch')}</div>
    </div>
    <div class="ov-kv-note">Measured from the page, so this is the whole round trip. A per-phase breakdown would need the browser's Resource Timing data, which this build does not read.</div>
  </div>`;
}

function framesPaneHtml(req: ApiRequest): string {
  const msgs = req.messages ?? [];
  const body = msgs.length === 0
    ? '<div class="ov-body-none">No messages yet</div>'
    : msgs.slice(-100).map(m => `<div class="ov-ws-msg ov-ws-${m.dir}">
            <span class="ov-ws-dir" title="${m.dir === 'sent' ? 'sent' : 'received'}">${m.dir === 'sent' ? '↑' : '↓'}</span>
            <span class="ov-ws-t">+${m.ts}ms</span>
            <pre class="ov-ws-body">${escHtml(m.body.slice(0, 500))}</pre>
          </div>`).join('');
  return `<div class="ov-panel"><div class="ov-ws-thread">${body}</div></div>`;
}

// '—' when the request never completed, ms under a second, otherwise seconds.
function formatDuration(ms: number | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// Short, human-readable label for the initiator column: the element that fired
// the request, or 'background' for anything outside the attribution window.
function initiatorLabel(req: ApiRequest): string {
  if (!req.element) return 'background';
  const raw = req.element.label || req.element.selector || 'element';
  return middleTruncate(raw, 28);
}

function rowHtml(req: ApiRequest): string {
  const bucket = statusBucket(req);
  const statusLabel = req.status === 'pending' ? '•••' : String(req.status);
  const method = req.method || 'GET';
  const isPage = !!req.element;
  const isExpanded = expandedIds.has(req.id);
  const isPinned = pinnedIds.has(req.id);
  const shortUrl = middleTruncate(urlPath(req.url), 72);

  const durLabel = formatDuration(req.ms);

  const wsFr = req.kind === 'ws' && req.messages?.length
    ? `<span class="ov-fr">${req.messages.length}fr</span>` : '';

  return `<div class="ov-row${isExpanded ? ' ov-expanded' : ''}${isPinned ? ' ov-pinned' : ''}"
      data-id="${req.id}" data-sel="${encodeURIComponent(req.element?.selector ?? '')}"
      title="${escHtml(req.url)}${req.element?.label ? ' — ' + escHtml(req.element.label) : ''}">
    <div class="ov-c ov-c-method m-${safeMethodClass(method)}">${escHtml(method)}</div>
    <div class="ov-c ov-c-url">
      <span class="ov-init-dot${isPage ? '' : ' ov-init-bg'}"></span>
      <span class="ov-url-path">${escHtml(shortUrl)}</span>
      ${wsFr}
    </div>
    <div class="ov-c ov-c-init${isPage ? '' : ' ov-init-bg'}">${isPage ? '◍' : '◌'} ${escHtml(initiatorLabel(req))}</div>
    <div class="ov-c ov-c-status s-${bucket}">${statusLabel}</div>
    <div class="ov-c ov-c-dur">${durLabel}</div>
    <div class="ov-c ov-c-act">
      <button class="ov-pin-btn${isPinned ? ' on' : ''}" data-id="${req.id}" title="Pin">${isPinned ? '★' : '☆'}</button>
      <button class="ov-copy-btn" data-url="${encodeURIComponent(req.url || '')}" title="Copy URL">copy</button>
    </div>
  </div>`;
}

// ── Views ─────────────────────────────────────────────────────────────────────

// Column headings above the log, matching the row grid.
const LIST_HEAD_HTML = `<div class="ov-list-head">
    <span class="ov-lh ov-lh-method">mthd</span>
    <span class="ov-lh ov-lh-path">path</span>
    <span class="ov-lh ov-lh-init">initiator</span>
    <span class="ov-lh ov-lh-status">stat</span>
    <span class="ov-lh ov-lh-dur">time</span>
    <span class="ov-lh ov-lh-act"></span>
  </div>`;

// One of the design's dormant/empty cards: icon, title, body, optional footnote.
function stateCardHtml(tone: string, icon: string, title: string, body: string, note = ''): string {
  return `<div class="ov-state ov-state-${tone}">
    <div class="ov-state-ico">${icon}</div>
    <div class="ov-state-title">${title}</div>
    <div class="ov-state-body">${body}</div>
    ${note ? `<div class="ov-state-note">${note}</div>` : ''}
  </div>`;
}

function pinnedViewHtml(): string {
  const pinned = [...requests.values()].filter(r => pinnedIds.has(r.id)).reverse();
  if (pinned.length === 0) {
    return stateCardHtml('idle', '★', 'Nothing pinned',
      'Pin a request with ☆ to keep it reachable while the log scrolls. Pins are stored by method and path, so they survive reloads.');
  }
  return LIST_HEAD_HTML + pinned.map(r => rowHtml(r)).join('');
}

// Is the site-map surface the one on screen? sitemap.ts asks before it re-renders,
// so the engine never has to know how the overlay switches views.
function siteMapVisible(): boolean {
  return currentView === 'map';
}

// The site-map surface. Discovery, static analysis and page verification live in
// sitemap.ts; this renders whatever the engine has built so far, or the primer
// with a Build control when nothing has been discovered yet.
function siteMapViewHtml(): string {
  if (smBuiltAt || smIsBuilding()) return smSiteMapHtml();
  return `${stateCardHtml('idle', '⌗', 'No site map built yet',
    'Map every page of this site against the API endpoints it uses. Pages are found from links, sitemap.xml and robots.txt; endpoints from captured traffic, any published OpenAPI document, and static analysis of page HTML and JS.',
    'Nothing is navigated without asking — logout, delete and reset routes are never loaded')}
    <div class="ov-tier-legend">
      <span class="ov-tier ov-tier-observed"><span class="ov-tier-swatch"></span>observed · facts</span>
      <span class="ov-tier ov-tier-declared"><span class="ov-tier-swatch"></span>declared · openapi</span>
      <span class="ov-tier ov-tier-inferred"><span class="ov-tier-swatch"></span>inferred · candidates</span>
    </div>
    <div class="ov-state-actions"><button class="ov-btn-primary" id="ov-build-map">Build map</button></div>`;
}

// ── Footer ────────────────────────────────────────────────────────────────────

function renderFooter(): void {
  const footer = $('ov-footer');
  if (!footer) return;
  let err = 0, slow = 0, xfer = 0;
  for (const r of requests.values()) {
    if (isError(r)) err++;
    if ((r.ms ?? 0) > 800) slow++;
    xfer += byteSize(r);
  }
  // A zero-count button is inert — unless its flag is on. Then it must stay
  // clickable: it is the only way to switch the flag off, and while it is on it
  // hides every row.
  const errOn = activeFlags.has('err');
  const slowOn = activeFlags.has('slow');
  footer.innerHTML = `
    <span class="ov-fstat">req <b>${requests.size}</b></span>
    <button class="ov-fstat ov-fstat-btn${err ? ' ov-fstat-err' : ''}${errOn ? ' on' : ''}" data-f="err" ${err || errOn ? '' : 'disabled'} data-tip="Filter: error requests">err <b>${err}</b></button>
    <button class="ov-fstat ov-fstat-btn${slow ? ' ov-fstat-warn' : ''}${slowOn ? ' on' : ''}" data-f="slow" ${slow || slowOn ? '' : 'disabled'} data-tip="Filter: slow (&gt;800ms)">slow <b>${slow}</b></button>
    <span class="ov-fstat">xfer <b>${(xfer / 1024).toFixed(1)}kb</b></span>
    <span class="ov-fspacer"></span>
    <span class="ov-fnote">${paused ? 'paused' : 'capturing'} · ${location.host}</span>
  `;
}

// ── Main render ───────────────────────────────────────────────────────────────

// Cap regex search input length per field. A pathological pattern (e.g. /(a+)+$/)
// on a 50KB body will hang the page; truncation bounds the worst case to a slice.
const REGEX_MAX_INPUT = 8000;

// The search box compiled into a predicate. `invalid` drives the red outline on
// the input when a regex fails to compile.
interface TextMatcher { test: (r: ApiRequest) => boolean; invalid: boolean }

function regexMatchesRequest(r: ApiRequest, regex: RegExp): boolean {
  const clip = (str: string): string => str.length > REGEX_MAX_INPUT ? str.slice(0, REGEX_MAX_INPUT) : str;
  return regex.test(clip(r.url || ''))
      || (r.reqBody != null && regex.test(clip(r.reqBody)))
      || (r.resBody != null && regex.test(clip(r.resBody)));
}

function buildTextMatcher(rawFilter: string): TextMatcher {
  const filterText = caseSensitiveSearch ? rawFilter : rawFilter.toLowerCase();
  if (!filterText) return { test: () => true, invalid: false };

  if (regexSearch) {
    let regex: RegExp;
    try { regex = new RegExp(rawFilter, caseSensitiveSearch ? '' : 'i'); }
    catch { return { test: () => false, invalid: true }; }
    return { test: r => regexMatchesRequest(r, regex), invalid: false };
  }
  if (caseSensitiveSearch) {
    return {
      invalid: false,
      test: r => (r.url || '').includes(filterText)
        || (r.reqBody?.includes(filterText) ?? false)
        || (r.resBody?.includes(filterText) ?? false),
    };
  }
  return {
    invalid: false,
    test: r => (r._lcUrl ?? '').includes(filterText)
      || (r._lcReqBody?.includes(filterText) ?? false)
      || (r._lcResBody?.includes(filterText) ?? false),
  };
}

// AND semantics: 'err' + 'slow' both selected ⇒ only slow errors.
function matchesFlags(r: ApiRequest): boolean {
  if (activeFlags.size === 0) return true;
  if (activeFlags.has('err')  && !isError(r)) return false;
  if (activeFlags.has('slow') && (r.ms ?? 0) <= 800) return false;
  return true;
}

// Every chip/flag filter except the text box. An empty set means "no constraint".
function matchesChipFilters(r: ApiRequest): boolean {
  if (activeMethods.size > 0 && !activeMethods.has((r.method || 'GET').toUpperCase())) return false;
  if (activeStatus.size > 0 && !activeStatus.has(statusBucket(r))) return false;
  if (activeInitiators.size > 0 && !activeInitiators.has(r.element ? 'page' : 'bg')) return false;
  return matchesFlags(r);
}

// Newest first, stopping at RENDER_LIMIT so a huge log can't stall the render.
function selectVisibleRequests(snapshot: ApiRequest[], matcher: TextMatcher): ApiRequest[] {
  const visible: ApiRequest[] = [];
  for (let i = snapshot.length - 1; i >= 0 && visible.length < RENDER_LIMIT; i--) {
    const r = snapshot[i];
    if (!matchesChipFilters(r)) continue;
    if (!matcher.test(r)) continue;
    visible.push(r);
  }
  return visible;
}

// Two distinct empty states: nothing captured yet (listening) versus captured
// something the current filters exclude.
function listEmptyStateHtml(): string {
  if (requests.size === 0) {
    return `<div class="ov-empty">${stateCardHtml('live', '<span class="ov-live-dot"></span>', 'Listening…',
      'No API calls captured yet. Interact with the page to record its first request.',
      '0 requests')}</div>`;
  }
  return `<div class="ov-empty">${stateCardHtml('idle', '⌕', 'No matches',
    'Nothing in the log matches the current search and filters.',
    `${requests.size} captured`)}</div>`;
}

// Mount a virtualizer for every visible JSON response placeholder.
function mountVisibleJsonTrees(root: HTMLElement): void {
  for (const host of root.querySelectorAll<HTMLElement>('.ov-body-json[data-id]')) {
    const id = Number(host.dataset.id);
    const req = requests.get(id);
    if (!req?.resBody) continue;
    const parsed = tryParseJsonContainer(req.resBody);
    if (parsed === undefined) continue;
    jvVirtMounts.set(host, mountJsonVirtualizer(host, flattenJsonRows(parsed), id));
  }
}

// The docked inspector. At most one request is open at a time, so the dock shows
// the current selection and hides itself when there is none.
function selectedRequestId(): number | null {
  for (const id of expandedIds) if (requests.has(id)) return id;
  return null;
}

function closeDock(): void {
  const dock = $('ov-dock');
  if (!dock) return;
  dock.innerHTML = '';
  dock.toggleAttribute('hidden', true);
}

function renderDock(): void {
  const dock = $('ov-dock');
  if (!dock) return;
  const id = currentView === 'map' ? null : selectedRequestId();
  const req = id == null ? undefined : requests.get(id);
  if (!req) { closeDock(); return; }
  dock.toggleAttribute('hidden', false);
  dock.innerHTML = detailPanelHtml(req);
  mountVisibleJsonTrees(dock);
}

function viewBodyHtml(visible: ApiRequest[]): string {
  if (currentView === 'map') return siteMapViewHtml();
  if (currentView === 'pinned') return pinnedViewHtml();
  return visible.length === 0
    ? listEmptyStateHtml()
    : LIST_HEAD_HTML + visible.map(r => rowHtml(r)).join('');
}

function syncViewTabs(): void {
  for (const tab of document.querySelectorAll<HTMLElement>('#ov-views .ov-view')) {
    tab.classList.toggle('on', tab.dataset.v === currentView);
  }
  const pinN = $('ov-view-pin-n');
  if (pinN) {
    pinN.textContent = String(pinnedIds.size);
    pinN.toggleAttribute('hidden', pinnedIds.size === 0);
  }
}

function renderList(): void {
  if (!activated) return;
  if (dockState === 'pill') { refreshPill(); return; }

  const list = $('ov-list');
  const countEl = $('ov-count');
  if (!list) return;
  syncViewTabs();
  syncChipState();

  const matcher = buildTextMatcher(filterInput?.value ?? '');
  filterInput?.classList.toggle('ov-filter-invalid', matcher.invalid);

  const snapshot = Array.from(requests.values());
  const visible = selectVisibleRequests(snapshot, matcher);

  if (countEl) {
    // Over a built map the request tally means nothing; report the discovery
    // instead. Before a build there is nothing to report, so the tally stands.
    const t = smTally();
    countEl.textContent = currentView === 'map' && (smBuiltAt || smIsBuilding())
      ? `${t.pages}p/${t.endpoints}e`
      : `${visible.length}/${requests.size}`;
  }
  updateChipCounts(snapshot);
  updateSearchHits(visible.length);

  // Snapshot scroll positions of currently mounted JSON virtualizers, then tear
  // them down — the innerHTML writes below will detach their DOM hosts.
  captureJvScrollState();
  destroyAllJvVirt();

  list.innerHTML = viewBodyHtml(visible);
  renderDock();

  reattachValueHighlight();
  reattachRevHighlight();
  renderFooter();
}

// Live match count beside the search box; blank when nothing is being searched.
function updateSearchHits(count: number): void {
  const el = $('ov-hits');
  if (!el) return;
  const term = filterInput?.value ?? '';
  el.textContent = term ? `${count} hit${count === 1 ? '' : 's'}` : '';
}

// The active sets are the only source of truth for chip selection — they may
// have been restored from storage after the chips were built idle — so every
// render re-derives the .on class from them.
function chipIsOn(chip: HTMLElement): boolean {
  const { s, m, i } = chip.dataset;
  if (s) return activeStatus.has(s);
  if (m) return activeMethods.has(m);
  if (i) return activeInitiators.has(i);
  return false;
}

function syncChipState(): void {
  for (const chip of document.querySelectorAll<HTMLElement>('#ov-chips .ov-chip')) {
    chip.classList.toggle('on', chipIsOn(chip));
  }
}

function updateChipCounts(snapshot: ApiRequest[]): void {
  const counts: Record<string, number> = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
  for (const r of snapshot) {
    const b = statusBucket(r);
    if (b in counts) counts[b]++;
  }
  for (const chip of document.querySelectorAll<HTMLElement>('.ov-chip[data-s]')) {
    const s = chip.dataset.s ?? '';
    const badge = chip.querySelector('.ov-chip-count');
    if (badge) badge.textContent = String(counts[s] ?? 0);
  }
}

// ── Event delegation ──────────────────────────────────────────────────────────

// The log and the docked inspector both host rows/values, so each gets the same
// delegate; the WeakSet keeps a re-bind on the same container a no-op.
const rowEventsBound = new WeakSet<HTMLElement>();

function bindListDelegation(list: HTMLElement): void {
  if (rowEventsBound.has(list)) return;
  rowEventsBound.add(list);

  list.addEventListener('mouseover', (e: Event) => {
    const jv = (e.target as Element).closest<HTMLElement>('.ov-jv');
    if (jv && list.contains(jv)) {
      const related = (e as MouseEvent).relatedTarget as Element | null;
      if (related && jv.contains(related)) return;
      clearHighlight();   // value preview takes over from the row→element highlight
      runJvHover(jv);
      return;
    }
    const row = (e.target as Element).closest<HTMLElement>('.ov-row');
    if (!row || !list.contains(row)) return;
    const related = (e as MouseEvent).relatedTarget as Element | null;
    if (related && row.contains(related)) return;
    const sel = safeDecodeURIComponent(row.dataset.sel ?? '');
    if (sel) highlightEl(sel);
  });

  list.addEventListener('mouseout', (e: Event) => {
    const jv = (e.target as Element).closest<HTMLElement>('.ov-jv');
    if (jv) {
      const related = (e as MouseEvent).relatedTarget as Element | null;
      if (related && jv.contains(related)) return;
      clearJvHover();
      return;
    }
    const row = (e.target as Element).closest<HTMLElement>('.ov-row');
    if (!row) return;
    const related = (e as MouseEvent).relatedTarget as Element | null;
    if (related && row.contains(related)) return;
    clearHighlight();
  });

  list.addEventListener('click', onListClick);
}

// Flash a transient label on a copy button, then restore it.
function flashCopyLabel(btn: HTMLElement, label: string): void {
  btn.textContent = label;
  setTimeout(() => { btn.textContent = 'copy'; }, 900);
}

function copyToClipboard(btn: HTMLElement, text: string, okLabel: string): void {
  if (!navigator.clipboard?.writeText) { flashCopyLabel(btn, 'failed'); return; }
  navigator.clipboard.writeText(text).then(
    () => flashCopyLabel(btn, okLabel),
    () => flashCopyLabel(btn, 'failed'),
  );
}

// Plain-text rendering of one detail tab, for the per-tab copy button.
function detailTabText(req: ApiRequest, tab: DetailTab): string {
  switch (tab) {
    case 'response': return req.resBody ?? '';
    case 'request':  return req.reqBody ?? '';
    case 'headers': {
      const fmt = (pairs: HeaderPair[] | null | undefined) =>
        (pairs ?? []).map(([n, v]) => `${n}: ${v}`).join('\n');
      return `-- Request --\n${fmt(req.reqHeaders)}\n\n-- Response --\n${fmt(req.resHeaders)}`;
    }
    case 'timing': {
      const started = req.ts ? new Date(req.ts).toISOString() : '—';
      return `Duration: ${formatDuration(req.ms)}\nStarted: ${started}\nKind: ${req.kind ?? 'fetch'}`;
    }
    case 'frames':
      return (req.messages ?? []).slice(-100).map(m => `[${m.dir} +${m.ts}ms] ${m.body}`).join('\n');
    default: return '';
  }
}

function togglePin(pinBtn: HTMLElement): void {
  const id = Number(pinBtn.dataset.id);
  if (!Number.isFinite(id)) return;
  const req = requests.get(id);
  if (!req) return;
  if (pinnedIds.has(id)) {
    pinnedIds.delete(id);
    pinnedKeys.delete(pinKey(req));
  } else {
    pinnedIds.add(id);
    pinnedKeys.add(pinKey(req));
  }
  chrome.storage.local.set({ ovPinnedKeys: [...pinnedKeys] });
  scheduleRender();
}

function switchDetailTab(tabBtn: HTMLElement): void {
  const id = Number(tabBtn.parentElement?.dataset.id);
  const tab = tabBtn.dataset.tab as DetailTab | undefined;
  if (!Number.isFinite(id) || !tab) return;
  detailTabs.set(id, tab);
  clearBulkHighlights();
  if (tab === 'response') runBulkHighlight(id);
  scheduleRender();
}

function collapseRow(id: number): void {
  expandedIds.delete(id);
  detailTabs.delete(id);
  if (valueHighlightKey.startsWith(`${id}|`)) clearValueHighlights();
  if (bulkHighlightRowId === id) clearBulkHighlights();
}

// The inspector is a single dock rather than a per-row accordion, so opening a
// request closes whatever was open before it.
function toggleRowExpansion(row: HTMLElement): void {
  const id = Number(row.dataset.id);
  if (!Number.isFinite(id)) return;
  if (expandedIds.has(id)) {
    collapseRow(id);
  } else {
    for (const other of [...expandedIds]) collapseRow(other);
    expandedIds.add(id);
    if ((detailTabs.get(id) ?? 'response') === 'response') runBulkHighlight(id);
  }
  scheduleRender();
}

// Controls are checked before the row itself, and each stops propagation, so a
// click on a control never also toggles the row underneath it.
function onListClick(e: Event): void {
  const target = e.target as Element;

  const pinBtn = target.closest<HTMLElement>('.ov-pin-btn');
  if (pinBtn) { e.stopPropagation(); togglePin(pinBtn); return; }

  const copyTabBtn = target.closest<HTMLElement>('.ov-copy-tab-btn');
  if (copyTabBtn) {
    e.stopPropagation();
    const id = Number(copyTabBtn.dataset.id);
    if (!Number.isFinite(id)) return;
    const req = requests.get(id);
    const text = req ? detailTabText(req, copyTabBtn.dataset.tab as DetailTab) : '';
    copyToClipboard(copyTabBtn, text, 'copied!');
    return;
  }

  const copyBtn = target.closest<HTMLElement>('.ov-copy-btn');
  if (copyBtn) {
    e.stopPropagation();
    copyToClipboard(copyBtn, safeDecodeURIComponent(copyBtn.dataset.url ?? ''), 'copied');
    return;
  }

  const tabBtn = target.closest<HTMLElement>('.ov-tab');
  if (tabBtn) { e.stopPropagation(); switchDetailTab(tabBtn); return; }

  const closeBtn = target.closest<HTMLElement>('.ov-dh-close');
  if (closeBtn) {
    e.stopPropagation();
    const id = Number(closeBtn.dataset.id);
    if (Number.isFinite(id)) { collapseRow(id); scheduleRender(); }
    return;
  }

  const trigger = target.closest<HTMLElement>('.ov-dh-trigger[data-sel]');
  if (trigger) {
    e.stopPropagation();
    revealElement(safeDecodeURIComponent(trigger.dataset.sel ?? ''));
    return;
  }

  const revealAll = target.closest<HTMLElement>('.ov-reveal-all');
  if (revealAll) {
    e.stopPropagation();
    toggleRevealAll(revealAll);
    return;
  }

  if (target.closest('#ov-build-map')) {
    e.stopPropagation();
    smEnsureBuilt();
    return;
  }

  const jv = target.closest<HTMLElement>('.ov-jv');
  if (jv) { e.stopPropagation(); handleJsonValueClick(jv); return; }

  const row = target.closest<HTMLElement>('.ov-row');
  if (row) toggleRowExpansion(row);
}

// Bring the element that fired the selected request into view and mark it.
// Unlike the hover highlight this is an explicit request, so it always centres
// the element rather than only scrolling when it happens to be off-screen.
function revealElement(selector: string): void {
  if (!selector) return;
  highlightEl(selector);
  activeHighlight?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// "Reveal all values on page" — the whole-response counterpart to clicking one
// JSON value. Reports how many matches were found on the button itself.
function toggleRevealAll(btn: HTMLElement): void {
  const id = Number(btn.dataset.id);
  if (!Number.isFinite(id)) return;
  if (bulkHighlightRowId === id) {
    clearBulkHighlights();
    btn.classList.remove('on');
    btn.textContent = '⊹ reveal all values on page';
    return;
  }
  clearValueHighlights();
  runBulkHighlight(id);
  btn.classList.add('on');
  const n = bulkHighlightEls.length;
  btn.textContent = n === 0
    ? '⊹ no values from this response on the page'
    : `⊹ ${n} value${n === 1 ? '' : 's'} revealed on page`;
}

function bindChipDelegation(container: HTMLElement): void {
  container.addEventListener('click', (e: Event) => {
    const chip = (e.target as Element).closest<HTMLElement>('.ov-chip');
    if (!chip) return;
    const s = chip.dataset.s;
    const m = chip.dataset.m;
    const ini = chip.dataset.i;

    if (s) {
      activeStatus.has(s) ? activeStatus.delete(s) : activeStatus.add(s);
    } else if (m) {
      activeMethods.has(m) ? activeMethods.delete(m) : activeMethods.add(m);
    } else if (ini) {
      activeInitiators.has(ini) ? activeInitiators.delete(ini) : activeInitiators.add(ini);
    }

    persistFilters();
    renderList();   // syncChipState (called within) re-derives the .on state
  });
}

// Only the chips persist. The err/slow flags describe the current log, so they
// are meaningless on the next page — and once carried over to a page with no
// errors they would hide every row.
function persistFilters(): void {
  chrome.storage.local.set({ ovFilters: {
    status: [...activeStatus], methods: [...activeMethods],
    initiators: [...activeInitiators],
  }});
}

function bindFooterDelegation(container: HTMLElement): void {
  container.addEventListener('click', (e: Event) => {
    const btn = (e.target as Element).closest<HTMLElement>('.ov-fstat-btn');
    if (!btn || (btn as HTMLButtonElement).disabled) return;
    const f = btn.dataset.f;
    if (!f) return;
    activeFlags.has(f) ? activeFlags.delete(f) : activeFlags.add(f);
    renderList();   // renderFooter (called within) re-derives the .on state
  });
}

// ── Pill (collapsed state) ────────────────────────────────────────────────────

// Expand to the panel, carrying the pill's position over so it grows in place.
function dockAsPanel(panel: HTMLElement | null, pill: HTMLElement | null): void {
  const pillRect = pill?.getBoundingClientRect();
  $('ov-pill')?.remove();
  if (!panelVisible) {
    panelVisible = true;
    chrome.storage.local.set({ ovVisible: true });
  }
  if (pillRect) {
    // Panel may be display:none here, so getBoundingClientRect can return 0×0.
    // Fall through to defaults rather than persisting a zero-size geometry.
    const measured = panel?.getBoundingClientRect();
    const w = savedPanelGeom?.width ?? (measured && measured.width > 0 ? measured.width : DEFAULT_PANEL_WIDTH);
    const h = savedPanelGeom?.height ?? (measured && measured.height > 0 ? measured.height : DEFAULT_PANEL_HEIGHT);
    savedPanelGeom = { left: pillRect.left, top: pillRect.top, width: w, height: h };
    chrome.storage.local.set({ ovPanelGeom: savedPanelGeom });
  }
  if (!panel) {
    buildPanel();
    return;
  }
  applySavedGeometry(panel);
  panel.style.setProperty('display', 'flex', 'important');
  renderList();
}

// Collapse to the pill, carrying the panel's position over so it shrinks in place.
function dockAsPill(panel: HTMLElement | null, pill: HTMLElement | null): void {
  if (panel) {
    const r = panel.getBoundingClientRect();
    savedPillGeom = { left: r.left, top: r.top };
    chrome.storage.local.set({ ovPillGeom: savedPillGeom });
    panel.style.setProperty('display', 'none', 'important');
  }
  if (!pill) {
    buildPill();
    return;
  }
  applySavedGeometry(pill);
  refreshPill();
}

function setDockState(next: DockState): void {
  if (next === dockState) return;
  dockState = next;
  chrome.storage.local.set({ ovDockState: next });
  const panel = $('ov-panel');
  const pill = $('ov-pill');
  if (next === 'panel') {
    dockAsPanel(panel, pill);
  } else if (next === 'pill') {
    dockAsPill(panel, pill);
  } else {
    if (panel) panel.style.setProperty('display', 'none', 'important');
    $('ov-pill')?.remove();
  }
}

// ── Click-away dismissal ──────────────────────────────────────────────────────

// Overlay surfaces a click can land on without meaning "get out of the way": the
// panel, the pill, an endpoint badge (circle or popup row) and the value cycler.
const OVERLAY_UI_SELECTOR = '#ov-panel, #ov-pill, .ov-float-badge, #ov-value-cycler';

function isOverlayUi(el: EventTarget | null): boolean {
  return el instanceof Element && !!el.closest(OVERLAY_UI_SELECTOR);
}

function onDismissPress(e: MouseEvent): void {
  pressStartedOnOverlay = isOverlayUi(e.target);
}

// Clicking the page collapses the panel back to the pill, so the overlay steps
// aside the moment attention returns to the site. Badges are excluded: their
// rows navigate into the panel (navigateToRequest), which re-expands it.
function onDismissClick(e: MouseEvent): void {
  const fromOverlay = pressStartedOnOverlay;
  pressStartedOnOverlay = false;          // one press, one verdict
  if (dockState !== 'panel' || !panelVisible) return;
  if (fromOverlay) return;                // drag that began inside the panel
  if (isOverlayUi(e.target)) return;
  setDockState('pill');
}

// Colour class for one tick in the pill's recent-request rail.
function pillTickClass(r: ApiRequest): string {
  const b = statusBucket(r);
  if (b === '4xx' || b === '5xx' || b === 'err') return 'err';
  if (b === '3xx') return 'warn';
  return r.kind === 'ws' ? 'ws' : '';
}

function pillInnerHtml(): string {
  const reqs = [...requests.values()];
  const total = reqs.length;
  const errs = reqs.filter(isError).length;
  // A dense activity band of uniform bars, newest on the right. Errors keep their
  // colour so a failing run is visible without expanding.
  const recent = reqs.slice(-PILL_RAIL_TICKS);
  const ticks = recent.map(r => {
    const cls = pillTickClass(r);
    return `<span class="ov-pill-tick${cls ? ' ' + cls : ''}"></span>`;
  }).join('');
  return `
    <span class="ov-pill-dot${paused ? ' ov-pill-paused' : ''}"></span>
    <span class="ov-pill-count">${total}</span>
    <span class="ov-pill-label">req</span>
    ${errs ? `<span class="ov-pill-err">${errs}</span>` : ''}
    <span class="ov-pill-rail">${ticks}</span>
    <button class="ov-pill-expand" title="Expand panel">⤢</button>
  `;
}

function buildPill(): void {
  if ($('ov-pill')) return;
  injectStyles();
  const pill = document.createElement('div');
  pill.id = 'ov-pill';
  pill.dataset.theme = currentTheme;
  pill.innerHTML = pillInnerHtml();
  document.documentElement.appendChild(pill);
  applySavedGeometry(pill);
  makeDraggable(pill, pill);
  pill.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.ov-pill-expand')) {
      setDockState('panel');
    }
  });
}

function refreshPill(): void {
  const pill = $('ov-pill');
  if (pill) pill.innerHTML = pillInnerHtml();
}

// ── Panel build ───────────────────────────────────────────────────────────────

function buildPanel(): void {
  if ($('ov-panel')) return;

  injectStyles();

  const panel = document.createElement('div');
  panel.id = 'ov-panel';
  panel.dataset.theme = currentTheme;
  panel.innerHTML = `
    <div id="ov-header">
      <div class="ov-grip"></div>
      <div class="ov-mark">C</div>
      <span class="ov-hdr-title">CalloutAPI</span>
      <span id="ov-live" class="ov-live"><span class="ov-live-dot"></span><span id="ov-count">0/0</span></span>
      <div class="ov-hdr-spacer"></div>
      <div id="ov-actions">
        <button id="ov-pause" data-tip="Pause or resume capturing">${paused ? '▶ rec' : '⏸ pause'}</button>
        <span class="ov-divider"></span>
        <button id="ov-theme" data-tip="Toggle dark / light theme">${currentTheme === 'dark' ? 'light' : 'dark'}</button>
        <span class="ov-divider"></span>
        <button id="ov-export" data-tip="Export as HAR file">↓ har</button>
        <span class="ov-divider"></span>
        <button id="ov-clear" data-tip="Clear all requests">✕ clear</button>
        <button id="ov-collapse" data-tip="Minimize" data-tip-align="right">_</button>
      </div>
    </div>
    <div id="ov-toolbar">
      <div id="ov-views" class="ov-views">
        <button class="ov-view" data-v="log" data-tip="Captured requests">Log</button>
        <button class="ov-view" data-v="pinned" data-tip="Pinned requests">Pinned<span class="ov-view-n" id="ov-view-pin-n">0</span></button>
        <button class="ov-view" data-v="map" data-tip="Site map — pages to endpoints">Map</button>
      </div>
      <div id="ov-search" class="ov-search">
        <span class="ov-prompt">›</span>
        <input id="ov-filter" placeholder="filter url, body, header…" autocomplete="off" spellcheck="false"/>
        <span id="ov-hits" class="ov-hits"></span>
        <button id="ov-case-toggle" class="ov-modebtn" data-tip="Case-sensitive" data-tip-align="right">Aa</button>
        <button id="ov-regex-toggle" class="ov-modebtn" data-tip="Regular expression" data-tip-align="right">.*</button>
      </div>
    </div>
    <div id="ov-chips">
      <div class="ov-chip-group">
        <span class="ov-chip-label">status</span>
        <button class="ov-chip" data-s="2xx" data-tip="Filter: 2xx success">2xx<span class="ov-chip-count">0</span></button>
        <button class="ov-chip" data-s="3xx" data-tip="Filter: 3xx redirects">3xx<span class="ov-chip-count">0</span></button>
        <button class="ov-chip" data-s="4xx" data-tip="Filter: 4xx client errors">4xx<span class="ov-chip-count">0</span></button>
        <button class="ov-chip" data-s="5xx" data-tip="Filter: 5xx server errors">5xx<span class="ov-chip-count">0</span></button>
      </div>
      <span class="ov-chip-sep"></span>
      <div class="ov-chip-group">
        <span class="ov-chip-label">method</span>
        <button class="ov-chip" data-m="GET" data-tip="Filter: GET requests">GET</button>
        <button class="ov-chip" data-m="POST" data-tip="Filter: POST requests">POST</button>
        <button class="ov-chip" data-m="PUT" data-tip="Filter: PUT requests">PUT</button>
        <button class="ov-chip" data-m="PATCH" data-tip="Filter: PATCH requests">PATCH</button>
        <button class="ov-chip" data-m="DELETE" data-tip="Filter: DELETE requests">DEL</button>
        <button class="ov-chip" data-m="WS" data-tip="Filter: WebSocket connections">WS</button>
      </div>
      <span class="ov-chip-sep"></span>
      <div class="ov-chip-group">
        <span class="ov-chip-label">from</span>
        <button class="ov-chip" data-i="page" data-tip="Requests a page element triggered">page</button>
        <button class="ov-chip" data-i="bg" data-tip="Background / automatic requests">bg</button>
      </div>
    </div>
    <div id="ov-list"></div>
    <div id="ov-dock" hidden></div>
    <div id="ov-footer"></div>
    <div class="ov-resize-handle" data-dir="n"></div>
    <div class="ov-resize-handle" data-dir="s"></div>
    <div class="ov-resize-handle" data-dir="e"></div>
    <div class="ov-resize-handle" data-dir="w"></div>
    <div class="ov-resize-handle" data-dir="ne"></div>
    <div class="ov-resize-handle" data-dir="nw"></div>
    <div class="ov-resize-handle" data-dir="se"></div>
    <div class="ov-resize-handle" data-dir="sw"></div>
  `;

  if (!panelVisible) panel.style.setProperty('display', 'none', 'important');
  document.documentElement.appendChild(panel);
  applySavedGeometry(panel);

  filterInput = $('ov-filter') as HTMLInputElement;

  const ovCollapse = $('ov-collapse');
  const ovClear    = $('ov-clear');
  const ovPause    = $('ov-pause');
  const ovTheme    = $('ov-theme');
  const ovExport   = $('ov-export');
  const caseBtn    = $('ov-case-toggle');
  const regexBtn   = $('ov-regex-toggle');

  if (ovCollapse) ovCollapse.onclick = () => setDockState('pill');
  if (ovClear) ovClear.onclick = () => {
    requests.clear(); requestsRev++; expandedIds.clear(); detailTabs.clear(); pinnedIds.clear();
    clearAllBadges(); clearValueHighlights(); clearBulkHighlights();
    clearJvHover(); clearRevHighlight();
    clearPreserved();
    smReset();
    renderList();
  };
  if (ovPause) ovPause.onclick = () => setPaused(!paused);
  if (ovTheme) ovTheme.onclick = () => {
    const next: 'dark' | 'light' = currentTheme === 'dark' ? 'light' : 'dark';
    chrome.storage.local.set({ ovTheme: next });
    applyTheme(next);
  };
  filterInput.oninput = () => scheduleRender();
  if (ovExport) ovExport.onclick = exportHAR;

  // The field's padding and the '›' prompt belong to the wrapper, not the input,
  // so clicking them would otherwise do nothing despite showing a text cursor.
  const field = filterInput;
  $('ov-search')?.addEventListener('mousedown', (e) => {
    const t = e.target as Element;
    if (t === field || t.closest('button')) return;
    e.preventDefault();
    field.focus();
  });

  if (caseBtn) caseBtn.onclick = () => {
    caseSensitiveSearch = !caseSensitiveSearch;
    caseBtn.classList.toggle('ov-active', caseSensitiveSearch);
    renderList();
  };
  if (regexBtn) regexBtn.onclick = () => {
    regexSearch = !regexSearch;
    regexBtn.classList.toggle('ov-active', regexSearch);
    renderList();
  };

  bindViewTabs($('ov-views')!);
  bindSearchToggle();

  makeDraggable(panel, $('ov-header')!);
  makeDraggable(panel, $('ov-toolbar')!);
  makeResizable(panel);
  const list = $('ov-list')!;
  bindListDelegation(list);
  bindListDelegation($('ov-dock')!);
  smBindSiteMapDelegation(list);
  bindChipDelegation($('ov-chips')!);
  bindFooterDelegation($('ov-footer')!);
  renderList();
}

// ── View tabs & filters popover ───────────────────────────────────────────────

function setView(next: OverlayView): void {
  if (next === currentView) return;
  currentView = next;
  chrome.storage.local.set({ ovView: next });
  renderList();
}

function bindViewTabs(container: HTMLElement): void {
  container.addEventListener('click', (e: Event) => {
    const btn = (e.target as Element).closest<HTMLElement>('.ov-view');
    const v = btn?.dataset.v;
    if (v === 'log' || v === 'pinned' || v === 'map') setView(v);
  });
}

// Escape clears the term from inside the field — the usual way to abandon a
// search without reaching for the mouse.
function bindSearchToggle(): void {
  filterInput?.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !filterInput?.value) return;
    e.stopPropagation();
    filterInput.value = '';
    renderList();
  });
}

// ── HAR export ────────────────────────────────────────────────────────────────

function exportHAR(): void {
  function parseQuery(url: string): { name: string; value: string }[] {
    try { return [...new URL(url).searchParams.entries()].map(([name, value]) => ({ name, value })); }
    catch { return []; }
  }
  function detectMime(body: string | null | undefined): string {
    if (!body) return 'text/plain';
    const t = body.trimStart();
    if (t.startsWith('{') || t.startsWith('[')) return 'application/json';
    if (t.startsWith('<')) return 'text/xml';
    return 'text/plain';
  }
  const encoder = new TextEncoder();
  const byteLen = (s: string | null | undefined): number => s ? encoder.encode(s).length : -1;
  const toHarHeaders = (hs: HeaderPair[] | null | undefined): { name: string; value: string }[] =>
    hs ? hs.map(([name, value]) => ({ name, value })) : [];

  const entries = [...requests.values()]
    .filter(r => r.kind !== 'ws' && typeof r.status === 'number')
    .map(r => ({
      startedDateTime: new Date(r.ts || Date.now()).toISOString(),
      time: r.ms ?? 0,
      request: {
        method: r.method || 'GET', url: r.url || '', httpVersion: 'HTTP/1.1',
        headers: toHarHeaders(r.reqHeaders), queryString: parseQuery(r.url),
        cookies: [], headersSize: -1, bodySize: byteLen(r.reqBody),
        ...(r.reqBody ? { postData: { mimeType: detectMime(r.reqBody), text: r.reqBody } } : {})
      },
      response: {
        status: r.status as number, statusText: '', httpVersion: 'HTTP/1.1',
        headers: toHarHeaders(r.resHeaders), cookies: [],
        content: { size: byteLen(r.resBody), mimeType: detectMime(r.resBody), text: r.resBody ?? '' },
        redirectURL: '', headersSize: -1, bodySize: byteLen(r.resBody)
      },
      cache: {},
      timings: { send: 0, wait: r.ms ?? 0, receive: 0 }
    }));

  const har = { log: { version: '1.2', creator: { name: 'CalloutAPI', version: '1.0' }, pages: [], entries } };
  const blob = new Blob([JSON.stringify(har)], { type: 'application/json' });
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = 'callout-' + Date.now() + '.har';
  document.documentElement.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(blobUrl);
}

// ── Element highlight ─────────────────────────────────────────────────────────

function highlightEl(selector: string): void {
  clearHighlight();
  try {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el || el.closest('#ov-panel')) return;
    el.classList.add('ov-highlighted');
    activeHighlight = el;
    const rect = el.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > window.innerHeight) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch { /* invalid selector */ }
}

function clearHighlight(): void {
  if (activeHighlight) { activeHighlight.classList.remove('ov-highlighted'); activeHighlight = null; }
}

// ── Float badges ──────────────────────────────────────────────────────────────

function removeSelectorReqId(sel: string, id: number): void {
  const ids = selectorReqIds.get(sel);
  if (!ids) return;
  const next = ids.filter(x => x !== id);
  if (next.length === 0) {
    const t = selectorTimers.get(sel);
    if (t !== undefined) clearTimeout(t);
    selectorBadges.get(sel)?.remove();
    selectorBadges.delete(sel);
    selectorReqIds.delete(sel);
    selectorTimers.delete(sel);
  } else {
    selectorReqIds.set(sel, next);
    refreshClusterBadge(sel);
  }
}

function clusterBadgeRowHtml(req: ApiRequest): string {
  let path = req.url;
  try { path = new URL(req.url).pathname; } catch { /* use full url */ }
  const sc = typeof req.status === 'number' ? String(req.status)[0] : '';
  const statusHtml = req.status !== 'pending'
    ? `<span class="ov-fb-s ov-fb-s-${sc}">${escHtml(String(req.status))}</span>`
    : '<span class="ov-fb-s">…</span>';
  return `<div class="ov-fb-row" data-id="${req.id}"><span class="ov-fb-m ov-fb-m-${safeMethodClass(req.method)}">${escHtml(req.method)}</span><span class="ov-fb-url">${escHtml(path)}</span>${statusHtml}</div>`;
}

// The single inline badge grows rightward from its anchor and can spill off the
// right edge of the viewport when anchored to an element near that edge. After
// its content is rendered, shift it left of the anchor so the whole box stays
// visible (max-width on .ov-fb-single ensures very long paths ellipsis-truncate
// first). Always derived from the stored anchor — never the current left — so it
// is idempotent across re-renders and lets the badge drift back right when its
// width shrinks. Horizontal only; the vertical anchor is clamped in flashBadge.
function clampBadgeLeftIntoView(badge: HTMLElement): void {
  const anchor = parseFloat(badge.dataset.anchorLeft ?? badge.style.left) || 0;
  const w = badge.offsetWidth; // forces layout; accurate once content + CSS applied
  const maxLeft = window.scrollX + window.innerWidth - w - 8;
  const minLeft = window.scrollX + 4;
  badge.style.left = `${Math.max(minLeft, Math.min(anchor, maxLeft))}px`;
}

// Single endpoint — show inline, no circle, no popup.
function renderSingleBadge(badge: HTMLElement, id: number): void {
  const r = requests.get(id);
  if (!r) return;
  badge.className = 'ov-float-badge ov-fb-single';
  badge.dataset.theme = currentTheme;
  badge.classList.remove('ov-fb-open');
  badge.innerHTML = clusterBadgeRowHtml(r);
  clampBadgeLeftIntoView(badge);
}

// First render, or an upgrade from the single layout — build from scratch.
function buildClusterBadge(badge: HTMLElement, ids: number[], open: boolean): void {
  const popupHtml = ids.map(id => {
    const r = requests.get(id);
    return r ? clusterBadgeRowHtml(r) : '';
  }).join('');
  const dir = badge.dataset.popupDir ?? 'right';
  badge.innerHTML = `<span class="ov-fb-circle">${ids.length}</span>`
    + `<div class="ov-fb-popup ov-fb-popup-${dir}${open ? ' ov-fb-popup-show' : ''}">${popupHtml}</div>`;
}

// Add/update rows in place without touching unaffected ones, so an open popup
// isn't torn down underneath the pointer.
function syncClusterRows(popupEl: HTMLElement, ids: number[]): void {
  const existingRows = Array.from(popupEl.querySelectorAll<HTMLElement>('.ov-fb-row'));
  for (let i = 0; i < ids.length; i++) {
    const r = requests.get(ids[i]);
    if (!r) continue;
    if (existingRows[i]) existingRows[i].outerHTML = clusterBadgeRowHtml(r);
    else popupEl.insertAdjacentHTML('beforeend', clusterBadgeRowHtml(r));
  }
  const staleRows = Array.from(popupEl.querySelectorAll<HTMLElement>('.ov-fb-row')).slice(ids.length);
  for (const el of staleRows) el.remove();
}

function refreshClusterBadge(sel: string): void {
  const badge = selectorBadges.get(sel);
  if (!badge) return;
  const ids = selectorReqIds.get(sel) ?? [];

  if (ids.length === 1) { renderSingleBadge(badge, ids[0]); return; }

  // Multi-endpoint cluster — upgrade class if coming from single mode
  if (!badge.classList.contains('ov-fb-cluster')) {
    badge.className = 'ov-float-badge ov-fb-cluster';
    badge.dataset.theme = currentTheme;
    // The single badge may have shifted left to fit; the small cluster circle
    // fits at the original anchor, so snap it back to the element's corner.
    if (badge.dataset.anchorLeft) badge.style.left = `${badge.dataset.anchorLeft}px`;
  }

  const open = badge.classList.contains('ov-fb-open');
  const countEl = badge.querySelector<HTMLElement>('.ov-fb-circle');
  const popupEl = badge.querySelector<HTMLElement>('.ov-fb-popup');
  if (!countEl || !popupEl) { buildClusterBadge(badge, ids, open); return; }

  countEl.textContent = String(ids.length);
  popupEl.classList.toggle('ov-fb-popup-show', open);
  syncClusterRows(popupEl, ids);
}

function navigateToRequest(id: number): void {
  if (!panelVisible) {
    panelVisible = true;
    chrome.storage.local.set({ ovVisible: true });
  }
  // Track whether the panel already exists; if not, setDockState → buildPanel
  // will call renderList() internally, so we skip the redundant call below.
  const panelExisted = !!$('ov-panel');
  if (dockState !== 'panel') {
    setDockState('panel');
  } else {
    $('ov-panel')?.style.setProperty('display', 'flex', 'important');
  }
  // A marker can point at a request the Map view would never list; jump back to
  // the log so the row it scrolls to actually exists.
  if (currentView === 'map') currentView = 'log';
  if (!expandedIds.has(id)) {
    for (const other of [...expandedIds]) collapseRow(other);
    expandedIds.add(id);
    if ((detailTabs.get(id) ?? 'response') === 'response') runBulkHighlight(id);
  }
  if (panelExisted) renderList();
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(`#ov-list .ov-row[data-id="${id}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

function clearRevHighlight(): void {
  for (const el of revHighlightRows) el.classList.remove('ov-row-rev-hl');
  revHighlightRows = [];
  revHoverActiveEl = null;
}

// Reverse of the row→element hover: highlight (and scroll into view) the overlay
// rows for the requests a page element triggered. Returns the number of rows
// actually highlighted — fewer than ids.length when some are filtered out of the
// current list view.
function showRevHighlight(ids: number[]): number {
  clearRevHighlight();
  const list = $('ov-list');
  if (!list) return 0;
  let first: HTMLElement | null = null;
  for (const id of ids) {
    const row = list.querySelector<HTMLElement>(`.ov-row[data-id="${id}"]`);
    if (!row) continue;
    row.classList.add('ov-row-rev-hl');
    revHighlightRows.push(row);
    if (!first) first = row;
  }
  if (first) first.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return revHighlightRows.length;
}

// Re-apply the reverse highlight after renderList() rebuilds the row DOM (which
// drops the ov-row-rev-hl class). Clearing revHoverActiveEl first forces
// resolveRevHover to re-resolve rather than short-circuit on the unchanged element.
function reattachRevHighlight(): void {
  if (!revHoverActiveEl) return;
  const el = revHoverActiveEl;
  revHoverActiveEl = null;
  resolveRevHover(el);
}

function isOverlayOwned(el: Element | null): boolean {
  return isOverlayUi(el);
}

// Resolve every captured selector to its live element once, keyed by element so
// the hover path is a cheap identity lookup. Selectors that no longer resolve
// (element gone) are simply dropped; ids from distinct selectors that resolve to
// the same element are merged.
function rebuildSelectorIndex(): void {
  selectorIndex = new WeakMap<Element, number[]>();
  for (const [id, req] of requests) {
    const sel = req.element?.selector;
    if (!sel) continue;
    let el: Element | null;
    try { el = document.querySelector(sel); } catch { continue; }
    if (!el || isOverlayOwned(el)) continue;
    const arr = selectorIndex.get(el);
    if (arr) arr.push(id); else selectorIndex.set(el, [id]);
  }
  selectorIndexRev = requestsRev;
}

// Map the hovered page element to the request(s) it triggered and flash their
// rows. Walks up from the pointer; the first (nearest) ancestor in the index is
// the deepest/most-specific triggering element, so it wins automatically.
// Note: because elements are resolved at rebuild time, a silent SPA re-render
// that replaces a triggering element without firing a new request will make the
// reverse highlight go quiet for it until the next request — an accepted
// trade-off for the cheap ancestor-walk lookup (vs. live closest() matching).
function resolveRevHover(target: Element | null): void {
  if (!activated || !$('ov-list')) return;
  if (target && isOverlayOwned(target)) return;   // over the overlay → leave as-is
  if (selectorIndexRev !== requestsRev) rebuildSelectorIndex();

  for (let node: Element | null = target; node; node = node.parentElement) {
    const ids = selectorIndex.get(node);
    if (!ids) continue;
    if (node === revHoverActiveEl) return;         // already flashing this element
    // Only latch onto this element once at least one row is actually shown. When
    // every triggering row is filtered out, leave revHoverActiveEl unset so a
    // later filter change re-resolves on the next pointer move instead of
    // short-circuiting on a stale "active" element with no visible highlight.
    revHoverActiveEl = showRevHighlight(ids) > 0 ? node : null;
    return;
  }
  clearRevHighlight();
}

function onPageHover(e: MouseEvent): void {
  revHoverTarget = e.target instanceof Element ? e.target : null;
  if (revHoverRaf) return;                          // coalesce to one pass per frame
  revHoverRaf = requestAnimationFrame(() => {
    revHoverRaf = 0;
    resolveRevHover(revHoverTarget);
  });
}

function onPageHoverOut(e: MouseEvent): void {
  if (e.relatedTarget) return;                      // still inside the document
  if (revHighlightRows.length) clearRevHighlight();
}

function flashBadge(req: ApiRequest): void {
  if (!req.element?.selector) return;
  try {
    const el = document.querySelector(req.element.selector);
    if (!el || el.closest('#ov-panel')) return;
    const rect = el.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    const sel = req.element.selector;

    // Track this request under its selector
    const ids = selectorReqIds.get(sel) ?? [];
    if (!ids.includes(req.id)) ids.push(req.id);
    selectorReqIds.set(sel, ids);

    // Create cluster badge if needed
    if (!selectorBadges.has(sel)) {
      const badge = document.createElement('div');
      badge.className = 'ov-float-badge ov-fb-cluster';
      badge.dataset.theme = currentTheme;
      badge.dataset.sel = sel;
      // Popup opens right unless circle is in the right half — then open left
      const popupDir = (rect.right - 13) > window.innerWidth / 2 ? 'left' : 'right';
      badge.dataset.popupDir = popupDir;
      // Anchor circle to element's top-right corner, clamped inside viewport
      const cx = Math.min(
        window.scrollX + rect.right - 13,
        window.innerWidth - 30
      );
      const cy = Math.max(window.scrollY + rect.top - 13, window.scrollY + 4);
      // Remember the intended top-right anchor; the single badge may shift left
      // of it to stay on-screen (see clampBadgeLeftIntoView), and the cluster circle
      // must be able to snap back to it.
      badge.dataset.anchorLeft = String(cx);
      badge.style.cssText = `top:${cy}px;left:${cx}px;`;
      document.documentElement.appendChild(badge);
      selectorBadges.set(sel, badge);
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        const row = (e.target as Element).closest<HTMLElement>('.ov-fb-row');
        if (row?.dataset.id) {
          navigateToRequest(Number(row.dataset.id));
          badge.classList.remove('ov-fb-open');
          refreshClusterBadge(sel);
          return;
        }
        badge.classList.toggle('ov-fb-open');
        refreshClusterBadge(sel);
      });
    }

    refreshClusterBadge(sel);

    // Reset auto-dismiss timer (restarts on each new request for this element)
    const prev = selectorTimers.get(sel);
    if (prev !== undefined) clearTimeout(prev);
    const timer = window.setTimeout(() => {
      selectorBadges.get(sel)?.remove();
      selectorBadges.delete(sel);
      selectorReqIds.delete(sel);
      selectorTimers.delete(sel);
    }, 6000);
    selectorTimers.set(sel, timer);
  } catch { /* invalid selector */ }
}

function clearAllBadges(): void {
  for (const b of selectorBadges.values()) b.remove();
  for (const t of selectorTimers.values()) clearTimeout(t);
  selectorBadges.clear();
  selectorReqIds.clear();
  selectorTimers.clear();
  for (const b of document.querySelectorAll('.ov-float-badge')) b.remove();
}

// ── Drag / resize ─────────────────────────────────────────────────────────────

function signalInjected(action: 'pause' | 'resume' | 'stop' | 'start'): void {
  window.postMessage({ __apiOverlayControl: true, action }, TARGET_ORIGIN);
}

function isValidPanelGeom(v: unknown): v is PanelGeom {
  if (!v || typeof v !== 'object') return false;
  const g = v as Record<string, unknown>;
  return Number.isFinite(g.left) && Number.isFinite(g.top)
    && Number.isFinite(g.width) && (g.width as number) > 0
    && Number.isFinite(g.height) && (g.height as number) > 0;
}

function isValidPillGeom(v: unknown): v is PillGeom {
  if (!v || typeof v !== 'object') return false;
  const g = v as Record<string, unknown>;
  return Number.isFinite(g.left) && Number.isFinite(g.top);
}

function clampToViewport(left: number, top: number, w: number): { left: number; top: number } {
  const KEEP_VISIBLE = 60;
  const minLeft = KEEP_VISIBLE - w;
  const maxLeft = window.innerWidth - KEEP_VISIBLE;
  const maxTop = Math.max(0, window.innerHeight - KEEP_VISIBLE);
  return {
    left: Math.min(maxLeft, Math.max(minLeft, left)),
    top: Math.min(maxTop, Math.max(0, top)),
  };
}

function applySavedGeometry(el: HTMLElement): void {
  if (el.id === 'ov-panel' && savedPanelGeom) {
    const { left, top } = clampToViewport(savedPanelGeom.left, savedPanelGeom.top, savedPanelGeom.width);
    el.style.setProperty('left', `${left}px`, 'important');
    el.style.setProperty('top', `${top}px`, 'important');
    el.style.setProperty('right', 'auto', 'important');
    el.style.setProperty('bottom', 'auto', 'important');
    el.style.setProperty('width', `${savedPanelGeom.width}px`, 'important');
    el.style.setProperty('height', `${savedPanelGeom.height}px`, 'important');
  } else if (el.id === 'ov-pill' && savedPillGeom) {
    const r = el.getBoundingClientRect();
    const { left, top } = clampToViewport(savedPillGeom.left, savedPillGeom.top, r.width || DEFAULT_PILL_WIDTH);
    el.style.setProperty('left', `${left}px`, 'important');
    el.style.setProperty('top', `${top}px`, 'important');
    el.style.setProperty('right', 'auto', 'important');
    el.style.setProperty('bottom', 'auto', 'important');
  }
}

function persistGeometry(el: HTMLElement): void {
  const rect = el.getBoundingClientRect();
  if (el.id === 'ov-panel') {
    savedPanelGeom = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    chrome.storage.local.set({ ovPanelGeom: savedPanelGeom });
  } else if (el.id === 'ov-pill') {
    savedPillGeom = { left: rect.left, top: rect.top };
    chrome.storage.local.set({ ovPillGeom: savedPillGeom });
  }
}

// Both the drag and the resize gesture end the same way: unbind the transient
// document listeners and persist the new geometry. Shared so the two closures
// aren't byte-identical duplicates.
function makeGestureEnd(panel: HTMLElement, move: (ev: MouseEvent) => void): () => void {
  const up = (): void => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    persistGeometry(panel);
  };
  return up;
}

function makeDraggable(panel: HTMLElement, handle: HTMLElement): void {
  let ox = 0, oy = 0;
  handle.addEventListener('mousedown', (e: MouseEvent) => {
    // Form controls live in the header rows, and the preventDefault() below would
    // stop them ever taking focus — you could not click into the search box.
    // .ov-search covers the field's own padding too: it shows a text cursor, so
    // grabbing it must land in the input rather than drag the panel away.
    if ((e.target as Element).closest('button, input, textarea, select, [contenteditable], .ov-search')) return;
    e.preventDefault();
    const rect0 = panel.getBoundingClientRect();
    ox = e.clientX - rect0.left;
    oy = e.clientY - rect0.top;
    // Keep at least this much of the panel onscreen so the user can always grab it back.
    const KEEP_VISIBLE = 60;
    const move = (ev: MouseEvent) => {
      const w = panel.offsetWidth || rect0.width;
      const minLeft = KEEP_VISIBLE - w;
      const maxLeft = window.innerWidth - KEEP_VISIBLE;
      const minTop = 0;
      const maxTop = window.innerHeight - KEEP_VISIBLE;
      const left = Math.min(maxLeft, Math.max(minLeft, ev.clientX - ox));
      const top = Math.min(maxTop, Math.max(minTop, ev.clientY - oy));
      panel.style.setProperty('left', `${left}px`, 'important');
      panel.style.setProperty('top', `${top}px`, 'important');
      panel.style.setProperty('right', 'auto', 'important');
      panel.style.setProperty('bottom', 'auto', 'important');
    };
    const up = makeGestureEnd(panel, move);
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

function makeResizable(panel: HTMLElement): void {
  panel.addEventListener('mousedown', (e: MouseEvent) => {
    const handle = (e.target as Element).closest<HTMLElement>('.ov-resize-handle');
    if (!handle) return;
    const dir = handle.dataset.dir ?? '';
    e.preventDefault();
    e.stopPropagation();
    const rect = panel.getBoundingClientRect();
    panel.style.setProperty('left', `${rect.left}px`, 'important');
    panel.style.setProperty('top', `${rect.top}px`, 'important');
    panel.style.setProperty('right', 'auto', 'important');
    panel.style.setProperty('bottom', 'auto', 'important');
    panel.style.setProperty('width', `${rect.width}px`, 'important');
    panel.style.setProperty('height', `${rect.height}px`, 'important');
    const startX = e.clientX, startY = e.clientY;
    const startLeft = rect.left, startTop = rect.top, startW = rect.width, startH = rect.height;
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      let left = startLeft, top = startTop, w = startW, h = startH;
      if (dir.includes('e')) w = Math.min(window.innerWidth * 0.95, Math.max(320, startW + dx));
      if (dir.includes('s')) h = Math.min(window.innerHeight * 0.95, Math.max(240, startH + dy));
      if (dir.includes('w')) { const cdx = Math.min(startW - 320, dx); w = startW - cdx; left = startLeft + cdx; }
      if (dir.includes('n')) { const cdy = Math.min(startH - 240, dy); h = startH - cdy; top = startTop + cdy; }
      panel.style.setProperty('left', `${left}px`, 'important');
      panel.style.setProperty('top', `${top}px`, 'important');
      panel.style.setProperty('width', `${w}px`, 'important');
      panel.style.setProperty('height', `${h}px`, 'important');
    };
    const up = makeGestureEnd(panel, move);
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

// ── Styles ────────────────────────────────────────────────────────────────────

function injectStyles(): void {
  if ($('ov-styles')) return;
  const s = document.createElement('style');
  s.id = 'ov-styles';
  s.textContent = `
    /* ══ Tokens ══════════════════════════════════════════════════════════════
       The overlay renders inside pages whose CSS it does not control, so every
       declaration is !important and the root does a full 'all: initial' reset.
       Custom properties survive that reset, which is what makes theming work. */
    #ov-panel {
      all: initial;
      /* dark theme (default) */
      --ov-bg:               #0e1116;
      --ov-bg-2:             #12171e;
      --ov-bg-3:             #161c24;
      --ov-log:              #0b0f14;
      --ov-hdr:              linear-gradient(#161b22,#12161c);
      --ov-hdr-flat:         #12161c;
      --ov-border:           #232c37;
      --ov-border-soft:      #1b222b;
      --ov-grid:             #12171e;
      --ov-text:             #d7dee7;
      --ov-text-dim:         #c3cdd8;
      --ov-text-muted:       #8a97a6;
      --ov-text-faint:       #6b7684;
      --ov-text-ghost:       #4f5a67;
      --ov-title:            #eef2f7;
      --ov-accent:           #5b8cff;
      --ov-accent-soft:      #8fb0ff;
      --ov-accent-bg:        rgba(91,140,255,.14);
      --ov-accent-bd:        rgba(91,140,255,.35);
      --ov-trace:            #b78bff;
      --ov-trace-bg:         rgba(139,91,255,.18);
      --ov-trace-bd:         rgba(139,91,255,.45);
      --ov-mark:             linear-gradient(135deg,#5b8cff,#8a5bff);
      --ov-mark-fg:          #0a0c0f;
      --ov-m-get:            #7bb0a0;
      --ov-m-post:           #4c9dff;
      --ov-m-put:            #d9a441;
      --ov-m-patch:          #d9a441;
      --ov-m-delete:         #e5615e;
      --ov-m-ws:             #b78bff;
      --ov-s-2xx:            #4ec9a5;
      --ov-s-3xx:            #54b8c8;
      --ov-s-4xx:            #d9a441;
      --ov-s-5xx:            #e5615e;
      --ov-s-err:            #e5615e;
      --ov-s-pending:        #5b8cff;
      --ov-scrollbar:        #2a333f;
      --ov-shadow:           0 40px 90px -20px rgba(0,0,0,.7);
      --ov-shadow-pop:       0 24px 50px -12px rgba(0,0,0,.75);
      --ov-r-sm:             5px;
      --ov-r:                7px;
      --ov-r-lg:             10px;
      position: fixed !important;
      bottom: 20px !important;
      right: 20px !important;
      width: 520px !important;
      height: 640px !important;
      min-width: 360px !important;
      min-height: 240px !important;
      max-width: 95vw !important;
      max-height: 95vh !important;
      background: var(--ov-bg) !important;
      color: var(--ov-text) !important;
      border-radius: 12px !important;
      box-shadow: var(--ov-shadow), 0 0 0 1px rgba(255,255,255,.02) inset !important;
      z-index: 2147483647 !important;
      font-family: var(--ov-font-family,'IBM Plex Mono','JetBrains Mono',ui-monospace,monospace) !important;
      font-size: calc(12px * var(--ov-font-scale,1)) !important;
      display: flex !important;
      flex-direction: column !important;
      overflow: hidden !important;
      border: 1px solid var(--ov-border) !important;
      /* Drives the narrow-panel rules below; the workspace can be resized to
         roughly 360px, at which point secondary columns give up their space. */
      container-type: inline-size !important;
    }
    #ov-panel[data-theme="light"] {
      --ov-bg:               #ffffff;
      --ov-bg-2:             #f7f9fb;
      --ov-bg-3:             #eef1f5;
      --ov-log:              #fafbfc;
      --ov-hdr:              #f3f5f8;
      --ov-hdr-flat:         #f3f5f8;
      --ov-border:           #dce1e8;
      --ov-border-soft:      #e4e8ee;
      --ov-grid:             #f0f2f5;
      --ov-text:             #1c2530;
      --ov-text-dim:         #3a4552;
      --ov-text-muted:       #5c6773;
      --ov-text-faint:       #67727e;
      --ov-text-ghost:       #98a2ae;
      --ov-title:            #1c2530;
      --ov-accent:           #2563eb;
      --ov-accent-soft:      #1d4ed8;
      --ov-accent-bg:        rgba(37,99,235,.10);
      --ov-accent-bd:        rgba(37,99,235,.35);
      --ov-trace:            #7c3aed;
      --ov-trace-bg:         rgba(124,58,237,.14);
      --ov-trace-bd:         rgba(124,58,237,.45);
      --ov-mark:             linear-gradient(135deg,#3b6fe0,#7c3aed);
      --ov-mark-fg:          #ffffff;
      --ov-m-get:            #2f8f6f;
      --ov-m-post:           #2563eb;
      --ov-m-put:            #b7791f;
      --ov-m-patch:          #b7791f;
      --ov-m-delete:         #d64545;
      --ov-m-ws:             #7c3aed;
      --ov-s-2xx:            #17915f;
      --ov-s-3xx:            #0f7490;
      --ov-s-4xx:            #b7791f;
      --ov-s-5xx:            #d64545;
      --ov-s-err:            #d64545;
      --ov-s-pending:        #2563eb;
      --ov-scrollbar:        #cfd5de;
      --ov-shadow:           0 30px 60px -24px rgba(20,30,50,.35);
      --ov-shadow-pop:       0 18px 40px -12px rgba(20,30,50,.28);
    }

    @keyframes ov-pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
    @keyframes ov-spin  { to { transform: rotate(360deg); } }
    @keyframes ov-fadein { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:translateY(0); } }

    /* ══ Header — one compact toolbar ═══════════════════════════════════════ */
    #ov-header {
      display: flex !important;
      align-items: center !important;
      gap: 8px !important;
      padding: 8px 10px !important;
      background: var(--ov-hdr) !important;
      cursor: move !important;
      user-select: none !important;
      border-bottom: 1px solid var(--ov-border) !important;
      flex-shrink: 0 !important;
      flex-wrap: nowrap !important;
    }
    .ov-grip {
      background-image: radial-gradient(circle, var(--ov-text-ghost) 1px, transparent 1px) !important;
      background-size: 4px 4px !important;
      width: 8px !important;
      height: 12px !important;
      flex-shrink: 0 !important;
    }
    .ov-mark {
      width: 20px !important;
      height: 20px !important;
      border-radius: var(--ov-r-sm) !important;
      background: var(--ov-mark) !important;
      color: var(--ov-mark-fg) !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      font-weight: 700 !important;
      font-size: calc(11px * var(--ov-font-scale,1)) !important;
      flex-shrink: 0 !important;
      font-family: inherit !important;
    }
    .ov-hdr-title {
      font-weight: 700 !important;
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
      color: var(--ov-title) !important;
      letter-spacing: .1em !important;
      text-transform: uppercase !important;
      flex-shrink: 0 !important;
    }
    /* Pushes #ov-actions to the trailing edge, so the controls track the panel's
       width instead of bunching against the live badge on a wide panel. */
    .ov-hdr-spacer { flex: 1 !important; min-width: 0 !important; }
    .ov-live {
      display: inline-flex !important;
      align-items: center !important;
      gap: 6px !important;
      padding: 2px 8px !important;
      border-radius: 20px !important;
      background: rgba(78,201,165,.12) !important;
      border: 1px solid rgba(78,201,165,.25) !important;
      color: var(--ov-s-2xx) !important;
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
      font-weight: 500 !important;
      flex-shrink: 0 !important;
      font-variant-numeric: tabular-nums !important;
    }
    .ov-live-dot {
      width: 6px !important;
      height: 6px !important;
      border-radius: 50% !important;
      background: var(--ov-s-2xx) !important;
      animation: ov-pulse 1.6s infinite !important;
      flex-shrink: 0 !important;
      display: inline-block !important;
    }
    #ov-panel.ov-paused .ov-live {
      background: rgba(217,164,65,.12) !important;
      border-color: rgba(217,164,65,.3) !important;
      color: var(--ov-s-4xx) !important;
    }
    #ov-panel.ov-paused .ov-live-dot { background: var(--ov-s-4xx) !important; animation: none !important; }

    /* ── Segmented view switch ── */
    .ov-views {
      display: flex !important;
      gap: 2px !important;
      background: var(--ov-bg-2) !important;
      border: 1px solid var(--ov-border) !important;
      border-radius: 8px !important;
      padding: 2px !important;
      flex-shrink: 0 !important;
    }
    .ov-view {
      all: unset !important;
      cursor: pointer !important;
      display: inline-flex !important;
      align-items: center !important;
      gap: 5px !important;
      padding: 4px 11px !important;
      border-radius: var(--ov-r) !important;
      font-family: var(--ov-font-family,'IBM Plex Sans',system-ui,sans-serif) !important;
      font-size: calc(11px * var(--ov-font-scale,1)) !important;
      color: var(--ov-text-muted) !important;
      white-space: nowrap !important;
      transition: background 90ms, color 90ms !important;
    }
    .ov-view:hover { color: var(--ov-text-dim) !important; }
    .ov-view.on {
      background: var(--ov-border) !important;
      color: var(--ov-title) !important;
      font-weight: 600 !important;
    }
    #ov-panel[data-theme="light"] .ov-view.on { background: #ffffff !important; box-shadow: 0 1px 2px rgba(20,30,50,.12) !important; }
    .ov-view-n {
      font-size: calc(9px * var(--ov-font-scale,1)) !important;
      font-weight: 700 !important;
      color: var(--ov-text-dim) !important;
    }
    .ov-view-n[hidden] { display: none !important; }

    /* ── Second row: the filter field, its own full-width line ── */
    #ov-toolbar {
      display: flex !important;
      align-items: center !important;
      gap: 8px !important;
      padding: 7px 10px !important;
      background: var(--ov-bg-2) !important;
      border-bottom: 1px solid var(--ov-border-soft) !important;
      flex-shrink: 0 !important;
      cursor: move !important;
      user-select: none !important;
    }
    .ov-search {
      display: flex !important;
      align-items: center !important;
      gap: 7px !important;
      flex: 1 1 auto !important;
      min-width: 0 !important;
      height: 28px !important;
      background: var(--ov-bg) !important;
      border: 1px solid var(--ov-border) !important;
      border-radius: var(--ov-r) !important;
      padding: 0 7px 0 9px !important;
      /* The toolbar is a drag handle, so it hands down cursor:move. The field has
         to look typeable across its whole box, padding and prompt included. */
      cursor: text !important;
    }
    .ov-search:focus-within { border-color: var(--ov-accent-bd) !important; }
    .ov-prompt {
      color: var(--ov-text-faint) !important;
      font-size: calc(12px * var(--ov-font-scale,1)) !important;
      flex-shrink: 0 !important;
    }
    #ov-filter {
      all: unset !important;
      flex: 1 1 auto !important;
      min-width: 0 !important;
      color: var(--ov-text) !important;
      font-size: calc(11px * var(--ov-font-scale,1)) !important;
      font-family: inherit !important;
      /* all:unset drops the UA's own cursor and user-select, leaving the input to
         inherit the drag handle's move cursor and its unselectable text. */
      cursor: text !important;
      user-select: text !important;
      -webkit-user-select: text !important;
    }
    #ov-filter::placeholder { color: var(--ov-text-ghost) !important; }
    #ov-filter.ov-filter-invalid { color: var(--ov-s-err) !important; }
    .ov-hits {
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
      color: var(--ov-text-faint) !important;
      white-space: nowrap !important;
      flex-shrink: 0 !important;
    }
    .ov-modebtn {
      all: unset !important;
      cursor: pointer !important;
      padding: 2px 6px !important;
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
      font-weight: 600 !important;
      font-family: inherit !important;
      color: var(--ov-text-faint) !important;
      border-radius: var(--ov-r-sm) !important;
      flex-shrink: 0 !important;
    }
    .ov-modebtn:hover { color: var(--ov-text-dim) !important; background: var(--ov-bg-3) !important; }
    .ov-modebtn.ov-active {
      color: var(--ov-accent-soft) !important;
      background: var(--ov-accent-bg) !important;
    }

    /* ── Text actions, separated by rules ── */
    #ov-actions { display: flex !important; align-items: center !important; gap: 2px !important; flex-shrink: 0 !important; }
    #ov-actions button {
      all: unset !important;
      cursor: pointer !important;
      color: var(--ov-text-muted) !important;
      padding: 3px 7px !important;
      border-radius: var(--ov-r-sm) !important;
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
      font-family: inherit !important;
      white-space: nowrap !important;
      transition: color 90ms, background 90ms !important;
    }
    #ov-actions button:hover { color: var(--ov-title) !important; background: var(--ov-bg-3) !important; }
    #ov-actions button.ov-active { color: var(--ov-accent) !important; background: var(--ov-accent-bg) !important; }
    #ov-panel .ov-divider {
      width: 1px !important;
      height: 13px !important;
      background: var(--ov-border) !important;
      flex-shrink: 0 !important;
      margin: 0 3px !important;
    }

    /* ══ Filter row ═════════════════════════════════════════════════════════ */
    /* Every filter is on the panel permanently — nothing behind a disclosure. */
    #ov-chips {
      display: flex !important;
      align-items: center !important;
      flex-wrap: wrap !important;
      gap: 4px 10px !important;
      padding: 7px 10px !important;
      background: var(--ov-bg) !important;
      border-bottom: 1px solid var(--ov-border) !important;
      flex-shrink: 0 !important;
    }
    /* Each group is its own flex run so a wrap never splits a label from the
       chips it names. */
    .ov-chip-group {
      display: flex !important;
      align-items: center !important;
      gap: 4px !important;
      min-width: 0 !important;
    }
    .ov-chip-label {
      font-size: calc(9px * var(--ov-font-scale,1)) !important;
      letter-spacing: .07em !important;
      text-transform: uppercase !important;
      color: var(--ov-text-ghost) !important;
      flex-shrink: 0 !important;
      margin-right: 2px !important;
    }
    .ov-chip-sep {
      width: 1px !important;
      height: 13px !important;
      background: var(--ov-border) !important;
      flex-shrink: 0 !important;
    }
    .ov-chip {
      all: unset !important;
      cursor: pointer !important;
      font-size: calc(9.5px * var(--ov-font-scale,1)) !important;
      font-weight: 600 !important;
      font-family: inherit !important;
      padding: 2px 7px !important;
      border-radius: var(--ov-r) !important;
      border: 1px solid var(--ov-border) !important;
      color: var(--ov-text-muted) !important;
      background: var(--ov-bg-2) !important;
      white-space: nowrap !important;
      transition: color 90ms, border-color 90ms, background 90ms !important;
    }
    .ov-chip:hover { color: var(--ov-text-dim) !important; border-color: var(--ov-text-faint) !important; }
    .ov-chip.on {
      border-color: var(--ov-accent-bd) !important;
      color: var(--ov-accent-soft) !important;
      background: var(--ov-accent-bg) !important;
    }
    .ov-chip[data-s="2xx"].on { color: var(--ov-s-2xx) !important; border-color: var(--ov-s-2xx) !important; background: rgba(78,201,165,.14) !important; }
    .ov-chip[data-s="3xx"].on { color: var(--ov-s-3xx) !important; border-color: var(--ov-s-3xx) !important; background: rgba(84,184,200,.14) !important; }
    .ov-chip[data-s="4xx"].on { color: var(--ov-s-4xx) !important; border-color: var(--ov-s-4xx) !important; background: rgba(217,164,65,.14) !important; }
    .ov-chip[data-s="5xx"].on { color: var(--ov-s-5xx) !important; border-color: var(--ov-s-5xx) !important; background: rgba(229,97,94,.14) !important; }
    .ov-chip[data-m="GET"].on    { color: var(--ov-m-get) !important;    border-color: var(--ov-m-get) !important; }
    .ov-chip[data-m="POST"].on   { color: var(--ov-m-post) !important;   border-color: var(--ov-m-post) !important; }
    .ov-chip[data-m="PUT"].on    { color: var(--ov-m-put) !important;    border-color: var(--ov-m-put) !important; }
    .ov-chip[data-m="PATCH"].on  { color: var(--ov-m-patch) !important;  border-color: var(--ov-m-patch) !important; }
    .ov-chip[data-m="DELETE"].on { color: var(--ov-m-delete) !important; border-color: var(--ov-m-delete) !important; }
    .ov-chip[data-m="WS"].on     { color: var(--ov-m-ws) !important;     border-color: var(--ov-m-ws) !important; }
    .ov-chip-count { font-size: calc(9px * var(--ov-font-scale,1)) !important; margin-left: 4px !important; opacity: .7 !important; }

    /* ══ Log ════════════════════════════════════════════════════════════════ */
    #ov-list {
      overflow-y: auto !important;
      flex: 1 1 auto !important;
      min-height: 0 !important;
      background: var(--ov-log) !important;
    }
    #ov-list::-webkit-scrollbar { width: 9px !important; }
    #ov-list::-webkit-scrollbar-track { background: transparent !important; }
    #ov-list::-webkit-scrollbar-thumb { background: var(--ov-scrollbar) !important; border-radius: 6px !important; }

    /* Row + heading share one grid so the columns line up. */
    .ov-list-head, .ov-row {
      display: grid !important;
      grid-template-columns: 50px minmax(0,1fr) 130px 40px 54px 46px !important;
      align-items: center !important;
    }
    .ov-list-head {
      position: sticky !important;
      top: 0 !important;
      z-index: 2 !important;
      padding: 6px 0 !important;
      background: var(--ov-log) !important;
      border-bottom: 1px solid var(--ov-grid) !important;
      font-size: calc(9px * var(--ov-font-scale,1)) !important;
      letter-spacing: .08em !important;
      text-transform: uppercase !important;
      color: var(--ov-text-ghost) !important;
    }
    .ov-lh { padding: 0 5px !important; white-space: nowrap !important; overflow: hidden !important; }
    .ov-lh-method { padding-left: 12px !important; }
    .ov-lh-status, .ov-lh-dur { text-align: right !important; }

    .ov-row {
      min-height: 30px !important;
      border-bottom: 1px solid var(--ov-grid) !important;
      background: transparent !important;
      cursor: pointer !important;
      border-left: 2px solid transparent !important;
      transition: background 90ms !important;
    }
    .ov-row:hover { background: var(--ov-bg-2) !important; }
    .ov-row.ov-expanded {
      background: var(--ov-accent-bg) !important;
      border-left-color: var(--ov-accent) !important;
    }
    .ov-row.ov-pinned:not(.ov-expanded) { border-left-color: var(--ov-m-patch) !important; }
    .ov-row.ov-row-rev-hl {
      background: var(--ov-trace-bg) !important;
      border-left-color: var(--ov-trace) !important;
    }

    .ov-c {
      padding: 0 5px !important;
      min-width: 0 !important;
      white-space: nowrap !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      font-size: calc(11px * var(--ov-font-scale,1)) !important;
      line-height: 30px !important;
    }
    .ov-c-method {
      font-weight: 600 !important;
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
      letter-spacing: .03em !important;
      padding-left: 10px !important;
    }
    .ov-c-method.m-get    { color: var(--ov-m-get)    !important; }
    .ov-c-method.m-post   { color: var(--ov-m-post)   !important; }
    .ov-c-method.m-put    { color: var(--ov-m-put)    !important; }
    .ov-c-method.m-patch  { color: var(--ov-m-patch)  !important; }
    .ov-c-method.m-delete { color: var(--ov-m-delete) !important; }
    .ov-c-method.m-ws     { color: var(--ov-m-ws)     !important; }
    .ov-c-url { display: flex !important; align-items: center !important; gap: 6px !important; }
    .ov-init-dot {
      width: 6px !important;
      height: 6px !important;
      border-radius: 50% !important;
      background: var(--ov-trace) !important;
      flex: none !important;
    }
    .ov-init-dot.ov-init-bg { background: var(--ov-text-ghost) !important; }
    .ov-url-path { color: var(--ov-text-dim) !important; overflow: hidden !important; text-overflow: ellipsis !important; }
    .ov-row.ov-expanded .ov-url-path { color: var(--ov-title) !important; }
    .ov-fr { font-size: calc(9px * var(--ov-font-scale,1)) !important; color: var(--ov-m-ws) !important; flex-shrink: 0 !important; }
    .ov-c-init {
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
      color: var(--ov-trace) !important;
    }
    .ov-c-init.ov-init-bg { color: var(--ov-text-ghost) !important; }
    .ov-c-status {
      font-weight: 600 !important;
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
      text-align: right !important;
    }
    .ov-c-status.s-2xx     { color: var(--ov-s-2xx) !important; }
    .ov-c-status.s-3xx     { color: var(--ov-s-3xx) !important; }
    .ov-c-status.s-4xx     { color: var(--ov-s-4xx) !important; }
    .ov-c-status.s-5xx     { color: var(--ov-s-5xx) !important; }
    .ov-c-status.s-err     { color: var(--ov-s-err) !important; }
    .ov-c-status.s-pending { color: var(--ov-s-pending) !important; animation: ov-pulse 1.4s infinite !important; }
    .ov-c-dur {
      color: var(--ov-text-faint) !important;
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
      font-variant-numeric: tabular-nums !important;
      text-align: right !important;
    }
    .ov-c-act {
      display: flex !important;
      gap: 2px !important;
      align-items: center !important;
      justify-content: flex-end !important;
      padding-right: 6px !important;
      opacity: 0 !important;
      transition: opacity 90ms !important;
    }
    .ov-row:hover .ov-c-act,
    .ov-row.ov-pinned .ov-c-act { opacity: 1 !important; }
    .ov-pin-btn, .ov-copy-btn, .ov-copy-tab-btn {
      all: unset !important;
      cursor: pointer !important;
      font-size: calc(9px * var(--ov-font-scale,1)) !important;
      font-family: inherit !important;
      color: var(--ov-text-faint) !important;
      padding: 2px 5px !important;
      border-radius: var(--ov-r-sm) !important;
    }
    .ov-pin-btn:hover, .ov-copy-btn:hover, .ov-copy-tab-btn:hover {
      background: var(--ov-bg-3) !important;
      color: var(--ov-text) !important;
    }
    .ov-pin-btn.on { color: var(--ov-m-patch) !important; }

    /* Narrow panel: the initiator column is the first to go, then the duration.
       A hidden cell stops being a grid item, so each breakpoint drops the matching
       track too — leave the counts out of step and every later column shifts. */
    /* The wordmark goes before anything functional does — the C mark still
       identifies the panel, and the row needs its width for the controls. */
    @container (max-width: 430px) {
      .ov-hdr-title { display: none !important; }
    }
    /* Then the chips give up their group labels: a chip reading "2xx" or "GET"
       already names its own dimension. */
    @container (max-width: 470px) {
      .ov-chip-label, .ov-chip-sep { display: none !important; }
      #ov-chips { gap: 4px 6px !important; }
      #ov-header, #ov-toolbar, #ov-chips { padding-left: 7px !important; padding-right: 7px !important; }
      #ov-header { gap: 6px !important; }
      .ov-view { padding: 4px 8px !important; }
      .ov-view-n { display: none !important; }
      .ov-live { padding: 2px 6px !important; }
      #ov-actions button { padding: 3px 5px !important; }
    }
    @container (max-width: 520px) {
      .ov-list-head, .ov-row { grid-template-columns: 46px minmax(0,1fr) 40px 52px 44px !important; }
      .ov-c-init, .ov-lh-init { display: none !important; }
    }
    @container (max-width: 400px) {
      .ov-list-head, .ov-row { grid-template-columns: 42px minmax(0,1fr) 38px 40px !important; }
      .ov-c-dur, .ov-lh-dur { display: none !important; }
      #ov-dock { max-height: 66% !important; }
    }

    /* ══ Docked inspector ═══════════════════════════════════════════════════ */
    #ov-dock {
      flex: 0 0 auto !important;
      /* Three rows of chrome sit above the log now, so the dock takes less of
         what is left — the log has to stay usable while the inspector is open. */
      max-height: 50% !important;
      display: flex !important;
      flex-direction: column !important;
      overflow: hidden !important;
      background: var(--ov-bg) !important;
      border-top: 2px solid var(--ov-border) !important;
    }
    #ov-dock[hidden] { display: none !important; }
    .ov-detail {
      display: flex !important;
      flex-direction: column !important;
      flex: 1 1 auto !important;
      min-height: 0 !important;
      overflow: hidden !important;
    }

    /* ── Detail head ── */
    .ov-dh { padding: 10px 12px 9px !important; border-bottom: 1px solid var(--ov-border-soft) !important; flex-shrink: 0 !important; }
    .ov-dh-top { display: flex !important; align-items: center !important; gap: 8px !important; margin-bottom: 7px !important; }
    .ov-dh-method {
      padding: 2px 8px !important;
      border-radius: var(--ov-r) !important;
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
      font-weight: 700 !important;
      background: var(--ov-bg-3) !important;
      flex-shrink: 0 !important;
    }
    .ov-dh-method.m-get    { color: var(--ov-m-get)    !important; }
    .ov-dh-method.m-post   { color: var(--ov-m-post)   !important; background: rgba(76,157,255,.16) !important; }
    .ov-dh-method.m-put    { color: var(--ov-m-put)    !important; }
    .ov-dh-method.m-patch  { color: var(--ov-m-patch)  !important; }
    .ov-dh-method.m-delete { color: var(--ov-m-delete) !important; }
    .ov-dh-method.m-ws     { color: var(--ov-m-ws)     !important; background: rgba(183,139,255,.16) !important; }
    .ov-dh-status {
      font-size: calc(11px * var(--ov-font-scale,1)) !important;
      font-weight: 600 !important;
      display: inline-flex !important;
      align-items: center !important;
      gap: 5px !important;
      flex-shrink: 0 !important;
    }
    .ov-dh-status.s-2xx     { color: var(--ov-s-2xx) !important; }
    .ov-dh-status.s-3xx     { color: var(--ov-s-3xx) !important; }
    .ov-dh-status.s-4xx     { color: var(--ov-s-4xx) !important; }
    .ov-dh-status.s-5xx     { color: var(--ov-s-5xx) !important; }
    .ov-dh-status.s-err     { color: var(--ov-s-err) !important; }
    .ov-dh-status.s-pending { color: var(--ov-s-pending) !important; }
    .ov-spinner {
      width: 9px !important;
      height: 9px !important;
      border: 2px solid var(--ov-border) !important;
      border-top-color: var(--ov-accent) !important;
      border-radius: 50% !important;
      display: inline-block !important;
      animation: ov-spin .7s linear infinite !important;
      flex-shrink: 0 !important;
    }
    .ov-dh-meta { font-size: calc(10px * var(--ov-font-scale,1)) !important; color: var(--ov-text-muted) !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; }
    .ov-dh-spacer { flex: 1 !important; }
    .ov-dh-pin, .ov-dh-close {
      all: unset !important;
      cursor: pointer !important;
      font-family: inherit !important;
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
      color: var(--ov-text-muted) !important;
      border: 1px solid var(--ov-border) !important;
      background: var(--ov-bg-3) !important;
      border-radius: var(--ov-r) !important;
      padding: 3px 8px !important;
      flex-shrink: 0 !important;
      opacity: 1 !important;
    }
    .ov-dh-pin:hover, .ov-dh-close:hover { color: var(--ov-title) !important; border-color: var(--ov-text-faint) !important; }
    .ov-dh-pin.on { color: var(--ov-m-patch) !important; border-color: var(--ov-m-patch) !important; }
    .ov-dh-url {
      font-size: calc(11px * var(--ov-font-scale,1)) !important;
      color: var(--ov-text-muted) !important;
      word-break: break-all !important;
      line-height: 1.5 !important;
    }
    .ov-dh-path { color: var(--ov-title) !important; font-weight: 600 !important; }
    .ov-dh-trigger {
      all: unset !important;
      display: flex !important;
      align-items: center !important;
      gap: 8px !important;
      margin-top: 8px !important;
      padding: 5px 9px !important;
      border-radius: var(--ov-r) !important;
      background: var(--ov-trace-bg) !important;
      border: 1px solid var(--ov-trace-bd) !important;
      font-family: inherit !important;
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
      cursor: pointer !important;
      box-sizing: border-box !important;
      width: 100% !important;
      overflow: hidden !important;
    }
    .ov-dh-trigger-bg {
      background: var(--ov-bg-2) !important;
      border-color: var(--ov-border) !important;
      cursor: default !important;
    }
    .ov-dh-trigger-lbl { color: var(--ov-trace) !important; flex-shrink: 0 !important; }
    .ov-dh-trigger-bg .ov-dh-trigger-lbl { color: var(--ov-text-faint) !important; }
    .ov-dh-trigger-el {
      color: var(--ov-title) !important;
      background: var(--ov-bg-3) !important;
      padding: 1px 6px !important;
      border-radius: 4px !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      white-space: nowrap !important;
      min-width: 0 !important;
    }
    .ov-dh-trigger-hint { color: var(--ov-text-ghost) !important; flex-shrink: 0 !important; margin-left: auto !important; }
    .ov-dh-trigger:hover .ov-dh-trigger-hint { color: var(--ov-accent-soft) !important; }

    /* ── Detail tabs ── */
    .ov-tabs {
      display: flex !important;
      align-items: center !important;
      gap: 2px !important;
      padding: 6px 10px 0 !important;
      border-bottom: 1px solid var(--ov-border-soft) !important;
      flex-shrink: 0 !important;
    }
    .ov-tab {
      all: unset !important;
      cursor: pointer !important;
      padding: 5px 10px !important;
      font-size: calc(10.5px * var(--ov-font-scale,1)) !important;
      color: var(--ov-text-muted) !important;
      border-bottom: 2px solid transparent !important;
      font-family: inherit !important;
      text-transform: capitalize !important;
    }
    .ov-tab:hover { color: var(--ov-text-dim) !important; }
    .ov-tab.ov-tab-active {
      color: var(--ov-title) !important;
      font-weight: 600 !important;
      border-bottom-color: var(--ov-accent) !important;
    }
    .ov-tab-spacer { flex: 1 !important; }

    /* ── Detail panes ── */
    .ov-panel {
      padding: 10px 12px !important;
      overflow-y: auto !important;
      flex: 1 1 auto !important;
      min-height: 0 !important;
    }
    .ov-panel::-webkit-scrollbar { width: 9px !important; }
    .ov-panel::-webkit-scrollbar-thumb { background: var(--ov-scrollbar) !important; border-radius: 6px !important; }
    .ov-detail-section { margin-bottom: 10px !important; }
    .ov-detail-label {
      font-size: calc(9px * var(--ov-font-scale,1)) !important;
      font-weight: 600 !important;
      color: var(--ov-text-faint) !important;
      letter-spacing: .08em !important;
      text-transform: uppercase !important;
      margin-bottom: 5px !important;
    }
    .ov-hdr-table {
      background: var(--ov-bg-2) !important;
      border: 1px solid var(--ov-border-soft) !important;
      border-radius: var(--ov-r) !important;
      padding: 3px 0 !important;
      max-height: 180px !important;
      overflow-y: auto !important;
    }
    .ov-hdr-table::-webkit-scrollbar { width: 8px !important; }
    .ov-hdr-table::-webkit-scrollbar-thumb { background: var(--ov-scrollbar) !important; border-radius: 6px !important; }
    .ov-hdr-row {
      display: flex !important;
      gap: 8px !important;
      padding: 3px 9px !important;
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
      line-height: 1.45 !important;
    }
    .ov-hdr-row:hover { background: var(--ov-bg-3) !important; }
    .ov-hdr-name {
      color: var(--ov-accent-soft) !important;
      font-weight: 600 !important;
      flex-shrink: 0 !important;
      min-width: 110px !important;
      max-width: 180px !important;
      word-break: break-all !important;
    }
    .ov-hdr-val { color: var(--ov-text-muted) !important; word-break: break-all !important; flex: 1 !important; }
    .ov-body-pre {
      all: unset !important;
      display: block !important;
      background: var(--ov-bg-2) !important;
      border: 1px solid var(--ov-border-soft) !important;
      border-radius: var(--ov-r) !important;
      padding: 8px 9px !important;
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
      font-family: inherit !important;
      color: var(--ov-text-dim) !important;
      white-space: pre-wrap !important;
      word-break: break-all !important;
      max-height: 190px !important;
      overflow-y: auto !important;
    }
    .ov-body-pre::-webkit-scrollbar { width: 8px !important; }
    .ov-body-pre::-webkit-scrollbar-thumb { background: var(--ov-scrollbar) !important; border-radius: 6px !important; }
    .ov-trunc-note {
      font-size: calc(9.5px * var(--ov-font-scale,1)) !important;
      color: var(--ov-s-4xx) !important;
      background: rgba(217,164,65,.10) !important;
      border: 1px solid rgba(217,164,65,.3) !important;
      border-radius: var(--ov-r) !important;
      padding: 5px 8px !important;
      margin-bottom: 7px !important;
    }
    .ov-body-bar {
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      gap: 8px !important;
      margin-bottom: 7px !important;
    }
    .ov-body-meta { font-size: calc(9.5px * var(--ov-font-scale,1)) !important; color: var(--ov-text-faint) !important; }
    .ov-reveal-all {
      all: unset !important;
      cursor: pointer !important;
      font-family: inherit !important;
      font-size: calc(9.5px * var(--ov-font-scale,1)) !important;
      color: var(--ov-s-2xx) !important;
      background: rgba(78,201,165,.1) !important;
      border: 1px solid rgba(78,201,165,.25) !important;
      padding: 3px 9px !important;
      border-radius: 20px !important;
      text-align: center !important;
    }
    .ov-reveal-all:hover { background: rgba(78,201,165,.18) !important; }
    .ov-reveal-all.on {
      color: var(--ov-trace) !important;
      background: var(--ov-trace-bg) !important;
      border-color: var(--ov-trace-bd) !important;
    }

    /* ── JSON tree ── */
    .ov-body-json {
      display: block !important;
      background: var(--ov-bg-2) !important;
      border: 1px solid var(--ov-border-soft) !important;
      border-radius: var(--ov-r) !important;
      padding: 6px 8px !important;
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
      font-family: inherit !important;
      color: var(--ov-text) !important;
      white-space: pre-wrap !important;
      word-break: break-all !important;
      max-height: 220px !important;
      overflow-y: auto !important;
    }
    .ov-body-json.ov-jv-virt {
      position: relative !important;
      padding: 0 !important;
      overflow: auto !important;
      white-space: normal !important;
      word-break: normal !important;
      contain: strict !important;
      height: 220px !important;
    }
    .ov-jv-spacer { width: 1px !important; pointer-events: none !important; visibility: hidden !important; }
    .ov-jv-window { position: absolute !important; top: 0 !important; left: 0 !important; right: 0 !important; will-change: transform !important; }
    .ov-jv-line {
      display: block !important;
      height: 14px !important;
      line-height: 14px !important;
      padding: 0 8px !important;
      white-space: pre !important;
      overflow: visible !important;
      font-family: inherit !important;
    }
    .ov-body-json::-webkit-scrollbar { width: 9px !important; height: 9px !important; }
    .ov-body-json::-webkit-scrollbar-thumb { background: var(--ov-scrollbar) !important; border-radius: 6px !important; }
    .ov-jk { color: #7fb1ff !important; }
    .ov-jv { cursor: pointer !important; border-radius: 3px !important; padding: 0 2px !important; transition: background .1s !important; }
    .ov-jv-string  { color: #e6c07b !important; }
    .ov-jv-number  { color: #7ee0a1 !important; }
    .ov-jv-boolean { color: #b78bff !important; }
    .ov-jv-null    { color: #b78bff !important; font-style: italic !important; }
    #ov-panel[data-theme="light"] .ov-jk { color: #1d4ed8 !important; }
    #ov-panel[data-theme="light"] .ov-jv-string  { color: #a16207 !important; }
    #ov-panel[data-theme="light"] .ov-jv-number  { color: #15803d !important; }
    #ov-panel[data-theme="light"] .ov-jv-boolean { color: #7c3aed !important; }
    #ov-panel[data-theme="light"] .ov-jv-null    { color: #7c3aed !important; }
    .ov-jv:hover { background: var(--ov-accent-bg) !important; }
    .ov-jv.ov-jv-active {
      background: var(--ov-trace-bg) !important;
      box-shadow: 0 0 0 1px var(--ov-trace-bd) !important;
    }
    .ov-jv-trunc { color: var(--ov-text-ghost) !important; font-style: italic !important; }
    .ov-body-none { font-size: calc(10px * var(--ov-font-scale,1)) !important; color: var(--ov-text-ghost) !important; font-style: italic !important; }

    /* ── Timing ── */
    .ov-kv {
      display: grid !important;
      grid-template-columns: 88px 1fr !important;
      gap: 3px 10px !important;
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
    }
    .ov-kv-k {
      color: var(--ov-text-faint) !important;
      font-size: calc(9px * var(--ov-font-scale,1)) !important;
      font-weight: 600 !important;
      letter-spacing: .06em !important;
      text-transform: uppercase !important;
      padding: 2px 0 !important;
    }
    .ov-kv-v { color: var(--ov-text) !important; font-weight: 600 !important; padding: 2px 0 !important; }
    /* Explains an absence rather than warning about bad data, so it is set as
       quiet body text, not as a caution. */
    .ov-kv-note {
      margin-top: 12px !important;
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
      color: var(--ov-text-ghost) !important;
      line-height: 1.55 !important;
      font-family: var(--ov-font-family,'IBM Plex Sans',system-ui,sans-serif) !important;
    }

    /* ── WebSocket frames ── */
    .ov-ws-thread { display: flex !important; flex-direction: column !important; gap: 1px !important; }
    .ov-ws-msg { display: flex !important; gap: 10px !important; padding: 3px 0 !important; align-items: flex-start !important; }
    .ov-ws-dir {
      font-size: calc(11px * var(--ov-font-scale,1)) !important;
      font-weight: 700 !important;
      flex: none !important;
      width: 14px !important;
      text-align: center !important;
    }
    .ov-ws-sent .ov-ws-dir { color: var(--ov-m-post) !important; }
    .ov-ws-recv .ov-ws-dir { color: var(--ov-s-2xx) !important; }
    .ov-ws-body {
      all: unset !important;
      display: block !important;
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
      font-family: inherit !important;
      color: var(--ov-text-dim) !important;
      white-space: pre-wrap !important;
      word-break: break-all !important;
      flex: 1 !important;
    }
    .ov-ws-t {
      font-size: calc(9.5px * var(--ov-font-scale,1)) !important;
      color: var(--ov-text-ghost) !important;
      flex: none !important;
      width: 62px !important;
      font-variant-numeric: tabular-nums !important;
    }

    /* ══ Empty / dormant states ═════════════════════════════════════════════ */
    .ov-empty { padding: 22px 16px !important; }
    .ov-state {
      max-width: 320px !important;
      margin: 0 auto !important;
      padding: 18px 16px !important;
      border: 1px solid var(--ov-border) !important;
      border-radius: var(--ov-r-lg) !important;
      background: var(--ov-bg) !important;
      display: flex !important;
      flex-direction: column !important;
      font-family: var(--ov-font-family,'IBM Plex Sans',system-ui,sans-serif) !important;
    }
    .ov-state-idle { border-style: dashed !important; }
    .ov-state-ico {
      width: 32px !important;
      height: 32px !important;
      border-radius: 9px !important;
      background: var(--ov-bg-3) !important;
      border: 1px solid var(--ov-border) !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      font-size: calc(14px * var(--ov-font-scale,1)) !important;
      color: var(--ov-text-faint) !important;
      margin-bottom: 12px !important;
    }
    .ov-state-live .ov-state-ico {
      background: rgba(78,201,165,.1) !important;
      border-color: rgba(78,201,165,.25) !important;
    }
    .ov-state-warn .ov-state-ico {
      background: rgba(217,164,65,.1) !important;
      border-color: rgba(217,164,65,.3) !important;
      color: var(--ov-s-4xx) !important;
    }
    .ov-state-title {
      font-size: calc(12px * var(--ov-font-scale,1)) !important;
      font-weight: 600 !important;
      color: var(--ov-title) !important;
      margin-bottom: 5px !important;
    }
    .ov-state-body {
      font-size: calc(11px * var(--ov-font-scale,1)) !important;
      color: var(--ov-text-muted) !important;
      line-height: 1.55 !important;
    }
    .ov-state-note {
      margin-top: 12px !important;
      font-family: var(--ov-font-family,'IBM Plex Mono',ui-monospace,monospace) !important;
      font-size: calc(9.5px * var(--ov-font-scale,1)) !important;
      color: var(--ov-text-ghost) !important;
    }
    .ov-state-actions { display: flex !important; justify-content: center !important; padding: 0 16px 18px !important; }
    .ov-btn-primary {
      all: unset !important;
      padding: 7px 18px !important;
      border-radius: 8px !important;
      background: var(--ov-accent) !important;
      color: var(--ov-mark-fg) !important;
      font-family: var(--ov-font-family,'IBM Plex Sans',system-ui,sans-serif) !important;
      font-size: calc(11px * var(--ov-font-scale,1)) !important;
      font-weight: 600 !important;
      cursor: pointer !important;
    }
    .ov-btn-primary:disabled { opacity: .4 !important; cursor: not-allowed !important; }

    /* ── Site-map confidence tiers ── */
    .ov-tier-legend {
      display: flex !important;
      justify-content: center !important;
      flex-wrap: wrap !important;
      gap: 12px !important;
      padding: 14px 16px !important;
      font-size: calc(9.5px * var(--ov-font-scale,1)) !important;
    }
    .ov-tier { display: inline-flex !important; align-items: center !important; gap: 6px !important; }
    .ov-tier-swatch { width: 8px !important; height: 8px !important; border-radius: 2px !important; display: inline-block !important; }
    .ov-tier-observed { color: var(--ov-s-2xx) !important; }
    .ov-tier-observed .ov-tier-swatch { background: var(--ov-s-2xx) !important; }
    .ov-tier-declared { color: var(--ov-s-3xx) !important; }
    .ov-tier-declared .ov-tier-swatch { background: var(--ov-s-3xx) !important; }
    .ov-tier-inferred { color: var(--ov-s-4xx) !important; }
    .ov-tier-inferred .ov-tier-swatch { border: 1px dashed var(--ov-s-4xx) !important; }

    /* ══ Footer ═════════════════════════════════════════════════════════════ */
    #ov-footer {
      display: flex !important;
      align-items: center !important;
      gap: 12px !important;
      padding: 6px 12px !important;
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
      color: var(--ov-text-faint) !important;
      border-top: 1px solid var(--ov-border) !important;
      flex-shrink: 0 !important;
      background: var(--ov-hdr-flat) !important;
      overflow: hidden !important;
      white-space: nowrap !important;
    }
    .ov-fstat { color: var(--ov-text-faint) !important; }
    .ov-fstat b { color: var(--ov-text-dim) !important; font-weight: 600 !important; }
    .ov-fstat-err b { color: var(--ov-s-err) !important; }
    .ov-fstat-warn b { color: var(--ov-s-4xx) !important; }
    .ov-fstat-btn {
      all: unset !important;
      cursor: pointer !important;
      font-family: inherit !important;
      font-size: inherit !important;
      color: var(--ov-text-faint) !important;
      padding: 1px 6px !important;
      border: 1px solid transparent !important;
      border-radius: var(--ov-r-sm) !important;
    }
    .ov-fstat-btn:hover { border-color: var(--ov-border) !important; }
    .ov-fstat-btn.on {
      border-color: var(--ov-accent-bd) !important;
      background: var(--ov-accent-bg) !important;
    }
    .ov-fstat-btn:disabled { cursor: default !important; opacity: .5 !important; }
    .ov-fstat-btn:disabled:hover { border-color: transparent !important; }
    .ov-fspacer { flex: 1 !important; }
    .ov-fnote { color: var(--ov-text-ghost) !important; overflow: hidden !important; text-overflow: ellipsis !important; }

    /* ══ Resize handles ═════════════════════════════════════════════════════ */
    .ov-resize-handle { position: absolute !important; z-index: 10 !important; }
    .ov-resize-handle[data-dir="n"]  { top:0 !important; left:8px !important; right:8px !important; height:5px !important; cursor:n-resize !important; }
    .ov-resize-handle[data-dir="s"]  { bottom:0 !important; left:8px !important; right:8px !important; height:5px !important; cursor:s-resize !important; }
    .ov-resize-handle[data-dir="e"]  { top:8px !important; right:0 !important; bottom:8px !important; width:5px !important; cursor:e-resize !important; }
    .ov-resize-handle[data-dir="w"]  { top:8px !important; left:0 !important; bottom:8px !important; width:5px !important; cursor:w-resize !important; }
    .ov-resize-handle[data-dir="nw"] { top:0 !important; left:0 !important; width:8px !important; height:8px !important; cursor:nw-resize !important; }
    .ov-resize-handle[data-dir="ne"] { top:0 !important; right:0 !important; width:8px !important; height:8px !important; cursor:ne-resize !important; }
    .ov-resize-handle[data-dir="sw"] { bottom:0 !important; left:0 !important; width:8px !important; height:8px !important; cursor:sw-resize !important; }
    .ov-resize-handle[data-dir="se"] { bottom:0 !important; right:0 !important; width:8px !important; height:8px !important; cursor:se-resize !important; }

    /* ══ Minimized / ambient pill ═══════════════════════════════════════════ */
    /* A light capsule with a soft halo: status dot, count, REQ, a dense activity
       band, and the expand affordance. No wordmark — the shape is the identity. */
    #ov-pill {
      all: initial;
      position: fixed !important;
      bottom: 20px !important;
      right: 20px !important;
      z-index: 2147483646 !important;
      display: flex !important;
      align-items: center !important;
      gap: 9px !important;
      padding: 9px 16px !important;
      background: #ffffff !important;
      border: 0 !important;
      border-radius: 999px !important;
      font-family: var(--ov-font-family,'IBM Plex Mono','JetBrains Mono',ui-monospace,monospace) !important;
      font-size: calc(11px * var(--ov-font-scale,1)) !important;
      color: #1c2530 !important;
      cursor: move !important;
      /* Tight contact shadow, wide diffuse halo, and a hairline ring so the
         capsule still reads against a white page. */
      box-shadow:
        0 0 0 1px rgba(20,30,50,.06),
        0 2px 6px -1px rgba(20,30,50,.10),
        0 10px 28px -6px rgba(20,30,50,.16),
        0 0 0 7px rgba(20,30,50,.035) !important;
      user-select: none !important;
    }
    #ov-pill[data-theme="dark"] {
      background: #12161c !important;
      color: #eef2f7 !important;
      box-shadow:
        0 0 0 1px rgba(255,255,255,.07),
        0 2px 6px -1px rgba(0,0,0,.5),
        0 10px 28px -6px rgba(0,0,0,.6),
        0 0 0 7px rgba(255,255,255,.03) !important;
    }
    .ov-pill-dot {
      width: 8px !important; height: 8px !important;
      border-radius: 50% !important;
      background: #22c58b !important;
      flex-shrink: 0 !important;
      animation: ov-pulse 1.6s infinite !important;
    }
    .ov-pill-dot.ov-pill-paused { background: #d9a441 !important; animation: none !important; }
    .ov-pill-count {
      font-weight: 700 !important;
      font-size: calc(13px * var(--ov-font-scale,1)) !important;
      font-variant-numeric: tabular-nums !important;
    }
    .ov-pill-label {
      color: #98a2ae !important;
      font-size: calc(9.5px * var(--ov-font-scale,1)) !important;
      font-weight: 600 !important;
      letter-spacing: .1em !important;
      text-transform: uppercase !important;
    }
    #ov-pill[data-theme="dark"] .ov-pill-label { color: #6b7684 !important; }
    .ov-pill-err {
      color: #e5615e !important;
      font-weight: 700 !important;
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
      font-variant-numeric: tabular-nums !important;
    }
    /* Uniform full-height bars, packed tight — an activity band, not a chart. */
    .ov-pill-rail {
      display: flex !important;
      gap: 1.5px !important;
      align-items: center !important;
      height: 15px !important;
    }
    .ov-pill-tick {
      width: 2px !important;
      height: 15px !important;
      background: #1c2530 !important;
      border-radius: 0 !important;
      flex-shrink: 0 !important;
    }
    #ov-pill[data-theme="dark"] .ov-pill-tick { background: #e4eaf1 !important; }
    .ov-pill-tick.err  { background: #e5615e !important; }
    .ov-pill-tick.warn { background: #d9a441 !important; }
    .ov-pill-tick.ws   { background: #7c3aed !important; }
    #ov-pill[data-theme="dark"] .ov-pill-tick.ws { background: #8fb0ff !important; }
    .ov-pill-expand {
      all: unset !important;
      cursor: pointer !important;
      font-size: calc(13px * var(--ov-font-scale,1)) !important;
      color: #98a2ae !important;
      padding: 0 1px !important;
      line-height: 1 !important;
    }
    .ov-pill-expand:hover { color: #2563eb !important; }
    #ov-pill[data-theme="dark"] .ov-pill-expand { color: #6b7684 !important; }
    #ov-pill[data-theme="dark"] .ov-pill-expand:hover { color: #8fb0ff !important; }

    /* ══ Ghost mode ═════════════════════════════════════════════════════════ */
    .ov-ghost { opacity: 0.25 !important; transition: opacity 100ms !important; pointer-events: auto !important; }
    .ov-ghost:hover { opacity: 1 !important; }

    /* ══ On the page itself ═════════════════════════════════════════════════ */
    .ov-highlighted {
      outline: 2px solid #4c9dff !important;
      outline-offset: 2px !important;
      box-shadow: 0 0 0 4px rgba(76,157,255,.28) !important;
    }
    /* Value tracing is purple throughout — hover preview, pinned matches, and
       the one match the cycler is currently parked on. */
    .ov-value-hover {
      background: rgba(138,91,255,.10) !important;
      box-shadow: 0 0 0 1px rgba(138,91,255,.35) !important;
      border-radius: 4px !important;
    }
    .ov-value-match {
      background: rgba(138,91,255,.18) !important;
      box-shadow: 0 0 0 2px rgba(138,91,255,.45) !important;
      border-radius: 4px !important;
    }
    .ov-value-current {
      background: rgba(138,91,255,.26) !important;
      box-shadow: 0 0 0 2px rgba(138,91,255,.9), 0 0 0 6px rgba(138,91,255,.18) !important;
      border-radius: 4px !important;
    }

    /* ── Value-trace cycler ── */
    .ov-value-cycler {
      position: absolute !important;
      z-index: 2147483646 !important;
      transform: translateY(-100%) !important;
      display: flex !important;
      align-items: center !important;
      gap: 9px !important;
      padding: 6px 9px !important;
      background: #141a21 !important;
      border: 1px solid #8a5bff !important;
      border-radius: 8px !important;
      box-shadow: 0 12px 28px -8px rgba(0,0,0,.6) !important;
      white-space: nowrap !important;
      font-family: var(--ov-font-family,'IBM Plex Mono','JetBrains Mono',ui-monospace,monospace) !important;
      font-size: calc(11px * var(--ov-font-scale,1)) !important;
      color: #c3cdd8 !important;
      animation: ov-fadein .12s ease !important;
    }
    .ov-value-cycler.ov-vc-below { transform: none !important; }
    .ov-value-cycler[data-empty="1"] { border-color: #4f5a67 !important; }
    .ov-vc-val { color: #e6c07b !important; }
    .ov-value-cycler[data-empty="1"] .ov-vc-val { color: #8a97a6 !important; }
    .ov-vc-lbl { color: #8a97a6 !important; font-size: calc(10px * var(--ov-font-scale,1)) !important; }
    .ov-vc-nav { display: inline-flex !important; align-items: center !important; gap: 6px !important; }
    .ov-vc-pos { color: #c3cdd8 !important; font-variant-numeric: tabular-nums !important; }
    .ov-vc-btn {
      all: unset !important;
      cursor: pointer !important;
      color: #8fb0ff !important;
      font-family: inherit !important;
      font-size: calc(13px * var(--ov-font-scale,1)) !important;
      line-height: 1 !important;
      padding: 0 3px !important;
    }
    .ov-vc-btn:hover { color: #ffffff !important; }

    /* ── Element markers ── */
    .ov-float-badge {
      position: absolute !important;
      z-index: 2147483645 !important;
      pointer-events: none !important;
      font-family: var(--ov-font-family,'IBM Plex Mono','JetBrains Mono',ui-monospace,monospace) !important;
    }
    .ov-fb-cluster { pointer-events: auto !important; }

    /* dark theme (default) */
    .ov-fb-cluster .ov-fb-circle {
      background: #4c9dff !important;
      color: #04121f !important;
      border-color: rgba(255,255,255,.25) !important;
    }
    .ov-fb-cluster:hover .ov-fb-circle,
    .ov-fb-cluster.ov-fb-open .ov-fb-circle {
      background: #6fb2ff !important;
      border-color: #ffffff !important;
    }
    .ov-fb-cluster .ov-fb-popup { background: #141a21 !important; border-color: #2a333f !important; }
    .ov-fb-cluster .ov-fb-url { color: #c3cdd8 !important; }
    .ov-fb-cluster .ov-fb-s   { color: #8a97a6 !important; }

    /* light theme */
    .ov-fb-cluster[data-theme="light"] .ov-fb-circle {
      background: #2563eb !important;
      color: #ffffff !important;
      border-color: rgba(255,255,255,.6) !important;
    }
    .ov-fb-cluster[data-theme="light"]:hover .ov-fb-circle,
    .ov-fb-cluster[data-theme="light"].ov-fb-open .ov-fb-circle { background: #1d4ed8 !important; }
    .ov-fb-cluster[data-theme="light"] .ov-fb-popup {
      background: #ffffff !important;
      border-color: #dce1e8 !important;
      box-shadow: 0 14px 32px -10px rgba(20,30,50,.28) !important;
    }
    .ov-fb-cluster[data-theme="light"] .ov-fb-url { color: #3a4552 !important; }
    .ov-fb-cluster[data-theme="light"] .ov-fb-s   { color: #5c6773 !important; }

    /* Single-endpoint inline marker — the design's method pill on the element */
    .ov-fb-single {
      pointer-events: auto !important;
      background: #4c9dff !important;
      border: 0 !important;
      border-radius: 7px !important;
      box-shadow: 0 6px 14px -4px rgba(0,0,0,.5) !important;
      animation: ov-fadein .15s ease !important;
      max-width: min(340px, 90vw) !important;
      overflow: hidden !important;
    }
    .ov-fb-single .ov-fb-row { border-bottom: none !important; padding: 2px 8px !important; }
    .ov-fb-single .ov-fb-m { background: transparent !important; color: #04121f !important; padding: 0 !important; }
    .ov-fb-single .ov-fb-url { color: #04121f !important; font-weight: 600 !important; }
    .ov-fb-single .ov-fb-s   { color: rgba(4,18,31,.7) !important; }
    .ov-fb-single[data-theme="light"] { background: #2563eb !important; }
    .ov-fb-single[data-theme="light"] .ov-fb-m,
    .ov-fb-single[data-theme="light"] .ov-fb-url { color: #ffffff !important; }
    .ov-fb-single[data-theme="light"] .ov-fb-s { color: rgba(255,255,255,.75) !important; }

    .ov-fb-circle {
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      width: 24px !important;
      height: 24px !important;
      border-radius: 8px !important;
      font-size: calc(11px * var(--ov-font-scale,1)) !important;
      font-weight: 700 !important;
      cursor: pointer !important;
      box-shadow: 0 6px 14px -4px rgba(0,0,0,.5) !important;
      border: 1.5px solid !important;
      user-select: none !important;
      animation: ov-fadein .15s ease !important;
      transition: background .12s, border-color .12s, transform .1s !important;
    }
    .ov-fb-cluster:hover .ov-fb-circle { transform: scale(1.1) !important; }

    .ov-fb-popup {
      display: none !important;
      position: absolute !important;
      top: -4px !important;
      min-width: 230px !important;
      max-width: 340px !important;
      border-radius: var(--ov-r-lg, 10px) !important;
      box-shadow: 0 20px 40px -12px rgba(0,0,0,.6) !important;
      padding: 4px 0 !important;
      animation: ov-fadein .12s ease !important;
      z-index: 2147483646 !important;
      border: 1px solid !important;
      overflow: hidden !important;
    }
    .ov-fb-popup-right { left: 30px !important; right: auto !important; }
    .ov-fb-popup-left  { right: 30px !important; left: auto !important; }
    .ov-fb-popup-show { display: block !important; }
    .ov-fb-row {
      display: flex !important;
      align-items: center !important;
      gap: 6px !important;
      padding: 5px 10px !important;
      white-space: nowrap !important;
      overflow: hidden !important;
      border-bottom: 1px solid rgba(255,255,255,.05) !important;
      cursor: pointer !important;
    }
    .ov-fb-cluster[data-theme="light"] .ov-fb-row { border-bottom-color: #eef1f5 !important; }
    .ov-fb-row:last-child { border-bottom: none !important; }
    .ov-fb-cluster .ov-fb-row:hover { background: rgba(91,140,255,.12) !important; }
    .ov-fb-m {
      font-weight: 700 !important;
      font-size: calc(9px * var(--ov-font-scale,1)) !important;
      letter-spacing: .03em !important;
      padding: 1px 6px !important;
      border-radius: 4px !important;
      color: #04121f !important;
      flex-shrink: 0 !important;
    }
    .ov-fb-m-get    { background: #7bb0a0 !important; }
    .ov-fb-m-post   { background: #4c9dff !important; }
    .ov-fb-m-put    { background: #d9a441 !important; }
    .ov-fb-m-patch  { background: #d9a441 !important; }
    .ov-fb-m-delete { background: #e5615e !important; }
    .ov-fb-m-ws     { background: #b78bff !important; }
    .ov-fb-url {
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      flex: 1 1 0 !important;
      min-width: 0 !important;
    }
    .ov-fb-s {
      font-weight: 600 !important;
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
      flex-shrink: 0 !important;
    }
    .ov-fb-s-2 { color: #4ec9a5 !important; }
    .ov-fb-s-4 { color: #d9a441 !important; }
    .ov-fb-s-5 { color: #e5615e !important; }

    /* ══ Tooltips ═══════════════════════════════════════════════════════════ */
    #ov-panel [data-tip] { position: relative !important; }
    #ov-panel [data-tip]::after {
      content: attr(data-tip) !important;
      position: absolute !important;
      top: calc(100% + 7px) !important;
      left: 50% !important;
      transform: translateX(-50%) !important;
      background: var(--ov-bg-3) !important;
      color: var(--ov-text-dim) !important;
      border: 1px solid var(--ov-border) !important;
      border-radius: var(--ov-r-sm) !important;
      padding: 4px 8px !important;
      font-size: calc(9px * var(--ov-font-scale,1)) !important;
      font-family: var(--ov-font-family,'IBM Plex Mono',ui-monospace,monospace) !important;
      line-height: 1.5 !important;
      white-space: nowrap !important;
      pointer-events: none !important;
      opacity: 0 !important;
      transition: opacity 0.1s !important;
      z-index: 9999 !important;
      box-shadow: var(--ov-shadow-pop) !important;
    }
    #ov-panel [data-tip]::before {
      content: '' !important;
      position: absolute !important;
      top: calc(100% + 2px) !important;
      left: 50% !important;
      transform: translateX(-50%) !important;
      border: 4px solid transparent !important;
      border-bottom-color: var(--ov-border) !important;
      pointer-events: none !important;
      opacity: 0 !important;
      transition: opacity 0.1s !important;
      z-index: 9999 !important;
    }
    #ov-panel [data-tip]:hover::after { opacity: 1 !important; transition: opacity 0.15s 0.4s !important; }
    #ov-panel [data-tip]:hover::before { opacity: 1 !important; transition: opacity 0.15s 0.4s !important; }
    #ov-panel [data-tip][data-tip-pos="above"]::after { top: auto !important; bottom: calc(100% + 7px) !important; }
    #ov-panel [data-tip][data-tip-pos="above"]::before {
      top: auto !important; bottom: calc(100% + 2px) !important;
      border-bottom-color: transparent !important;
      border-top-color: var(--ov-border) !important;
    }
    #ov-panel [data-tip][data-tip-align="right"]::after { left: auto !important; right: 0 !important; transform: none !important; }
    #ov-panel [data-tip][data-tip-align="right"]::before { left: auto !important; right: 8px !important; transform: none !important; }
${smStylesCss()}
  `;
  document.documentElement.appendChild(s);
}

// ── Activation / deactivation ─────────────────────────────────────────────────

// The activation chain, flattened into named steps: theme → stored state →
// preserved log → surface. Each step is top-level so the callbacks don't nest.

// Chips only. Older builds also stored `flags`; that key is deliberately
// ignored so a stuck err/slow flag from before does not come back. Anything
// that is not a string array is dropped: this runs inside the activation
// chain, and a throw here would leave the page with no overlay at all.
function restoreFilters(saved: unknown): void {
  if (!saved || typeof saved !== 'object') return;
  const f = saved as Record<string, unknown>;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  for (const s of strings(f.status)) activeStatus.add(s);
  for (const m of strings(f.methods)) activeMethods.add(m);
  for (const i of strings(f.initiators)) activeInitiators.add(i);
}

function buildOverlaySurface(): void {
  // Opened by the site-map scanner: capture into the map, render nothing. The
  // scanned tab is closed as soon as its calls have been harvested.
  if (smCaptureOnly) { drainPreActivationBuffer(); return; }
  if (dockState === 'pill') buildPill();
  else buildPanel();
  // Replay anything captured before the UI existed (load-time requests).
  drainPreActivationBuffer();
}

function applyStoredOverlayState(result: Record<string, unknown>): void {
  dockState = (result.ovDockState as DockState) || 'panel';
  const view = result.ovView;
  if (view === 'log' || view === 'pinned' || view === 'map') currentView = view;
  if (Array.isArray(result.ovPinnedKeys)) {
    for (const k of result.ovPinnedKeys) pinnedKeys.add(k);
  }
  restoreFilters(result.ovFilters);
  savedPanelGeom = isValidPanelGeom(result.ovPanelGeom) ? result.ovPanelGeom : null;
  savedPillGeom = isValidPillGeom(result.ovPillGeom) ? result.ovPillGeom : null;
  // Must resolve before the surface is built — it decides whether to build one.
  void smCheckScanTab().then(() => hydrateFromPreserved(buildOverlaySurface));
}

function applyLoadedTheme(theme: 'dark' | 'light'): void {
  currentTheme = theme;
  chrome.storage.local.get(
    ['ovDockState', 'ovView', 'ovPinnedKeys', 'ovFilters', 'ovPanelGeom', 'ovPillGeom'],
    applyStoredOverlayState,
  );
}

function activateOverlay(): void {
  if (activated) return;
  activated = true;
  // The capture hook (dist/injected.js, a MAIN-world content script) is already
  // installed at document_start; here we only (re)enable emission in case a
  // prior deactivate stopped it. Requests seen
  // before activation were buffered and are replayed by drainPreActivationBuffer.
  signalInjected('start');

  const init = () => {
    loadFont().then(({ family, size }) => applyFont(family, size));
    loadTheme().then(applyLoadedTheme);
  };

  clusterOutsideClickHandler = (e: MouseEvent) => {
    const target = e.target as Element | null;
    for (const badge of selectorBadges.values()) {
      if (!badge.classList.contains('ov-fb-open')) continue;
      if (!badge.contains(target)) {
        badge.classList.remove('ov-fb-open');
        refreshClusterBadge(badge.dataset.sel ?? '');
      }
    }
  };
  document.addEventListener('click', clusterOutsideClickHandler, true);

  // Capture phase so a page that swallows its own clicks can't pin the panel open.
  dismissPressHandler = onDismissPress;
  dismissClickHandler = onDismissClick;
  document.addEventListener('mousedown', dismissPressHandler, true);
  document.addEventListener('click', dismissClickHandler, true);

  pageHoverHandler = onPageHover;
  pageHoverOutHandler = onPageHoverOut;
  document.addEventListener('mouseover', pageHoverHandler, true);
  document.addEventListener('mouseout', pageHoverOutHandler, true);

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init, { once: true });
}

function deactivateOverlay(): void {
  if (!activated) return;
  activated = false;
  // rowEventsBound needs no reset: it is keyed on the containers themselves, and
  // deactivation removes the panel, so a rebuild always gets fresh elements.
  if (clusterOutsideClickHandler) {
    document.removeEventListener('click', clusterOutsideClickHandler, true);
    clusterOutsideClickHandler = null;
  }
  if (dismissPressHandler) {
    document.removeEventListener('mousedown', dismissPressHandler, true);
    dismissPressHandler = null;
  }
  if (dismissClickHandler) {
    document.removeEventListener('click', dismissClickHandler, true);
    dismissClickHandler = null;
  }
  pressStartedOnOverlay = false;
  if (pageHoverHandler) {
    document.removeEventListener('mouseover', pageHoverHandler, true);
    pageHoverHandler = null;
  }
  if (pageHoverOutHandler) {
    document.removeEventListener('mouseout', pageHoverOutHandler, true);
    pageHoverOutHandler = null;
  }
  if (revHoverRaf) { cancelAnimationFrame(revHoverRaf); revHoverRaf = 0; }
  revHoverTarget = null;
  selectorIndex = new WeakMap();
  selectorIndexRev = -1;
  requestsRev = 0;
  clearRevHighlight();
  signalInjected('stop');
  smTeardown();
  cancelScheduledRender();
  // NOTE: do NOT clearPreserved() here — deactivation can fire from a transient
  // allowlist toggle (or extension reload), and dropping the user's captured
  // log on that path would be surprising. Preserved data is only cleared on
  // explicit user "Clear" or when the tab closes (handled by the SW).
  // Flush any pending writes so they reach the SW before this script dies.
  flushPreserve();
  dirtyPreserveIds.clear();
  pendingWsMessages.clear();
  if (preserveTimer !== null) { clearTimeout(preserveTimer); preserveTimer = null; }
  document.getElementById('ov-panel')?.remove();
  document.getElementById('ov-pill')?.remove();
  document.getElementById('ov-styles')?.remove();
  filterInput = null;
  clearAllBadges();
  clearValueHighlights();
  clearBulkHighlights();
  clearJvHover();
  requests.clear();
  expandedIds.clear();
  detailTabs.clear();
  pinnedIds.clear();
  activeStatus.clear();
  activeMethods.clear();
  activeInitiators.clear();
  smTeardown();
  activeFlags.clear();
  paused = false;
  panelVisible = true;
  preActivationBuffer.length = 0;
  dockState = 'panel';
  currentView = 'log';
  ghostHeld = false;
}

// ── Ghost mode ────────────────────────────────────────────────────────────────

window.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key !== 'Alt' || ghostHeld) return;
  if (ghostTimer !== null) { clearTimeout(ghostTimer); ghostTimer = null; }
  ghostTimer = window.setTimeout(() => {
    ghostTimer = null;
    if (!ghostHeld) {
      ghostHeld = true;
      $('ov-panel')?.classList.add('ov-ghost');
      $('ov-pill')?.classList.add('ov-ghost');
    }
  }, 80);
});

window.addEventListener('keyup', (e: KeyboardEvent) => {
  if (e.key !== 'Alt') return;
  if (ghostTimer !== null) { clearTimeout(ghostTimer); ghostTimer = null; }
  ghostHeld = false;
  $('ov-panel')?.classList.remove('ov-ghost');
  $('ov-pill')?.classList.remove('ov-ghost');
});

// ── Host allowlist ────────────────────────────────────────────────────────────

function hostAllowed(allowedHosts: string[], current: string): boolean {
  if (!current) return false;
  return allowedHosts.some(h => h === current || current.endsWith('.' + h));
}

chrome.storage.local.get('ovAllowedHosts', ({ ovAllowedHosts }) => {
  if (hostAllowed((ovAllowedHosts as string[]) ?? [], location.hostname)) {
    activateOverlay();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.ovAllowedHosts) return;
  const next = (changes.ovAllowedHosts.newValue as string[] | undefined) ?? [];
  const shouldBeActive = hostAllowed(next, location.hostname);
  if (shouldBeActive && !activated) activateOverlay();
  else if (!shouldBeActive && activated) deactivateOverlay();
});
