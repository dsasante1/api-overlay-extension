import { describe, it, expect, beforeEach } from 'vitest'
import { loadOverlay, activateOverlay } from './harness'

// jsdom does no flex layout, so these assert the invariant that actually broke:
// a spacer div shipped in the markup with no rule to make it grow, which left
// the header's action cluster pinned beside the live badge instead of tracking
// the panel's trailing edge. The wider the panel, the larger the dead gap.

const styleText = () => document.getElementById('ov-styles')?.textContent ?? ''

beforeEach(async () => {
  loadOverlay()
  await activateOverlay()
})

describe('flex spacers', () => {
  it('gives every spacer element a rule that lets it grow', () => {
    const panel = document.getElementById('ov-panel')!
    const spacers = [...panel.querySelectorAll('[class*="spacer"]')]
      .flatMap(el => [...el.classList])
      .filter(c => c.includes('spacer'))

    expect(spacers.length).toBeGreaterThan(0)
    for (const cls of new Set(spacers)) {
      const rule = new RegExp(`\\.${cls}\\s*\\{[^}]*flex:\\s*1`)
      expect(rule.test(styleText()), `.${cls} needs a growing flex rule`).toBe(true)
    }
  })

  it('puts the header spacer between the live badge and the actions', () => {
    const header = document.getElementById('ov-header')!
    const kids = [...header.children]
    const spacer = kids.findIndex(el => el.classList.contains('ov-hdr-spacer'))
    const live = kids.findIndex(el => el.id === 'ov-live')
    const actions = kids.findIndex(el => el.id === 'ov-actions')

    expect(spacer).toBeGreaterThan(live)
    expect(spacer).toBeLessThan(actions)
  })
})
