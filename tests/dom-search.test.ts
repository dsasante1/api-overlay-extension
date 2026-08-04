import { describe, it, expect, beforeEach } from 'vitest'
import { loadOverlay, type OverlayApi } from './harness'

// findValuesInDom (complexity 45) and findMultipleValuesInDom (36) are the two
// worst S3776 offenders. They decide which page elements light up when a user
// expands a response, so their matching rules are pinned down here in detail.
//
// Relevant constants from content.ts: MIN_VALUE_LEN = 2, MIN_SUBSTRING_LEN = 4,
// MAX_VALUE_HIGHLIGHTS = 50.

let ov: OverlayApi

const page = (html: string) => { document.body.innerHTML = html }
const ids = (els: HTMLElement[]) => els.map(e => e.id || e.tagName.toLowerCase())

beforeEach(() => { ov = loadOverlay() })

describe('normalizeNumber', () => {
  it('strips thousands separators and normalizes the numeric form', () => {
    expect(ov.normalizeNumber('1,234')).toBe('1234')
    expect(ov.normalizeNumber('42')).toBe('42')
    expect(ov.normalizeNumber('-7.50')).toBe('-7.5')
    expect(ov.normalizeNumber('0012')).toBe('12')
  })

  it('extracts the first number embedded in surrounding text', () => {
    expect(ov.normalizeNumber('5 Branches')).toBe('5')
    expect(ov.normalizeNumber('$1,299.99 total')).toBe('1299.99')
  })

  it('returns an empty string when there is no number', () => {
    expect(ov.normalizeNumber('none')).toBe('')
    expect(ov.normalizeNumber('')).toBe('')
  })
})

describe('findValuesInDom — guards', () => {
  it('ignores booleans and nulls entirely', () => {
    page('<div id="a">true</div><div id="b">null</div>')
    expect(ov.findValuesInDom('true', 'boolean')).toEqual([])
    expect(ov.findValuesInDom('null', 'null')).toEqual([])
  })

  it('ignores blank values', () => {
    page('<div id="a">x</div>')
    expect(ov.findValuesInDom('   ', 'string')).toEqual([])
  })

  it('applies the MIN_VALUE_LEN floor to strings but not to numbers', () => {
    page('<div id="s">a</div><div id="n">7</div>')
    expect(ov.findValuesInDom('a', 'string')).toEqual([])
    expect(ids(ov.findValuesInDom('7', 'number'))).toEqual(['n'])
  })
})

describe('findValuesInDom — text matching', () => {
  it('matches an exact text node', () => {
    page('<div id="hit">hello</div><div id="miss">other</div>')
    expect(ids(ov.findValuesInDom('hello', 'string'))).toEqual(['hit'])
  })

  it('matches case-insensitively on the whole text node', () => {
    page('<div id="hit">HELLO</div>')
    expect(ids(ov.findValuesInDom('hello', 'string'))).toEqual(['hit'])
  })

  it('only does substring matching once the value reaches MIN_SUBSTRING_LEN', () => {
    page('<div id="a">xxabcxx</div>')
    expect(ov.findValuesInDom('abc', 'string')).toEqual([])   // 3 chars — exact only
    expect(ids(ov.findValuesInDom('abcx', 'string'))).toEqual(['a'])
  })

  it('skips script, style and noscript content', () => {
    page('<script>needle</script><style>needle</style><noscript>needle</noscript><div id="ok">needle</div>')
    expect(ids(ov.findValuesInDom('needle', 'string'))).toEqual(['ok'])
  })

  it('returns the parent element of each matching text node, deduplicated', () => {
    page('<div id="one">needle</div><div id="two">needle</div>')
    expect(ids(ov.findValuesInDom('needle', 'string'))).toEqual(['one', 'two'])
  })

  it('matches numbers by normalized value rather than substring', () => {
    page('<div id="a">1,234</div><div id="b">12345</div>')
    expect(ids(ov.findValuesInDom('1234', 'number'))).toEqual(['a'])
  })
})

