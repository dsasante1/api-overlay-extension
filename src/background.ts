/// <reference types="chrome" />

// Preserves captured requests per-tab so logs survive in-tab navigations
// (e.g. login → redirect, logout → redirect). Backed by chrome.storage.session
// so the data survives MV3 service-worker eviction; the in-memory map is just
// a write-through cache.

// NOTE: keep PreservedRequest in sync with ApiRequest in src/content.ts —
// the fields below are the subset that crosses the messaging boundary.
// (Bg-prefixed names exist because tsconfig uses module: "None", so top-level
// declarations share a global namespace with content.ts. Don't drop the prefix.)
interface BgWsMessage { dir: 'sent' | 'recv'; body: string; ts: number; }

interface PreservedRequest {
  id: number;
  url: string;
  method: string;
  kind: 'fetch' | 'xhr' | 'ws';
  status: number | 'pending' | 'error' | 'closed';
  element?: unknown;
  ts: number;
  reqBody?: string | null;
  resBody?: string | null;
  reqHeaders?: Array<[string, string]> | null;
  resHeaders?: Array<[string, string]> | null;
  messages?: BgWsMessage[];
  ms?: number;
  pageUrl?: string;
}

const BG_MAX_REQUESTS_PER_TAB = 1000;
const BG_MAX_WS_MESSAGES_PER_CONN = 500;

const STORAGE_PREFIX = 'ovTab_';
const storageKey = (tabId: number): string => `${STORAGE_PREFIX}${tabId}`;

// In-memory cache. Lost on SW eviction, then rebuilt lazily from storage.session.
const preservedByTab = new Map<number, Map<number, PreservedRequest>>();

async function getTabStore(tabId: number): Promise<Map<number, PreservedRequest>> {
  let store = preservedByTab.get(tabId);
  if (store) return store;
  store = new Map();
  preservedByTab.set(tabId, store);
  try {
    const key = storageKey(tabId);
    const result = await chrome.storage.session.get(key);
    const list = result[key] as PreservedRequest[] | undefined;
    if (Array.isArray(list)) {
      for (const r of list) {
        if (typeof r?.id === 'number') store.set(r.id, r);
      }
    }
  } catch {
    // storage.session unavailable — fall back to in-memory only for this SW lifetime.
  }
  return store;
}

function trimStore(store: Map<number, PreservedRequest>): void {
  if (store.size <= BG_MAX_REQUESTS_PER_TAB) return;
  const overflow = store.size - BG_MAX_REQUESTS_PER_TAB;
  const iter = store.keys();
  for (let i = 0; i < overflow; i++) {
    const k = iter.next().value;
    if (k === undefined) break;
    store.delete(k);
  }
}

async function persistTabStore(tabId: number, store: Map<number, PreservedRequest>): Promise<void> {
  try {
    await chrome.storage.session.set({ [storageKey(tabId)]: Array.from(store.values()) });
  } catch {
    // Quota exceeded or session storage unavailable. In-memory copy still serves
    // requests until the SW is evicted; nothing else we can do.
  }
}

async function handlePreserve(
  tabId: number,
  reqs: PreservedRequest[],
  wsDeltas: Record<string, BgWsMessage[]>,
): Promise<void> {
  const store = await getTabStore(tabId);

  for (const r of reqs) {
    if (typeof r?.id !== 'number') continue;
    store.set(r.id, r);
  }

  for (const [idStr, deltas] of Object.entries(wsDeltas)) {
    if (!Array.isArray(deltas) || !deltas.length) continue;
    const id = Number(idStr);
    const existing = store.get(id);
    if (!existing) continue; // delta for an unknown ws — drop (full record will arrive later)
    if (!existing.messages) existing.messages = [];
    existing.messages.push(...deltas);
    if (existing.messages.length > BG_MAX_WS_MESSAGES_PER_CONN) {
      existing.messages.splice(0, existing.messages.length - BG_MAX_WS_MESSAGES_PER_CONN);
    }
  }

  trimStore(store);
  await persistTabStore(tabId, store);
}

async function handleGetPreserved(tabId: number): Promise<PreservedRequest[]> {
  const store = await getTabStore(tabId);
  return Array.from(store.values());
}

