import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { vi } from 'vitest'

// src/ is compiled with `module: "None"`, so nothing is importable. The manifest
// loads dist/sitemap.js and dist/content.js into one shared content-script scope,
// in that order — so the tests concatenate them the same way and evaluate the
// result inside jsdom. `new Function` gives the scripts their own scope and the
// appended return closes over every top-level binding we want to assert on.
//
// Consequence: these run against the code the extension actually ships, but they
// need `tsc` to have run first.

const SOURCE_FILES = ['../dist/sitemap.js', '../dist/content.js']

const EXPORTED = [
  'smTemplatizeSegment', 'smTemplatizePath', 'smQuerySig', 'smRouteKey',
  'smParseEndpoint', 'smRegistrableDomain', 'smIsFirstParty', 'smIsDeniedPath',
  'smNormalizeCandidate', 'smScanJs', 'smExtractFromHtml', 'smExtractLinks',
  'smParseSitemapXml', 'smParseRobotsSitemaps', 'smParseOpenApi',
  'smEnsurePage', 'smAddCandidates', 'smFoldRequest', 'smCollapseSharedInferred',
  'smGroupByHost', 'smSiteMapHtml', 'smEndpointRowHtml', 'smToMarkdown', 'smReset',
  'smPages', 'smDeclared', 'smShared', 'smExpandedPages', 'smExpandedHosts',
] as const

export type SiteMapApi = Record<(typeof EXPORTED)[number], any>

/** A chrome mock complete enough for content.ts's top-level side effects. */
function makeChromeMock() {
  const local: Record<string, unknown> = {}
  return {
    runtime: {
      id: 'mock-id',
      lastError: undefined as { message: string } | undefined,
      getURL: vi.fn((p: string) => `chrome-extension://mock-id/${p}`),
      sendMessage: vi.fn((_msg: unknown, cb?: (r: unknown) => void) => {
        if (typeof cb === 'function') cb({ ok: true, reqs: [] })
      }),
      onMessage: { addListener: vi.fn() },
    },
    storage: {
      local: {
        get: vi.fn((keys: unknown, cb?: (v: Record<string, unknown>) => void) => {
          const out: Record<string, unknown> = {}
          const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : []
          for (const k of list) if (k in local) out[k] = local[k]
          cb?.(out)
          return Promise.resolve(out)
        }),
        set: vi.fn((obj: Record<string, unknown>, cb?: () => void) => {
          Object.assign(local, obj)
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
    tabs: { query: vi.fn(), sendMessage: vi.fn(), create: vi.fn(), remove: vi.fn() },
  }
}

let cachedSource: string | null = null

function overlaySource(): string {
  if (cachedSource === null) {
    cachedSource = SOURCE_FILES.map(rel => {
      const path = resolve(__dirname, rel)
      try {
        return readFileSync(path, 'utf8')
      } catch {
        throw new Error(`${rel} is missing — run \`npm run build\` first (path: ${path})`)
      }
    }).join('\n;\n')
  }
  return cachedSource
}

/** Load a fresh copy of sitemap.ts + content.ts into the current jsdom document. */
export function loadSiteMap(): SiteMapApi {
  ;(globalThis as unknown as { chrome: unknown }).chrome = makeChromeMock()
  document.body.innerHTML = ''
  document.head.innerHTML = ''
  const factory = new Function(
    `${overlaySource()}\n;return { ${EXPORTED.join(', ')} };`,
  ) as () => SiteMapApi
  return factory()
}

/** Minimal captured-request shape — only the fields smFoldRequest reads. */
export function fold(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    url: 'https://api.example.com/v1/users/8821',
    method: 'GET',
    kind: 'fetch',
    status: 200,
    ts: 1_700_000_000_000,
    ms: 90,
    element: null,
    pageUrl: 'https://example.com/products/17',
    ...over,
  }
}
