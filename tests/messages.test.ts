import { describe, it, expect, beforeEach } from 'vitest'
import { loadOverlay, activateOverlay, sendToOverlay, flush, req, type OverlayApi } from './harness'

// handleOverlayMessage (complexity 34) is the single entry point for everything
// the injected hook captures, and hydrateFromPreserved (the S2004 nesting
// finding) is what restores the log across in-tab navigations.

let ov: OverlayApi

const post = (msg: Record<string, unknown>) =>
  ov.handleOverlayMessage({ __apiOverlay: true, ...msg })

beforeEach(async () => {
  ov = loadOverlay()
  await activateOverlay()
})

describe('handleOverlayMessage — request records', () => {
  it('creates a record for an unseen id', () => {
    post(req({ id: 5, url: 'https://a.test/x' }))
    expect(ov.requests.size).toBe(1)
    expect(ov.requests.get(5).url).toBe('https://a.test/x')
  })

  it('merges an update into the existing record instead of duplicating it', () => {
    post(req({ id: 5, status: 'pending', ms: undefined }))
    post({ id: 5, status: 200, ms: 42 })
    expect(ov.requests.size).toBe(1)
    const r = ov.requests.get(5)
    expect(r.status).toBe(200)
    expect(r.ms).toBe(42)
    expect(r.url).toBe('https://api.example.com/v1/users')  // preserved from the first emit
  })

  it('rejects ids that are not safe integers', () => {
    post(req({ id: -1 }))
    post(req({ id: 1.5 }))
    post(req({ id: Number.MAX_SAFE_INTEGER }))
    post(req({ id: 'x' }))
    expect(ov.requests.size).toBe(0)
  })

  it('creates a bare record when only a body patch arrives', () => {
    // injected.ts emits the streamed body as `{ id, resBody }` with no other
    // fields; if the parent record is gone the patch still creates a row.
    post({ id: 9, resBody: '{"a":1}' })
    expect(ov.requests.size).toBe(1)
    expect(ov.requests.get(9).url).toBeUndefined()
  })
})

describe('handleOverlayMessage — pause semantics', () => {
  it('drops new records while paused but still applies updates to existing ones', () => {
    post(req({ id: 1, status: 'pending' }))
    sendToOverlay({ action: 'pause', value: true })

    post(req({ id: 2 }))                    // new — dropped
    post({ id: 1, status: 200, ms: 7 })     // update — applied

    expect(ov.requests.size).toBe(1)
    expect(ov.requests.get(1).status).toBe(200)

    sendToOverlay({ action: 'pause', value: false })
    post(req({ id: 3 }))
    expect(ov.requests.size).toBe(2)
  })
})

describe('handleOverlayMessage — websocket frames', () => {
  const wsConn = () => post(req({ id: 1, kind: 'ws', method: 'WS', status: 101 }))

  it('appends frames to the parent connection', () => {
    wsConn()
    post({ __wsMsg: true, wsId: 1, dir: 'send', body: 'hello', ts: 1 })
    post({ __wsMsg: true, wsId: 1, dir: 'recv', body: 'world', ts: 2 })
    expect(ov.requests.get(1).messages).toEqual([
      { dir: 'send', body: 'hello', ts: 1 },
      { dir: 'recv', body: 'world', ts: 2 },
    ])
  })

  it('drops frames whose connection is unknown', () => {
    post({ __wsMsg: true, wsId: 99, dir: 'send', body: 'x', ts: 1 })
    expect(ov.requests.size).toBe(0)
  })

  it('ignores frames with an unsafe wsId', () => {
    wsConn()
    post({ __wsMsg: true, wsId: -3, dir: 'send', body: 'x', ts: 1 })
    expect(ov.requests.get(1).messages).toBeUndefined()
  })

  it('ignores incomplete frames', () => {
    wsConn()
    post({ __wsMsg: true, wsId: 1, dir: 'send', ts: 1 })          // no body
    post({ __wsMsg: true, wsId: 1, body: 'x', ts: 1 })            // no dir
    expect(ov.requests.get(1).messages).toEqual([])
  })
})

describe('handleOverlayMessage — capacity', () => {
  it('trims the oldest records once the cap is exceeded', () => {
    for (let i = 1; i <= 1200; i++) post(req({ id: i }))
    expect(ov.requests.size).toBeLessThanOrEqual(1000)
    // the newest survive, the oldest are evicted
    expect(ov.requests.has(1200)).toBe(true)
    expect(ov.requests.has(1)).toBe(false)
  })
})

describe('window message channel', () => {
  // jsdom's window.postMessage delivers source: null and origin: '', so the
  // channel has to be exercised with a synthetic event that mirrors what a
  // browser actually dispatches for a same-window post.
  const dispatch = (over: Partial<MessageEventInit>) =>
    window.dispatchEvent(new MessageEvent('message', {
      data: { __apiOverlay: true, ...req({ id: 4 }) },
      source: window as unknown as MessageEventSource,
      origin: location.origin,
      ...over,
    }))

  it('accepts a same-window, same-origin message', async () => {
    dispatch({})
    await flush()
    expect(ov.requests.has(4)).toBe(true)
  })

  it('ignores messages that did not come from this window', async () => {
    dispatch({ source: null })
    await flush()
    expect(ov.requests.size).toBe(0)
  })

  // Guards the S2819 fix: a cross-origin frame must not be able to inject rows.
  it('ignores messages whose origin is not this page', async () => {
    dispatch({ origin: 'https://evil.test' })
    await flush()
    expect(ov.requests.size).toBe(0)
  })

  it('ignores same-window messages that are not overlay payloads', async () => {
    window.dispatchEvent(new MessageEvent('message', {
      data: { hello: 'world' },
      source: window as unknown as MessageEventSource,
      origin: location.origin,
    }))
    await flush()
    expect(ov.requests.size).toBe(0)
  })
})

describe('hydrateFromPreserved', () => {
  it('restores preserved rows on activation', async () => {
    ov = loadOverlay({
      replies: {
        'ov-get-preserved': {
          ok: true,
          reqs: [
            { ...req({ id: -2, url: 'https://a.test/old-1', ts: 10 }) },
            { ...req({ id: -1, url: 'https://a.test/old-2', ts: 20 }) },
          ],
        },
      },
    })
    await activateOverlay()
    expect(ov.requests.size).toBe(2)
    // Preserved rows are re-keyed to negative ids in timestamp order, so they
    // can never collide with the injected hook's positive per-page counter.
    expect(ov.requests.get(-1).url).toBe('https://a.test/old-1')
    expect(ov.requests.get(-2).url).toBe('https://a.test/old-2')
  })

  it('tolerates an empty or malformed reply', async () => {
    ov = loadOverlay({ replies: { 'ov-get-preserved': { ok: true, reqs: 'not-an-array' } } })
    await activateOverlay()
    expect(ov.requests.size).toBe(0)
    expect(document.getElementById('ov-panel')).not.toBeNull()
  })

  it('still builds the panel when the service worker never replies', async () => {
    ov = loadOverlay({ replies: { 'ov-get-preserved': undefined } })
    await activateOverlay()
    expect(document.getElementById('ov-panel')).not.toBeNull()
  })
})

describe('clear', () => {
  it('empties the log and the derived state', () => {
    post(req({ id: 1 }))
    post(req({ id: 2 }))
    sendToOverlay({ action: 'clear' })
    expect(ov.requests.size).toBe(0)
    expect(ov.pinnedIds.size).toBe(0)
    expect(ov.expandedIds.size).toBe(0)
  })
})
