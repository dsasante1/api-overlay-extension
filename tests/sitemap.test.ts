import { describe, it, expect, beforeEach } from 'vitest'
import { loadSiteMap, fold, type SiteMapApi } from './sitemap-harness'

let sm: SiteMapApi

beforeEach(() => {
  sm = loadSiteMap()
  sm.smReset()
})

describe('path templating', () => {
  it('collapses the segment shapes that identify a resource', () => {
    expect(sm.smTemplatizeSegment('8821')).toBe('{id}')
    expect(sm.smTemplatizeSegment('4f9a2c1e-1b2d-4c3f-9e8a-7d6b5c4a3f21')).toBe('{uuid}')
    expect(sm.smTemplatizeSegment('2024-11-03')).toBe('{date}')
    expect(sm.smTemplatizeSegment('a3f9c2e18b4d6072a1c5e93f')).toBe('{hash}')
    expect(sm.smTemplatizeSegment('eyJhbGciOiJIUzI1NiJ9abc')).toBe('{token}')
  })

  it('leaves real path words alone', () => {
    expect(sm.smTemplatizeSegment('users')).toBe('users')
    expect(sm.smTemplatizeSegment('v1')).toBe('v1')
    expect(sm.smTemplatizeSegment('my-first-post')).toBe('my-first-post')
  })

  it('passes through tokens that are already parameters', () => {
    expect(sm.smTemplatizeSegment('{id}')).toBe('{id}')
  })

  it('templatizes a whole path, keeping its leading slash', () => {
    expect(sm.smTemplatizePath('/api/v1/users/8821/orders')).toBe('/api/v1/users/{id}/orders')
    expect(sm.smTemplatizePath('/')).toBe('/')
  })

  it('unifies two concrete ids onto one template', () => {
    expect(sm.smTemplatizePath('/v1/users/8821'))
      .toBe(sm.smTemplatizePath('/v1/users/9134'))
  })
})

describe('query signature', () => {
  it('keeps sorted keys and drops every value', () => {
    expect(sm.smQuerySig('?q=secret&page=2')).toBe('?page&q')
  })

  it('deduplicates repeated keys', () => {
    expect(sm.smQuerySig('?tag=a&tag=b')).toBe('?tag')
  })

  it('is empty for a query-less url', () => {
    expect(sm.smQuerySig('')).toBe('')
    expect(sm.smQuerySig('?')).toBe('')
  })
})

describe('endpoint + route parsing', () => {
  it('splits an absolute url into host and template', () => {
    const p = sm.smParseEndpoint('https://api.example.com/v1/orders/42?expand=items')
    expect(p.ok).toBe(true)
    expect(p.host).toBe('api.example.com')
    expect(p.template).toBe('/v1/orders/{id}?expand')
  })

  it('rejects non-http schemes', () => {
    expect(sm.smParseEndpoint('data:text/plain,hi').ok).toBe(false)
  })

  it('drops query and hash from a page route', () => {
    expect(sm.smRouteKey('https://example.com/products/17?ref=email#reviews'))
      .toBe('/products/{id}')
  })
})

describe('first-party classification', () => {
  it('treats subdomains of the same registrable domain as first party', () => {
    expect(sm.smIsFirstParty('api.example.com', 'www.example.com')).toBe(true)
  })

  it('handles two-label public suffixes', () => {
    expect(sm.smRegistrableDomain('api.shop.co.uk')).toBe('shop.co.uk')
    expect(sm.smIsFirstParty('api.shop.co.uk', 'www.shop.co.uk')).toBe(true)
  })

  it('flags analytics and error reporting as third party', () => {
    expect(sm.smIsFirstParty('www.google-analytics.com', 'example.com')).toBe(false)
    expect(sm.smIsFirstParty('o41.ingest.sentry.io', 'example.com')).toBe(false)
  })
})

describe('deny-list', () => {
  it('refuses paths that log out or destroy something', () => {
    expect(sm.smIsDeniedPath('https://example.com/logout')).toBe(true)
    expect(sm.smIsDeniedPath('https://example.com/account/delete')).toBe(true)
    expect(sm.smIsDeniedPath('https://example.com/sign-out')).toBe(true)
    expect(sm.smIsDeniedPath('https://example.com/subscriptions/cancel')).toBe(true)
  })

  it('allows ordinary pages', () => {
    expect(sm.smIsDeniedPath('https://example.com/products/17')).toBe(false)
    expect(sm.smIsDeniedPath('https://example.com/about')).toBe(false)
  })

  it('fails closed on an unparseable url', () => {
    expect(sm.smIsDeniedPath('http://[')).toBe(true)
  })
})

