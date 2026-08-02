import { describe, it, expect, beforeEach } from 'vitest'
import { loadOverlay, req, type OverlayApi } from './harness'

// Characterization tests for the status/derived-metric helpers. statusBucket is
// one of the functions flagged by SonarQube S3776, and isError/byteSize feed the
// footer counters, so a behaviour change here silently mis-colours every row.

let ov: OverlayApi

beforeEach(() => { ov = loadOverlay() })

describe('statusBucket', () => {
  it('maps numeric HTTP statuses to their class', () => {
    expect(ov.statusBucket(req({ status: 200 }))).toBe('2xx')
    expect(ov.statusBucket(req({ status: 204 }))).toBe('2xx')
    expect(ov.statusBucket(req({ status: 301 }))).toBe('3xx')
    expect(ov.statusBucket(req({ status: 404 }))).toBe('4xx')
    expect(ov.statusBucket(req({ status: 500 }))).toBe('5xx')
    expect(ov.statusBucket(req({ status: 599 }))).toBe('5xx')
  })

  it('treats pending and error sentinels specially', () => {
    expect(ov.statusBucket(req({ status: 'pending' }))).toBe('pending')
    expect(ov.statusBucket(req({ status: 'error' }))).toBe('err')
  })

  it('buckets sub-200 and unknown statuses as errors', () => {
    expect(ov.statusBucket(req({ status: 100 }))).toBe('err')
    expect(ov.statusBucket(req({ status: 0 }))).toBe('err')
    expect(ov.statusBucket(req({ status: undefined }))).toBe('err')
  })

  it('applies websocket-specific rules ahead of the numeric ones', () => {
    expect(ov.statusBucket(req({ kind: 'ws', status: 101 }))).toBe('2xx')
    expect(ov.statusBucket(req({ kind: 'ws', status: 'closed' }))).toBe('2xx')
    // A ws row with an ordinary 200 is NOT a successful handshake.
    expect(ov.statusBucket(req({ kind: 'ws', status: 200 }))).toBe('err')
    expect(ov.statusBucket(req({ kind: 'ws', status: 'pending' }))).toBe('pending')
    expect(ov.statusBucket(req({ kind: 'ws', status: 'error' }))).toBe('err')
  })
})

describe('isError', () => {
  it('counts 4xx, 5xx and transport errors, nothing else', () => {
    expect(ov.isError(req({ status: 404 }))).toBe(true)
    expect(ov.isError(req({ status: 500 }))).toBe(true)
    expect(ov.isError(req({ status: 'error' }))).toBe(true)
    expect(ov.isError(req({ status: 200 }))).toBe(false)
    expect(ov.isError(req({ status: 302 }))).toBe(false)
    expect(ov.isError(req({ status: 'pending' }))).toBe(false)
  })

  it('counts a non-101 websocket row as an error', () => {
    expect(ov.isError(req({ kind: 'ws', status: 101 }))).toBe(false)
    expect(ov.isError(req({ kind: 'ws', status: 999 }))).toBe(true)
  })
})

describe('byteSize', () => {
  it('sums the UTF-8 length of both bodies', () => {
    expect(ov.byteSize(req({ reqBody: null, resBody: null }))).toBe(0)
    expect(ov.byteSize(req({ resBody: 'abc' }))).toBe(3)
    expect(ov.byteSize(req({ reqBody: 'ab', resBody: 'cde' }))).toBe(5)
  })

  it('counts multi-byte characters by their encoded length', () => {
    expect(ov.byteSize(req({ resBody: '€' }))).toBe(3)
    expect(ov.byteSize(req({ resBody: '😀' }))).toBe(4)
  })
})

describe('formatDuration', () => {
  it('renders an em dash when the request never completed', () => {
    expect(ov.formatDuration(undefined)).toBe('—')
    expect(ov.formatDuration(null)).toBe('—')
  })

  it('renders milliseconds below one second and seconds above', () => {
    expect(ov.formatDuration(0)).toBe('0ms')
    expect(ov.formatDuration(999)).toBe('999ms')
    expect(ov.formatDuration(1000)).toBe('1.00s')
    expect(ov.formatDuration(1500)).toBe('1.50s')
    expect(ov.formatDuration(12345)).toBe('12.35s')
  })
})

describe('pillTickClass', () => {
  it('colours ticks by bucket, with ws taking the leftover case', () => {
    expect(ov.pillTickClass(req({ status: 500 }))).toBe('err')
    expect(ov.pillTickClass(req({ status: 404 }))).toBe('err')
    expect(ov.pillTickClass(req({ status: 'error' }))).toBe('err')
    expect(ov.pillTickClass(req({ status: 301 }))).toBe('warn')
    expect(ov.pillTickClass(req({ status: 200 }))).toBe('')
    expect(ov.pillTickClass(req({ kind: 'ws', status: 101 }))).toBe('ws')
    expect(ov.pillTickClass(req({ status: 'pending' }))).toBe('')
  })
})
