import { describe, it, expect, beforeEach, vi } from 'vitest'
import { loadOverlay, activateOverlay, req, type OverlayApi } from './harness'

// setDockState (complexity 26), refreshClusterBadge (17) and the list click
// delegate (43) are the remaining S3776 findings that need behavioural cover.

let ov: OverlayApi

const seed = (...rows: Array<Record<string, unknown>>) => {
  for (const r of rows) ov.handleOverlayMessage({ __apiOverlay: true, ...r })
  ov.renderList()
}

const panel = () => document.getElementById('ov-panel')
const pill = () => document.getElementById('ov-pill')

beforeEach(async () => {
  ov = loadOverlay()
  await activateOverlay()
})

describe('setDockState', () => {
  it('starts docked as a panel', () => {
    expect(panel()).not.toBeNull()
    expect(pill()).toBeNull()
  })

  it('collapses the panel into a pill and hides the panel', () => {
    ov.setDockState('pill')
    expect(pill()).not.toBeNull()
    expect(panel()?.style.display).toBe('none')
  })

  it('expands the pill back into a panel and removes the pill', () => {
    ov.setDockState('pill')
    ov.setDockState('panel')
    expect(pill()).toBeNull()
    expect(panel()?.style.display).toBe('flex')
  })

  it('hides both surfaces in the hidden state', () => {
    ov.setDockState('hidden')
    expect(panel()?.style.display).toBe('none')
    expect(pill()).toBeNull()
  })

  it('is a no-op when the state is unchanged', () => {
    const before = panel()
    ov.setDockState('panel')
    expect(panel()).toBe(before)
  })

  it('persists the dock state', () => {
    ov.setDockState('pill')
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({ ovDockState: 'pill' }),
    )
  })

  it('renders request counts into the pill', () => {
    seed(req({ id: 1, status: 200 }), req({ id: 2, status: 500 }))
    ov.setDockState('pill')
    const text = (pill()?.textContent ?? '').replace(/\s+/g, ' ')
    expect(text).toContain('2 req')
    expect(pill()?.querySelector('.ov-pill-err')?.textContent).toBe('1')
    // One bar per recent request, error-coloured where the call failed.
    expect(pill()?.querySelectorAll('.ov-pill-tick')).toHaveLength(2)
    expect(pill()?.querySelectorAll('.ov-pill-tick.err')).toHaveLength(1)
  })
})

describe('list click delegation', () => {
  it('expands a row on click and collapses it on a second click', () => {
    seed(req({ id: 1, resBody: '{"a":1}' }))
    const row = document.querySelector<HTMLElement>('#ov-list .ov-row')!
    row.click()
    // the click schedules an async re-render; force it for a deterministic DOM
    ov.renderList()
    expect(ov.expandedIds.has(1)).toBe(true)
    expect(document.querySelector('.ov-detail')).not.toBeNull()

    document.querySelector<HTMLElement>('#ov-list .ov-row')!.click()
    ov.renderList()
    expect(ov.expandedIds.has(1)).toBe(false)
    expect(document.querySelector('.ov-detail')).toBeNull()
  })

  it('toggles a pin without expanding the row', () => {
    seed(req({ id: 1 }))
    document.querySelector<HTMLButtonElement>('.ov-pin-btn')!.click()
    expect(ov.pinnedIds.has(1)).toBe(true)
    expect(ov.expandedIds.has(1)).toBe(false)

    document.querySelector<HTMLButtonElement>('.ov-pin-btn')!.click()
    expect(ov.pinnedIds.has(1)).toBe(false)
  })

  it('switches the detail tab without collapsing the row', () => {
    seed(req({ id: 1, resBody: '{"a":1}', reqBody: 'x=1' }))
    document.querySelector<HTMLElement>('#ov-list .ov-row')!.click()
    ov.renderList()
    const requestTab = [...document.querySelectorAll<HTMLElement>('.ov-tab')]
      .find(t => t.dataset.tab === 'request')!
    requestTab.click()
    ov.renderList()
    expect(ov.expandedIds.has(1)).toBe(true)
    const active = document.querySelector<HTMLElement>('.ov-tab-active')
    expect(active?.dataset.tab).toBe('request')
  })

  it('ignores clicks on the list background', () => {
    seed(req({ id: 1 }))
    document.getElementById('ov-list')!.click()
    expect(ov.expandedIds.size).toBe(0)
  })
})