async function handleClear(tabId: number): Promise<void> {
  preservedByTab.delete(tabId);
  try {
    await chrome.storage.session.remove(storageKey(tabId));
  } catch {
    // ignore — see persistTabStore
  }
}

// ── Site-map background scan ─────────────────────────────────────────────────
//
// Loads one page in an inactive tab so that tab's content script can capture the
// calls it really makes, then harvests the result and closes it. This is the only
// part of the site map that navigates anywhere, which is why it runs one page at
// a time and only when the user clicks "scan" on that page.

const SM_SCAN_LOAD_TIMEOUT_MS = 20_000;
const SM_SCAN_SETTLE_MS = 2_500;

// Normalized origin+pathname of the scan currently in flight. The scanned tab's
// content script asks whether it matches and, if so, suppresses its overlay.
// Keyed by URL rather than tab id because the content script runs at
// document_start — before chrome.tabs.create() has resolved with an id.
const smPendingScanUrls = new Set<string>();
let smScanInFlight = false;

function smNormUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '';
  }
}

function smWaitForLoad(tabId: number): Promise<void> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve();
    };
    const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo): void => {
      if (id === tabId && info.status === 'complete') finish();
    };
    const timer = setTimeout(finish, SM_SCAN_LOAD_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(onUpdated);
    // The page may already have finished loading before the listener attached.
    chrome.tabs.get(tabId)
      .then(t => { if (t.status === 'complete') finish(); })
      .catch(() => finish());
  });
}

async function smHandleScan(url: string): Promise<PreservedRequest[]> {
  const norm = smNormUrl(url);
  if (!norm || smScanInFlight) return [];
  smScanInFlight = true;
  smPendingScanUrls.add(norm);

  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
    if (typeof tabId !== 'number') return [];
    await smWaitForLoad(tabId);
    // Load-time XHRs fire after 'complete'; give them a moment to land.
    await new Promise(r => setTimeout(r, SM_SCAN_SETTLE_MS));
    // Harvest *before* the tab is removed — onRemoved wipes its store.
    const store = await getTabStore(tabId);
    return Array.from(store.values());
  } catch {
    return [];
  } finally {
    smPendingScanUrls.delete(norm);
    smScanInFlight = false;
    if (typeof tabId === 'number') {
      preservedByTab.delete(tabId);
      try { await chrome.storage.session.remove(storageKey(tabId)); } catch { /* see persistTabStore */ }
      try { await chrome.tabs.remove(tabId); } catch { /* already closed */ }
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Asked before the overlay decides whether to build any UI, so it has to be
  // answered even for a frame we have no tab id for.
  if (msg?.action === 'sm-is-scan-tab') {
    sendResponse({ scan: smPendingScanUrls.has(smNormUrl(sender.url ?? '')) });
    return false;
  }

  const tabId = sender.tab?.id;
  if (typeof tabId !== 'number') {
    sendResponse({ ok: false });
    return false;
  }

  switch (msg?.action) {
    case 'ov-preserve': {
      const reqs = Array.isArray(msg.reqs) ? (msg.reqs as PreservedRequest[]) : [];
      const wsDeltas = (msg.wsDeltas && typeof msg.wsDeltas === 'object')
        ? (msg.wsDeltas as Record<string, BgWsMessage[]>)
        : {};
      handlePreserve(tabId, reqs, wsDeltas)
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true; // async sendResponse
    }
    case 'ov-get-preserved': {
      handleGetPreserved(tabId)
        .then(reqs => sendResponse({ ok: true, reqs }))
        .catch(() => sendResponse({ ok: false, reqs: [] }));
      return true;
    }
    case 'ov-clear-preserved': {
      handleClear(tabId)
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }
    case 'sm-scan': {
      const url = typeof msg.url === 'string' ? msg.url : '';
      smHandleScan(url)
        .then(reqs => sendResponse({ ok: true, reqs }))
        .catch(() => sendResponse({ ok: false, reqs: [] }));
      return true;
    }
    default:
      return false;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  preservedByTab.delete(tabId);
  chrome.storage.session.remove(storageKey(tabId)).catch(() => { /* see persistTabStore */ });
});
