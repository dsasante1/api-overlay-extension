/// <reference types="chrome" />

interface ElementInfo { selector: string; label: string; }
interface WsMessage { dir: 'sent' | 'recv'; body: string; ts: number; }
type RequestStatus = number | 'pending' | 'error' | 'closed';
type HeaderPair = [string, string];
type DetailTab = 'response' | 'request' | 'headers' | 'timing' | 'frames';
type DockState = 'panel' | 'pill' | 'hidden';

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
  reqBody?: string | null;
  resBody?: string | null;
  reqHeaders?: HeaderPair[] | null;
  resHeaders?: HeaderPair[] | null;
  messages?: WsMessage[];
  ms?: number;
  // The page (or SPA route) that was loaded when this call fired. Stamped by the
  // content script rather than the injected hook, so it tracks in-page route
  // changes for free — location.href is read once per captured request.
  pageUrl?: string;
  _lcUrl?: string;
  _lcReqBody?: string;
  _lcResBody?: string;
  // Set once the site map has counted this request; the capture path emits
  // several times per request (pending → status → body) and only the first
  // terminal emit should increment a call count.
  _smFolded?: boolean;
}

interface OverlayMessage extends Partial<ApiRequest> {
  __apiOverlay?: boolean;
  __wsMsg?: boolean;
  wsId?: number;
  dir?: 'sent' | 'recv';
  body?: string;
}


const TIMING_DNS_MS = 12;
const TIMING_TCP_MS = 28;
const TIMING_DL_MS  = 20;

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
let cspBlocked = false;
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
type PanelGeom = { left: number; top: number; width: number; height: number };
type PillGeom = { left: number; top: number };
let savedPanelGeom: PanelGeom | null = null;
let savedPillGeom: PillGeom | null = null;
let showPinTray = false;
let ghostHeld = false;
let ghostTimer: number | null = null;
let clusterOutsideClickHandler: ((e: MouseEvent) => void) | null = null;

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
      () => void chrome.runtime.lastError,
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
      () => void chrome.runtime.lastError,
    );
  } catch { /* see flushPreserve */ }
}