describe('JS static scan', () => {
  it('picks up fetch call sites', () => {
    const found = sm.smScanJs(`await fetch('/api/v1/users')`)
    expect(found).toContainEqual({ url: '/api/v1/users', method: '?' })
  })

  it('recovers the method from axios and xhr call sites', () => {
    expect(sm.smScanJs(`axios.post('/api/orders', body)`))
      .toContainEqual({ url: '/api/orders', method: 'POST' })
    expect(sm.smScanJs(`xhr.open("PUT", "/api/cart")`))
      .toContainEqual({ url: '/api/cart', method: 'PUT' })
  })

  it('folds an unresolvable template expression to {id}', () => {
    const found = sm.smScanJs('fetch(`/v1/users/${userId}/orders`)')
    expect(found).toContainEqual({ url: '/v1/users/{id}/orders', method: '?' })
  })

  it('skips asset paths and protocol-relative urls', () => {
    const found = sm.smScanJs(`
      fetch('/static/app.js')
      fetch('//cdn.example.com/lib.js')
      fetch('/assets/logo.svg')
    `)
    expect(found).toEqual([])
  })

  it('only takes bare literals that look like API paths', () => {
    const found = sm.smScanJs(`const a = '/api/config'; const b = '/some/marketing/page';`)
    expect(found.map((c: { url: string }) => c.url)).toEqual(['/api/config'])
  })
})

describe('HTML static scan', () => {
  const base = 'https://example.com/checkout'

  it('reads form actions with their method', () => {
    const out = sm.smExtractFromHtml(
      `<form action="/api/checkout" method="post"></form>`, base)
    expect(out.candidates).toContainEqual({ url: '/api/checkout', method: 'POST' })
  })

  it('reads htmx attributes', () => {
    const out = sm.smExtractFromHtml(`<button hx-delete="/api/cart/9">x</button>`, base)
    expect(out.candidates).toContainEqual({ url: '/api/cart/9', method: 'DELETE' })
  })

  it('collects same-origin script srcs and skips cross-origin ones', () => {
    const out = sm.smExtractFromHtml(`
      <script src="/static/app.js"></script>
      <script src="https://cdn.other.com/x.js"></script>
    `, base)
    expect(out.scripts).toEqual(['https://example.com/static/app.js'])
  })

  it('scans inline scripts without executing them', () => {
    ;(globalThis as Record<string, unknown>).__smPwned = undefined
    const out = sm.smExtractFromHtml(
      `<script>globalThis.__smPwned = true; fetch('/api/inline')</script>`, base)
    expect(out.candidates).toContainEqual({ url: '/api/inline', method: '?' })
    expect((globalThis as Record<string, unknown>).__smPwned).toBeUndefined()
  })

  it('extracts same-origin links and ignores anchors and mailto', () => {
    const out = sm.smExtractFromHtml(`
      <a href="/about">a</a>
      <a href="#top">b</a>
      <a href="mailto:x@y.z">c</a>
      <a href="https://other.com/x">d</a>
    `, base)
    expect(out.links).toEqual(['https://example.com/about'])
  })
})

describe('sitemap.xml and robots.txt', () => {
  it('reads urls out of a urlset', () => {
    const { urls, sitemaps } = sm.smParseSitemapXml(
      `<urlset><url><loc>https://example.com/a</loc></url>
       <url><loc>https://example.com/b?x=1&amp;y=2</loc></url></urlset>`)
    expect(urls).toEqual(['https://example.com/a', 'https://example.com/b?x=1&y=2'])
    expect(sitemaps).toEqual([])
  })

  it('reads child documents out of a sitemap index', () => {
    const { urls, sitemaps } = sm.smParseSitemapXml(
      `<sitemapindex><sitemap><loc>https://example.com/sitemap-1.xml</loc></sitemap></sitemapindex>`)
    expect(sitemaps).toEqual(['https://example.com/sitemap-1.xml'])
    expect(urls).toEqual([])
  })

  it('finds Sitemap directives in robots.txt', () => {
    expect(sm.smParseRobotsSitemaps(
      'User-agent: *\nDisallow: /admin\nSitemap: https://example.com/sitemap.xml\n'))
      .toEqual(['https://example.com/sitemap.xml'])
  })
})

