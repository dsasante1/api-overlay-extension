/// <reference types="chrome" />

type PopupFontFamilyKey = 'mono' | 'sans' | 'serif';
type PopupFontSizeKey = 's' | 'm' | 'l' | 'xl';

let visible = true;
let capturePaused = false;
let siteEnabled = false;
let allowedHosts: string[] = [];
let currentHostname = '';
let currentTabId: number | null = null;
let requestCount = 0;

// Reading chrome.runtime.lastError is what suppresses the "Unchecked
// runtime.lastError" console warning; the value itself is never needed.
function swallowPopupLastError(): void {
  if (chrome.runtime.lastError) { /* intentionally ignored */ }
}

function sendMessageSafe(tabId: number, message: Record<string, unknown>): Promise<unknown> {
  return new Promise(resolve => {
    try {
      chrome.tabs.sendMessage(tabId, message, response => {
        swallowPopupLastError();
        resolve(response ?? null);
      });
    } catch {
      resolve(null);
    }
  });
}

async function send(action: string, extra: Record<string, unknown> = {}): Promise<void> {
  if (currentTabId != null) await sendMessageSafe(currentTabId, { action, ...extra });
}

function popupEscHtml(str: unknown): string {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function normalizeHost(raw: string): string {
  const trimmed = raw.trim().toLowerCase().replace(/\.+$/, '');
  if (!trimmed) return '';
  try {
    const withScheme = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
    return new URL(withScheme).hostname.replace(/\.+$/, '');
  } catch {
    return /^[a-z0-9.-]+$/.test(trimmed) ? trimmed : '';
  }
}

function popupHostAllowed(hosts: string[], current: string): boolean {
  if (!current) return false;
  return hosts.some(h => h === current || current.endsWith(`.${h}`));
}

// ── DOM refs ──────────────────────────────────────────────────────────────────

const statusBadge   = document.getElementById('status-badge') as HTMLElement;
const statusLine    = document.getElementById('status-line') as HTMLElement;
const statusMeta    = document.getElementById('status-meta') as HTMLElement;
const statusHost    = document.getElementById('status-host') as HTMLElement;
const capturingBtns = document.getElementById('capturing-btns') as HTMLElement;
const enableRow     = document.getElementById('enable-row') as HTMLElement;
const btnEnable     = document.getElementById('btn-enable') as HTMLButtonElement;
const btnToggle     = document.getElementById('btn-toggle') as HTMLButtonElement;
const btnPause      = document.getElementById('btn-pause') as HTMLButtonElement;
const btnExport     = document.getElementById('btn-export') as HTMLButtonElement;
const btnClear      = document.getElementById('btn-clear') as HTMLButtonElement;
const btnDisable    = document.getElementById('btn-disable') as HTMLButtonElement;
const btnDark       = document.getElementById('btn-dark') as HTMLButtonElement;
const btnLight      = document.getElementById('btn-light') as HTMLButtonElement;
const fontBtns: Record<PopupFontFamilyKey, HTMLButtonElement> = {
  mono:  document.getElementById('btn-font-mono')  as HTMLButtonElement,
  sans:  document.getElementById('btn-font-sans')  as HTMLButtonElement,
  serif: document.getElementById('btn-font-serif') as HTMLButtonElement,
};
// Font size is a slider: four discrete steps, ordered smallest to largest.
const SIZE_STEPS: PopupFontSizeKey[] = ['s', 'm', 'l', 'xl'];
const sizeRange = document.getElementById('size-range') as HTMLInputElement;
const hostInput     = document.getElementById('host-input') as HTMLInputElement;
const btnAddHost    = document.getElementById('btn-add-host') as HTMLButtonElement;
const siteCountEl   = document.getElementById('site-count') as HTMLElement;
const versionEl     = document.getElementById('ext-version') as HTMLElement;
const footerPm      = document.getElementById('footer-pm') as HTMLElement;
const footerStatus  = document.getElementById('footer-status') as HTMLElement;

// ── State appliers ────────────────────────────────────────────────────────────

function applyPopupTheme(theme: 'dark' | 'light'): void {
  document.body.dataset.theme = theme;
  btnDark.className  = `btn${theme === 'dark'  ? ' primary' : ''}`;
  btnLight.className = `btn${theme === 'light' ? ' primary' : ''}`;
}

function applyPopupFontFamily(family: PopupFontFamilyKey): void {
  const valid = family in fontBtns ? family : 'mono';
  for (const key of Object.keys(fontBtns) as PopupFontFamilyKey[]) {
    fontBtns[key].className = `btn${key === valid ? ' primary' : ''}`;
  }
}

function applyPopupFontSize(size: PopupFontSizeKey): void {
  const idx = SIZE_STEPS.indexOf(size);
  sizeRange.value = String(idx === -1 ? SIZE_STEPS.indexOf('m') : idx);
}

function applyVisibleState(v: boolean): void {
  visible = v;
  btnToggle.textContent = v ? '👁 hide panel' : '👁 show panel';
}

function applyPausedState(p: boolean): void {
  capturePaused = p;
  btnPause.textContent = p ? '▶ resume' : '⏸ pause';
}

function updateCurrentSiteSection(): void {
  // status line
  const isActive = siteEnabled;
  statusLine.className = `status-line${isActive ? '' : ' off'}`;

  // badge
  statusBadge.textContent = isActive ? 'capturing' : 'inactive';
  statusBadge.className = `badge${isActive ? ' on' : ' off'}`;

  // hostname + meta
  statusHost.textContent = currentHostname || '—';
  if (isActive) {
    statusMeta.textContent = requestCount > 0 ? `active · ${requestCount} captured` : 'active';
  } else {
    statusMeta.textContent = currentHostname ? 'dormant here' : '';
  }

  // buttons
  capturingBtns.style.display = isActive ? '' : 'none';
  enableRow.style.display = isActive ? 'none' : '';
  btnEnable.textContent = currentHostname
    ? `+ enable on ${currentHostname}`
    : '+ enable on this site';

  // footer
  const live = isActive;
  footerPm.className = `pm${live ? '' : ' idle'}`;
  footerStatus.textContent = live ? 'live' : 'idle';
}

// ── Host list rendering ───────────────────────────────────────────────────────

function renderHostList(): void {
  const list = document.getElementById('host-list') as HTMLElement;
  siteCountEl.textContent = String(allowedHosts.length);
  if (allowedHosts.length === 0) {
    list.innerHTML = '<div class="host-empty">Nothing allowed yet.<br>CalloutAPI stays dormant until you add a host.</div>';
    return;
  }
  list.innerHTML = allowedHosts.map((h, i) => {
    const safe = popupEscHtml(h);
    const isCurrent = currentHostname === h || currentHostname.endsWith(`.${h}`);
    return `<div class="host-item${isCurrent ? ' current' : ''}">
      <span class="host-dot">${isCurrent ? '●' : '○'}</span>
      <span class="host-name" title="${safe}">${safe}</span>
      <span class="host-meta">+ subdomains</span>
      <button type="button" class="host-remove" data-index="${i}" title="Remove">✕</button>
    </div>`;
  }).join('');
}

function bindHostListDelegation(): void {
  const list = document.getElementById('host-list') as HTMLElement;
  list.addEventListener('click', async (e: Event) => {
    const btn = (e.target as Element).closest<HTMLButtonElement>('.host-remove');
    if (!btn) return;
    const idx = Number(btn.dataset.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= allowedHosts.length) return;
    allowedHosts.splice(idx, 1);
    await chrome.storage.local.set({ ovAllowedHosts: allowedHosts });
    renderHostList();
    const stillAllowed = popupHostAllowed(allowedHosts, currentHostname);
    if (siteEnabled && !stillAllowed) {
      siteEnabled = false;
      updateCurrentSiteSection();
      if (currentTabId != null) await sendMessageSafe(currentTabId, { action: 'deactivate' });
    }
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  // Read from the manifest rather than hard-coding it here, so the two can
  // never disagree after a version bump.
  versionEl.textContent = `v${chrome.runtime.getManifest().version}`;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id ?? null;
  try { currentHostname = tab?.url ? new URL(tab.url).hostname : ''; } catch { currentHostname = ''; }

  allowedHosts = await new Promise<string[]>(resolve => {
    chrome.storage.local.get('ovAllowedHosts', ({ ovAllowedHosts }) => {
      resolve((ovAllowedHosts as string[]) ?? []);
    });
  });

  siteEnabled = popupHostAllowed(allowedHosts, currentHostname);
  renderHostList();
  bindHostListDelegation();

  let synced = false;
  if (currentTabId != null) {
    const resp = await sendMessageSafe(currentTabId, { action: 'get-state' }) as
      { visible?: boolean; paused?: boolean; theme?: 'dark' | 'light';
        fontFamily?: PopupFontFamilyKey; fontSize?: PopupFontSizeKey; count?: number } | null;
    if (resp) {
      applyPopupTheme(resp.theme ?? 'dark');
      applyPopupFontFamily(resp.fontFamily ?? 'mono');
      applyPopupFontSize(resp.fontSize ?? 'm');
      applyVisibleState(resp.visible !== false);
      applyPausedState(resp.paused === true);
      if (typeof resp.count === 'number') requestCount = resp.count;
      synced = true;
    }
  }

  if (!synced) {
    await new Promise<void>(resolve => {
      chrome.storage.local.get(
        ['ovTheme', 'ovVisible', 'ovPaused', 'ovFontFamily', 'ovFontSize'],
        ({ ovTheme, ovVisible, ovPaused, ovFontFamily, ovFontSize }) => {
          applyPopupTheme((ovTheme as 'dark' | 'light') || 'dark');
          applyPopupFontFamily((ovFontFamily as PopupFontFamilyKey) || 'mono');
          applyPopupFontSize((ovFontSize as PopupFontSizeKey) || 'm');
          applyVisibleState(ovVisible !== false);
          applyPausedState(ovPaused === true);
          resolve();
        });
    });
  }

  updateCurrentSiteSection();
}

void init();

// ── Button handlers ───────────────────────────────────────────────────────────

btnDark.addEventListener('click', async () => {
  applyPopupTheme('dark');
  await send('theme', { value: 'dark' });
});

btnLight.addEventListener('click', async () => {
  applyPopupTheme('light');
  await send('theme', { value: 'light' });
});

for (const key of Object.keys(fontBtns) as PopupFontFamilyKey[]) {
  fontBtns[key].addEventListener('click', async () => {
    applyPopupFontFamily(key);
    // The content script always listens (even when the panel isn't built), so it
    // persists the preference to storage and applies it live where active.
    await send('font-family', { value: key });
  });
}

sizeRange.addEventListener('input', async () => {
  const key = SIZE_STEPS[Number(sizeRange.value)];
  if (!key) return;
  await send('font-size', { value: key });
});

btnToggle.addEventListener('click', async () => {
  const prev = visible;
  visible = !visible;
  applyVisibleState(visible);
  if (currentTabId != null) {
    const ok = await sendMessageSafe(currentTabId, { action: 'toggle' });
    if (ok === null) { visible = prev; applyVisibleState(visible); }
  }
});

btnPause.addEventListener('click', async () => {
  const prev = capturePaused;
  capturePaused = !capturePaused;
  applyPausedState(capturePaused);
  if (currentTabId != null) {
    const ok = await sendMessageSafe(currentTabId, { action: 'pause', value: capturePaused });
    if (ok === null) { capturePaused = prev; applyPausedState(capturePaused); }
  }
});

btnExport.addEventListener('click', () => send('export-har'));
btnClear.addEventListener('click',  () => send('clear'));

btnEnable.addEventListener('click', async () => {
  if (!currentHostname) return;
  // Don't add a redundant entry when an existing rule already covers this hostname
  // (e.g. allowing example.com transitively allows sub.example.com).
  if (!popupHostAllowed(allowedHosts, currentHostname)) {
    allowedHosts.push(currentHostname);
    await chrome.storage.local.set({ ovAllowedHosts: allowedHosts });
    renderHostList();
  }
  siteEnabled = true;
  updateCurrentSiteSection();
  if (currentTabId != null) await sendMessageSafe(currentTabId, { action: 'activate' });
});

// Drop every allowlist rule that covers this hostname — an exact entry, and any
// parent domain the host inherits from — then tear the overlay down in place.
btnDisable.addEventListener('click', async () => {
  if (!currentHostname) return;
  const remaining = allowedHosts.filter(
    h => !(currentHostname === h || currentHostname.endsWith(`.${h}`)),
  );
  if (remaining.length !== allowedHosts.length) {
    allowedHosts = remaining;
    await chrome.storage.local.set({ ovAllowedHosts: allowedHosts });
    renderHostList();
  }
  siteEnabled = false;
  updateCurrentSiteSection();
  if (currentTabId != null) await sendMessageSafe(currentTabId, { action: 'deactivate' });
});

btnAddHost.addEventListener('click', async () => {
  const host = normalizeHost(hostInput.value);
  if (!host) { hostInput.value = ''; hostInput.placeholder = 'invalid hostname'; return; }
  if (allowedHosts.includes(host)) { hostInput.value = host; return; }
  allowedHosts.push(host);
  hostInput.value = '';
  await chrome.storage.local.set({ ovAllowedHosts: allowedHosts });
  renderHostList();
  if (!siteEnabled && popupHostAllowed([host], currentHostname)) {
    siteEnabled = true;
    updateCurrentSiteSection();
    if (currentTabId != null) await sendMessageSafe(currentTabId, { action: 'activate' });
  }
});

hostInput.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') btnAddHost.click();
});
