/// <reference types="chrome" />

// ── Site map ─────────────────────────────────────────────────────────────────
//
// Builds a two-level map of the site: pages → the API endpoints each page uses.
//
// Every endpoint records the tier it was learned at, because the three sources
// differ enormously in what they can be trusted to say:
//
//   observed  The capture hook watched the call run. Carries method, status,
//             latency and the DOM element that triggered it. Only available for
//             pages that were actually loaded — that is the whole cost.
//   declared  Read out of an OpenAPI/Swagger document the site publishes. Real
//             methods and real paths, but no page attribution at all, so these
//             are filed under the site rather than under any one page.
//   inferred  Pulled out of a page's HTML and its JS bundles *without executing
//             them* — one fetch per page, no navigation, no side effects. These
//             are candidates, not facts: computed URLs don't resolve, dead code
//             and vendored SDK constants show up as false positives, and a
//             shared SPA bundle would otherwise attribute every route's calls to
//             every page (see smCollapseSharedInferred for that last one).
//
// Loaded as a separate content script *before* content.ts. tsconfig uses
// `module: "None"`, so there are no imports here and every declaration shares
// one global scope with content.ts — hence the Sm prefix on all of them, the
// same convention background.ts uses with Bg.

type SmTier = 'observed' | 'declared' | 'inferred';
type SmPageSource = 'visited' | 'link' | 'sitemap';

interface SmCandidate { url: string; method: string }

interface SmEndpoint {
  key: string;
  method: string;            // '?' when the source can't reveal one
  host: string;
  template: string;
  tier: SmTier;
  count: number;
  statuses: Record<string, number>;
  msTotal: number;
  msCount: number;
  interactive: boolean;      // at least one call came from a user interaction
  triggers: Map<string, string>;   // selector → label
  reqIds: number[];          // ids in the live log, for click-through
}

interface SmPage {
  route: string;             // templatized pathname — the map's key
  url: string;               // a representative concrete URL
  source: SmPageSource;
  scanned: boolean;          // has runtime-observed data
  inferred: boolean;         // the static pass has run
  error: string;
  endpoints: Map<string, SmEndpoint>;
  observedSigs: Set<string>; // `${host}${template}` seen at runtime
}

// A single request/response pair, as much of one as any source can supply.
interface SmFoldable {
  id?: number;
  url: string;
  method?: string;
  status?: RequestStatus;
  kind?: string;
  ms?: number;
  element?: ElementInfo | null;
  pageUrl?: string;
}

const SM_MAX_PAGES = 300;
const SM_MAX_ENDPOINTS_PER_PAGE = 200;
const SM_MAX_SCRIPTS_PER_PAGE = 12;
const SM_MAX_FETCH_BYTES = 3_000_000;
const SM_MAX_CANDIDATES_PER_SOURCE = 200;
const SM_FETCH_TIMEOUT_MS = 8_000;
const SM_INFER_CONCURRENCY = 4;
const SM_SITEMAP_MAX_DOCS = 5;
const SM_SHARED_BUNDLE_RATIO = 0.6;

const smPages = new Map<string, SmPage>();
const smDeclared = new Map<string, SmEndpoint>();
// Inferred endpoints that turned up on most pages — almost always a shared SPA
// bundle rather than something each page genuinely calls.
const smShared = new Map<string, SmEndpoint>();
// Scanned once, reused across pages: SPA bundles are shared by every route.
const smScriptCache = new Map<string, SmCandidate[]>();

let smBuilding = false;
let smAbort = false;
let smBuiltAt = 0;
let smStatus = '';
// Build progress as a fraction, or -1 while the work is unbounded (discovery and
// doc-reading have no denominator until the page list is known).
let smProgress = -1;
let smScanningRoute = '';
// UI expansion state, keyed by route / `${route} ${host}`.
const smExpandedPages = new Set<string>();
const smExpandedHosts = new Set<string>();
// Set when this tab was opened by the background scanner: capture, render nothing.
let smCaptureOnly = false;

// ── URL normalization ─────────────────────────────────────────────────────────

const SM_RE_NUM = /^\d+$/;
const SM_RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SM_RE_DATE = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?$/;
const SM_RE_HEX = /^[0-9a-f]{24,}$/i;
// Long, mixed alphanumeric: session ids, signed tokens, content hashes.
const SM_RE_TOKEN = /^(?=[\s\S]*\d)(?=[\s\S]*[a-zA-Z])[A-Za-z0-9_-]{20,}$/;

function smTemplatizeSegment(seg: string): string {
  if (!seg) return seg;
  // Already a template parameter — from an OpenAPI path or a `${…}` expression.
  if (seg.startsWith('{') && seg.endsWith('}')) return seg;
  if (SM_RE_NUM.test(seg)) return '{id}';
  if (SM_RE_UUID.test(seg)) return '{uuid}';
  if (SM_RE_DATE.test(seg)) return '{date}';
  // Before {token}: an all-hex digest satisfies the token pattern too.
  if (SM_RE_HEX.test(seg)) return '{hash}';
  if (SM_RE_TOKEN.test(seg)) return '{token}';
  return seg;
}

function smTemplatizePath(pathname: string): string {
  // split('/') puts a leading '' before the first segment — keep it so the
  // rejoined path keeps its leading slash.
  return pathname.split('/').map((seg, i) => i === 0 ? seg : smTemplatizeSegment(seg)).join('/');
}

// Query *keys* identify an endpoint; query values are unbounded noise, and in an
// exported map they leak session state. Keep the sorted key set only.
function smQuerySig(search: string): string {
  if (!search || search === '?') return '';
  const keys: string[] = [];
  try {
    for (const k of new URLSearchParams(search).keys()) {
      if (keys.indexOf(k) < 0) keys.push(k);
    }
  } catch { return ''; }
  if (!keys.length) return '';
  keys.sort();
  return `?${keys.join('&')}`;
}

interface SmParsedUrl { host: string; template: string; ok: boolean }

// new URL() percent-encodes braces, so an OpenAPI path (/users/{id}) or a
// candidate folded from `${userId}` would come back as /users/%7Bid%7D and never
// line up with the {id} the runtime templater emits — which is the whole point of
// putting all three tiers in one map. Put the braces back before templatizing.
function smRestoreBraces(path: string): string {
  return path.replace(/%7B/gi, '{').replace(/%7D/gi, '}');
}

function smParseEndpoint(rawUrl: string, base?: string): SmParsedUrl {
  try {
    const u = new URL(rawUrl, base ?? location.href);
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'ws:' && u.protocol !== 'wss:') {
      return { host: '', template: '', ok: false };
    }
    return {
      host: u.host,
      template: smTemplatizePath(smRestoreBraces(u.pathname)) + smQuerySig(u.search),
      ok: true,
    };
  } catch {
    return { host: '', template: '', ok: false };
  }
}

// The map's page key. Query and hash are dropped: they vary per visit without
// changing which endpoints the route uses.
function smRouteKey(rawUrl: string): string {
  try {
    return smTemplatizePath(smRestoreBraces(new URL(rawUrl, location.href).pathname)) || '/';
  } catch {
    return '/';
  }
}

// No Public Suffix List — shipping one would dwarf the extension. This handles
// the common two-label suffixes and otherwise assumes eTLD+1 is the last two
// labels, which misgroups a handful of exotic domains into "third party".
const SM_TWO_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  'co.nz', 'co.za', 'co.in', 'co.kr', 'co.id', 'co.th',
  'com.br', 'com.mx', 'com.ar', 'com.sg', 'com.tr', 'com.cn', 'com.hk', 'com.tw',
]);

