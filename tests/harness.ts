import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { vi } from 'vitest'

// src/ is compiled with `module: "None"`, so nothing in content.ts is importable.
// Instead we evaluate the built script inside the jsdom environment and hand back
// the declarations we want to assert on: `new Function` gives the script its own
// scope, and the appended assignment closes over every top-level binding.
//
// Consequence: tests run against the same code the extension ships, but they
// require `tsc` to have run first (package.json wires that up as `pretest`).

const EXPORTED = [
  'statusBucket', 'isError', 'byteSize', 'formatDuration', 'pillTickClass',
  'parseJsonBody', 'parsePartialJson', 'collectJsonLeaves', 'formatBody',
  'normalizeNumber', 'findValuesInDom', 'findMultipleValuesInDom',
  'detailPanelHtml', 'rowHtml', 'renderList', 'setDockState',
  'refreshClusterBadge', 'handleOverlayMessage', 'hydrateFromPreserved',
  'buildPanel', 'urlPath', 'middleTruncate', 'requests', 'activeFlags',
  'activeStatus', 'activeMethods', 'activeInitiators', 'expandedIds',
  'pinnedIds', 'trimRequests', 'renderFooter', 'escHtml',
  'flattenJsonRows', 'jsonRowToHtml', 'escJsonControl', 'pinKey',
  'selectorBadges', 'selectorReqIds', 'clusterBadgeRowHtml', 'refreshPill',
] as const

export type OverlayApi = Record<(typeof EXPORTED)[number], any>

export interface StorageStub {
  local: Record<string, unknown>
  session: Record<string, unknown>
}

/** Canned replies for chrome.runtime.sendMessage, keyed by the message action. */
export type SendMessageReplies = Record<string, unknown>

/** A chrome mock complete enough for content.ts's top-level side effects. */
export function makeChromeMock(storage: StorageStub, replies: SendMessageReplies = {}) {
  return {
    runtime: {
      id: 'mock-id',
      lastError: undefined as { message: string } | undefined,
      getURL: vi.fn((p: string) => `chrome-extension://mock-id/${p}`),
      sendMessage: vi.fn((msg: unknown, cb?: (r: unknown) => void) => {
        const action = (msg as { action?: string } | undefined)?.action ?? ''
        const reply = action in replies ? replies[action] : { ok: true, reqs: [] }
        if (typeof cb === 'function') cb(reply)
      }),
      onMessage: {
        addListener: vi.fn((fn: typeof messageListener) => { messageListener = fn }),
      },
    },
    storage: {
      local: {
        get: vi.fn((keys: unknown, cb?: (v: Record<string, unknown>) => void) => {
          const out: Record<string, unknown> = {}
          const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : []
          for (const k of list) if (k in storage.local) out[k] = storage.local[k]
          if (typeof cb === 'function') cb(out)
          return Promise.resolve(out)
        }),
        set: vi.fn((obj: Record<string, unknown>, cb?: () => void) => {
          Object.assign(storage.local, obj)
          cb?.()
          return Promise.resolve()
        }),
        remove: vi.fn(() => Promise.resolve()),
      },
      session: {
        get: vi.fn(() => Promise.resolve({})),
        set: vi.fn(() => Promise.resolve()),
        remove: vi.fn(() => Promise.resolve()),
      },
      onChanged: { addListener: vi.fn() },
    },
    tabs: { query: vi.fn(), sendMessage: vi.fn() },
  }
}

/** Listener content.ts registers on chrome.runtime.onMessage, captured at load. */
let messageListener:
  | ((msg: unknown, sender: unknown, sendResponse: (r?: unknown) => void) => unknown)
  | null = null

/** Dispatch an extension message (the popup's channel) and return the response. */
export function sendToOverlay(msg: Record<string, unknown>): unknown {
  if (!messageListener) throw new Error('overlay did not register an onMessage listener')
  let response: unknown
  messageListener(msg, {}, (r?: unknown) => { response = r })
  return response
}