describe('findValuesInDom — inputs and URLs', () => {
  it('matches the value of inputs and textareas', () => {
    page('<input id="i" value="secret-token"><textarea id="t">secret-token</textarea>')
      // jsdom needs the property set, not just the attribute
    ;(document.getElementById('i') as HTMLInputElement).value = 'secret-token'
    ;(document.getElementById('t') as HTMLTextAreaElement).value = 'secret-token'
    expect(ids(ov.findValuesInDom('secret-token', 'string'))).toContain('i')
  })

  it('matches url-like values against src/href attributes', () => {
    page('<img id="img" src="https://cdn.example.com/a.png"><a id="link" href="/docs/page">x</a>')
    expect(ids(ov.findValuesInDom('https://cdn.example.com/a.png', 'string'))).toContain('img')
    expect(ids(ov.findValuesInDom('/docs/page', 'string'))).toContain('link')
  })

  it('does not scan src/href for values that are not url-like', () => {
    page('<img id="img" src="https://cdn.example.com/needle.png">')
    expect(ov.findValuesInDom('needle', 'string')).toEqual([])
  })

  it('caps results at MAX_VALUE_HIGHLIGHTS', () => {
    page(Array.from({ length: 60 }, (_, i) => `<div id="d${i}">needle</div>`).join(''))
    expect(ov.findValuesInDom('needle', 'string')).toHaveLength(50)
  })
})

describe('findMultipleValuesInDom', () => {
  it('returns nothing for an empty query list', () => {
    page('<div id="a">x</div>')
    expect(ov.findMultipleValuesInDom([])).toEqual([])
  })

  it('matches any of the supplied terms', () => {
    page('<div id="a">alpha</div><div id="b">bravo</div><div id="c">charlie</div>')
    expect(ids(ov.findMultipleValuesInDom([
      { value: 'alpha', kind: 'string' },
      { value: 'charlie', kind: 'string' },
    ]))).toEqual(['a', 'c'])
  })

  it('deduplicates identical kind+value queries', () => {
    page('<div id="a">alpha</div>')
    expect(ids(ov.findMultipleValuesInDom([
      { value: 'alpha', kind: 'string' },
      { value: 'alpha', kind: 'string' },
    ]))).toEqual(['a'])
  })

  it('treats the same value under different kinds as distinct terms', () => {
    page('<div id="n">42</div>')
    const out = ov.findMultipleValuesInDom([
      { value: '42', kind: 'number' },
      { value: '42', kind: 'string' },
    ])
    expect(ids(out)).toEqual(['n'])
  })

  it('records each element once even when several terms match it', () => {
    page('<div id="a">alpha bravo</div>')
    expect(ids(ov.findMultipleValuesInDom([
      { value: 'alpha', kind: 'string' },
      { value: 'bravo', kind: 'string' },
    ]))).toEqual(['a'])
  })

  it('applies the substring floor per term, unlike findValuesInDom', () => {
    // findMultipleValuesInDom has no MIN_VALUE_LEN guard, so a short term still
    // matches an exactly-equal text node.
    page('<div id="a">ab</div><div id="b">xxabxx</div>')
    expect(ids(ov.findMultipleValuesInDom([{ value: 'ab', kind: 'string' }]))).toEqual(['a'])
  })

  it('matches number terms by normalized value', () => {
    page('<div id="a">1,234</div>')
    expect(ids(ov.findMultipleValuesInDom([{ value: '1234', kind: 'number' }]))).toEqual(['a'])
  })

  it('skips script, style and noscript content', () => {
    page('<script>needle</script><div id="ok">needle</div>')
    expect(ids(ov.findMultipleValuesInDom([{ value: 'needle', kind: 'string' }]))).toEqual(['ok'])
  })

  it('caps results at MAX_VALUE_HIGHLIGHTS', () => {
    page(Array.from({ length: 60 }, (_, i) => `<div id="d${i}">needle</div>`).join(''))
    expect(ov.findMultipleValuesInDom([{ value: 'needle', kind: 'string' }])).toHaveLength(50)
  })
})