function smRegistrableDomain(host: string): string {
  const parts = host.toLowerCase().replace(/\.+$/, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  const last2 = parts.slice(-2).join('.');
  return SM_TWO_PART_TLDS.has(last2) ? parts.slice(-3).join('.') : last2;
}

function smIsFirstParty(host: string, pageHost: string): boolean {
  if (!host) return true;
  const a = host.split(':')[0];
  const b = pageHost.split(':')[0];
  return smRegistrableDomain(a) === smRegistrableDomain(b);
}

// Paths we refuse to fetch or navigate. A GET to /logout still logs the user out
// even though no JS runs, so this guards the static pass as well as the scanner.
const SM_DENY_RE = /(?:^|\/)(?:log-?out|sign-?out|delete|destroy|remove|revoke|deactivate|unsubscribe|cancel|purge|reset|logoff|exit)(?:\/|$)/i;

function smIsDeniedPath(rawUrl: string): boolean {
  try {
    return SM_DENY_RE.test(new URL(rawUrl, location.href).pathname);
  } catch {
    return true;   // unparseable → refuse to touch it
  }
}

// ── Candidate extraction ──────────────────────────────────────────────────────

const SM_ASSET_RE = /\.(?:js|mjs|cjs|jsx|tsx?|css|scss|less|png|jpe?g|gif|svg|webp|avif|ico|bmp|woff2?|ttf|otf|eot|map|mp4|webm|ogg|mp3|wav|pdf|zip|gz|txt|md|html?|xml|csv)(?:$|[?#])/i;
const SM_APIISH_RE = /(?:^|\/)(?:api|apis|v[0-9]+|rest|graphql|gql|rpc|ajax|service|services|endpoints?|internal|_next\/data|wp-json)(?:\/|$)/i;
const SM_HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

// `${expr}` in a template literal is a path parameter we can't resolve. Fold it
// to {id} — the same token the runtime templater emits for a numeric segment —
// so a statically guessed /v1/users/${userId} lines up with an observed
// /v1/users/8821 instead of sitting beside it as a near-duplicate row.
function smNormalizeCandidate(raw: string): string {
  return raw.trim().replace(/\$\{[^}]*\}/g, '{id}').replace(/:[A-Za-z_][A-Za-z0-9_]*(?=\/|$)/g, '{id}');
}

function smAcceptCandidate(out: SmCandidate[], seen: Set<string>, raw: string, method: string): void {
  if (out.length >= SM_MAX_CANDIDATES_PER_SOURCE) return;
  const url = smNormalizeCandidate(raw);
  if (!url || url.length > 300) return;
  if (url.startsWith('//')) return;                    // protocol-relative — nearly always a CDN asset
  if (!/^(?:https?:\/\/|\/)/.test(url)) return;        // relative to an unknown base
  if (SM_ASSET_RE.test(url)) return;
  const key = `${method} ${url}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ url, method });
}

// Pull endpoint candidates out of JS source text. Call sites first (they carry a
// method); bare literals last and only when they look like an API path, because
// unfiltered `/`-prefixed strings in a bundle are overwhelmingly routes and asset
// paths.
function smScanJs(src: string): SmCandidate[] {
  const out: SmCandidate[] = [];
  const seen = new Set<string>();

  for (const m of src.matchAll(/\bfetch\s*\(\s*['"`]([^'"`\n]{1,300})['"`]/g)) {
    smAcceptCandidate(out, seen, m[1], '?');
  }
  for (const m of src.matchAll(/\baxios\s*\.\s*(get|post|put|patch|delete|head)\s*\(\s*['"`]([^'"`\n]{1,300})['"`]/gi)) {
    smAcceptCandidate(out, seen, m[2], m[1].toUpperCase());
  }
  for (const m of src.matchAll(/\$\s*\.\s*(get|post|getJSON)\s*\(\s*['"`]([^'"`\n]{1,300})['"`]/gi)) {
    smAcceptCandidate(out, seen, m[2], m[1].toLowerCase() === 'post' ? 'POST' : 'GET');
  }
  for (const m of src.matchAll(/\.open\s*\(\s*['"`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"`]\s*,\s*['"`]([^'"`\n]{1,300})['"`]/gi)) {
    smAcceptCandidate(out, seen, m[2], m[1].toUpperCase());
  }
  // `url:` inside an options object — axios({url}), $.ajax({url}), ky, superagent.
  for (const m of src.matchAll(/\burl\s*:\s*['"`]([^'"`\n]{1,300})['"`]/g)) {
    smAcceptCandidate(out, seen, m[1], '?');
  }
  for (const m of src.matchAll(/['"`](\/[A-Za-z0-9._~\-/{}$:]{1,200})['"`]/g)) {
    if (SM_APIISH_RE.test(m[1])) smAcceptCandidate(out, seen, m[1], '?');
  }
  return out;
}

interface SmHtmlScan { candidates: SmCandidate[]; scripts: string[]; links: string[] }

// DOMParser with 'text/html' produces an inert document: scripts do not run and
// no subresources are fetched. That is the entire safety property of the static
// pass — we read the page's markup without becoming the page.
function smExtractFromHtml(html: string, baseUrl: string): SmHtmlScan {
  const candidates: SmCandidate[] = [];
  const seen = new Set<string>();
  const scripts: string[] = [];
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return { candidates, scripts, links: [] };
  }

  for (const f of Array.from(doc.querySelectorAll('form[action]'))) {
    const action = f.getAttribute('action') ?? '';
    if (action) smAcceptCandidate(candidates, seen, action, (f.getAttribute('method') || 'GET').toUpperCase());
  }
  for (const verb of ['get', 'post', 'put', 'patch', 'delete']) {
    for (const el of Array.from(doc.querySelectorAll(`[hx-${verb}]`))) {
      const v = el.getAttribute(`hx-${verb}`) ?? '';
      if (v) smAcceptCandidate(candidates, seen, v, verb.toUpperCase());
    }
  }
  for (const attr of ['data-url', 'data-endpoint', 'data-api']) {
    for (const el of Array.from(doc.querySelectorAll(`[${attr}]`))) {
      const v = el.getAttribute(attr) ?? '';
      if (v) smAcceptCandidate(candidates, seen, v, '?');
    }
  }
  for (const s of Array.from(doc.querySelectorAll('script'))) {
    const src = s.getAttribute('src');
    if (src) {
      try {
        const u = new URL(src, baseUrl);
        if (u.origin === new URL(baseUrl).origin && scripts.indexOf(u.href) < 0) scripts.push(u.href);
      } catch { /* unparseable src */ }
      continue;
    }
    const text = s.textContent ?? '';
    if (text.length > 4) {
      for (const c of smScanJs(text)) smAcceptCandidate(candidates, seen, c.url, c.method);
    }
  }

  return { candidates, scripts, links: smExtractLinks(doc, baseUrl) };
}

function smExtractLinks(doc: Document, baseUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let origin: string;
  try { origin = new URL(baseUrl).origin; } catch { return out; }

  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    if (out.length >= SM_MAX_PAGES) break;
    const href = a.getAttribute('href') ?? '';
    if (!href || href.startsWith('#')) continue;
    if (/^(?:javascript|mailto|tel|data|blob|sms):/i.test(href)) continue;
    let u: URL;
    try { u = new URL(href, baseUrl); } catch { continue; }
    if (u.origin !== origin) continue;
    if (SM_ASSET_RE.test(u.pathname)) continue;
    const norm = u.origin + u.pathname;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

// ── sitemap.xml / robots.txt ──────────────────────────────────────────────────

const SM_XML_ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
};

function smDecodeXmlEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, m => {
    const lower = m.toLowerCase();
    if (lower in SM_XML_ENTITIES) return SM_XML_ENTITIES[lower];
    try {
      return lower.charAt(1) === '#' && lower.charAt(2) === 'x'
        ? String.fromCodePoint(parseInt(lower.slice(3, -1), 16))
        : String.fromCodePoint(Number(lower.slice(2, -1)));
    } catch {
      return m;   // out-of-range code point
    }
  });
}

// Regex rather than DOMParser: sitemap files run to megabytes and <loc> is the
// only thing we need out of them.
function smParseSitemapXml(xml: string): { urls: string[]; sitemaps: string[] } {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const urls: string[] = [];
  const sitemaps: string[] = [];
  for (const m of xml.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)) {
    const v = smDecodeXmlEntities(m[1]).trim();
    if (!v) continue;
    if (isIndex) sitemaps.push(v);
    else urls.push(v);
    if (urls.length + sitemaps.length >= SM_MAX_PAGES * 2) break;
  }
  return { urls, sitemaps };
}

function smParseRobotsSitemaps(txt: string): string[] {
  const out: string[] = [];
  for (const line of txt.split(/\r?\n/)) {
    const m = /^\s*sitemap\s*:\s*(\S+)/i.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

// ── OpenAPI ───────────────────────────────────────────────────────────────────

const SM_OPENAPI_PATHS = [
  '/openapi.json', '/swagger.json', '/api-docs', '/api-docs.json',
  '/api/openapi.json', '/api/swagger.json', '/swagger/v1/swagger.json',
  '/v1/openapi.json', '/.well-known/openapi.json',
];

function smJoinUrl(prefix: string, path: string): string {
  if (!prefix) return path;
  return prefix.replace(/\/+$/, '') + path;
}

function smParseOpenApi(doc: unknown): SmCandidate[] {
  const out: SmCandidate[] = [];
  if (!doc || typeof doc !== 'object') return out;
  const d = doc as { paths?: unknown; servers?: unknown; basePath?: unknown };
  if (!d.paths || typeof d.paths !== 'object') return out;

  // OpenAPI 3 puts the base in servers[0].url; Swagger 2 uses basePath.
  let prefix = '';
  if (Array.isArray(d.servers) && d.servers.length) {
    const first = d.servers[0] as { url?: unknown };
    if (typeof first?.url === 'string') prefix = first.url;
  } else if (typeof d.basePath === 'string') {
    prefix = d.basePath;
  }

  for (const [p, item] of Object.entries(d.paths as Record<string, unknown>)) {
    if (!p.startsWith('/')) continue;
    const joined = smJoinUrl(prefix, p);
    const verbs = (item && typeof item === 'object')
      ? Object.keys(item as Record<string, unknown>).filter(k => SM_HTTP_VERBS.has(k.toLowerCase()))
      : [];
    if (!verbs.length) { out.push({ url: joined, method: '?' }); continue; }
    for (const v of verbs) out.push({ url: joined, method: v.toUpperCase() });
  }
  return out;
}

// ── Model ─────────────────────────────────────────────────────────────────────

function smNewEndpoint(key: string, method: string, host: string, template: string, tier: SmTier): SmEndpoint {
  return {
    key, method, host, template, tier,
    count: 0, statuses: {}, msTotal: 0, msCount: 0,
    interactive: false, triggers: new Map(), reqIds: [],
  };
}

function smEnsurePage(route: string, url: string, source: SmPageSource): SmPage {
  let page = smPages.get(route);
  if (page) return page;
  page = {
    route, url, source,
    scanned: false, inferred: false, error: '',
    endpoints: new Map(), observedSigs: new Set(),
  };
  smPages.set(route, page);
  return page;
}

function smFoldInto(page: SmPage, r: SmFoldable, countIt: boolean): void {
  const parsed = smParseEndpoint(r.url);
  if (!parsed.ok) return;
  const method = (r.method || 'GET').toUpperCase();
  const sig = `${parsed.host}${parsed.template}`;
  const key = `${method} ${sig}`;

  let ep = page.endpoints.get(key);
  if (!ep) {
    if (page.endpoints.size >= SM_MAX_ENDPOINTS_PER_PAGE) return;
    ep = smNewEndpoint(key, method, parsed.host, parsed.template, 'observed');
    page.endpoints.set(key, ep);
  }
  // Seeing it run outranks anything we guessed about it.
  ep.tier = 'observed';
  page.observedSigs.add(sig);
  // Drop the methodless static guess this observation just superseded.
  if (page.endpoints.has(`? ${sig}`)) page.endpoints.delete(`? ${sig}`);

  if (countIt) {
    ep.count++;
    const bucket = statusBucket({ status: r.status ?? 'error', kind: r.kind });
    ep.statuses[bucket] = (ep.statuses[bucket] ?? 0) + 1;
    if (typeof r.ms === 'number') { ep.msTotal += r.ms; ep.msCount++; }
    if (typeof r.id === 'number' && ep.reqIds.length < 20) ep.reqIds.push(r.id);
  }
  if (r.element?.selector) {
    ep.interactive = true;
    if (ep.triggers.size < 20) ep.triggers.set(r.element.selector, r.element.label || '');
  }
}

// Called for every captured request as it reaches a terminal status. Folding at
// capture time (rather than deriving the map from `requests` on demand) is what
// lets the map outlive trimRequests() — the aggregate is one row per endpoint,
// not per call, so it stays complete long after the log has rolled over.
function smFoldRequest(r: ApiRequest): void {
  if (r.status === 'pending') return;
  const pageUrl = r.pageUrl || location.href;
  const page = smEnsurePage(smRouteKey(pageUrl), pageUrl, 'visited');
  page.scanned = true;
  const first = !r._smFolded;
  r._smFolded = true;
  smFoldInto(page, r, first);
}

function smAddCandidates(page: SmPage, cands: SmCandidate[], tier: SmTier): void {
  for (const c of cands) {
    if (page.endpoints.size >= SM_MAX_ENDPOINTS_PER_PAGE) return;
    const parsed = smParseEndpoint(c.url, page.url);
    if (!parsed.ok) continue;
    const sig = `${parsed.host}${parsed.template}`;
    const method = c.method || '?';
    // Never let a guess sit next to (or overwrite) something we actually saw.
    if (page.observedSigs.has(sig)) continue;
    const key = `${method} ${sig}`;
    if (page.endpoints.has(key)) continue;
    page.endpoints.set(key, smNewEndpoint(key, method, parsed.host, parsed.template, tier));
  }
}

// A candidate found in a bundle that nearly every page loads says something about
// the app, not about any one route. Without this the static pass reports the same
// forty endpoints on all 200 pages and the map is worthless.
function smCollapseSharedInferred(): void {
  const pages = [...smPages.values()].filter(p => p.inferred && !p.scanned);
  if (pages.length < 3) return;

  const tally = new Map<string, number>();
  for (const p of pages) {
    for (const [k, ep] of p.endpoints) {
      if (ep.tier === 'inferred') tally.set(k, (tally.get(k) ?? 0) + 1);
    }
  }

  const threshold = Math.max(3, Math.ceil(pages.length * SM_SHARED_BUNDLE_RATIO));
  for (const [k, n] of tally) {
    if (n < threshold) continue;
    for (const p of pages) {
      const ep = p.endpoints.get(k);
      if (ep?.tier !== 'inferred') continue;
      if (!smShared.has(k)) smShared.set(k, ep);
      p.endpoints.delete(k);
    }
  }
}

function smReset(): void {
  smPages.clear();
  smDeclared.clear();
  smShared.clear();
  smScriptCache.clear();
  smExpandedPages.clear();
  smExpandedHosts.clear();
  smAbort = true;
  smBuilding = false;
  smBuiltAt = 0;
  smStatus = '';
  smScanningRoute = '';
}

// ── Network helpers ───────────────────────────────────────────────────────────

// Runs in the content script's isolated world, which injected.ts never patches —
// so nothing fetched here shows up in the capture log or pollutes the map.
async function smFetchText(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SM_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { credentials: 'same-origin', signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) return null;
    const len = Number(res.headers.get('content-length') ?? '0');
    if (Number.isFinite(len) && len > SM_MAX_FETCH_BYTES) return null;
    const text = await res.text();
    return text.length > SM_MAX_FETCH_BYTES ? text.slice(0, SM_MAX_FETCH_BYTES) : text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function smPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    workers.push((async () => {
      while (cursor < items.length && !smAbort) {
        const item = items[cursor++];
        await fn(item);
      }
    })());
  }
  await Promise.all(workers);
}

// ── Build ─────────────────────────────────────────────────────────────────────

function smAddDiscovered(urls: string[], source: SmPageSource): void {
  for (const u of urls) {
    if (smPages.size >= SM_MAX_PAGES) return;
    let abs: URL;
    try { abs = new URL(u, location.href); } catch { continue; }
    if (abs.origin !== location.origin) continue;
    smEnsurePage(smRouteKey(abs.href), abs.origin + abs.pathname, source);
  }
}

async function smDiscoverFromSitemaps(): Promise<void> {
  const queue: string[] = [new URL('/sitemap.xml', location.origin).href];
  const robots = await smFetchText(new URL('/robots.txt', location.origin).href);
  if (robots) {
    for (const s of smParseRobotsSitemaps(robots)) {
      if (queue.indexOf(s) < 0) queue.push(s);
    }
  }

  const done = new Set<string>();
  let budget = SM_SITEMAP_MAX_DOCS;
  while (queue.length && budget-- > 0 && !smAbort) {
    const next = queue.shift() as string;
    if (done.has(next)) { budget++; continue; }
    done.add(next);
    const xml = await smFetchText(next);
    if (!xml) continue;
    const { urls, sitemaps } = smParseSitemapXml(xml);
    smAddDiscovered(urls, 'sitemap');
    for (const s of sitemaps) {
      if (!done.has(s) && queue.indexOf(s) < 0) queue.push(s);
    }
  }
}

async function smDiscoverDeclared(): Promise<void> {
  for (const path of SM_OPENAPI_PATHS) {
    if (smAbort) return;
    const text = await smFetchText(new URL(path, location.origin).href);
    if (!text || text.length > 4_000_000) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { continue; }
    const cands = smParseOpenApi(parsed);
    if (!cands.length) continue;
    for (const c of cands) {
      const ep = smParseEndpoint(c.url, location.origin + path);
      if (!ep.ok) continue;
      const key = `${c.method} ${ep.host}${ep.template}`;
      if (!smDeclared.has(key)) {
        smDeclared.set(key, smNewEndpoint(key, c.method, ep.host, ep.template, 'declared'));
      }
    }
    return;   // first document that parses wins; the rest are usually aliases
  }
}

async function smInferPage(page: SmPage): Promise<void> {
  page.inferred = true;
  if (smIsDeniedPath(page.url)) { page.error = 'skipped — deny-list'; return; }

  const html = await smFetchText(page.url);
  if (html == null) { page.error = 'fetch failed'; return; }

  const scan = smExtractFromHtml(html, page.url);
  smAddCandidates(page, scan.candidates, 'inferred');
  // Links found on a fetched page widen the map beyond what the live DOM showed.
  smAddDiscovered(scan.links, 'link');

  let budget = SM_MAX_SCRIPTS_PER_PAGE;
  for (const src of scan.scripts) {
    if (budget-- <= 0 || smAbort) break;
    let found = smScriptCache.get(src);
    if (!found) {
      const js = await smFetchText(src);
      found = js ? smScanJs(js) : [];
      smScriptCache.set(src, found);
    }
    smAddCandidates(page, found, 'inferred');
  }
}

function smSetStatus(text: string, progress = -1): void {
  smStatus = text;
  smProgress = progress;
  smRenderSiteMap();
}

async function smBuildMap(): Promise<void> {
  if (smBuilding) return;
  smBuilding = true;
  smAbort = false;
  smShared.clear();
  smScriptCache.clear();

  try {
    smSetStatus('discovering pages…');
    // The page we're on is already folded by the capture path; make sure it
    // exists even if it made no calls at all.
    smEnsurePage(smRouteKey(location.href), location.origin + location.pathname, 'visited');
    smAddDiscovered(smExtractLinks(document, location.href), 'link');
    await smDiscoverFromSitemaps();

    smSetStatus('reading API docs…');
    await smDiscoverDeclared();

    const targets = [...smPages.values()].filter(p => !p.scanned && !p.inferred);
    let done = 0;
    smSetStatus(`reading page source 0/${targets.length}…`, 0);
    await smPool(targets, SM_INFER_CONCURRENCY, async p => {
      await smInferPage(p);
      done++;
      smStatus = `reading page source ${done}/${targets.length}…`;
      smProgress = done / Math.max(1, targets.length);
      if (done % 4 === 0) smRenderSiteMap();
    });

    smCollapseSharedInferred();
  } finally {
    smBuilding = false;
    // A build cut short by "stop" or by Clear must not count as built, or the
    // next open would show a half-finished map instead of rebuilding.
    if (!smAbort) smBuiltAt = Date.now();
    smStatus = '';
    smProgress = -1;
    smRenderSiteMap();
  }
}

// ── Background scan (inferred → observed) ─────────────────────────────────────

function smSendMessage(msg: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(msg, (resp: Record<string, unknown> | undefined) => {
        void chrome.runtime.lastError;
        resolve(resp ?? null);
      });
    } catch {
      resolve(null);   // extension context invalidated
    }
  });
}

// A tab opened by the background scanner is one nobody will ever look at: it
// should capture normally but build no UI. Asked over the message channel rather
// than read from storage.session, which content scripts can't reach unless the
// whole session store is opened up to untrusted contexts.
async function smCheckScanTab(): Promise<void> {
  const resp = await smSendMessage({ action: 'sm-is-scan-tab' });
  smCaptureOnly = resp?.scan === true;
}

async function smScanPage(route: string): Promise<void> {
  const page = smPages.get(route);
  if (!page || smScanningRoute) return;
  if (smIsDeniedPath(page.url)) { page.error = 'skipped — deny-list'; smRenderSiteMap(); return; }

  smScanningRoute = route;
  smSetStatus(`loading ${page.route} in a background tab…`);
  try {
    const resp = await smSendMessage({ action: 'sm-scan', url: page.url });
    const reqs = Array.isArray(resp?.reqs) ? resp.reqs as SmFoldable[] : [];
    for (const r of reqs) {
      if (r && typeof r.url === 'string') smFoldInto(page, r, true);
    }
    page.scanned = true;
    page.error = reqs.length ? '' : 'no calls captured';
    smExpandedPages.add(route);
  } catch {
    page.error = 'scan failed';
  } finally {
    smScanningRoute = '';
    smSetStatus('');
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function smDominantStatus(ep: SmEndpoint): { label: string; bucket: string } {
  let best = '';
  let bestN = 0;
  for (const [b, n] of Object.entries(ep.statuses)) {
    if (n > bestN) { best = b; bestN = n; }
  }
  if (!best) return { label: '—', bucket: 'none' };
  return { label: best, bucket: best };
}

function smMeanMs(ep: SmEndpoint): string {
  if (!ep.msCount) return '';
  const mean = Math.round(ep.msTotal / ep.msCount);
  return mean < 1000 ? `${mean}ms` : `${(mean / 1000).toFixed(2)}s`;
}

function smEndpointRowHtml(ep: SmEndpoint, route: string): string {
  const status = smDominantStatus(ep);
  const sel = ep.triggers.size ? [...ep.triggers.keys()][0] : '';
  const method = ep.method === '?' ? '?' : ep.method;
  const count = ep.count > 0 ? `<span class="ov-sm-n">${ep.count}×</span>` : '';
  const statusHtml = status.label === '—'
    ? ''
    : `<span class="ov-sm-st s-${escHtml(status.bucket)}">${escHtml(status.label)}</span>`;
  const ms = smMeanMs(ep);
  return `<div class="ov-sm-ep ov-tier-${ep.tier}" data-route="${escHtml(route)}" data-key="${encodeURIComponent(ep.key)}"
      data-sel="${encodeURIComponent(sel)}" title="${escHtml(ep.host + ep.template)}">
    <span class="ov-sm-m m-${safeMethodClass(method === '?' ? 'GET' : method)}${method === '?' ? ' ov-sm-m-unk' : ''}">${escHtml(method)}</span>
    <span class="ov-sm-url">${escHtml(ep.template)}</span>
    ${ep.interactive ? '<span class="ov-sm-zap" title="triggered by a user interaction">⚡</span>' : ''}
    ${count}${statusHtml}<span class="ov-sm-ms">${escHtml(ms)}</span>
  </div>`;
}

interface SmHostGroup { host: string; eps: SmEndpoint[] }

function smGroupByHost(eps: SmEndpoint[], pageHost: string): { first: SmEndpoint[]; third: SmHostGroup[] } {
  const first: SmEndpoint[] = [];
  const byHost = new Map<string, SmEndpoint[]>();
  for (const ep of eps) {
    if (smIsFirstParty(ep.host, pageHost)) { first.push(ep); continue; }
    let list = byHost.get(ep.host);
    if (!list) { list = []; byHost.set(ep.host, list); }
    list.push(ep);
  }
  const cmp = (a: SmEndpoint, b: SmEndpoint): number =>
    a.template === b.template ? a.method.localeCompare(b.method) : a.template.localeCompare(b.template);
  first.sort(cmp);
  const third = [...byHost.entries()]
    .map(([host, list]) => ({ host, eps: list.sort(cmp) }))
    .sort((a, b) => b.eps.length - a.eps.length);
  return { first, third };
}

function smThirdPartyHtml(groups: SmHostGroup[], route: string): string {
  let html = '';
  for (const g of groups) {
    const key = `${route} ${g.host}`;
    const open = smExpandedHosts.has(key);
    html += `<div class="ov-sm-tp${open ? ' open' : ''}" data-route="${escHtml(route)}" data-host="${escHtml(g.host)}">
      <span class="ov-sm-caret">${open ? '▾' : '▸'}</span>
      <span class="ov-sm-tp-host">${escHtml(g.host)}</span>
      <span class="ov-sm-tp-tag">third-party</span>
      <span class="ov-sm-n">${g.eps.length}</span>
    </div>`;
    if (open) html += g.eps.map(ep => smEndpointRowHtml(ep, route)).join('');
  }
  return html;
}

function smPageHtml(page: SmPage): string {
  const open = smExpandedPages.has(page.route);
  const eps = [...page.endpoints.values()];
  let badge = '<span class="ov-sm-badge">not scanned</span>';
  if (page.scanned) badge = '<span class="ov-sm-badge ov-sm-badge-obs">visited</span>';
  else if (page.inferred) badge = '<span class="ov-sm-badge ov-sm-badge-inf">inferred</span>';
  const err = page.error ? `<span class="ov-sm-err">${escHtml(page.error)}</span>` : '';
  const scanning = smScanningRoute === page.route;
  // Routes that look destructive are never loaded, so say so where the scan
  // control would otherwise be rather than refusing after the click.
  const denied = smIsDeniedPath(page.url);
  let scanBtn = '';
  if (denied) {
    scanBtn = '<span class="ov-sm-shield" data-tip="Logout, delete and reset routes are never loaded" data-tip-align="right">🛡 never scanned</span>';
  } else if (!page.scanned) {
    scanBtn = `<button class="ov-sm-scan" data-route="${escHtml(page.route)}"${scanning || smScanningRoute ? ' disabled' : ''}
        data-tip="Load this page in a background tab and capture its real calls" data-tip-align="right">${scanning ? '…' : 'scan'}</button>`;
  }

  let body = '';
  if (open) {
    if (!eps.length) {
      body = `<div class="ov-sm-none">${page.inferred || page.scanned ? 'no endpoints found' : 'not scanned yet'}</div>`;
    } else {
      const { first, third } = smGroupByHost(eps, location.hostname);
      body = first.map(ep => smEndpointRowHtml(ep, page.route)).join('') + smThirdPartyHtml(third, page.route);
    }
  }

  return `<div class="ov-sm-page">
    <div class="ov-sm-phead" data-route="${escHtml(page.route)}">
      <span class="ov-sm-caret">${open ? '▾' : '▸'}</span>
      <span class="ov-sm-route">${escHtml(middleTruncate(page.route, 52))}</span>
      ${badge}${err}
      <span class="ov-sm-spacer"></span>
      <span class="ov-sm-n">${eps.length}</span>
      ${scanBtn}
    </div>
    ${body}
  </div>`;
}

function smSiteGroupHtml(id: string, title: string, tip: string, eps: SmEndpoint[]): string {
  if (!eps.length) return '';
  const open = smExpandedPages.has(id);
  const sorted = [...eps].sort((a, b) =>
    a.template === b.template ? a.method.localeCompare(b.method) : a.template.localeCompare(b.template));
  return `<div class="ov-sm-page ov-sm-sitewide">
    <div class="ov-sm-phead" data-route="${escHtml(id)}">
      <span class="ov-sm-caret">${open ? '▾' : '▸'}</span>
      <span class="ov-sm-route">${escHtml(title)}</span>
      <span class="ov-sm-badge">${escHtml(tip)}</span>
      <span class="ov-sm-spacer"></span>
      <span class="ov-sm-n">${sorted.length}</span>
    </div>
    ${open ? sorted.map(ep => smEndpointRowHtml(ep, id)).join('') : ''}
  </div>`;
}

function smCountEndpoints(): number {
  let n = smDeclared.size + smShared.size;
  for (const p of smPages.values()) n += p.endpoints.size;
  return n;
}

// Endpoints per confidence tier, for the legend's running totals.
function smTierCounts(): { observed: number; declared: number; inferred: number } {
  const out = { observed: 0, declared: 0, inferred: 0 };
  for (const page of smPages.values()) {
    for (const ep of page.endpoints.values()) out[ep.tier]++;
  }
  for (const ep of smDeclared.values()) out[ep.tier]++;
  for (const ep of smShared.values()) out[ep.tier]++;
  return out;
}

function smSiteMapHtml(): string {
  const pages = [...smPages.values()].sort((a, b) => {
    // Visited pages first — they're the ones with real data.
    if (a.scanned !== b.scanned) return a.scanned ? -1 : 1;
    return a.route.localeCompare(b.route);
  });

  const bar = `<div class="ov-sm-bar">
    <span class="ov-sm-title">site map</span>
    <span class="ov-sm-meta">${smPages.size} pages · ${smCountEndpoints()} endpoints</span>
    <span class="ov-sm-spacer"></span>
    ${smBuilding
      ? '<button class="ov-sm-act ov-sm-act-stop" data-act="stop">■ stop</button>'
      : '<button class="ov-sm-act" data-act="rebuild" data-tip="Re-run discovery" data-tip-pos="above">↻ rebuild</button>'}
    <button class="ov-sm-act" data-act="export" data-tip="Export as Markdown" data-tip-pos="above">↓ md</button>
    <button class="ov-sm-act" data-act="close" data-tip="Back to the request log" data-tip-pos="above" data-tip-align="right">← log</button>
  </div>`;

  const tiers = smTierCounts();
  const legend = `<div class="ov-sm-legend">
    <span class="ov-sm-tier ov-tier-observed"><i class="ov-sm-sw"></i>observed <b>${tiers.observed}</b></span>
    <span class="ov-sm-tier ov-tier-declared"><i class="ov-sm-sw"></i>declared <b>${tiers.declared}</b></span>
    <span class="ov-sm-tier ov-tier-inferred"><i class="ov-sm-sw"></i>inferred <b>${tiers.inferred}</b></span>
    <span class="ov-sm-spacer"></span>
    <span class="ov-sm-legend-note">inferred rows are candidates — click scan to verify</span>
  </div>`;

  // While building: a spinner, the current step, and a determinate track once the
  // page list gives the work a denominator.
  const status = smStatus ? `<div class="ov-sm-status">
      <div class="ov-sm-status-line">
        ${smBuilding ? '<span class="ov-sm-spin"></span>' : ''}
        <span class="ov-sm-status-text">${escHtml(smStatus)}</span>
      </div>
      ${smProgress >= 0
        ? `<div class="ov-sm-track"><div class="ov-sm-fill" style="width:${Math.round(smProgress * 100)}%"></div></div>`
        : ''}
    </div>` : '';

  if (!pages.length && !smBuilding) {
    return `${bar}<div class="ov-empty">No site map yet.<br><small>Click ⊞ map in the header to build one.</small></div>`;
  }

  // Sentinel ids for the two site-level groups. They share the expansion state
  // and click handling of a page row, so they need keys a real route can never
  // collide with — every route starts with '/'.
  const sitewide =
    smSiteGroupHtml('@declared', 'declared API surface', 'openapi', [...smDeclared.values()]) +
    smSiteGroupHtml('@shared', 'shared app bundle', 'all pages', [...smShared.values()]);

  return bar + legend + status + sitewide + pages.map(p => smPageHtml(p)).join('');
}

// The overlay owns which view is showing (log / pinned / map) and writes #ov-list
// itself, so the map only asks for a re-render and lets renderList() pull the
// HTML back out of smSiteMapHtml(). One writer for the list, one for the count.
function smRenderSiteMap(): void {
  if (!siteMapVisible()) return;
  renderList();
}

// ── Markdown export ───────────────────────────────────────────────────────────

function smEndpointMd(ep: SmEndpoint): string {
  const bits = [`${ep.method} ${ep.host}${ep.template}`];
  if (ep.count) bits.push(`${ep.count}×`);
  const st = smDominantStatus(ep);
  if (st.label !== '—') bits.push(st.label);
  const ms = smMeanMs(ep);
  if (ms) bits.push(ms);
  bits.push(`_${ep.tier}_`);
  if (ep.interactive) bits.push('⚡');
  return `  - ${bits.join(' · ')}`;
}

function smToMarkdown(): string {
  const lines: string[] = [
    `# API site map — ${location.hostname}`,
    '',
    `Generated ${new Date().toISOString()} · ${smPages.size} pages · ${smCountEndpoints()} endpoints`,
    '',
    'Tiers: **observed** (captured at runtime) · **declared** (from OpenAPI) · **inferred** (static scan of HTML/JS — candidates only).',
    '',
  ];

  if (smDeclared.size) {
    lines.push('## Declared API surface', '');
    for (const ep of smDeclared.values()) lines.push(smEndpointMd(ep));
    lines.push('');
  }
  if (smShared.size) {
    lines.push('## Shared app bundle (all pages)', '');
    for (const ep of smShared.values()) lines.push(smEndpointMd(ep));
    lines.push('');
  }

  lines.push('## Pages', '');
  const pages = [...smPages.values()].sort((a, b) => a.route.localeCompare(b.route));
  for (const p of pages) {
    const tag = p.scanned ? 'visited' : p.inferred ? 'inferred' : 'not scanned';
    lines.push(`### ${p.route}  _(${tag}${p.error ? ` — ${p.error}` : ''})_`, '');
    if (!p.endpoints.size) { lines.push('  - _no endpoints found_', ''); continue; }
    const sorted = [...p.endpoints.values()].sort((a, b) => a.template.localeCompare(b.template));
    for (const ep of sorted) lines.push(smEndpointMd(ep));
    lines.push('');
  }
  return lines.join('\n');
}

function smExportMarkdown(): void {
  const blob = new Blob([smToMarkdown()], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sitemap-${location.hostname}-${Date.now()}.md`;
  document.documentElement.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ── Build entry point + events ────────────────────────────────────────────────

// Called when the Map view is opened and by its Build / rebuild control. Builds
// once per activation unless the user explicitly asks for a rebuild.
function smEnsureBuilt(): void {
  if (!smBuiltAt && !smBuilding) void smBuildMap();
}

function smRebuild(): void {
  smBuiltAt = 0;
  void smBuildMap();
}

function smIsBuilding(): boolean {
  return smBuilding;
}

// Pages / endpoints discovered so far — shown in place of the request tally
// while the Map view is open.
function smTally(): { pages: number; endpoints: number } {
  return { pages: smPages.size, endpoints: smCountEndpoints() };
}

let smEventsBound = false;

// Deactivation destroys the panel, so the delegation has to be re-bound the next
// time one is built — mirrors what deactivateOverlay does with rowEventsBound.
function smTeardown(): void {
  smReset();
  smEventsBound = false;
  smCaptureOnly = false;
}

function smBindSiteMapDelegation(list: HTMLElement): void {
  if (smEventsBound) return;
  smEventsBound = true;

  list.addEventListener('click', (e: Event) => {
    if (!siteMapVisible()) return;
    const target = e.target as HTMLElement;

    const act = target.closest<HTMLElement>('.ov-sm-act');
    if (act) {
      e.stopPropagation();
      const which = act.dataset.act;
      if (which === 'close') setView('log');
      else if (which === 'export') smExportMarkdown();
      else if (which === 'stop') { smAbort = true; smSetStatus('stopped'); }
      else if (which === 'rebuild') smRebuild();
      return;
    }

    const scan = target.closest<HTMLElement>('.ov-sm-scan');
    if (scan) {
      e.stopPropagation();
      void smScanPage(scan.dataset.route ?? '');
      return;
    }

    const tp = target.closest<HTMLElement>('.ov-sm-tp');
    if (tp) {
      e.stopPropagation();
      const key = `${tp.dataset.route ?? ''} ${tp.dataset.host ?? ''}`;
      if (smExpandedHosts.has(key)) smExpandedHosts.delete(key);
      else smExpandedHosts.add(key);
      smRenderSiteMap();
      return;
    }

    const head = target.closest<HTMLElement>('.ov-sm-phead');
    if (head) {
      e.stopPropagation();
      const route = head.dataset.route ?? '';
      if (smExpandedPages.has(route)) smExpandedPages.delete(route);
      else smExpandedPages.add(route);
      smRenderSiteMap();
      return;
    }

    // An observed row knows which log entries produced it — jump to the first.
    const row = target.closest<HTMLElement>('.ov-sm-ep');
    if (row) {
      e.stopPropagation();
      const route = row.dataset.route ?? '';
      const key = safeDecodeURIComponent(row.dataset.key ?? '');
      const ep = smPages.get(route)?.endpoints.get(key);
      const id = ep?.reqIds[0];
      if (typeof id === 'number' && requests.has(id)) {
        setView('log');
        navigateToRequest(id);
      }
    }
  });

  list.addEventListener('mouseover', (e: Event) => {
    if (!siteMapVisible()) return;
    const row = (e.target as Element).closest<HTMLElement>('.ov-sm-ep');
    if (!row) return;
    const related = (e as MouseEvent).relatedTarget as Element | null;
    if (related && row.contains(related)) return;
    const sel = safeDecodeURIComponent(row.dataset.sel ?? '');
    if (sel) highlightEl(sel);
  });

  list.addEventListener('mouseout', (e: Event) => {
    if (!siteMapVisible()) return;
    const row = (e.target as Element).closest<HTMLElement>('.ov-sm-ep');
    if (!row) return;
    const related = (e as MouseEvent).relatedTarget as Element | null;
    if (related && row.contains(related)) return;
    clearHighlight();
  });
}

// ── Styles ────────────────────────────────────────────────────────────────────

function smStylesCss(): string {
  return `
    /* ══ Site map ═══════════════════════════════════════════════════════════
       Shares the overlay's tokens, so the palette and both themes come for free;
       this only carries the geometry the map needs on top of them. */
    #ov-panel .ov-sm-bar {
      display: flex !important; align-items: center !important; gap: 8px !important;
      padding: 9px 12px !important;
      border-bottom: 1px solid var(--ov-border-soft) !important;
      background: var(--ov-bg-2) !important;
      position: sticky !important; top: 0 !important; z-index: 3 !important;
    }
    #ov-panel .ov-sm-title {
      color: var(--ov-title) !important; font-weight: 600 !important;
      font-size: calc(11.5px * var(--ov-font-scale,1)) !important;
    }
    #ov-panel .ov-sm-meta {
      color: var(--ov-text-faint) !important;
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
      white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important;
    }
    #ov-panel .ov-sm-spacer { flex: 1 1 auto !important; }
    #ov-panel .ov-sm-act {
      all: unset !important;
      cursor: pointer !important;
      background: var(--ov-bg-3) !important; color: var(--ov-text-dim) !important;
      border: 1px solid var(--ov-border) !important; border-radius: var(--ov-r) !important;
      padding: 3px 9px !important; flex-shrink: 0 !important;
      font-family: inherit !important; font-size: calc(10px * var(--ov-font-scale,1)) !important;
      transition: color 90ms, border-color 90ms, background 90ms !important;
    }
    #ov-panel .ov-sm-act:hover { color: var(--ov-accent-soft) !important; border-color: var(--ov-accent-bd) !important; background: var(--ov-accent-bg) !important; }
    #ov-panel .ov-sm-act-stop {
      color: var(--ov-s-err) !important;
      background: rgba(229,97,94,.10) !important;
      border-color: rgba(229,97,94,.3) !important;
    }
    #ov-panel .ov-sm-act-stop:hover { color: var(--ov-s-err) !important; background: rgba(229,97,94,.18) !important; border-color: var(--ov-s-err) !important; }

    /* ── Build progress ── */
    #ov-panel .ov-sm-status {
      padding: 8px 12px !important;
      border-bottom: 1px solid var(--ov-border-soft) !important;
      background: var(--ov-bg-2) !important;
    }
    #ov-panel .ov-sm-status-line {
      display: flex !important; align-items: center !important; gap: 8px !important;
      font-size: calc(10.5px * var(--ov-font-scale,1)) !important;
      color: var(--ov-text-dim) !important;
    }
    #ov-panel .ov-sm-spin {
      width: 11px !important; height: 11px !important; flex-shrink: 0 !important;
      border: 2px solid var(--ov-border) !important;
      border-top-color: var(--ov-accent) !important;
      border-radius: 50% !important; display: inline-block !important;
      animation: ov-spin .7s linear infinite !important;
    }
    #ov-panel .ov-sm-track {
      height: 5px !important; margin-top: 8px !important;
      border-radius: 3px !important; overflow: hidden !important;
      background: var(--ov-bg-3) !important;
    }
    #ov-panel .ov-sm-fill {
      height: 100% !important;
      background: linear-gradient(90deg, var(--ov-accent), var(--ov-trace)) !important;
      transition: width 200ms ease !important;
    }

    /* ── Tier legend ── */
    #ov-panel .ov-sm-legend {
      display: flex !important; align-items: center !important; gap: 12px !important;
      padding: 7px 12px !important;
      border-bottom: 1px solid var(--ov-border-soft) !important;
      background: var(--ov-bg) !important;
      font-size: calc(9.5px * var(--ov-font-scale,1)) !important;
      flex-wrap: wrap !important;
    }
    #ov-panel .ov-sm-tier { display: inline-flex !important; align-items: center !important; gap: 6px !important; }
    #ov-panel .ov-sm-tier b { font-weight: 700 !important; }
    #ov-panel .ov-sm-sw {
      width: 8px !important; height: 8px !important; border-radius: 2px !important;
      display: inline-block !important; flex-shrink: 0 !important;
    }
    #ov-panel .ov-sm-legend .ov-tier-observed { color: var(--ov-s-2xx) !important; }
    #ov-panel .ov-sm-legend .ov-tier-observed .ov-sm-sw { background: var(--ov-s-2xx) !important; }
    #ov-panel .ov-sm-legend .ov-tier-declared { color: var(--ov-s-3xx) !important; }
    #ov-panel .ov-sm-legend .ov-tier-declared .ov-sm-sw { background: var(--ov-s-3xx) !important; }
    /* Inferred is dashed everywhere it appears — the shape says "candidate". */
    #ov-panel .ov-sm-legend .ov-tier-inferred { color: var(--ov-s-4xx) !important; }
    #ov-panel .ov-sm-legend .ov-tier-inferred .ov-sm-sw { background: transparent !important; border: 1px dashed var(--ov-s-4xx) !important; }
    #ov-panel .ov-sm-legend-note { color: var(--ov-text-ghost) !important; }

    /* ── Page cards ── */
    #ov-panel .ov-sm-page { padding: 0 8px !important; }
    #ov-panel .ov-sm-page:first-of-type { padding-top: 8px !important; }
    #ov-panel .ov-sm-phead {
      display: flex !important; align-items: center !important; gap: 8px !important;
      padding: 6px 10px !important; cursor: pointer !important;
      border-radius: var(--ov-r) !important;
      background: var(--ov-bg-2) !important;
      margin-bottom: 4px !important;
      font-size: calc(11px * var(--ov-font-scale,1)) !important;
      transition: background 90ms !important;
    }
    #ov-panel .ov-sm-phead:hover { background: var(--ov-bg-3) !important; }
    #ov-panel .ov-sm-sitewide .ov-sm-phead {
      background: transparent !important;
      border: 1px solid var(--ov-border-soft) !important;
    }
    #ov-panel .ov-sm-caret { color: var(--ov-text-faint) !important; width: 9px !important; flex-shrink: 0 !important; }
    #ov-panel .ov-sm-route {
      color: var(--ov-title) !important; font-weight: 600 !important;
      overflow: hidden !important; text-overflow: ellipsis !important; white-space: nowrap !important;
    }

    /* Tier badges are pills, and the inferred one is outlined rather than filled. */
    #ov-panel .ov-sm-badge {
      color: var(--ov-text-faint) !important;
      background: var(--ov-bg-3) !important;
      border: 1px solid transparent !important;
      border-radius: 20px !important; padding: 1px 8px !important; flex-shrink: 0 !important;
      font-size: calc(9px * var(--ov-font-scale,1)) !important;
    }
    #ov-panel .ov-sm-badge-obs {
      color: var(--ov-s-2xx) !important;
      background: rgba(78,201,165,.12) !important;
      border-color: rgba(78,201,165,.3) !important;
    }
    #ov-panel .ov-sm-badge-inf {
      color: var(--ov-s-4xx) !important;
      background: rgba(217,164,65,.10) !important;
      border: 1px dashed rgba(217,164,65,.45) !important;
    }
    #ov-panel .ov-sm-err {
      color: var(--ov-s-4xx) !important; font-size: calc(9px * var(--ov-font-scale,1)) !important;
      overflow: hidden !important; text-overflow: ellipsis !important; white-space: nowrap !important;
    }
    #ov-panel .ov-sm-n { color: var(--ov-text-faint) !important; font-size: calc(9.5px * var(--ov-font-scale,1)) !important; flex-shrink: 0 !important; }
    #ov-panel .ov-sm-scan {
      all: unset !important;
      cursor: pointer !important;
      background: var(--ov-accent-bg) !important; color: var(--ov-accent-soft) !important;
      border: 1px solid var(--ov-accent-bd) !important; border-radius: var(--ov-r) !important;
      padding: 2px 9px !important; flex-shrink: 0 !important;
      font-family: inherit !important; font-size: calc(9px * var(--ov-font-scale,1)) !important;
    }
    #ov-panel .ov-sm-scan:hover:not(:disabled) { background: rgba(91,140,255,.24) !important; }
    #ov-panel .ov-sm-scan:disabled { opacity: .4 !important; cursor: default !important; }
    #ov-panel .ov-sm-shield {
      color: var(--ov-s-err) !important;
      background: rgba(229,97,94,.08) !important;
      border: 1px solid rgba(229,97,94,.25) !important;
      border-radius: var(--ov-r) !important;
      padding: 2px 8px !important; flex-shrink: 0 !important; white-space: nowrap !important;
      font-size: calc(9px * var(--ov-font-scale,1)) !important;
    }

    /* ── Endpoint rows ── */
    #ov-panel .ov-sm-ep {
      display: flex !important; align-items: center !important; gap: 7px !important;
      padding: 3px 10px 3px 22px !important; cursor: pointer !important;
      margin: 0 0 1px 12px !important;
      border-radius: var(--ov-r-sm) !important;
      font-size: calc(10.5px * var(--ov-font-scale,1)) !important;
    }
    #ov-panel .ov-sm-ep:hover { background: var(--ov-bg-2) !important; }
    #ov-panel .ov-sm-m { width: 40px !important; flex-shrink: 0 !important; font-weight: 600 !important; font-size: calc(9.5px * var(--ov-font-scale,1)) !important; }
    #ov-panel .ov-sm-m-unk { color: var(--ov-text-ghost) !important; }
    #ov-panel .ov-sm-url { flex: 1 1 auto !important; overflow: hidden !important; text-overflow: ellipsis !important; white-space: nowrap !important; color: var(--ov-text-dim) !important; }
    #ov-panel .ov-sm-zap { flex-shrink: 0 !important; font-size: calc(9px * var(--ov-font-scale,1)) !important; color: var(--ov-trace) !important; }
    #ov-panel .ov-sm-st { flex-shrink: 0 !important; font-size: calc(9px * var(--ov-font-scale,1)) !important; font-weight: 600 !important; }
    #ov-panel .ov-sm-ms { flex-shrink: 0 !important; color: var(--ov-text-ghost) !important; font-size: calc(9px * var(--ov-font-scale,1)) !important; min-width: 34px !important; text-align: right !important; }

    /* The tier rail: solid for facts, dashed for guesses. Inferred rows are also
       dimmed and italic so they never read as measured data. */
    #ov-panel .ov-sm-ep.ov-tier-observed { box-shadow: inset 2px 0 0 var(--ov-s-2xx) !important; }
    #ov-panel .ov-sm-ep.ov-tier-declared { box-shadow: inset 2px 0 0 var(--ov-s-3xx) !important; }
    #ov-panel .ov-sm-ep.ov-tier-inferred {
      opacity: .72 !important;
      border-left: 2px dashed var(--ov-s-4xx) !important;
      padding-left: 20px !important;
    }
    #ov-panel .ov-sm-ep.ov-tier-inferred .ov-sm-url { font-style: italic !important; }

    /* ── Third-party group ── */
    #ov-panel .ov-sm-tp {
      display: flex !important; align-items: center !important; gap: 7px !important;
      padding: 4px 10px !important; cursor: pointer !important;
      margin: 2px 0 3px 12px !important;
      border: 1px solid var(--ov-border-soft) !important;
      border-radius: var(--ov-r) !important;
      color: var(--ov-text-muted) !important;
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
    }
    #ov-panel .ov-sm-tp:hover { background: var(--ov-bg-2) !important; }
    #ov-panel .ov-sm-tp-host { overflow: hidden !important; text-overflow: ellipsis !important; white-space: nowrap !important; }
    #ov-panel .ov-sm-tp-tag { color: var(--ov-text-ghost) !important; font-size: calc(9px * var(--ov-font-scale,1)) !important; }
    #ov-panel .ov-sm-none {
      padding: 6px 10px 8px 24px !important; color: var(--ov-text-ghost) !important;
      font-style: italic !important;
      font-size: calc(10px * var(--ov-font-scale,1)) !important;
    }
  `;
}
