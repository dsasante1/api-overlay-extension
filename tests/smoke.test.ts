import { describe, it, expect } from 'vitest'
import { loadOverlay, req } from './harness'

describe('harness', () => {
  it('loads the built overlay and exposes its functions', () => {
    const ov = loadOverlay()
    expect(typeof ov.statusBucket).toBe('function')
    expect(ov.statusBucket(req({ status: 200 }))).toBe('2xx')
  })
})
