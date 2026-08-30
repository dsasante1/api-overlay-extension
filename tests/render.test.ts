import { describe, it, expect, beforeEach } from 'vitest'
import { loadOverlay, activateOverlay, sendToOverlay, req, type OverlayApi } from './harness'

// renderList (complexity 36) and detailPanelHtml (27) are S3776 findings, and
// renderFooter/rowHtml are the surfaces they feed. These tests drive the real
// activation path so the assertions run against the panel the extension builds.

let ov: OverlayApi

/** Push requests through the same entry point the injected hook uses. */
function seed(...rows: Array<Record<string, unknown>>): void {
  for (const r of rows) ov.handleOverlayMessage({ __apiOverlay: true, ...r })
  ov.renderList()
}

const rowIds = () =>
  [...document.querySelectorAll('#ov-list .ov-row')].map(el => (el as HTMLElement).dataset.id)

const countText = () => document.getElementById('ov-count')?.textContent ?? ''
const footerText = () => document.getElementById('ov-footer')?.textContent?.replace(/\s+/g, ' ').trim() ?? ''

beforeEach(async () => {
  ov = loadOverlay()
  await activateOverlay()
})

describe('renderList — baseline', () => {
  it('shows the empty state before anything is captured', () => {
    ov.renderList()
    expect(document.querySelector('#ov-list .ov-empty')?.textContent)
      .toContain('No API calls captured yet')
  })

  it('renders one row per request, newest first', () => {
    seed(req({ id: 1, url: 'https://a.test/one' }),
         req({ id: 2, url: 'https://a.test/two' }),
         req({ id: 3, url: 'https://a.test/three' }))
    expect(rowIds()).toEqual(['3', '2', '1'])
    expect(countText()).toBe('3/3')
  })

  it('escapes markup in the rendered URL', () => {
    seed(req({ id: 1, url: 'https://a.test/<img src=x onerror=alert(1)>' }))
    const list = document.getElementById('ov-list')!
    // URL parsing percent-encodes the payload before it ever reaches the DOM.
    expect(list.querySelector('img')).toBeNull()
    expect(list.textContent).toContain('%3Cimg')
  })
})

describe('renderList — filters', () => {
  const mixed = () => seed(
    req({ id: 1, method: 'GET',  status: 200, ms: 100, url: 'https://a.test/alpha' }),
    req({ id: 2, method: 'POST', status: 404, ms: 100, url: 'https://a.test/bravo' }),
    req({ id: 3, method: 'GET',  status: 500, ms: 900, url: 'https://a.test/charlie' }),
    req({ id: 4, method: 'GET',  status: 200, ms: 900, url: 'https://a.test/delta',
          element: { selector: '#btn', label: 'Go' } }),
  )

  it('filters by status bucket', () => {
    mixed()
    ov.activeStatus.add('4xx')
    ov.renderList()
    expect(rowIds()).toEqual(['2'])
  })

  it('filters by method', () => {
    mixed()
    ov.activeMethods.add('POST')
    ov.renderList()
    expect(rowIds()).toEqual(['2'])
  })

  it('filters by initiator — page rows carry an element, bg rows do not', () => {
    mixed()
    ov.activeInitiators.add('page')
    ov.renderList()
    expect(rowIds()).toEqual(['4'])
    ov.activeInitiators.clear()
    ov.activeInitiators.add('bg')
    ov.renderList()
    expect(rowIds()).toEqual(['3', '2', '1'])
  })

  it('filters by the err flag', () => {
    mixed()
    ov.activeFlags.add('err')
    ov.renderList()
    expect(rowIds()).toEqual(['3', '2'])
  })

  it('filters by the slow flag at the >800ms threshold', () => {
    mixed()
    ov.activeFlags.add('slow')
    ov.renderList()
    expect(rowIds()).toEqual(['4', '3'])
  })

  it('ANDs the err and slow flags together', () => {
    mixed()
    ov.activeFlags.add('err')
    ov.activeFlags.add('slow')
    ov.renderList()
    expect(rowIds()).toEqual(['3'])
  })

  it('combines flag filters with chip filters', () => {
    mixed()
    ov.activeFlags.add('slow')
    ov.activeMethods.add('GET')
    ov.renderList()
    expect(rowIds()).toEqual(['4', '3'])
  })

  it('shows the no-results empty state when filters exclude everything', () => {
    mixed()
    ov.activeStatus.add('3xx')
    ov.renderList()
    expect(document.querySelector('#ov-list .ov-empty')?.textContent)
      .toContain('No matches')
  })

  it('reports visible/total in the count', () => {
    mixed()
    ov.activeMethods.add('POST')
    ov.renderList()
    expect(countText()).toBe('1/4')
  })
})