function hydrateFromPreserved(onDone: () => void): void {
  try {
    chrome.runtime.sendMessage({ action: 'ov-get-preserved' }, (resp: { ok?: boolean; reqs?: ApiRequest[] } | undefined) => {
      void chrome.runtime.lastError;
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
    const k = iter.next().value as number | undefined;
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

window.addEventListener('message', (e: MessageEvent<OverlayMessage>) => {
  if (e.source !== window) return;
  if (!e.data?.__apiOverlay || !activated) return;
  const msg = e.data;

  if (msg.__wsMsg) {
    if (!isSafeId(msg.wsId)) return;
    const conn = requests.get(msg.wsId);
    if (conn) {
      if (!conn.messages) conn.messages = [];
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
    return;
  }

  if (!isSafeId(msg.id)) return;

  if (requests.has(msg.id)) {
    const existing = requests.get(msg.id)!;
    // element is re-evaluated on updates (e.g. the response emit), so the
    // selector can change or drop — invalidate the index when it does.
    const prevSel = existing.element?.selector;
    Object.assign(existing, msg);
    if (msg.element !== undefined && existing.element?.selector !== prevSel) requestsRev++;
    refreshSearchCache(existing, msg);
    // sync pin by key
    const key = pinKey(existing);
    if (pinnedKeys.has(key)) pinnedIds.add(existing.id);
    // Updates to existing rows are preserved even while paused — pause only
    // gates *new* entries (the `return` below). Keep this in sync if you ever
    // refactor the pause semantics.
    markPreserveDirty(existing.id);
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
  if (btn) btn.textContent = paused ? 'Resume' : 'Pause';
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

function tryParseJsonContainer(text: string | null | undefined): unknown | undefined {
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

// Recursive-descent JSON parser that tolerates end-of-input at any point: an
// unfinished string is kept as far as it was read, an unfinished object/array
// drops only its incomplete trailing element, and an unfinished value is
// discarded. Used only as a fallback for truncated bodies.
function parsePartialJson(src: string): unknown | undefined {
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

  function parseString(): string {
    i++; // opening quote
    let out = '';
    while (i < n) {
      const ch = src[i++];
      if (ch === '\\') {
        if (i >= n) break; // truncated escape
        const e = src[i++];
        switch (e) {
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case '/': out += '/'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'u': {
            if (i + 4 <= n) {
              const code = parseInt(src.slice(i, i + 4), 16);
              if (!Number.isNaN(code)) { out += String.fromCharCode(code); i += 4; }
            } else { i = n; }
            break;
          }
          default: out += e;
        }
      } else if (ch === '"') {
        return out;
      } else {
        out += ch;
      }
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

  function parseKeyword(word: string, value: unknown): unknown | typeof EOF {
    if (!src.startsWith(word, i)) return EOF;
    i += word.length;
    return value;
  }

  function parseValue(): unknown | typeof EOF {
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

// Structurally typed rather than taking an ApiRequest: the site map buckets
// statuses for endpoints reconstructed from a background scan, which never
// become full ApiRequest records.
function statusBucket(req: { status: RequestStatus; kind?: string }): string {
  const s = req.status;
  if (s === 'pending') return 'pending';
  if (s === 'error') return 'err';
  if (req.kind === 'ws') {
    if (s === 'closed') return '2xx';
    if (typeof s === 'number' && s === 101) return '2xx';
    return 'err';
  }
  if (typeof s === 'number') {
    if (s >= 500) return '5xx';
    if (s >= 400) return '4xx';
    if (s >= 300) return '3xx';
    if (s >= 200) return '2xx';
  }
  return 'err';
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
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
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
  function walk(v: unknown, depth: number, key: string | null, trailing: boolean): void {
    if (rows.length >= MAX_JSON_ROWS) { capped = true; return; }
    if (v === null) {
      rows.push({ depth, segs: [...keySeg(key), leafSeg('null', 'null', 'null'), ...commaSeg(trailing)] });
      return;
    }
    const t = typeof v;
    if (t === 'string') {
      const s = v as string;
      const cut = s.length > MAX_JSON_LEAF_LEN ? s.slice(0, MAX_JSON_LEAF_LEN) : s;
      const ell = cut.length < s.length ? '…' : '';
      rows.push({ depth, segs: [...keySeg(key), leafSeg('string', `"${escHtml(escJsonControl(cut))}${ell}"`, cut), ...commaSeg(trailing)] });
      return;
    }
    if (t === 'number' || t === 'boolean') {
      const display = String(v);
      rows.push({ depth, segs: [...keySeg(key), leafSeg(t as JsonLeafKind, display, display), ...commaSeg(trailing)] });
      return;
    }
    if (Array.isArray(v)) {
      if (v.length === 0) {
        rows.push({ depth, segs: [...keySeg(key), textSeg('[]'), ...commaSeg(trailing)] });
        return;
      }
      rows.push({ depth, segs: [...keySeg(key), textSeg('[')] });
      for (let i = 0; i < v.length; i++) walk(v[i], depth + 1, null, i < v.length - 1);
      rows.push({ depth, segs: [textSeg(']'), ...commaSeg(trailing)] });
      return;
    }
    if (t === 'object') {
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj);
      if (keys.length === 0) {
        rows.push({ depth, segs: [...keySeg(key), textSeg('{}'), ...commaSeg(trailing)] });
        return;
      }
      rows.push({ depth, segs: [...keySeg(key), textSeg('{')] });
      for (let i = 0; i < keys.length; i++) walk(obj[keys[i]], depth + 1, keys[i], i < keys.length - 1);
      rows.push({ depth, segs: [textSeg('}'), ...commaSeg(trailing)] });
      return;
    }
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
    const isActive = activeKey && activeKey.endsWith(`|${seg.vkind}|${enc}`);
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
  const m = s.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!m) return '';
  const n = Number(m[0]);
  return Number.isFinite(n) ? String(n) : '';
}

function findMultipleValuesInDom(queries: Array<{value: string; kind: string}>): HTMLElement[] {
  if (queries.length === 0) return [];
  const termSeen = new Set<string>();
  const terms: Array<{lower: string; value: string; kind: string; numNorm: string}> = [];
  for (const q of queries) {
    const key = `${q.kind}:${q.value}`;
    if (termSeen.has(key)) continue;
    termSeen.add(key);
    terms.push({ lower: q.value.toLowerCase(), value: q.value, kind: q.kind, numNorm: q.kind === 'number' ? normalizeNumber(q.value) : '' });
  }
  if (terms.length === 0) return [];
  const results: HTMLElement[] = [];
  const seenEls = new Set<HTMLElement>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || isOverlayOwned(parent)) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  for (let node = walker.nextNode(); node && results.length < MAX_VALUE_HIGHLIGHTS; node = walker.nextNode()) {
    const text = (node.nodeValue || '').trim();
    if (!text) continue;
    const textLower = text.toLowerCase();
    for (const term of terms) {
      let hit = false;
      if (term.kind === 'number') {
        if (term.numNorm && normalizeNumber(text) === term.numNorm) hit = true;
      } else {
        if (text === term.value || textLower === term.lower) hit = true;
        else if (term.value.length >= MIN_SUBSTRING_LEN && textLower.includes(term.lower)) hit = true;
      }
      if (hit) {
        const parent = (node as Text).parentElement;
        if (parent && !seenEls.has(parent)) { seenEls.add(parent); results.push(parent); }
        break;
      }
    }
  }
  return results;
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
  const collect = (el: HTMLElement | null): boolean => {
    if (!el || seen.has(el) || isOverlayOwned(el)) return true;
    seen.add(el);
    results.push(el);
    return results.length < MAX_VALUE_HIGHLIGHTS;
  };
  const lower = trimmed.toLowerCase();
  const numNorm = kind === 'number' ? normalizeNumber(trimmed) : '';
  const isUrlLike = kind === 'string' && (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('data:'));
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || isOverlayOwned(parent)) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.nodeValue || '').trim();
    if (!text) continue;
    let hit = false;
    if (kind === 'number') {
      if (numNorm && normalizeNumber(text) === numNorm) hit = true;
    } else if (text === trimmed || text.toLowerCase() === lower) {
      hit = true;
    } else if (trimmed.length >= MIN_SUBSTRING_LEN && text.toLowerCase().includes(lower)) {
      hit = true;
    }
    if (hit && !collect((node as Text).parentElement)) break;
  }
  if (kind === 'string' && results.length < MAX_VALUE_HIGHLIGHTS) {
    const inputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
    for (let i = 0; i < inputs.length; i++) {
      const el = inputs[i];
      const v = (el.value || '').trim();
      if (!v) continue;
      const matches = v === trimmed || (trimmed.length >= MIN_SUBSTRING_LEN && v.toLowerCase().includes(lower));
      if (matches && !collect(el)) break;
    }
  }
  if (isUrlLike && results.length < MAX_VALUE_HIGHLIGHTS) {
    const urlEls = document.querySelectorAll<HTMLElement>('img[src], a[href], source[src], video[src], audio[src], iframe[src]');
    for (let i = 0; i < urlEls.length; i++) {
      const el = urlEls[i];
      const src = el.getAttribute('src') || el.getAttribute('href') || '';
      if (!src) continue;
      const matches = src === trimmed || src.endsWith(trimmed) || (trimmed.length >= MIN_SUBSTRING_LEN && src.includes(trimmed));
      if (matches && !collect(el)) break;
    }
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
  document.getElementById('ov-value-status')?.remove();
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
function runJvHover(jv: HTMLElement): void {
  const row = jv.closest<HTMLElement>('.ov-row');
  const rowId = row?.dataset.id || '';
  const encVal = jv.dataset.ovVal || '';
  const kind = jv.dataset.ovKind || 'string';
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

function setValueStatusBadge(jv: HTMLElement, total: number, index: number): void {
  let el = document.getElementById('ov-value-status');
  if (!el) {
    el = document.createElement('span');
    el.id = 'ov-value-status';
    el.className = 'ov-value-status';
  }
  if (total === 0) el.textContent = 'no match on page';
  else if (total === 1) el.textContent = '1 match';
  else el.textContent = `${index + 1}/${total} · click to cycle`;
  el.dataset.empty = total === 0 ? '1' : '';
  // Anchor the badge to the JSON host instead of next to jv. The virtualizer
  // recycles .ov-jv spans on scroll, which would orphan an inline badge.
  const host = jv.closest<HTMLElement>('.ov-body-json');
  if (host?.parentElement) host.parentElement.insertBefore(el, host.nextSibling);
  else jv.after(el);
}

function handleJsonValueClick(jv: HTMLElement): void {
  clearJvHover();
  clearBulkHighlights();
  const row = jv.closest<HTMLElement>('.ov-row');
  const rowId = row?.dataset.id || '';
  const encVal = jv.dataset.ovVal || '';
  const kind = jv.dataset.ovKind || 'string';
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
    `#ov-list .ov-row[data-id="${rowIdStr}"] .ov-jv[data-ov-kind="${kind}"][data-ov-val="${encVal}"]`
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

  let paneHtml = '';

  if (activeTab === 'response') {
    let resBodyHtml: string;
    if (req.resBody != null) {
      const parsed = parseJsonBody(req.resBody);
      const truncNote = parsed?.truncated
        ? '<div class="ov-trunc-note">⚠ response truncated — showing recovered partial body</div>'
        : '';
      resBodyHtml = parsed !== undefined
        ? `${truncNote}<div class="ov-body-json" data-id="${req.id}"></div>`
        : `<pre class="ov-body-pre">${escHtml(formatBody(req.resBody).slice(0, 3000))}</pre>`;
    } else if (req.status === 'pending') {
      resBodyHtml = '<div class="ov-body-none">Waiting…</div>';
    } else {
      resBodyHtml = '<div class="ov-body-none">No response body</div>';
    }
    paneHtml = `<div class="ov-panel">${resBodyHtml}</div>`;

  } else if (activeTab === 'request') {
    paneHtml = req.reqBody
      ? `<div class="ov-panel"><pre class="ov-body-pre">${escHtml(formatBody(req.reqBody).slice(0, 3000))}</pre></div>`
      : `<div class="ov-panel"><div class="ov-body-none">No request body</div></div>`;

  } else if (activeTab === 'headers') {
    paneHtml = `<div class="ov-panel">
      <div class="ov-detail-label" style="margin-bottom:4px">Request</div>
      ${headerRowsHtml('', req.reqHeaders)}
      <div class="ov-detail-label" style="margin:10px 0 4px">Response</div>
      ${headerRowsHtml('', req.resHeaders)}
    </div>`;

  } else if (activeTab === 'timing') {
    const total = req.ms ?? 0;
    const ttfb = Math.max(0, total - TIMING_DNS_MS - TIMING_TCP_MS - TIMING_DL_MS);
    paneHtml = `<div class="ov-panel"><div class="ov-kv">
      <div class="ov-kv-k">DNS</div><div class="ov-kv-v">${TIMING_DNS_MS}ms</div>
      <div class="ov-kv-k">TCP</div><div class="ov-kv-v">${TIMING_TCP_MS}ms</div>
      <div class="ov-kv-k">TTFB</div><div class="ov-kv-v">${ttfb}ms</div>
      <div class="ov-kv-k">Download</div><div class="ov-kv-v">${TIMING_DL_MS}ms</div>
      <div class="ov-kv-k">Total</div><div class="ov-kv-v">${total}ms</div>
    </div></div>`;

  } else if (activeTab === 'frames') {
    const msgs = req.messages ?? [];
    paneHtml = `<div class="ov-panel"><div class="ov-ws-thread">${
      msgs.length === 0
        ? '<div class="ov-body-none">No messages yet</div>'
        : msgs.slice(-100).map(m => `<div class="ov-ws-msg ov-ws-${m.dir}">
            <span class="ov-ws-dir">${m.dir === 'sent' ? 'send ▶' : '◀ recv'}</span>
            <span class="ov-ws-t">+${m.ts}ms</span>
            <pre class="ov-ws-body">${escHtml(m.body.slice(0, 500))}</pre>
          </div>`).join('')
    }</div></div>`;
  }

  return `<div class="ov-detail">${tabsHtml}${paneHtml}</div>`;
}

function rowHtml(req: ApiRequest): string {
  const bucket = statusBucket(req);
  const statusLabel = req.status === 'pending' ? '•••' : String(req.status);
  const method = req.method || 'GET';
  const initiator = req.element ? 'page' : 'bg';
  const isExpanded = expandedIds.has(req.id);
  const isPinned = pinnedIds.has(req.id);
  const shortUrl = middleTruncate(urlPath(req.url), 72);

  const durLabel = req.ms == null ? '—'
    : req.ms < 1000 ? `${req.ms}ms`
    : `${(req.ms / 1000).toFixed(2)}s`;

  const wsFr = req.kind === 'ws' && req.messages?.length
    ? `<span class="ov-fr">${req.messages.length}fr</span>` : '';

  return `<div class="ov-row${isExpanded ? ' ov-expanded' : ''}${isPinned ? ' ov-pinned' : ''}"
      data-id="${req.id}" data-sel="${encodeURIComponent(req.element?.selector || '')}"
      title="${escHtml(req.url)}${req.element?.label ? ' — ' + escHtml(req.element.label) : ''}">
    <div class="ov-c ov-c-method m-${safeMethodClass(method)}">${escHtml(method)}</div>
    <div class="ov-c ov-c-status s-${bucket}">${statusLabel}</div>
    <div class="ov-c ov-c-dur">${durLabel}</div>
    <div class="ov-c ov-c-url">
      <span class="ov-url-path">${escHtml(shortUrl)}</span>
      ${wsFr}
      <span class="ov-init${initiator === 'bg' ? ' ov-init-bg' : ''}">${initiator}</span>
    </div>
    <div class="ov-c ov-c-act">
      <button class="ov-pin-btn${isPinned ? ' on' : ''}" data-id="${req.id}" title="Pin">${isPinned ? '★' : '☆'}</button>
      <button class="ov-copy-btn" data-url="${encodeURIComponent(req.url || '')}" title="Copy URL">copy</button>
    </div>
    ${isExpanded ? detailPanelHtml(req) : ''}
  </div>`;
}

// ── Pin tray ──────────────────────────────────────────────────────────────────

function renderPinTray(): string {
  if (!showPinTray) return '';
  const pinned = [...requests.values()].filter(r => pinnedIds.has(r.id));
  if (pinned.length === 0) {
    return `<div class="ov-pintray">
      <div class="ov-pintray-head">★ pinned (0)</div>
      <div class="ov-pintray-empty">click ☆ on any row to pin it</div>
    </div>`;
  }
  return `<div class="ov-pintray">
    <div class="ov-pintray-head">★ pinned (${pinned.length})</div>
    ${pinned.map(r => rowHtml(r)).join('')}
  </div>`;
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
  footer.innerHTML = `
    <span class="ov-fstat">req <b>${requests.size}</b></span>
    <span class="ov-fstat${err ? ' ov-fstat-err' : ''}">err <b>${err}</b></span>
    <span class="ov-fstat${slow ? ' ov-fstat-warn' : ''}">slow <b>${slow}</b></span>
    <span class="ov-fstat">xfer <b>${(xfer / 1024).toFixed(1)}kb</b></span>
    <span class="ov-fspacer"></span>
    <button class="ov-pin-toggle${showPinTray ? ' on' : ''}" id="ov-pin-tray-btn" data-tip="Show / hide pinned requests" data-tip-pos="above" data-tip-align="right">★ ${pinnedIds.size}</button>
  `;
  $('ov-pin-tray-btn')!.onclick = () => {
    showPinTray = !showPinTray;
    renderList();
  };
}

// ── Main render ───────────────────────────────────────────────────────────────

function renderList(): void {
  if (!activated) return;

  if (dockState === 'pill') { refreshPill(); return; }

  const list = $('ov-list');
  const countEl = $('ov-count');
  if (!list) return;

  // The site map is built from its own accumulator and from static analysis, so
  // it still has something to show when the capture hook was blocked outright.
  if (smView === 'map') {
    captureJvScrollState();
    destroyAllJvVirt();
    smRenderSiteMap();
    renderFooter();
    return;
  }

  if (cspBlocked) {
    list.innerHTML = `<div class="ov-empty" style="color:var(--ov-s-err)">
      Capture script failed to load.<br><small>Likely blocked by the page's Content-Security-Policy.</small>
    </div>`;
    if (countEl) countEl.textContent = '0';
    renderFooter();
    return;
  }

  const rawFilter = filterInput?.value || '';
  const filterText = caseSensitiveSearch ? rawFilter : rawFilter.toLowerCase();

  let regex: RegExp | null = null;
  let regexInvalid = false;
  if (regexSearch && rawFilter) {
    try { regex = new RegExp(rawFilter, caseSensitiveSearch ? '' : 'i'); }
    catch { regexInvalid = true; }
  }
  filterInput?.classList.toggle('ov-filter-invalid', regexInvalid);

  // Cap regex search input length per field. A pathological pattern (e.g. /(a+)+$/)
  // on a 50KB body will hang the page; truncation bounds the worst case to a slice.
  const REGEX_MAX_INPUT = 8000;
  function matchesText(r: ApiRequest): boolean {
    if (!filterText) return true;
    if (regexInvalid) return false;
    if (regex) {
      const clip = (s: string): string => s.length > REGEX_MAX_INPUT ? s.slice(0, REGEX_MAX_INPUT) : s;
      return regex.test(clip(r.url || ''))
          || (r.reqBody != null && regex.test(clip(r.reqBody)))
          || (r.resBody != null && regex.test(clip(r.resBody)));
    }
    if (caseSensitiveSearch) {
      return (r.url || '').includes(filterText)
          || (r.reqBody != null && r.reqBody.includes(filterText))
          || (r.resBody != null && r.resBody.includes(filterText));
    }
    return (r._lcUrl || '').includes(filterText)
        || (r._lcReqBody != null && r._lcReqBody.includes(filterText))
        || (r._lcResBody != null && r._lcResBody.includes(filterText));
  }

  function matchesStatus(r: ApiRequest): boolean {
    if (activeStatus.size === 0) return true;
    const b = statusBucket(r);
    return activeStatus.has(b);
  }

  function matchesMethod(r: ApiRequest): boolean {
    if (activeMethods.size === 0) return true;
    return activeMethods.has((r.method || 'GET').toUpperCase());
  }

  function matchesInitiator(r: ApiRequest): boolean {
    if (activeInitiators.size === 0) return true;
    const ini = r.element ? 'page' : 'bg';
    return activeInitiators.has(ini);
  }

  const snapshot = Array.from(requests.values());
  const visible: ApiRequest[] = [];
  for (let i = snapshot.length - 1; i >= 0 && visible.length < RENDER_LIMIT; i--) {
    const r = snapshot[i];
    if (!matchesMethod(r)) continue;
    if (!matchesStatus(r)) continue;
    if (!matchesInitiator(r)) continue;
    if (!matchesText(r)) continue;
    visible.push(r);
  }

  if (countEl) countEl.textContent = `${visible.length}/${requests.size}`;

  // update chip counts
  updateChipCounts(snapshot);

  let html = '';

  if (showPinTray) html += renderPinTray();

  if (visible.length === 0) {
    html += `<div class="ov-empty">${
      requests.size === 0
        ? 'No API calls captured yet.<br><small>Interact with the page to see calls appear here.</small>'
        : 'No results match your filter.'
    }</div>`;
  } else {
    html += visible.map(r => rowHtml(r)).join('');
  }

  // Snapshot scroll positions of currently mounted JSON virtualizers, then tear
  // them down — innerHTML below will detach their DOM hosts.
  captureJvScrollState();
  destroyAllJvVirt();

  list.innerHTML = html;

  // Mount a virtualizer for every visible JSON response placeholder.
  for (const host of list.querySelectorAll<HTMLElement>('.ov-body-json[data-id]')) {
    const id = Number(host.dataset.id);
    const req = requests.get(id);
    if (!req?.resBody) continue;
    const parsed = tryParseJsonContainer(req.resBody);
    if (parsed === undefined) continue;
    const rows = flattenJsonRows(parsed);
    jvVirtMounts.set(host, mountJsonVirtualizer(host, rows, id));
  }

  reattachValueHighlight();
  reattachRevHighlight();
  renderFooter();
}

function updateChipCounts(snapshot: ApiRequest[]): void {
  const counts: Record<string, number> = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
  for (const r of snapshot) {
    const b = statusBucket(r);
    if (b in counts) counts[b]++;
  }
  for (const chip of document.querySelectorAll<HTMLElement>('.ov-chip[data-s]')) {
    const s = chip.dataset.s || '';
    const badge = chip.querySelector('.ov-chip-count');
    if (badge) badge.textContent = String(counts[s] ?? 0);
  }
}

// ── Event delegation ──────────────────────────────────────────────────────────

let rowEventsBound = false;

function bindListDelegation(list: HTMLElement): void {
  if (rowEventsBound) return;
  rowEventsBound = true;

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
    const sel = safeDecodeURIComponent(row.dataset.sel || '');
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

  list.addEventListener('click', (e: Event) => {
    const target = e.target as Element;

    const pinBtn = target.closest<HTMLElement>('.ov-pin-btn');
    if (pinBtn) {
      e.stopPropagation();
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
      return;
    }

    const copyTabBtn = target.closest<HTMLElement>('.ov-copy-tab-btn');
    if (copyTabBtn) {
      e.stopPropagation();
      const id = Number(copyTabBtn.dataset.id);
      if (!Number.isFinite(id)) return;
      const tab = copyTabBtn.dataset.tab as DetailTab;
      const req = requests.get(id);
      let text = '';
      if (req) {
        if (tab === 'response') {
          text = req.resBody ?? '';
        } else if (tab === 'request') {
          text = req.reqBody ?? '';
        } else if (tab === 'headers') {
          const fmt = (pairs: HeaderPair[] | null | undefined) =>
            (pairs ?? []).map(([n, v]) => `${n}: ${v}`).join('\n');
          text = `-- Request --\n${fmt(req.reqHeaders)}\n\n-- Response --\n${fmt(req.resHeaders)}`;
        } else if (tab === 'timing') {
          const total = req.ms ?? 0;
          const ttfb = Math.max(0, total - TIMING_DNS_MS - TIMING_TCP_MS - TIMING_DL_MS);
          text = `DNS: ${TIMING_DNS_MS}ms\nTCP: ${TIMING_TCP_MS}ms\nTTFB: ${ttfb}ms\nDownload: ${TIMING_DL_MS}ms\nTotal: ${total}ms`;
        } else if (tab === 'frames') {
          text = (req.messages ?? []).slice(-100).map(m => `[${m.dir} +${m.ts}ms] ${m.body}`).join('\n');
        }
      }
      const restore = (label: string) => {
        copyTabBtn.textContent = label;
        setTimeout(() => { copyTabBtn.textContent = 'copy'; }, 900);
      };
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(() => restore('copied!'), () => restore('failed'));
      } else {
        restore('failed');
      }
      return;
    }

    const copyBtn = target.closest<HTMLElement>('.ov-copy-btn');
    if (copyBtn) {
      e.stopPropagation();
      const url = safeDecodeURIComponent(copyBtn.dataset.url || '');
      const restore = (label: string) => {
        copyBtn.textContent = label;
        setTimeout(() => { copyBtn.textContent = 'copy'; }, 900);
      };
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(url).then(() => restore('copied'), () => restore('failed'));
      } else {
        restore('failed');
      }
      return;
    }

    const tabBtn = target.closest<HTMLElement>('.ov-tab');
    if (tabBtn) {
      e.stopPropagation();
      const wrap = tabBtn.parentElement as HTMLElement | null;
      const id = Number(wrap?.dataset.id);
      const tab = tabBtn.dataset.tab as DetailTab | undefined;
      if (!Number.isFinite(id) || !tab) return;
      detailTabs.set(id, tab);
      clearBulkHighlights();
      if (tab === 'response') runBulkHighlight(id);
      scheduleRender();
      return;
    }

    const jv = target.closest<HTMLElement>('.ov-jv');
    if (jv) {
      e.stopPropagation();
      handleJsonValueClick(jv);
      return;
    }

    const row = target.closest<HTMLElement>('.ov-row');
    if (!row) return;
    // The detail panel is rendered inside .ov-row, so a click on its body (not on
    // a tab/copy/value control handled above) would otherwise bubble here and
    // collapse the row. Only the summary header toggles expansion.
    if (target.closest('.ov-detail')) return;
    const id = Number(row.dataset.id);
    if (expandedIds.has(id)) {
      expandedIds.delete(id);
      detailTabs.delete(id);
      if (valueHighlightKey.startsWith(`${id}|`)) clearValueHighlights();
      if (bulkHighlightRowId === id) clearBulkHighlights();
    } else {
      expandedIds.add(id);
      const activeTab = detailTabs.get(id) ?? 'response';
      if (activeTab === 'response') runBulkHighlight(id);
    }
    scheduleRender();
  });
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
      chip.classList.toggle('on', activeStatus.has(s));
    } else if (m) {
      activeMethods.has(m) ? activeMethods.delete(m) : activeMethods.add(m);
      chip.classList.toggle('on', activeMethods.has(m));
    } else if (ini) {
      activeInitiators.has(ini) ? activeInitiators.delete(ini) : activeInitiators.add(ini);
      chip.classList.toggle('on', activeInitiators.has(ini));
    }

    chrome.storage.local.set({ ovFilters: {
      status: [...activeStatus], methods: [...activeMethods], initiators: [...activeInitiators]
    }});
    renderList();
  });
}

// ── Pill (collapsed state) ────────────────────────────────────────────────────

function setDockState(next: DockState): void {
  if (next === dockState) return;
  dockState = next;
  chrome.storage.local.set({ ovDockState: next });
  const panel = $('ov-panel');
  const pill = $('ov-pill');
  if (next === 'panel') {
    // Carry the pill's current position over to the panel so it expands in place.
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
    } else {
      applySavedGeometry(panel);
      panel.style.setProperty('display', 'flex', 'important');
      renderList();
    }
  } else if (next === 'pill') {
    // Carry the panel's current position over to the pill so it collapses in place.
    if (panel) {
      const r = panel.getBoundingClientRect();
      savedPillGeom = { left: r.left, top: r.top };
      chrome.storage.local.set({ ovPillGeom: savedPillGeom });
      panel.style.setProperty('display', 'none', 'important');
    }
    if (!pill) buildPill();
    else { applySavedGeometry(pill); refreshPill(); }
  } else {
    if (panel) panel.style.setProperty('display', 'none', 'important');
    $('ov-pill')?.remove();
  }
}

function pillInnerHtml(): string {
  const reqs = [...requests.values()];
  const total = reqs.length;
  const errs = reqs.filter(isError).length;
  const recent = reqs.slice(-12);
  const ticks = recent.map(r => {
    const b = statusBucket(r);
    const cls = b === '4xx' || b === '5xx' || b === 'err' ? 'err'
              : b === '3xx' ? 'warn'
              : r.kind === 'ws' ? 'ws' : '';
    return `<span class="ov-pill-tick${cls ? ' ' + cls : ''}"></span>`;
  }).join('');
  return `
    <span class="ov-pill-dot"></span>
    <span class="ov-pill-count">${total}</span>
    <span class="ov-pill-label">req</span>
    ${errs ? `<span class="ov-pill-err">${errs} err</span>` : ''}
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
      <span class="ov-hdr-title">API Overlay</span>
      <span id="ov-count" class="ov-count-badge" data-tip="Visible / total requests">0/0</span>
      <div class="ov-hdr-spacer"></div>
      <div id="ov-actions">
        <button id="ov-pause" data-tip="Pause or resume capturing">${paused ? '▶ rec' : '⏸ pause'}</button>
        <div class="ov-divider"></div>
        <button id="ov-theme" data-tip="Toggle dark / light theme">${currentTheme === 'dark' ? 'light' : 'dark'}</button>
        <button id="ov-sitemap" data-tip="Build the site map — pages and the APIs each one uses">⊞ map</button>
        <button id="ov-export" data-tip="Export as HAR file">↓ har</button>
        <div class="ov-divider"></div>
        <button id="ov-clear" data-tip="Clear all requests">✕ clear</button>
        <button id="ov-collapse" data-tip="Collapse to pill" data-tip-align="right">_</button>
      </div>
    </div>
    <div id="ov-filter-row">
      <div class="ov-search">
        <span class="ov-prompt">›</span>
        <input id="ov-filter" placeholder="filter url, body, header…" autocomplete="off" spellcheck="false"/>
        <div class="ov-search-modes">
          <button id="ov-case-toggle" class="ov-modebtn" data-tip="Case-sensitive search" data-tip-align="right">Aa</button>
          <button id="ov-regex-toggle" class="ov-modebtn" data-tip="Regex search" data-tip-align="right">.*</button>
        </div>
      </div>
    </div>
    <div id="ov-chips">
      <span class="ov-chip-label">status</span>
      <button class="ov-chip" data-s="2xx" data-tip="Filter: 2xx success">2xx<span class="ov-chip-count">0</span></button>
      <button class="ov-chip" data-s="3xx" data-tip="Filter: 3xx redirects">3xx<span class="ov-chip-count">0</span></button>
      <button class="ov-chip" data-s="4xx" data-tip="Filter: 4xx client errors">4xx<span class="ov-chip-count">0</span></button>
      <button class="ov-chip" data-s="5xx" data-tip="Filter: 5xx server errors">5xx<span class="ov-chip-count">0</span></button>
      <span class="ov-chip-sep"></span>
      <span class="ov-chip-label">method</span>
      <button class="ov-chip" data-m="GET" data-tip="Filter: GET requests">GET</button>
      <button class="ov-chip" data-m="POST" data-tip="Filter: POST requests">POST</button>
      <button class="ov-chip" data-m="PUT" data-tip="Filter: PUT requests">PUT</button>
      <button class="ov-chip" data-m="PATCH" data-tip="Filter: PATCH requests">PATCH</button>
      <button class="ov-chip" data-m="DELETE" data-tip="Filter: DELETE requests">DEL</button>
      <button class="ov-chip" data-m="WS" data-tip="Filter: WebSocket connections">WS</button>
      <span class="ov-chip-sep"></span>
      <span class="ov-chip-label">from</span>
      <button class="ov-chip" data-i="page" data-tip="Requests from page scripts">page</button>
      <button class="ov-chip" data-i="bg" data-tip="Background / extension requests">bg</button>
    </div>
    <div id="ov-list"></div>
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
  const ovSitemap  = $('ov-sitemap');
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
  if (ovSitemap) ovSitemap.onclick = () => {
    if (smView === 'map') smSetView('log');
    else smOpenSiteMap();
  };
  if (ovPause) ovPause.onclick = () => setPaused(!paused);
  if (ovTheme) ovTheme.onclick = () => {
    const next: 'dark' | 'light' = currentTheme === 'dark' ? 'light' : 'dark';
    chrome.storage.local.set({ ovTheme: next });
    applyTheme(next);
  };
  filterInput.oninput = () => scheduleRender();
  if (ovExport) ovExport.onclick = exportHAR;

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

  makeDraggable(panel, $('ov-header')!);
  makeResizable(panel);
  const list = $('ov-list')!;
  bindListDelegation(list);
  smBindSiteMapDelegation(list);
  bindChipDelegation($('ov-chips')!);
  renderList();
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
      time: r.ms || 0,
      request: {
        method: r.method || 'GET', url: r.url || '', httpVersion: 'HTTP/1.1',
        headers: toHarHeaders(r.reqHeaders), queryString: parseQuery(r.url),
        cookies: [], headersSize: -1, bodySize: byteLen(r.reqBody),
        ...(r.reqBody ? { postData: { mimeType: detectMime(r.reqBody), text: r.reqBody } } : {})
      },
      response: {
        status: r.status as number, statusText: '', httpVersion: 'HTTP/1.1',
        headers: toHarHeaders(r.resHeaders), cookies: [],
        content: { size: byteLen(r.resBody), mimeType: detectMime(r.resBody), text: r.resBody || '' },
        redirectURL: '', headersSize: -1, bodySize: byteLen(r.resBody)
      },
      cache: {},
      timings: { send: 0, wait: r.ms || 0, receive: 0 }
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

function refreshClusterBadge(sel: string): void {
  const badge = selectorBadges.get(sel);
  if (!badge) return;
  const ids = selectorReqIds.get(sel) ?? [];
  const count = ids.length;

  if (count === 1) {
    // Single endpoint — show inline, no circle, no popup
    const r = requests.get(ids[0]);
    if (!r) return;
    badge.className = 'ov-float-badge ov-fb-single';
    badge.dataset.theme = currentTheme;
    badge.classList.remove('ov-fb-open');
    badge.innerHTML = clusterBadgeRowHtml(r);
    clampBadgeLeftIntoView(badge);
    return;
  }

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

  if (!countEl || !popupEl) {
    // First render or upgrade from single — build from scratch
    const popupHtml = ids.map(id => {
      const r = requests.get(id);
      return r ? clusterBadgeRowHtml(r) : '';
    }).join('');
    const dir = badge.dataset.popupDir ?? 'right';
    badge.innerHTML = `<span class="ov-fb-circle">${count}</span><div class="ov-fb-popup ov-fb-popup-${dir}${open ? ' ov-fb-popup-show' : ''}">${popupHtml}</div>`;
    return;
  }

  // Surgical updates — avoid full rebuild while popup may be open
  countEl.textContent = String(count);
  popupEl.classList.toggle('ov-fb-popup-show', open);

  // Sync rows: add/update without touching unaffected ones
  const existingRows = Array.from(popupEl.querySelectorAll<HTMLElement>('.ov-fb-row'));
  for (let i = 0; i < ids.length; i++) {
    const r = requests.get(ids[i]);
    if (!r) continue;
    if (existingRows[i]) {
      existingRows[i].outerHTML = clusterBadgeRowHtml(r);
    } else {
      popupEl.insertAdjacentHTML('beforeend', clusterBadgeRowHtml(r));
    }
  }
  // Remove stale trailing rows
  const staleRows = Array.from(popupEl.querySelectorAll<HTMLElement>('.ov-fb-row')).slice(ids.length);
  for (const el of staleRows) el.remove();
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
  if (!expandedIds.has(id)) {
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
  return !!el && (!!el.closest('#ov-panel') || !!el.closest('#ov-pill') || el.classList.contains('ov-float-badge'));
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
  window.postMessage({ __apiOverlayControl: true, action }, '*');
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

function makeDraggable(panel: HTMLElement, handle: HTMLElement): void {
  let ox = 0, oy = 0;
  handle.addEventListener('mousedown', (e: MouseEvent) => {
    if ((e.target as HTMLElement).tagName === 'BUTTON') return;
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
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      persistGeometry(panel);
    };
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
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      persistGeometry(panel);
    };
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
    #ov-panel {
      all: initial;
      /* dark theme (default) */
      --ov-bg:               #0d0e10;
      --ov-bg-2:             #14161a;
      --ov-bg-3:             #1a1d22;
      --ov-hdr:              #14161a;
      --ov-border:           #2a2f37;
      --ov-grid:             #1f2329;
      --ov-text:             #d6dae0;
      --ov-text-dim:         #9aa1ab;
      --ov-text-muted:       #6a7180;
      --ov-text-faint:       #4a505c;
      --ov-title:            #d6dae0;
      --ov-accent:           #6ab0ff;
      --ov-accent-bg:        rgba(106,176,255,.14);
      --ov-m-get:            #6ab0ff;
      --ov-m-post:           #b58cff;
      --ov-m-put:            #ffb86c;
      --ov-m-patch:          #ffd86c;
      --ov-m-delete:         #ff6b8a;
      --ov-m-ws:             #4ec9b0;
      --ov-s-2xx:            #7a8290;
      --ov-s-3xx:            #d4a85e;
      --ov-s-4xx:            #ff9a52;
      --ov-s-5xx:            #ff5a6e;
      --ov-s-err:            #ff5a6e;
      --ov-s-pending:        #4ec9b0;
      --ov-scrollbar:        #2a2f37;
      --ov-shadow:           rgba(0,0,0,.6);
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
      border-radius: 2px !important;
      box-shadow: 0 12px 40px var(--ov-shadow) !important;
      z-index: 2147483647 !important;
      font-family: var(--ov-font-family,'JetBrains Mono','IBM Plex Mono',ui-monospace,monospace) !important;
      font-size: calc(12px * var(--ov-font-scale,1)) !important;
      display: flex !important;
      flex-direction: column !important;
      overflow: hidden !important;
      border: 1px solid var(--ov-border) !important;
    }
    #ov-panel[data-theme="light"] {
      --ov-bg:               #fbfaf7;
      --ov-bg-2:             #ffffff;
      --ov-bg-3:             #f3f1ec;
      --ov-hdr:              #ffffff;
      --ov-border:           #d9d4c4;
      --ov-grid:             #ebe6d8;
      --ov-text:             #1a1c20;
      --ov-text-dim:         #4a4f59;
      --ov-text-muted:       #6c727c;
      --ov-text-faint:       #9a9fa8;
      --ov-title:            #1a1c20;
      --ov-accent:           #2a6fdb;
      --ov-accent-bg:        rgba(42,111,219,.12);
      --ov-m-get:            #1f6feb;
      --ov-m-post:           #7a3df0;
      --ov-m-put:            #b8631a;
      --ov-m-patch:          #a6791f;
      --ov-m-delete:         #d23158;
      --ov-m-ws:             #1a8473;
      --ov-s-2xx:            #6c727c;
      --ov-s-3xx:            #8a5a14;
      --ov-s-4xx:            #b8541d;
      --ov-s-5xx:            #c0273f;
      --ov-s-err:            #c0273f;
      --ov-s-pending:        #1a8473;
      --ov-scrollbar:        #d9d4c4;
      --ov-shadow:           rgba(0,0,0,.15);
    }

    /* ── Header ── */
    #ov-header {
      display: flex !important;
      align-items: center !important;
      gap: 6px !important;
      padding: 0 8px 0 10px !important;
      height: 36px !important;
      background: var(--ov-hdr) !important;
      cursor: move !important;
      user-select: none !important;
      border-bottom: 1px solid var(--ov-border) !important;
      flex-shrink: 0 !important;
    }
    .ov-grip {
      display: grid !important;
      grid-template-columns: 3px 3px !important;
      grid-template-rows: repeat(3, 3px) !important;
      gap: 2px !important;
      flex-shrink: 0 !important;
      margin-right: 2px !important;
    }
    .ov-grip::before, .ov-grip::after {
      content: '' !important;
      display: none !important;
    }
    .ov-grip {
      background-image: radial-gradient(circle, var(--ov-text-faint) 1px, transparent 1px) !important;
      background-size: 4px 4px !important;
      width: 8px !important;
      height: 12px !important;
      background-position: 0 0 !important;
      border-radius: 0 !important;
    }
    .ov-hdr-title {
      font-weight: 700 !important;
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
      color: var(--ov-title) !important;
      letter-spacing: .1em !important;
      text-transform: uppercase !important;
      flex-shrink: 0 !important;
    }
    .ov-count-badge {
      font-size: calc(9px * var(--ov-font-scale,1)) !important;
      color: var(--ov-text-faint) !important;
      background: var(--ov-bg-3) !important;
      border: 1px solid var(--ov-border) !important;
      padding: 1px 5px !important;
      border-radius: 2px !important;
      font-weight: 700 !important;
      flex-shrink: 0 !important;
    }
    .ov-hdr-spacer { flex: 1 !important; }
    .ov-divider {
      width: 1px !important;
      height: 14px !important;
      background: var(--ov-border) !important;
      flex-shrink: 0 !important;
    }
    #ov-actions { display: flex !important; align-items: center !important; gap: 2px !important; }
    #ov-actions button {
      all: unset !important;
      background: transparent !important;
      color: var(--ov-text-muted) !important;
      padding: 3px 7px !important;
      border-radius: 2px !important;
      cursor: pointer !important;
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
      font-family: inherit !important;
      white-space: nowrap !important;
      border: 1px solid transparent !important;
      transition: color 80ms, border-color 80ms !important;
    }
    #ov-actions button:hover { color: var(--ov-text) !important; border-color: var(--ov-border) !important; }
    #ov-actions button.ov-active { color: var(--ov-accent) !important; border-color: var(--ov-accent) !important; }

    /* ── Filter row ── */
    #ov-filter-row {
      padding: 6px 8px !important;
      background: var(--ov-bg-2) !important;
      border-bottom: 1px solid var(--ov-border) !important;
      flex-shrink: 0 !important;
    }
    .ov-search {
      display: flex !important;
      align-items: center !important;
      background: var(--ov-bg-3) !important;
      border: 1px solid var(--ov-border) !important;
      border-radius: 2px !important;
      padding: 0 4px !important;
    }
    .ov-prompt {
      color: var(--ov-text-muted) !important;
      font-size: calc(13px * var(--ov-font-scale,1)) !important;
      padding: 0 4px !important;
      flex-shrink: 0 !important;
    }
    #ov-filter {
      all: unset !important;
      flex: 1 !important;
      color: var(--ov-text) !important;
      font-size: calc(11px * var(--ov-font-scale,1)) !important;
      font-family: inherit !important;
      padding: 5px 4px !important;
    }
    #ov-filter::placeholder { color: var(--ov-text-faint) !important; }
    #ov-filter.ov-filter-invalid { color: var(--ov-s-err) !important; }
    .ov-search-modes { display: flex !important; gap: 2px !important; padding: 0 2px !important; }
    .ov-modebtn {
      all: unset !important;
      cursor: pointer !important;
      padding: 2px 5px !important;
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
      font-weight: 700 !important;
      font-family: inherit !important;
      color: var(--ov-text-faint) !important;
      border-radius: 2px !important;
      border: 1px solid transparent !important;
    }
    .ov-modebtn:hover { color: var(--ov-text-muted) !important; }
    .ov-modebtn.ov-active { color: var(--ov-accent) !important; border-color: var(--ov-accent) !important; }

    /* ── Chips ── */
    #ov-chips {
      display: flex !important;
      align-items: center !important;
      gap: 3px !important;
      padding: 4px 8px !important;
      background: var(--ov-bg) !important;
      border-bottom: 1px solid var(--ov-border) !important;
      flex-shrink: 0 !important;
      flex-wrap: wrap !important;
    }
    .ov-chip-label {
      font-size: calc(9px * var(--ov-font-scale,1)) !important;
      letter-spacing: .06em !important;
      text-transform: uppercase !important;
      color: var(--ov-text-faint) !important;
      padding: 0 2px !important;
      flex-shrink: 0 !important;
    }
    .ov-chip {
      all: unset !important;
      cursor: pointer !important;
      font-size: calc(9px * var(--ov-font-scale,1)) !important;
      font-weight: 700 !important;
      font-family: inherit !important;
      letter-spacing: .04em !important;
      padding: 2px 6px !important;
      border-radius: 2px !important;
      border: 1px solid var(--ov-border) !important;
      color: var(--ov-text-muted) !important;
      background: transparent !important;
      white-space: nowrap !important;
      transition: color 80ms, border-color 80ms, background 80ms !important;
    }
    .ov-chip:hover { border-color: var(--ov-text-muted) !important; color: var(--ov-text) !important; }
    .ov-chip.on { border-color: var(--ov-accent) !important; color: var(--ov-accent) !important; background: var(--ov-accent-bg) !important; }
    .ov-chip[data-s="2xx"].on { color: var(--ov-s-2xx) !important; border-color: var(--ov-s-2xx) !important; }
    .ov-chip[data-s="4xx"].on { color: var(--ov-s-4xx) !important; border-color: var(--ov-s-4xx) !important; }
    .ov-chip[data-s="5xx"].on { color: var(--ov-s-5xx) !important; border-color: var(--ov-s-5xx) !important; }
    .ov-chip[data-m="GET"].on    { color: var(--ov-m-get) !important;    border-color: var(--ov-m-get) !important; }
    .ov-chip[data-m="POST"].on   { color: var(--ov-m-post) !important;   border-color: var(--ov-m-post) !important; }
    .ov-chip[data-m="PUT"].on    { color: var(--ov-m-put) !important;    border-color: var(--ov-m-put) !important; }
    .ov-chip[data-m="PATCH"].on  { color: var(--ov-m-patch) !important;  border-color: var(--ov-m-patch) !important; }
    .ov-chip[data-m="DELETE"].on { color: var(--ov-m-delete) !important; border-color: var(--ov-m-delete) !important; }
    .ov-chip[data-m="WS"].on     { color: var(--ov-m-ws) !important;     border-color: var(--ov-m-ws) !important; }
    .ov-chip-count {
      font-size: calc(8px * var(--ov-font-scale,1)) !important;
      margin-left: 3px !important;
      color: var(--ov-text-faint) !important;
    }
    .ov-chip.on .ov-chip-count { color: inherit !important; }
    .ov-chip-sep {
      display: inline-block !important;
      width: 1px !important;
      height: 12px !important;
      background: var(--ov-border) !important;
      margin: 0 4px !important;
      flex-shrink: 0 !important;
    }

    /* ── List ── */
    #ov-list {
      overflow-y: auto !important;
      flex: 1 !important;
      padding: 0 !important;
    }
    #ov-list::-webkit-scrollbar { width: 10px !important; }
    #ov-list::-webkit-scrollbar-track { background: var(--ov-bg) !important; }
    #ov-list::-webkit-scrollbar-thumb { background: var(--ov-scrollbar) !important; border-radius: 0 !important; }

    /* ── Rows ── */
    .ov-row {
      display: grid !important;
      grid-template-columns: 42px 38px 52px 1fr 54px !important;
      align-items: center !important;
      min-height: 26px !important;
      padding: 0 !important;
      border-radius: 0 !important;
      border-bottom: 1px solid var(--ov-grid) !important;
      background: transparent !important;
      cursor: pointer !important;
      transition: background 80ms !important;
    }
    .ov-row:hover { background: var(--ov-bg-2) !important; }
    .ov-row.ov-expanded {
      grid-template-rows: 26px auto !important;
      min-height: auto !important;
      height: auto !important;
      background: var(--ov-bg-2) !important;
      box-shadow: inset 2px 0 0 var(--ov-accent) !important;
      align-items: start !important;
    }
    .ov-row.ov-pinned:not(.ov-expanded) { box-shadow: inset 2px 0 0 var(--ov-m-patch) !important; }
    .ov-row.ov-row-rev-hl {
      background: rgba(255,90,110,.14) !important;
      box-shadow: inset 2px 0 0 var(--ov-s-err) !important;
    }

    .ov-c {
      padding: 0 5px !important;
      min-width: 0 !important;
      white-space: nowrap !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      font-size: calc(11px * var(--ov-font-scale,1)) !important;
      line-height: 26px !important;
    }
    .ov-c-method {
      font-weight: 700 !important;
      font-size: calc(9px * var(--ov-font-scale,1)) !important;
      letter-spacing: .04em !important;
      text-align: right !important;
      padding-right: 6px !important;
    }
    .ov-c-method.m-get    { color: var(--ov-m-get)    !important; }
    .ov-c-method.m-post   { color: var(--ov-m-post)   !important; }
    .ov-c-method.m-put    { color: var(--ov-m-put)    !important; }
    .ov-c-method.m-patch  { color: var(--ov-m-patch)  !important; }
    .ov-c-method.m-delete { color: var(--ov-m-delete) !important; }
    .ov-c-method.m-ws     { color: var(--ov-m-ws)     !important; }
    .ov-c-status {
      font-weight: 700 !important;
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
    }
    .ov-c-status.s-2xx     { color: var(--ov-s-2xx) !important; }
    .ov-c-status.s-3xx     { color: var(--ov-s-3xx) !important; }
    .ov-c-status.s-4xx     { color: var(--ov-s-4xx) !important; }
    .ov-c-status.s-5xx     { color: var(--ov-s-5xx) !important; }
    .ov-c-status.s-err     { color: var(--ov-s-err) !important; }
    .ov-c-status.s-pending { color: var(--ov-s-pending) !important; }
    .ov-c-dur {
      color: var(--ov-text-muted) !important;
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
      font-variant-numeric: tabular-nums !important;
    }
    .ov-c-url { flex: 1 !important; display: flex !important; align-items: center !important; gap: 4px !important; }
    .ov-url-path { color: var(--ov-text-dim) !important; overflow: hidden !important; text-overflow: ellipsis !important; }
    .ov-fr { font-size: calc(9px * var(--ov-font-scale,1)) !important; color: var(--ov-m-ws) !important; flex-shrink: 0 !important; }
    .ov-init {
      font-size: calc(8px * var(--ov-font-scale,1)) !important;
      color: var(--ov-text-muted) !important;
      border: 1px solid var(--ov-border) !important;
      padding: 0 3px !important;
      text-transform: uppercase !important;
      letter-spacing: .04em !important;
      flex-shrink: 0 !important;
      border-radius: 1px !important;
    }
    .ov-init-bg { color: var(--ov-text-faint) !important; }
.ov-c-act {
      display: flex !important;
      gap: 3px !important;
      align-items: center !important;
      justify-content: flex-end !important;
      padding-right: 6px !important;
      opacity: 0 !important;
      transition: opacity 80ms !important;
    }
    .ov-row:hover .ov-c-act,
    .ov-row.ov-pinned .ov-c-act { opacity: 1 !important; }
    .ov-pin-btn, .ov-copy-btn, .ov-copy-tab-btn {
      all: unset !important;
      cursor: pointer !important;
      font-size: calc(9px * var(--ov-font-scale,1)) !important;
      font-family: inherit !important;
      color: var(--ov-text-muted) !important;
      padding: 1px 4px !important;
      border-radius: 2px !important;
    }
    .ov-pin-btn:hover, .ov-copy-btn:hover, .ov-copy-tab-btn:hover { background: var(--ov-bg-3) !important; color: var(--ov-text) !important; }
    .ov-pin-btn.on { color: var(--ov-m-patch) !important; }

    /* ── Detail panel ── */
    .ov-detail {
      grid-column: 1 / -1 !important;
      padding: 8px 10px !important;
      border-top: 1px solid var(--ov-border) !important;
      display: flex !important;
      flex-direction: column !important;
      gap: 0 !important;
    }
    .ov-detail-section { margin-bottom: 8px !important; }
    .ov-tabs {
      display: flex !important;
      gap: 2px !important;
      margin-bottom: 8px !important;
      border-bottom: 1px solid var(--ov-border) !important;
    }
    .ov-tab {
      all: unset !important;
      cursor: pointer !important;
      padding: 4px 10px !important;
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
      font-weight: 700 !important;
      letter-spacing: .04em !important;
      color: var(--ov-text-muted) !important;
      border-bottom: 2px solid transparent !important;
      font-family: inherit !important;
      text-transform: uppercase !important;
    }
    .ov-tab:hover { color: var(--ov-text) !important; }
    .ov-tab.ov-tab-active { color: var(--ov-accent) !important; border-bottom-color: var(--ov-accent) !important; }
    .ov-detail-label {
      font-size: calc(9px * var(--ov-font-scale,1)) !important;
      font-weight: 700 !important;
      color: var(--ov-text-muted) !important;
      letter-spacing: .06em !important;
      text-transform: uppercase !important;
      margin-bottom: 4px !important;
    }
    .ov-trigger-full {
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
      color: var(--ov-text-dim) !important;
      padding: 3px 0 !important;
    }
    .ov-hdr-table {
      background: var(--ov-bg) !important;
      border: 1px solid var(--ov-border) !important;
      border-radius: 2px !important;
      padding: 2px 0 !important;
      max-height: 180px !important;
      overflow-y: auto !important;
    }
    .ov-hdr-table::-webkit-scrollbar { width: 8px !important; }
    .ov-hdr-table::-webkit-scrollbar-thumb { background: var(--ov-scrollbar) !important; }
    .ov-hdr-row {
      display: flex !important;
      gap: 8px !important;
      padding: 2px 8px !important;
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
      line-height: 1.4 !important;
    }
    .ov-hdr-row:hover { background: var(--ov-bg-2) !important; }
    .ov-hdr-name {
      color: var(--ov-accent) !important;
      font-weight: 700 !important;
      flex-shrink: 0 !important;
      min-width: 110px !important;
      max-width: 180px !important;
      word-break: break-all !important;
    }
    .ov-hdr-val { color: var(--ov-text-dim) !important; word-break: break-all !important; flex: 1 !important; }
    .ov-body-pre {
      all: unset !important;
      display: block !important;
      background: var(--ov-bg) !important;
      border: 1px solid var(--ov-border) !important;
      border-radius: 2px !important;
      padding: 6px 8px !important;
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
      font-family: inherit !important;
      color: var(--ov-s-2xx) !important;
      white-space: pre-wrap !important;
      word-break: break-all !important;
      max-height: 150px !important;
      overflow-y: auto !important;
    }
    .ov-body-pre::-webkit-scrollbar { width: 8px !important; }
    .ov-body-pre::-webkit-scrollbar-thumb { background: var(--ov-scrollbar) !important; }
    .ov-trunc-note {
      font-size: calc(9px * var(--ov-font-scale,1)) !important;
      color: var(--ov-s-4xx) !important;
      margin-bottom: 4px !important;
      letter-spacing: .02em !important;
    }
    .ov-body-json {
      display: block !important;
      background: var(--ov-bg) !important;
      border: 1px solid var(--ov-border) !important;
      border-radius: 2px !important;
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
    .ov-body-json::-webkit-scrollbar { width: 8px !important; height: 8px !important; }
    .ov-body-json::-webkit-scrollbar-thumb { background: var(--ov-scrollbar) !important; }
    .ov-jk { color: var(--ov-accent) !important; }
    .ov-jv { cursor: pointer !important; border-radius: 1px !important; padding: 0 1px !important; transition: background .1s !important; }
    .ov-jv-string  { color: #89d182 !important; }
    .ov-jv-number  { color: #f78c6c !important; }
    .ov-jv-boolean { color: #b58cff !important; }
    .ov-jv-null    { color: #b58cff !important; font-style: italic !important; }
    #ov-panel[data-theme="light"] .ov-jk { color: var(--ov-accent) !important; }
    #ov-panel[data-theme="light"] .ov-jv-string  { color: #2e7d32 !important; }
    #ov-panel[data-theme="light"] .ov-jv-number  { color: #b8541d !important; }
    #ov-panel[data-theme="light"] .ov-jv-boolean { color: #7a3df0 !important; }
    #ov-panel[data-theme="light"] .ov-jv-null    { color: #7a3df0 !important; }
    .ov-jv:hover { background: var(--ov-accent-bg) !important; }
    .ov-jv.ov-jv-active { background: rgba(255,90,110,.2) !important; box-shadow: inset 0 0 0 1px var(--ov-s-err) !important; }
    .ov-jv-trunc { color: var(--ov-text-faint) !important; font-style: italic !important; }
    .ov-body-none { font-size: calc(10px * var(--ov-font-scale,1)) !important; color: var(--ov-text-faint) !important; font-style: italic !important; }
    .ov-value-status {
      display: inline-block !important;
      margin-left: 6px !important;
      padding: 0 6px !important;
      background: var(--ov-s-err) !important;
      color: #fff !important;
      border-radius: 2px !important;
      font-size: calc(9px * var(--ov-font-scale,1)) !important;
      font-weight: 700 !important;
      vertical-align: middle !important;
    }
    .ov-value-status[data-empty="1"] { background: var(--ov-text-faint) !important; }

    /* ── WS ── */
    .ov-ws-thread { max-height: 200px !important; overflow-y: auto !important; }
    .ov-ws-thread::-webkit-scrollbar { width: 8px !important; }
    .ov-ws-thread::-webkit-scrollbar-thumb { background: var(--ov-scrollbar) !important; }
    .ov-ws-msg { display: flex !important; gap: 6px !important; margin: 3px 0 !important; align-items: flex-start !important; }
    .ov-ws-dir { font-size: calc(9px * var(--ov-font-scale,1)) !important; font-weight: 700 !important; padding: 1px 4px !important; border-radius: 1px !important; flex-shrink: 0 !important; }
    .ov-ws-sent .ov-ws-dir { background: rgba(78,201,176,.15) !important; color: var(--ov-m-ws) !important; }
    .ov-ws-recv .ov-ws-dir { background: var(--ov-accent-bg) !important; color: var(--ov-accent) !important; }
    .ov-ws-body { all: unset !important; display: block !important; font-size: calc(10px * var(--ov-font-scale,1)) !important; font-family: inherit !important; color: var(--ov-text-dim) !important; white-space: pre-wrap !important; word-break: break-all !important; flex: 1 !important; }
    .ov-ws-t { font-size: calc(9px * var(--ov-font-scale,1)) !important; color: var(--ov-text-faint) !important; flex-shrink: 0 !important; margin-top: 1px !important; }

    /* ── Tab spacer & pane containers ── */
    .ov-tab-spacer { flex: 1 !important; }
    .ov-panel { padding: 4px 0 !important; }
    .ov-kv {
      display: grid !important;
      grid-template-columns: 80px 1fr !important;
      gap: 2px 8px !important;
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
      padding: 4px 2px !important;
    }
    .ov-kv-k {
      color: var(--ov-text-muted) !important;
      font-size: calc(9px * var(--ov-font-scale,1)) !important;
      font-weight: 700 !important;
      letter-spacing: .04em !important;
      text-transform: uppercase !important;
      padding: 2px 0 !important;
    }
    .ov-kv-v {
      color: var(--ov-text) !important;
      font-weight: 700 !important;
      padding: 2px 0 !important;
    }

    /* ── Empty ── */
    .ov-empty {
      color: var(--ov-text-faint) !important;
      text-align: center !important;
      padding: 30px 10px !important;
      line-height: 1.7 !important;
      font-size: calc(11px * var(--ov-font-scale,1)) !important;
    }

    /* ── Pin tray ── */
    .ov-pintray {
      border-bottom: 1px solid var(--ov-border) !important;
      background: var(--ov-bg-2) !important;
    }
    .ov-pintray-head {
      font-size: calc(9px * var(--ov-font-scale,1)) !important;
      font-weight: 700 !important;
      letter-spacing: .06em !important;
      text-transform: uppercase !important;
      color: var(--ov-m-patch) !important;
      padding: 4px 8px 2px !important;
    }
    .ov-pintray-empty {
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
      color: var(--ov-text-faint) !important;
      padding: 4px 8px 6px !important;
      font-style: italic !important;
    }

    /* ── Footer ── */
    #ov-footer {
      display: flex !important;
      align-items: center !important;
      gap: 10px !important;
      padding: 4px 10px !important;
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
      color: var(--ov-text-muted) !important;
      border-top: 1px solid var(--ov-border) !important;
      flex-shrink: 0 !important;
      background: var(--ov-hdr) !important;
    }
    .ov-fstat { color: var(--ov-text-muted) !important; }
    .ov-fstat b { color: var(--ov-text) !important; font-weight: 700 !important; }
    .ov-fstat-err b { color: var(--ov-s-err) !important; }
    .ov-fstat-warn b { color: var(--ov-s-4xx) !important; }
    .ov-fspacer { flex: 1 !important; }
    .ov-pin-toggle {
      all: unset !important;
      cursor: pointer !important;
      font-size: calc(9px * var(--ov-font-scale,1)) !important;
      font-family: inherit !important;
      color: var(--ov-text-muted) !important;
      padding: 1px 5px !important;
      border: 1px solid var(--ov-border) !important;
      border-radius: 2px !important;
    }
    .ov-pin-toggle:hover { color: var(--ov-m-patch) !important; border-color: var(--ov-m-patch) !important; }
    .ov-pin-toggle.on { color: var(--ov-m-patch) !important; border-color: var(--ov-m-patch) !important; }

    /* ── Resize handles ── */
    .ov-resize-handle { position: absolute !important; z-index: 10 !important; }
    .ov-resize-handle[data-dir="n"]  { top:0 !important; left:8px !important; right:8px !important; height:5px !important; cursor:n-resize !important; }
    .ov-resize-handle[data-dir="s"]  { bottom:0 !important; left:8px !important; right:8px !important; height:5px !important; cursor:s-resize !important; }
    .ov-resize-handle[data-dir="e"]  { top:8px !important; right:0 !important; bottom:8px !important; width:5px !important; cursor:e-resize !important; }
    .ov-resize-handle[data-dir="w"]  { top:8px !important; left:0 !important; bottom:8px !important; width:5px !important; cursor:w-resize !important; }
    .ov-resize-handle[data-dir="nw"] { top:0 !important; left:0 !important; width:8px !important; height:8px !important; cursor:nw-resize !important; }
    .ov-resize-handle[data-dir="ne"] { top:0 !important; right:0 !important; width:8px !important; height:8px !important; cursor:ne-resize !important; }
    .ov-resize-handle[data-dir="sw"] { bottom:0 !important; left:0 !important; width:8px !important; height:8px !important; cursor:sw-resize !important; }
    .ov-resize-handle[data-dir="se"] { bottom:0 !important; right:0 !important; width:8px !important; height:8px !important; cursor:se-resize !important; }

    /* ── Pill ── */
    #ov-pill {
      all: initial;
      position: fixed !important;
      bottom: 20px !important;
      right: 20px !important;
      z-index: 2147483646 !important;
      display: flex !important;
      align-items: center !important;
      gap: 8px !important;
      padding: 0 14px !important;
      height: 32px !important;
      background: #14161a !important;
      border: 1px solid #2a2f37 !important;
      border-radius: 16px !important;
      font-family: var(--ov-font-family,'JetBrains Mono','IBM Plex Mono',ui-monospace,monospace) !important;
      font-size: calc(11px * var(--ov-font-scale,1)) !important;
      color: #d6dae0 !important;
      cursor: move !important;
      box-shadow: 0 4px 20px rgba(0,0,0,.55) !important;
      user-select: none !important;
    }
    #ov-pill[data-theme="light"] {
      background: #ffffff !important;
      border-color: #d9d4c4 !important;
      color: #1a1c20 !important;
      box-shadow: 0 4px 20px rgba(0,0,0,.18) !important;
    }
    .ov-pill-dot {
      width: 7px !important; height: 7px !important;
      border-radius: 50% !important;
      background: #4ec9b0 !important;
      flex-shrink: 0 !important;
    }
    .ov-pill-count { font-weight: 700 !important; font-size: calc(12px * var(--ov-font-scale,1)) !important; }
    .ov-pill-label {
      color: #6a7180 !important;
      font-size: calc(9px * var(--ov-font-scale,1)) !important;
      font-weight: 700 !important;
      letter-spacing: .06em !important;
      text-transform: uppercase !important;
    }
    .ov-pill-err { color: #ff5a6e !important; font-weight: 700 !important; font-size: calc(10px * var(--ov-font-scale,1)) !important; }
    .ov-pill-rail { display: flex !important; gap: 2px !important; align-items: center !important; margin: 0 2px !important; }
    .ov-pill-tick {
      width: 3px !important; height: 12px !important;
      background: #2a2f37 !important;
      border-radius: 1px !important;
      flex-shrink: 0 !important;
    }
    .ov-pill-tick.ok { background: #4ec9b0 !important; }
    .ov-pill-tick.err { background: #ff5a6e !important; }
    .ov-pill-tick.warn { background: #d4a85e !important; }
    .ov-pill-tick.ws { background: #6ab0ff !important; }
    .ov-pill-expand {
      all: unset !important;
      cursor: pointer !important;
      font-size: calc(11px * var(--ov-font-scale,1)) !important;
      color: #6a7180 !important;
      padding: 0 3px !important;
      line-height: 1 !important;
    }
    .ov-pill-expand:hover { color: #6ab0ff !important; }

    /* ── Ghost mode ── */
    .ov-ghost { opacity: 0.25 !important; transition: opacity 100ms !important; pointer-events: auto !important; }
    .ov-ghost:hover { opacity: 1 !important; }

    /* ── Host page highlights ── */
    .ov-highlighted {
      outline: 2px solid #6ab0ff !important;
      outline-offset: 2px !important;
      box-shadow: 0 0 0 4px rgba(106,176,255,.15) !important;
    }
    .ov-value-hover {
      outline: 1.5px dashed rgba(255,107,138,.55) !important;
      outline-offset: 2px !important;
    }
    .ov-value-match {
      outline: 1.5px dashed #ff6b8a !important;
      outline-offset: 2px !important;
    }
    .ov-value-current {
      outline: 2px solid #ff5a6e !important;
      outline-offset: 3px !important;
      box-shadow: 0 0 0 5px rgba(255,90,110,.18) !important;
    }

    /* ── Float badge cluster button ── */
    .ov-float-badge {
      position: absolute !important;
      z-index: 2147483645 !important;
      pointer-events: none !important;
      font-family: var(--ov-font-family,'JetBrains Mono','IBM Plex Mono',ui-monospace,monospace) !important;
    }
    .ov-fb-cluster {
      pointer-events: auto !important;
    }

    /* dark theme (default) */
    .ov-fb-cluster .ov-fb-circle {
      background: #14161a !important;
      color: #6ab0ff !important;
      border-color: #2a2f37 !important;
    }
    .ov-fb-cluster:hover .ov-fb-circle,
    .ov-fb-cluster.ov-fb-open .ov-fb-circle {
      background: #1a1d22 !important;
      color: #6ab0ff !important;
      border-color: #6ab0ff !important;
    }
    .ov-fb-cluster .ov-fb-popup {
      background: #14161a !important;
      border-color: #2a2f37 !important;
    }
    .ov-fb-cluster .ov-fb-url { color: #9aa1ab !important; }
    .ov-fb-cluster .ov-fb-s   { color: #6c727c !important; }

    /* light theme */
    .ov-fb-cluster[data-theme="light"] .ov-fb-circle {
      background: #ffffff !important;
      color: #2a6fdb !important;
      border-color: #d9d4c4 !important;
      box-shadow: 0 2px 8px rgba(0,0,0,.18) !important;
    }
    .ov-fb-cluster[data-theme="light"]:hover .ov-fb-circle,
    .ov-fb-cluster[data-theme="light"].ov-fb-open .ov-fb-circle {
      background: #f3f1ec !important;
      border-color: #2a6fdb !important;
    }
    .ov-fb-cluster[data-theme="light"] .ov-fb-popup {
      background: #ffffff !important;
      border-color: #d9d4c4 !important;
      box-shadow: 0 6px 20px rgba(0,0,0,.15) !important;
    }
    .ov-fb-cluster[data-theme="light"] .ov-fb-url { color: #4a4f59 !important; }
    .ov-fb-cluster[data-theme="light"] .ov-fb-s   { color: #6c727c !important; }

    /* Single-endpoint inline badge */
    .ov-fb-single {
      pointer-events: auto !important;
      background: #14161a !important;
      border: 1px solid #2a2f37 !important;
      border-radius: 4px !important;
      box-shadow: 0 2px 8px rgba(0,0,0,.45) !important;
      animation: ov-fadein .15s ease !important;
      max-width: min(340px, 90vw) !important;
    }
    .ov-fb-single .ov-fb-row { border-bottom: none !important; }
    .ov-fb-single .ov-fb-url { color: #9aa1ab !important; }
    .ov-fb-single .ov-fb-s   { color: #6c727c !important; }
    .ov-fb-single[data-theme="light"] {
      background: #ffffff !important;
      border-color: #d9d4c4 !important;
      box-shadow: 0 2px 8px rgba(0,0,0,.18) !important;
    }
    .ov-fb-single[data-theme="light"] .ov-fb-url { color: #4a4f59 !important; }
    .ov-fb-single[data-theme="light"] .ov-fb-s   { color: #6c727c !important; }

    .ov-fb-circle {
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      width: 26px !important;
      height: 26px !important;
      border-radius: 50% !important;
      font-size: calc(11px * var(--ov-font-scale,1)) !important;
      font-weight: 700 !important;
      cursor: pointer !important;
      box-shadow: 0 2px 8px rgba(0,0,0,.45) !important;
      border: 1.5px solid !important;
      user-select: none !important;
      animation: ov-fadein .15s ease !important;
      transition: background .12s, border-color .12s, transform .1s !important;
    }
    .ov-fb-cluster:hover .ov-fb-circle {
      transform: scale(1.1) !important;
    }

    /* popup panel — opens to the right of the circle */
    .ov-fb-popup {
      display: none !important;
      position: absolute !important;
      top: -4px !important;
      min-width: 230px !important;
      max-width: 340px !important;
      border-radius: 6px !important;
      box-shadow: 0 6px 20px rgba(0,0,0,.5) !important;
      padding: 4px 0 !important;
      animation: ov-fadein .12s ease !important;
      z-index: 2147483646 !important;
      border: 1px solid !important;
    }
    /* default: open to the right of the circle */
    .ov-fb-popup-right { left: 32px !important; right: auto !important; }
    /* flip: open to the left when circle is in the right half of the viewport */
    .ov-fb-popup-left  { right: 32px !important; left: auto !important; }
    .ov-fb-popup-show {
      display: block !important;
    }
    .ov-fb-row {
      display: flex !important;
      align-items: center !important;
      gap: 5px !important;
      padding: 5px 10px !important;
      white-space: nowrap !important;
      overflow: hidden !important;
      border-bottom: 1px solid #1e2229 !important;
      cursor: pointer !important;
    }
    .ov-fb-cluster[data-theme="light"] .ov-fb-row {
      border-bottom-color: #ebe6d8 !important;
    }
    .ov-fb-row:last-child { border-bottom: none !important; }
    .ov-fb-m {
      font-weight: 700 !important;
      font-size: calc(9px * var(--ov-font-scale,1)) !important;
      letter-spacing: .04em !important;
      padding: 1px 5px !important;
      border-radius: 2px !important;
      color: #fff !important;
      flex-shrink: 0 !important;
    }
    .ov-fb-m-get    { background: #1f6feb !important; }
    .ov-fb-m-post   { background: #7a3df0 !important; }
    .ov-fb-m-put    { background: #b8631a !important; }
    .ov-fb-m-patch  { background: #a6791f !important; }
    .ov-fb-m-delete { background: #d23158 !important; }
    .ov-fb-m-ws     { background: #1a8473 !important; }
    .ov-fb-url {
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      flex: 1 1 0 !important;
      min-width: 0 !important;
    }
    .ov-fb-s {
      font-weight: 700 !important;
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
      flex-shrink: 0 !important;
    }
    .ov-fb-s-2 { color: #4ec9b0 !important; }
    .ov-fb-s-4 { color: #d4a85e !important; }
    .ov-fb-s-5 { color: #ff5a6e !important; }
    @keyframes ov-fadein {
      from { opacity:0; transform:translateY(4px); }
      to   { opacity:1; transform:translateY(0); }
    }

    /* ── Tooltips ── */
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
      border-radius: 2px !important;
      padding: 4px 8px !important;
      font-size: calc(9px * var(--ov-font-scale,1)) !important;
      font-family: var(--ov-font-family,'JetBrains Mono','IBM Plex Mono',ui-monospace,monospace) !important;
      line-height: 1.5 !important;
      white-space: nowrap !important;
      pointer-events: none !important;
      opacity: 0 !important;
      transition: opacity 0.1s !important;
      z-index: 9999 !important;
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
    #ov-panel [data-tip][data-tip-pos="above"]::after {
      top: auto !important; bottom: calc(100% + 7px) !important;
    }
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

let injectedLoaded = false;

function activateOverlay(): void {
  if (activated) return;
  activated = true;
  cspBlocked = false;
  if (!injectedLoaded) {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('dist/injected.js');
    script.onload = () => { injectedLoaded = true; script.remove(); };
    script.onerror = () => { script.remove(); cspBlocked = true; renderList(); };
    (document.head || document.documentElement).prepend(script);
  } else {
    signalInjected('start');
  }

  const init = () => {
    loadFont().then(({ family, size }) => applyFont(family, size));
    loadTheme().then(theme => {
      currentTheme = theme;
      chrome.storage.local.get(['ovDockState', 'ovPinnedKeys', 'ovFilters', 'ovPanelGeom', 'ovPillGeom'], result => {
        dockState = (result.ovDockState as DockState) || 'panel';
        if (Array.isArray(result.ovPinnedKeys)) {
          for (const k of result.ovPinnedKeys) pinnedKeys.add(k);
        }
        if (result.ovFilters) {
          const f = result.ovFilters as { status?: string[]; methods?: string[]; initiators?: string[] };
          if (f.status) for (const s of f.status) activeStatus.add(s);
          if (f.methods) for (const m of f.methods) activeMethods.add(m);
          if (f.initiators) for (const i of f.initiators) activeInitiators.add(i);
        }
        savedPanelGeom = isValidPanelGeom(result.ovPanelGeom) ? result.ovPanelGeom : null;
        savedPillGeom = isValidPillGeom(result.ovPillGeom) ? result.ovPillGeom : null;
        void smCheckScanTab().then(() => {
          hydrateFromPreserved(() => {
            // Opened by the site-map scanner: capture only, render nothing.
            if (smCaptureOnly) return;
            if (dockState === 'pill') buildPill();
            else buildPanel();
          });
        });
      });
    });
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
  rowEventsBound = false;
  if (clusterOutsideClickHandler) {
    document.removeEventListener('click', clusterOutsideClickHandler, true);
    clusterOutsideClickHandler = null;
  }
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
  paused = false;
  panelVisible = true;
  cspBlocked = false;
  dockState = 'panel';
  showPinTray = false;
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