describe('docked inspector', () => {
  const dock = () => document.getElementById('ov-dock')

  const openRow = (id: number) => {
    document.querySelector<HTMLElement>(`#ov-list .ov-row[data-id="${id}"]`)!.click()
    ov.renderList()
  }

  it('renders the detail in the dock, not inside the row', () => {
    seed(req({ id: 1, resBody: '{"a":1}' }))
    openRow(1)
    const detail = document.querySelector('.ov-detail')!
    expect(dock()?.contains(detail)).toBe(true)
    expect(document.querySelector('#ov-list .ov-detail')).toBeNull()
  })

  it('hides the dock until something is selected, and again once closed', () => {
    seed(req({ id: 1, resBody: '{"a":1}' }))
    expect(dock()?.hasAttribute('hidden')).toBe(true)

    openRow(1)
    expect(dock()?.hasAttribute('hidden')).toBe(false)

    document.querySelector<HTMLButtonElement>('.ov-dh-close')!.click()
    ov.renderList()
    expect(ov.expandedIds.size).toBe(0)
    expect(dock()?.hasAttribute('hidden')).toBe(true)
  })

  it('opens one request at a time', () => {
    seed(req({ id: 1 }), req({ id: 2 }))
    openRow(1)
    openRow(2)
    expect([...ov.expandedIds]).toEqual([2])
    expect(document.querySelectorAll('.ov-detail')).toHaveLength(1)
  })

  it('names the triggering element in the detail head', () => {
    seed(req({ id: 1, element: { selector: '#buy', label: 'button.buy' } }))
    openRow(1)
    const trigger = document.querySelector<HTMLElement>('.ov-dh-trigger')!
    expect(trigger.textContent).toContain('triggered by')
    expect(trigger.textContent).toContain('button.buy')
    expect(trigger.dataset.sel).toBe('%23buy')
  })

  it('reports only measured timings, never a fabricated phase breakdown', () => {
    seed(req({ id: 1, ms: 88, kind: 'fetch' }))
    openRow(1)
    const timingTab = [...document.querySelectorAll<HTMLElement>('.ov-tab')]
      .find(t => t.dataset.tab === 'timing')!
    timingTab.click()
    ov.renderList()

    const pane = document.querySelector('#ov-dock .ov-panel')!
    expect(pane.textContent).toContain('88ms')
    // DNS / TCP / download cannot be seen from the page, so they must not appear
    // at all — a plausible-looking constant is worse than an absent row.
    for (const phase of ['DNS', 'TCP', 'TTFB', 'Download']) {
      expect(pane.textContent, phase).not.toContain(phase)
    }
  })

  it('marks a background request as unattributed', () => {
    seed(req({ id: 1, element: null }))
    openRow(1)
    const trigger = document.querySelector<HTMLElement>('.ov-dh-trigger')!
    expect(trigger.textContent).toContain('background')
    expect(trigger.dataset.sel).toBeUndefined()
  })
})