describe('OpenAPI', () => {
  it('expands paths × verbs and applies the v3 server prefix', () => {
    const out = sm.smParseOpenApi({
      servers: [{ url: 'https://api.example.com/v2' }],
      paths: { '/users': { get: {}, post: {}, parameters: [] } },
    })
    expect(out).toEqual([
      { url: 'https://api.example.com/v2/users', method: 'GET' },
      { url: 'https://api.example.com/v2/users', method: 'POST' },
    ])
  })

  it('applies the Swagger 2 basePath', () => {
    const out = sm.smParseOpenApi({ basePath: '/api', paths: { '/ping': { get: {} } } })
    expect(out).toEqual([{ url: '/api/ping', method: 'GET' }])
  })

  it('returns nothing for a document with no paths', () => {
    expect(sm.smParseOpenApi({ openapi: '3.1.0' })).toEqual([])
    expect(sm.smParseOpenApi(null)).toEqual([])
  })
})

describe('folding captured requests', () => {
  it('files an endpoint under the templatized route of its page', () => {
    sm.smFoldRequest(fold())
    const page = sm.smPages.get('/products/{id}')
    expect(page).toBeDefined()
    expect(page.scanned).toBe(true)
    expect([...page.endpoints.keys()]).toEqual(['GET api.example.com/v1/users/{id}'])
  })

  it('counts a request once even though capture emits several times', () => {
    const r = fold()
    sm.smFoldRequest(r)
    sm.smFoldRequest(r)   // the resBody emit for the same request
    const ep = sm.smPages.get('/products/{id}').endpoints.get('GET api.example.com/v1/users/{id}')
    expect(ep.count).toBe(1)
  })

  it('merges two calls to the same endpoint from different ids', () => {
    sm.smFoldRequest(fold({ id: 1, url: 'https://api.example.com/v1/users/1' }))
    sm.smFoldRequest(fold({ id: 2, url: 'https://api.example.com/v1/users/2' }))
    const ep = sm.smPages.get('/products/{id}').endpoints.get('GET api.example.com/v1/users/{id}')
    expect(ep.count).toBe(2)
  })

  it('ignores a pending request', () => {
    sm.smFoldRequest(fold({ status: 'pending' }))
    expect(sm.smPages.size).toBe(0)
  })

  it('records the trigger element and marks the endpoint interactive', () => {
    sm.smFoldRequest(fold({ element: { selector: '#buy', label: 'Buy now' } }))
    const ep = sm.smPages.get('/products/{id}').endpoints.get('GET api.example.com/v1/users/{id}')
    expect(ep.interactive).toBe(true)
    expect(ep.triggers.get('#buy')).toBe('Buy now')
  })

  it('upgrades a static guess to observed and drops the methodless row', () => {
    const page = sm.smEnsurePage('/products/{id}', 'https://example.com/products/17', 'link')
    sm.smAddCandidates(page, [{ url: 'https://api.example.com/v1/users/{id}', method: '?' }], 'inferred')
    expect(page.endpoints.has('? api.example.com/v1/users/{id}')).toBe(true)

    sm.smFoldRequest(fold())
    expect(page.endpoints.has('? api.example.com/v1/users/{id}')).toBe(false)
    expect(page.endpoints.get('GET api.example.com/v1/users/{id}').tier).toBe('observed')
  })

  it('never lets a static guess overwrite something already observed', () => {
    sm.smFoldRequest(fold())
    const page = sm.smPages.get('/products/{id}')
    sm.smAddCandidates(page, [{ url: 'https://api.example.com/v1/users/{id}', method: 'POST' }], 'inferred')
    expect(page.endpoints.size).toBe(1)
    expect(page.endpoints.get('GET api.example.com/v1/users/{id}').tier).toBe('observed')
  })
})

describe('shared-bundle collapse', () => {
  function inferredPage(route: string, urls: string[]): void {
    const page = sm.smEnsurePage(route, `https://example.com${route}`, 'link')
    page.inferred = true
    sm.smAddCandidates(page, urls.map(u => ({ url: u, method: '?' })), 'inferred')
  }

  it('moves endpoints found on most pages into the shared group', () => {
    for (const r of ['/a', '/b', '/c', '/d']) {
      inferredPage(r, ['https://example.com/api/telemetry', `https://example.com/api${r}`])
    }
    sm.smCollapseSharedInferred()

    expect([...sm.smShared.keys()]).toEqual(['? example.com/api/telemetry'])
    for (const r of ['/a', '/b', '/c', '/d']) {
      const keys = [...sm.smPages.get(r).endpoints.keys()]
      expect(keys).toEqual([`? example.com/api${r}`])
    }
  })

  it('leaves a small map alone', () => {
    inferredPage('/a', ['https://example.com/api/x'])
    inferredPage('/b', ['https://example.com/api/x'])
    sm.smCollapseSharedInferred()
    expect(sm.smShared.size).toBe(0)
  })

  it('never touches observed pages', () => {
    for (const r of ['/a', '/b', '/c', '/d']) {
      sm.smFoldRequest(fold({ pageUrl: `https://example.com${r}`, url: 'https://example.com/api/telemetry' }))
    }
    sm.smCollapseSharedInferred()
    expect(sm.smShared.size).toBe(0)
    expect(sm.smPages.get('/a').endpoints.size).toBe(1)
  })
})

