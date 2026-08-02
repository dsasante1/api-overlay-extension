import { describe, it, expect, beforeEach } from 'vitest'
import { loadOverlay, type OverlayApi } from './harness'

// Characterization tests for the JSON pipeline. Three SonarQube S3776 findings
// live in here — parseString (inside parsePartialJson) and walk (inside
// flattenJsonRows) — and this is the code that renders every response body, so
// the truncation-recovery behaviour is worth pinning down precisely.

let ov: OverlayApi

beforeEach(() => { ov = loadOverlay() })

describe('parsePartialJson — well-formed input', () => {
  it('parses the same values JSON.parse would', () => {
    expect(ov.parsePartialJson('{"a":1,"b":"two","c":true,"d":null}'))
      .toEqual({ a: 1, b: 'two', c: true, d: null })
    expect(ov.parsePartialJson('[1,2,3]')).toEqual([1, 2, 3])
    expect(ov.parsePartialJson('{"nested":{"deep":[{"x":1}]}}'))
      .toEqual({ nested: { deep: [{ x: 1 }] } })
  })

  it('handles whitespace between every token', () => {
    expect(ov.parsePartialJson('{ "a" : [ 1 , 2 ] }')).toEqual({ a: [1, 2] })
  })
})

describe('parsePartialJson — string escapes', () => {
  it('decodes the standard two-character escapes', () => {
    expect(ov.parsePartialJson('{"s":"a\\"b"}')).toEqual({ s: 'a"b' })
    expect(ov.parsePartialJson('{"s":"a\\\\b"}')).toEqual({ s: 'a\\b' })
    expect(ov.parsePartialJson('{"s":"a\\/b"}')).toEqual({ s: 'a/b' })
    expect(ov.parsePartialJson('{"s":"a\\nb"}')).toEqual({ s: 'a\nb' })
    expect(ov.parsePartialJson('{"s":"a\\tb"}')).toEqual({ s: 'a\tb' })
    expect(ov.parsePartialJson('{"s":"a\\rb"}')).toEqual({ s: 'a\rb' })
    expect(ov.parsePartialJson('{"s":"a\\bb"}')).toEqual({ s: 'a\bb' })
    expect(ov.parsePartialJson('{"s":"a\\fb"}')).toEqual({ s: 'a\fb' })
  })

  it('decodes \\uXXXX escapes', () => {
    expect(ov.parsePartialJson('{"s":"\\u0041\\u00e9"}')).toEqual({ s: 'Aé' })
  })

  it('passes an unknown escape through as the literal character', () => {
    expect(ov.parsePartialJson('{"s":"a\\qb"}')).toEqual({ s: 'aqb' })
  })

  it('keeps what it read when the string is cut mid-way', () => {
    expect(ov.parsePartialJson('{"s":"abc')).toEqual({ s: 'abc' })
  })

  it('keeps what it read when the input ends inside an escape', () => {
    expect(ov.parsePartialJson('{"s":"abc\\')).toEqual({ s: 'abc' })
  })

  it('stops cleanly when a \\u escape is cut short', () => {
    expect(ov.parsePartialJson('{"s":"a\\u00')).toEqual({ s: 'a' })
  })
})

describe('parsePartialJson — truncation recovery', () => {
  it('drops a trailing number that ran to end-of-input', () => {
    // "12345" cut to "123" would be a wrong value, so the key is dropped entirely.
    expect(ov.parsePartialJson('{"a":1,"b":123')).toEqual({ a: 1 })
  })

  it('keeps completed entries and drops the incomplete trailing one', () => {
    expect(ov.parsePartialJson('{"a":1,"b":{"c":2},"d":')).toEqual({ a: 1, b: { c: 2 } })
    expect(ov.parsePartialJson('[1,2,')).toEqual([1, 2])
  })

  it('recovers a truncated array of objects, keeping the opened one empty', () => {
    expect(ov.parsePartialJson('[{"id":1},{"id":2},{"id"'))
      .toEqual([{ id: 1 }, { id: 2 }, {}])
  })

  it('returns an empty container when nothing completed', () => {
    expect(ov.parsePartialJson('{')).toEqual({})
    expect(ov.parsePartialJson('[')).toEqual([])
    expect(ov.parsePartialJson('{"a":1,"b":{')).toEqual({ a: 1, b: {} })
  })

  // NOTE: current behaviour, pinned here so the refactor can't change it by
  // accident — but it is inconsistent with how a truncated *number* is handled.
  // A number cut at end-of-input drops only its own key ({"a":1,"b":123 =>
  // {a:1}), whereas a keyword cut at end-of-input aborts the entire parse and
  // returns undefined, discarding the values that had already been recovered.
  it('abandons the whole parse on a truncated keyword', () => {
    expect(ov.parsePartialJson('{"a":tru')).toBeUndefined()
    expect(ov.parsePartialJson('{"a":1,"b":tru')).toBeUndefined()
    expect(ov.parsePartialJson('{"a":true,"b":fal')).toBeUndefined()
    expect(ov.parsePartialJson('[tru')).toBeUndefined()
  })
})