/** Let queued promise callbacks (loadFont → loadTheme → storage.get) settle. */
export async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
}

/**
 * Drive the real activation path: this is what the popup's "activate" does, and
 * it is the only way to get `activated = true` (renderList no-ops otherwise).
 */
export async function activateOverlay(): Promise<void> {
  sendToOverlay({ action: 'activate' })
  await flush()
}

// Each loadOverlay() re-evaluates the script, and the previous instance leaves
// listeners on window/document — including a capture-phase click handler that
// stops propagation. Left in place they intercept events meant for the current
// instance, so every listener added since the last load is recorded and removed.
interface TrackedListener {
  target: EventTarget
  type: string
  fn: EventListenerOrEventListenerObject | null
  opts?: boolean | AddEventListenerOptions
}
let tracked: TrackedListener[] = []
let addEventListenerPatched = false

function patchAddEventListener(): void {
  if (addEventListenerPatched) return
  addEventListenerPatched = true
  const original = EventTarget.prototype.addEventListener
  EventTarget.prototype.addEventListener = function (
    this: EventTarget,
    type: string,
    fn: EventListenerOrEventListenerObject | null,
    opts?: boolean | AddEventListenerOptions,
  ) {
    tracked.push({ target: this, type, fn, opts })
    return original.call(this, type, fn, opts)
  }
}

function removeTrackedListeners(): void {
  for (const { target, type, fn, opts } of tracked) {
    if (fn) target.removeEventListener(type, fn, opts)
  }
  tracked = []
}

let cachedSource: string | null = null

// The manifest loads sitemap.js before content.js into one shared content-script
// scope, and content.js calls into it — so the harness has to concatenate them in
// the same order rather than evaluating content.js alone.
const SOURCE_FILES = ['../dist/sitemap.js', '../dist/content.js']

function overlaySource(): string {
  if (cachedSource === null) {
    cachedSource = SOURCE_FILES.map(rel => {
      const path = resolve(__dirname, rel)
      try {
        return readFileSync(path, 'utf8')
      } catch {
        throw new Error(`${rel} is missing — run \`npm run build\` before the tests (path: ${path})`)
      }
    }).join('\n;\n')
  }
  return cachedSource
}

/**
 * Load a fresh copy of the overlay into the current jsdom document.
 * Each call re-evaluates the script, so module-level state (the `requests` map,
 * filter sets, dock state) starts clean and tests can't leak into each other.
 */
export function loadOverlay(
  opts: { storage?: Partial<StorageStub>; replies?: SendMessageReplies } = {},
): OverlayApi {
  const storage: StorageStub = {
    local: { ...(opts.storage?.local ?? {}) },
    session: { ...(opts.storage?.session ?? {}) },
  }
  // tests/setup.ts installs a writable (but non-configurable) `chrome`, so
  // replace it by assignment rather than redefining the property.
  ;(globalThis as unknown as { chrome: unknown }).chrome = makeChromeMock(storage, opts.replies)

  removeTrackedListeners()
  patchAddEventListener()

  // The overlay appends its panel/pill/badges to documentElement, not body, and
  // buildPanel() early-returns when #ov-panel already exists — so a stale panel
  // from the previous load would silently suppress the new instance's bindings.
  for (const node of [...document.documentElement.children]) {
    if (node !== document.head && node !== document.body) node.remove()
  }
  document.body.innerHTML = ''
  document.head.innerHTML = ''
  messageListener = null

  const factory = new Function(
    `${overlaySource()}\n;return { ${EXPORTED.join(', ')} };`,
  ) as () => OverlayApi
  return factory()
}

/** Minimal ApiRequest builder — only the fields the assertions care about. */
export function req(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1, url: 'https://api.example.com/v1/users', method: 'GET',
    kind: 'fetch', status: 200, ts: 1_700_000_000_000, ms: 120,
    element: null, ...over,
  }
}