describe('renderFooter', () => {
  it('counts requests, errors, slow rows and transfer size', () => {
    seed(req({ id: 1, status: 200, ms: 10, resBody: 'abcd' }),
         req({ id: 2, status: 500, ms: 900 }))
    const text = footerText()
    expect(text).toContain('req 2')
    expect(text).toContain('err 1')
    expect(text).toContain('slow 1')
    expect(text).toContain('xfer 0.0kb')
  })

  it('disables a stat button when its count is zero', () => {
    seed(req({ id: 1, status: 200, ms: 10 }))
    const err = document.querySelector<HTMLButtonElement>('.ov-fstat-btn[data-f="err"]')!
    const slow = document.querySelector<HTMLButtonElement>('.ov-fstat-btn[data-f="slow"]')!
    expect(err.disabled).toBe(true)
    expect(slow.disabled).toBe(true)
  })

  it('marks an active flag button with the on class', () => {
    seed(req({ id: 1, status: 500, ms: 10 }))
    ov.activeFlags.add('err')
    ov.renderList()
    expect(document.querySelector('.ov-fstat-btn[data-f="err"]')?.classList.contains('on')).toBe(true)
  })

  it('clicking a stat button toggles the filter', () => {
    seed(req({ id: 1, status: 500, ms: 10 }), req({ id: 2, status: 200, ms: 10 }))
    const err = document.querySelector<HTMLButtonElement>('.ov-fstat-btn[data-f="err"]')!
    err.click()
    expect(ov.activeFlags.has('err')).toBe(true)
    expect(rowIds()).toEqual(['1'])
    document.querySelector<HTMLButtonElement>('.ov-fstat-btn[data-f="err"]')!.click()
    expect(ov.activeFlags.has('err')).toBe(false)
    expect(rowIds()).toEqual(['2', '1'])
  })

  // An active flag on a log with zero matching rows hides everything; the button
  // has to stay clickable or there is no way out of that state.
  it('keeps an active flag button clickable at zero count so it can be switched off', () => {
    ov.activeFlags.add('err')
    seed(req({ id: 1, status: 200, ms: 10 }), req({ id: 2, status: 200, ms: 10 }))
    expect(rowIds()).toEqual([])
    expect(countText()).toBe('0/2')

    const err = document.querySelector<HTMLButtonElement>('.ov-fstat-btn[data-f="err"]')!
    expect(err.disabled).toBe(false)
    expect(err.classList.contains('on')).toBe(true)

    err.click()
    expect(ov.activeFlags.has('err')).toBe(false)
    expect(rowIds()).toEqual(['2', '1'])
    // Off and at zero count it goes back to inert.
    expect(document.querySelector<HTMLButtonElement>('.ov-fstat-btn[data-f="err"]')!.disabled).toBe(true)
  })

  it('does not persist the err/slow flags', () => {
    seed(req({ id: 1, status: 500, ms: 900 }))
    document.querySelector<HTMLButtonElement>('.ov-fstat-btn[data-f="err"]')!.click()
    document.querySelector<HTMLButtonElement>('.ov-fstat-btn[data-f="slow"]')!.click()
    expect(ov.activeFlags.has('err')).toBe(true)
    expect(ov.activeFlags.has('slow')).toBe(true)
    expect(chrome.storage.local.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ ovFilters: expect.anything() }))
  })
})