describe('host grouping', () => {
  it('splits first party from third party and orders third parties by size', () => {
    const page = sm.smEnsurePage('/', 'https://example.com/', 'visited')
    sm.smAddCandidates(page, [
      { url: 'https://example.com/api/a', method: 'GET' },
      { url: 'https://www.google-analytics.com/collect', method: 'POST' },
      { url: 'https://o1.ingest.sentry.io/envelope', method: 'POST' },
      { url: 'https://o1.ingest.sentry.io/store', method: 'POST' },
    ], 'inferred')

    const { first, third } = sm.smGroupByHost([...page.endpoints.values()], 'example.com')
    expect(first.map((e: { host: string }) => e.host)).toEqual(['example.com'])
    expect(third.map((g: { host: string }) => g.host))
      .toEqual(['o1.ingest.sentry.io', 'www.google-analytics.com'])
  })

  it('collapses per-id third-party beacons into one row', () => {
    const page = sm.smEnsurePage('/', 'https://example.com/', 'visited')
    sm.smAddCandidates(page, [
      { url: 'https://beacon.example.net/1', method: 'POST' },
      { url: 'https://beacon.example.net/2', method: 'POST' },
    ], 'inferred')
    expect(page.endpoints.size).toBe(1)
    expect([...page.endpoints.keys()]).toEqual(['POST beacon.example.net/{id}'])
  })
})

describe('output', () => {
  it('renders an empty state before a map has been built', () => {
    expect(sm.smSiteMapHtml()).toContain('No site map yet')
  })

  it('renders a page row with its endpoint count', () => {
    sm.smFoldRequest(fold())
    const html = sm.smSiteMapHtml()
    expect(html).toContain('/products/{id}')
    expect(html).toContain('visited')
  })

  // jsdom serves pages from localhost, so api.example.com counts as third party
  // — the rows only appear once both the page and that host group are open.
  it('keeps endpoint rows collapsed until the page is expanded', () => {
    sm.smFoldRequest(fold())
    expect(sm.smSiteMapHtml()).not.toContain('ov-sm-ep')

    sm.smExpandedPages.add('/products/{id}')
    const collapsed = sm.smSiteMapHtml()
    expect(collapsed).toContain('third-party')
    expect(collapsed).not.toContain('ov-sm-ep')

    sm.smExpandedHosts.add('/products/{id} api.example.com')
    expect(sm.smSiteMapHtml()).toContain('/v1/users/{id}')
  })

  it('marks each row with the tier it was learned at', () => {
    sm.smFoldRequest(fold())
    const page = sm.smPages.get('/products/{id}')
    sm.smAddCandidates(page, [{ url: 'https://api.example.com/v1/guess', method: '?' }], 'inferred')

    const observed = sm.smEndpointRowHtml(
      page.endpoints.get('GET api.example.com/v1/users/{id}'), '/products/{id}')
    const inferred = sm.smEndpointRowHtml(
      page.endpoints.get('? api.example.com/v1/guess'), '/products/{id}')
    expect(observed).toContain('ov-tier-observed')
    expect(inferred).toContain('ov-tier-inferred')
  })

  it('cannot inject markup through a captured url', () => {
    sm.smFoldRequest(fold({ url: 'https://api.example.com/a<img src=x onerror=alert(1)>' }))
    const ep = [...sm.smPages.get('/products/{id}').endpoints.values()][0]
    const html = sm.smEndpointRowHtml(ep, '/products/{id}')
    // URL parsing percent-encodes the angle brackets before escHtml even runs;
    // either layer alone is enough, so assert the outcome rather than the escape.
    expect(html).not.toContain('<img')
    expect(html).toContain('%3Cimg')
  })

  it('escapes markup that reaches the page header unencoded', () => {
    const page = sm.smEnsurePage('/x', 'https://example.com/x', 'link')
    page.error = '<img src=x onerror=alert(1)>'
    const html = sm.smSiteMapHtml()
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('exports markdown carrying the tier of every endpoint', () => {
    sm.smFoldRequest(fold())
    const md = sm.smToMarkdown()
    expect(md).toContain('# API site map')
    expect(md).toContain('/products/{id}')
    expect(md).toContain('_observed_')
  })
})