describe('view switching', () => {
  const clickView = (v: string) => {
    document.querySelector<HTMLElement>(`.ov-view[data-v="${v}"]`)!.click()
  }

  it('starts on the log with the log tab marked active', () => {
    seed(req({ id: 1 }))
    expect(document.querySelector('.ov-view.on')?.getAttribute('data-v')).toBe('log')
    expect(document.querySelectorAll('#ov-list .ov-row')).toHaveLength(1)
  })

  it('shows only pinned requests in the pinned view', () => {
    seed(req({ id: 1 }), req({ id: 2 }))
    document.querySelector<HTMLButtonElement>('.ov-row[data-id="2"] .ov-pin-btn')!.click()
    ov.renderList()

    clickView('pinned')
    const ids = [...document.querySelectorAll('#ov-list .ov-row')]
      .map(el => (el as HTMLElement).dataset.id)
    expect(ids).toEqual(['2'])
  })

  it('explains itself when nothing is pinned', () => {
    seed(req({ id: 1 }))
    clickView('pinned')
    expect(document.querySelector('#ov-list .ov-state-title')?.textContent).toBe('Nothing pinned')
  })

  it('offers the site map as a not-yet-built state with its tier legend', () => {
    seed(req({ id: 1 }))
    clickView('map')
    expect(document.querySelector('#ov-list .ov-state-title')?.textContent)
      .toBe('No site map built yet')
    expect(document.querySelectorAll('#ov-list .ov-tier')).toHaveLength(3)
    const build = document.querySelector<HTMLButtonElement>('#ov-build-map')!
    expect(build.disabled).toBe(false)
  })

  it('starts discovery when Build map is clicked, and offers a stop', () => {
    // Discovery fetches pages; fail them fast so the build unwinds on its own.
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
    seed(req({ id: 1 }))
    clickView('map')
    document.querySelector<HTMLButtonElement>('#ov-build-map')!.click()

    // smBuildMap flips into the building state synchronously, before it awaits.
    expect(document.querySelector('#ov-list .ov-sm-bar')).not.toBeNull()
    expect(document.querySelector('#ov-build-map')).toBeNull()
    expect(document.querySelector<HTMLElement>('.ov-sm-act[data-act="stop"]')).not.toBeNull()
  })

  it('keeps the request tally over the map until a build has started', () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
    seed(req({ id: 1 }), req({ id: 2 }))
    expect(document.getElementById('ov-count')?.textContent).toBe('2/2')

    // Nothing discovered yet — a pages/endpoints tally would contradict the primer.
    clickView('map')
    expect(document.getElementById('ov-count')?.textContent).toBe('2/2')

    document.querySelector<HTMLButtonElement>('#ov-build-map')!.click()
    expect(document.getElementById('ov-count')?.textContent).toMatch(/^\d+p\/\d+e$/)
  })

  it('keeps the dock closed while the site map is showing', () => {
    seed(req({ id: 1, resBody: '{"a":1}' }))
    document.querySelector<HTMLElement>('#ov-list .ov-row')!.click()
    ov.renderList()
    expect(document.getElementById('ov-dock')?.hasAttribute('hidden')).toBe(false)

    clickView('map')
    expect(document.getElementById('ov-dock')?.hasAttribute('hidden')).toBe(true)
  })

  it('persists the selected view', () => {
    clickView('pinned')
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({ ovView: 'pinned' }),
    )
  })
})

describe('toolbar', () => {
  it('keeps every capture control on the panel, not behind a menu', () => {
    for (const id of ['ov-pause', 'ov-clear', 'ov-theme', 'ov-export', 'ov-collapse']) {
      expect(document.getElementById(id), id).not.toBeNull()
    }
    expect(document.getElementById('ov-settings')).toBeNull()
  })

  it('shows all filter chips permanently', () => {
    expect(document.getElementById('ov-chips')?.hasAttribute('hidden')).toBe(false)
    expect(document.getElementById('ov-filters-btn')).toBeNull()
    expect(document.querySelectorAll('#ov-chips .ov-chip')).toHaveLength(12)
  })

  it('filters the log from a chip without any disclosure step', () => {
    seed(req({ id: 1, method: 'GET' }), req({ id: 2, method: 'POST' }))
    document.querySelector<HTMLButtonElement>('.ov-chip[data-m="POST"]')!.click()
    const ids = [...document.querySelectorAll('#ov-list .ov-row')]
      .map(el => (el as HTMLElement).dataset.id)
    expect(ids).toEqual(['2'])
  })
})