describe('filter persistence', () => {
  it('persists chips only — never the flags', () => {
    seed(req({ id: 1, status: 500, ms: 10 }))
    document.querySelector<HTMLButtonElement>('.ov-fstat-btn[data-f="err"]')!.click()
    document.querySelector<HTMLButtonElement>('.ov-chip[data-m="POST"]')!.click()
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      { ovFilters: { status: [], methods: ['POST'], initiators: [] } })
  })

  it('marks restored chips on and applies them to the list', async () => {
    ov = loadOverlay({ storage: { local: { ovFilters: { status: ['4xx'], methods: ['POST'] } } } })
    await activateOverlay()
    seed(req({ id: 1, method: 'GET',  status: 200 }),
         req({ id: 2, method: 'POST', status: 404 }),
         req({ id: 3, method: 'POST', status: 200 }))

    const on = (sel: string) => document.querySelector(sel)?.classList.contains('on')
    expect(on('.ov-chip[data-s="4xx"]')).toBe(true)
    expect(on('.ov-chip[data-m="POST"]')).toBe(true)
    expect(on('.ov-chip[data-s="2xx"]')).toBe(false)
    expect(on('.ov-chip[data-m="GET"]')).toBe(false)
    expect(rowIds()).toEqual(['2'])
    expect(countText()).toBe('1/3')
  })

  it('ignores flags stored by older builds', async () => {
    ov = loadOverlay({ storage: { local: { ovFilters: { flags: ['err', 'slow'] } } } })
    await activateOverlay()
    seed(req({ id: 1, status: 200, ms: 10 }), req({ id: 2, status: 200, ms: 10 }))
    expect(ov.activeFlags.size).toBe(0)
    expect(rowIds()).toEqual(['2', '1'])
    expect(countText()).toBe('2/2')
    expect(document.querySelector<HTMLButtonElement>('.ov-fstat-btn[data-f="err"]')!.disabled).toBe(true)
  })

  // restoreFilters runs inside the activation chain: a throw there means no
  // overlay on any page, with no way back from the UI.
  it('survives a corrupt ovFilters value without losing the overlay', async () => {
    for (const bad of [{ status: 5 }, { methods: { x: 1 } }, { initiators: [1, null] }, 'junk', 42]) {
      ov = loadOverlay({ storage: { local: { ovFilters: bad } } })
      await activateOverlay()
      seed(req({ id: 1, status: 200 }))
      expect(document.getElementById('ov-panel'), `ovFilters=${JSON.stringify(bad)}`).not.toBeNull()
      expect(rowIds()).toEqual(['1'])
      expect(ov.activeStatus.size + ov.activeMethods.size + ov.activeInitiators.size).toBe(0)
    }
  })

  it('keeps the string entries of a partly corrupt ovFilters value', async () => {
    ov = loadOverlay({ storage: { local: { ovFilters: { status: ['4xx', 7, null], methods: 'POST' } } } })
    await activateOverlay()
    seed(req({ id: 1, status: 404 }), req({ id: 2, status: 200 }))
    expect([...ov.activeStatus]).toEqual(['4xx'])
    expect(ov.activeMethods.size).toBe(0)
    expect(rowIds()).toEqual(['1'])
  })

  it('re-derives chip state on every render, so a click is reflected without a manual toggle', () => {
    seed(req({ id: 1, method: 'GET', status: 200 }), req({ id: 2, method: 'POST', status: 200 }))
    const post = document.querySelector<HTMLButtonElement>('.ov-chip[data-m="POST"]')!
    post.click()
    expect(post.classList.contains('on')).toBe(true)
    expect(rowIds()).toEqual(['2'])
    post.click()
    expect(post.classList.contains('on')).toBe(false)
    expect(rowIds()).toEqual(['2', '1'])
  })
})

describe('detailPanelHtml', () => {
  it('defaults to the response tab for http requests', () => {
    const html = ov.detailPanelHtml(req({ id: 1, resBody: '{"a":1}' }))
    expect(html).toContain('data-tab="response"')
    expect(html).toContain('ov-tab-active')
    expect(html).toContain('copy curl')
  })

  it('defaults to the frames tab for websockets', () => {
    const html = ov.detailPanelHtml(req({ id: 1, kind: 'ws', status: 101, messages: [] }))
    expect(html).toContain('data-tab="frames"')
    expect(html).not.toContain('data-tab="timing"')
  })

  it('offers a copy button only when the active tab has content', () => {
    expect(ov.detailPanelHtml(req({ id: 1, resBody: '{"a":1}' }))).toContain('ov-copy-tab-btn')
    expect(ov.detailPanelHtml(req({ id: 1, resBody: null }))).not.toContain('ov-copy-tab-btn')
  })

  it('renders the requested tab when one has been selected', () => {
    const r = req({ id: 7, reqBody: 'x=1' })
    ov.handleOverlayMessage({ __apiOverlay: true, ...r })
    sendToOverlay({ action: 'get-state' })
    const html = ov.detailPanelHtml(r)
    expect(html).toContain('data-id="7"')
  })

  it('escapes header values', () => {
    const html = ov.detailPanelHtml(req({
      id: 1, resHeaders: [['x-test', '<script>alert(1)</script>']],
    }))
    expect(html).not.toContain('<script>alert(1)</script>')
  })
})

describe('rowHtml', () => {
  it('names the triggering element as the initiator, or background when there is none', () => {
    const attributed = ov.rowHtml(req({ element: { selector: '#b', label: 'B' } }))
    expect(attributed).toContain('◍ B')
    expect(attributed).toContain('<span class="ov-init-dot"></span>')

    const background = ov.rowHtml(req({ element: null }))
    expect(background).toContain('◌ background')
    expect(background).toContain('ov-init-dot ov-init-bg')
  })

  it('renders pending status as an ellipsis', () => {
    expect(ov.rowHtml(req({ status: 'pending' }))).toContain('•••')
  })

  it('shows the formatted duration', () => {
    expect(ov.rowHtml(req({ ms: 1500 }))).toContain('1.50s')
    expect(ov.rowHtml(req({ ms: undefined }))).toContain('—')
  })
})