describe('parseJsonBody', () => {
  it('returns undefined for non-container bodies', () => {
    expect(ov.parseJsonBody(null)).toBeUndefined()
    expect(ov.parseJsonBody('')).toBeUndefined()
    expect(ov.parseJsonBody('plain text')).toBeUndefined()
    expect(ov.parseJsonBody('"just a string"')).toBeUndefined()
    expect(ov.parseJsonBody('42')).toBeUndefined()
  })

  it('marks strictly-valid JSON as not truncated', () => {
    expect(ov.parseJsonBody('{"a":1}')).toEqual({ value: { a: 1 }, truncated: false })
    expect(ov.parseJsonBody('  [1]  ')).toEqual({ value: [1], truncated: false })
  })

  it('falls back to the tolerant parser and flags truncation', () => {
    const out = ov.parseJsonBody('{"a":1,"b":')
    expect(out).toEqual({ value: { a: 1 }, truncated: true })
  })
})

describe('collectJsonLeaves', () => {
  it('collects strings of at least 6 characters and every number', () => {
    const out: Array<{ value: string; kind: string }> = []
    ov.collectJsonLeaves({ short: 'abc', long: 'abcdefgh', n: 42 }, out)
    expect(out).toEqual([
      { value: 'abcdefgh', kind: 'string' },
      { value: '42', kind: 'number' },
    ])
  })

  it('deduplicates repeated values', () => {
    const out: Array<{ value: string; kind: string }> = []
    ov.collectJsonLeaves({ a: 'duplicate', b: 'duplicate', c: 7, d: 7 }, out)
    expect(out).toEqual([
      { value: 'duplicate', kind: 'string' },
      { value: '7', kind: 'number' },
    ])
  })

  it('skips null and boolean leaves', () => {
    const out: Array<{ value: string; kind: string }> = []
    ov.collectJsonLeaves({ a: null, b: true, c: false }, out)
    expect(out).toEqual([])
  })

  it('walks nested arrays and objects, trimming strings', () => {
    const out: Array<{ value: string; kind: string }> = []
    ov.collectJsonLeaves({ list: [{ name: '  spaced  ' }, [1.5]] }, out)
    expect(out).toEqual([
      { value: 'spaced', kind: 'string' },
      { value: '1.5', kind: 'number' },
    ])
  })
})

describe('flattenJsonRows', () => {
  const depths = (rows: Array<{ depth: number }>) => rows.map(r => r.depth)
  const text = (rows: Array<{ segs: Array<Record<string, string>> }>) =>
    rows.map(r => r.segs.map(s => s.kind === 'leaf' ? s.display : s.html).join(''))

  it('emits one row per scalar with increasing depth', () => {
    const rows = ov.flattenJsonRows({ a: 1, b: 'x' })
    expect(depths(rows)).toEqual([0, 1, 1, 0])
    expect(text(rows)).toEqual([
      '{',
      '<span class="ov-jk">"a"</span>: 1,',
      '<span class="ov-jk">"b"</span>: "x"',
      '}',
    ])
  })

  it('renders empty containers inline', () => {
    expect(text(ov.flattenJsonRows({ a: [], b: {} }))).toEqual([
      '{',
      '<span class="ov-jk">"a"</span>: [],',
      '<span class="ov-jk">"b"</span>: {}',
      '}',
    ])
  })

  it('renders null and booleans as leaf segments', () => {
    const rows = ov.flattenJsonRows([null, true, false])
    const leaves = rows.flatMap((r: { segs: Array<Record<string, string>> }) =>
      r.segs.filter(s => s.kind === 'leaf').map(s => `${s.vkind}:${s.display}`))
    expect(leaves).toEqual(['null:null', 'boolean:true', 'boolean:false'])
  })

  it('keeps the raw (unescaped) value on string leaves for DOM matching', () => {
    const rows = ov.flattenJsonRows({ s: '<b>&x' })
    const leaf = rows.flatMap((r: { segs: Array<Record<string, string>> }) =>
      r.segs.filter(s => s.kind === 'leaf'))[0]
    expect(leaf.raw).toBe('<b>&x')
    expect(leaf.display).toBe('"&lt;b&gt;&amp;x"')
  })

  it('nests arrays of objects with the right depths', () => {
    const rows = ov.flattenJsonRows({ items: [{ id: 1 }] })
    expect(depths(rows)).toEqual([0, 1, 2, 3, 2, 1, 0])
  })
})

describe('escJsonControl', () => {
  it('escapes backslashes and control characters so values stay on one line', () => {
    expect(ov.escJsonControl('a\\b')).toBe('a\\\\b')
    expect(ov.escJsonControl('a\nb')).toBe('a\\nb')
    expect(ov.escJsonControl('a\tb')).toBe('a\\tb')
    expect(ov.escJsonControl('a\rb')).toBe('a\\rb')
    expect(ov.escJsonControl('plain')).toBe('plain')
  })
})