describe('search field', () => {
  const field = () => document.getElementById('ov-filter') as HTMLInputElement

  const type = (term: string) => {
    field().value = term
    field().dispatchEvent(new Event('input'))
    ov.renderList()
  }

  it('sits on its own row, visible without a disclosure', () => {
    expect(document.querySelector('#ov-toolbar #ov-search')).not.toBeNull()
    expect(document.getElementById('ov-search-btn')).toBeNull()
    expect(field().tabIndex).toBe(0)
  })

  it('filters the log and reports the hit count', () => {
    seed(req({ id: 1, url: 'https://a.test/alpha' }), req({ id: 2, url: 'https://a.test/bravo' }))
    type('bravo')

    const ids = [...document.querySelectorAll('#ov-list .ov-row')]
      .map(el => (el as HTMLElement).dataset.id)
    expect(ids).toEqual(['2'])
    expect(document.getElementById('ov-hits')?.textContent).toBe('1 hit')
  })

  it('clears the term on Escape', () => {
    seed(req({ id: 1, url: 'https://a.test/alpha' }), req({ id: 2, url: 'https://a.test/bravo' }))
    type('bravo')

    field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(field().value).toBe('')
    expect(document.querySelectorAll('#ov-list .ov-row')).toHaveLength(2)
  })

  it('does not let the toolbar drag swallow focus from the field', () => {
    // The toolbar is a drag handle; preventDefault on its mousedown would stop
    // the input ever taking focus, which is what made search unusable.
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    field().dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false)
  })
})

describe('refreshClusterBadge', () => {
  /** Register a badge the way the badge pipeline would, then refresh it. */
  function badgeFor(sel: string, ids: number[]): HTMLDivElement {
    const badge = document.createElement('div')
    badge.className = 'ov-float-badge'
    document.documentElement.appendChild(badge)
    ov.selectorBadges.set(sel, badge)
    ov.selectorReqIds.set(sel, ids)
    ov.refreshClusterBadge(sel)
    return badge
  }

  it('does nothing when the selector has no badge', () => {
    expect(() => ov.refreshClusterBadge('#missing')).not.toThrow()
  })

  it('renders a single endpoint inline, with no circle or popup', () => {
    seed(req({ id: 1, url: 'https://a.test/only' }))
    const badge = badgeFor('#one', [1])
    expect(badge.className).toContain('ov-fb-single')
    expect(badge.querySelector('.ov-fb-circle')).toBeNull()
    expect(badge.querySelector('.ov-fb-popup')).toBeNull()
  })

  it('renders a counted cluster with a popup for two or more', () => {
    seed(req({ id: 1 }), req({ id: 2 }))
    const badge = badgeFor('#two', [1, 2])
    expect(badge.className).toContain('ov-fb-cluster')
    expect(badge.querySelector('.ov-fb-circle')?.textContent).toBe('2')
    expect(badge.querySelectorAll('.ov-fb-row')).toHaveLength(2)
  })

  it('updates the count in place when the cluster grows', () => {
    seed(req({ id: 1 }), req({ id: 2 }))
    const badge = badgeFor('#grow', [1, 2])
    const circle = badge.querySelector('.ov-fb-circle')

    ov.handleOverlayMessage({ __apiOverlay: true, ...req({ id: 3 }) })
    ov.selectorReqIds.set('#grow', [1, 2, 3])
    ov.refreshClusterBadge('#grow')

    expect(badge.querySelector('.ov-fb-circle')).toBe(circle)  // not rebuilt
    expect(circle?.textContent).toBe('3')
    expect(badge.querySelectorAll('.ov-fb-row')).toHaveLength(3)
  })

  it('removes stale rows when the cluster shrinks', () => {
    seed(req({ id: 1 }), req({ id: 2 }), req({ id: 3 }))
    const badge = badgeFor('#shrink', [1, 2, 3])
    ov.selectorReqIds.set('#shrink', [1])
    ov.refreshClusterBadge('#shrink')
    expect(badge.querySelectorAll('.ov-fb-row')).toHaveLength(1)
  })

  it('downgrades to the single layout when only one request remains', () => {
    seed(req({ id: 1 }), req({ id: 2 }))
    const badge = badgeFor('#down', [1, 2])
    ov.selectorReqIds.set('#down', [1])
    ov.refreshClusterBadge('#down')
    expect(badge.className).toContain('ov-fb-single')
  })

  it('keeps the popup open across a refresh', () => {
    seed(req({ id: 1 }), req({ id: 2 }))
    const badge = badgeFor('#open', [1, 2])
    badge.classList.add('ov-fb-open')
    ov.refreshClusterBadge('#open')
    expect(badge.querySelector('.ov-fb-popup')?.classList.contains('ov-fb-popup-show')).toBe(true)
  })
})
