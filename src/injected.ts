interface Window {
  __apiOverlayActive?: boolean;
}

interface XMLHttpRequest {
  __ov_method?: string;
  __ov_url?: string;
  __ov_load_listener?: (this: XMLHttpRequest) => void;
  __ov_error_listener?: (this: XMLHttpRequest) => void;
  __ov_req_headers?: Array<[string, string]>;
}

(function () {
  type HeaderPair = [string, string];
  if (window.__apiOverlayActive) return;
  window.__apiOverlayActive = true;

  let requestId = 0;
  let lastInteractedEl: Element | null = null;
  let lastInteractTime = 0;
  let cachedSelectorEl: Element | null = null;
  let cachedSelector: string = '';
  // Memoize the isConnected/time validity of lastInteractedEl. Reset whenever
  // lastInteractedEl or lastInteractTime change.
  let validatedEl: Element | null = null;
  let validatedTime = 0;
  let capturing = true;
  let stopped = false;

  // Same-origin target for the page ↔ content-script channel. Opaque origins
  // (file://, sandboxed frames) serialize as the string "null", which is not a
  // valid targetOrigin and makes postMessage throw, so fall back to '*' there.
  // The payload carries no secrets — only capture records the page already has.
  const TARGET_ORIGIN = location.origin && location.origin !== 'null' ? location.origin : '*';

  const TEXTLIKE_CT = /^(?:text\/|application\/(?:json|ld\+json|xml|x-www-form-urlencoded|graphql|javascript|x-ndjson)|application\/.*\+json)/i;
  // Upper bound on a single captured request/response body. Set high enough to
  // show full API responses rather than a truncated preview; the ceiling only
  // exists so a pathological multi-MB or never-ending text stream can't be
  // accumulated into memory and freeze the tab. Bodies beyond it are still
  // rendered as a recovered partial tree (see parsePartialJson in content.ts).
  const MAX_BODY_BYTES = 25_000_000;
  const MAX_WS_BODY_BYTES = 10_000;
  // Skip reading a body whose content-length already exceeds the cap — no point
  // streaming bytes we'd only discard. Kept in lockstep with MAX_BODY_BYTES.
  const MAX_INSPECTED_BODY = MAX_BODY_BYTES;
  const INTERACT_WINDOW_MS = 800;

  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window) return;
    if (TARGET_ORIGIN !== '*' && e.origin !== TARGET_ORIGIN) return;
    const data = e.data;
    if (!data || data.__apiOverlayControl !== true) return;
    if (data.action === 'pause') capturing = false;
    else if (data.action === 'resume') capturing = true;
    else if (data.action === 'stop') { capturing = false; stopped = true; }
    else if (data.action === 'start') { stopped = false; capturing = true; }
  });

  interface ElementInfo {
    selector: string;
    label: string;
  }

  ['mousedown', 'touchstart', 'keydown'].forEach(evt => {
    document.addEventListener(evt, (e: Event) => {
      const target = e.target;
      const newEl = target instanceof Element ? target : null;
      if (newEl !== lastInteractedEl) {
        lastInteractedEl = newEl;
        cachedSelectorEl = null;
      }
      lastInteractTime = Date.now();
    }, { capture: true, passive: true });
  });

  function getInteractedElement(): Element | null {
    if (Date.now() - lastInteractTime >= INTERACT_WINDOW_MS) {
      lastInteractedEl = null;
      lastInteractTime = 0;
      cachedSelectorEl = null;
      validatedEl = null;
      return null;
    }
    // Skip the DOM access if we already validated this exact (el, interactTime) tuple.
    if (lastInteractedEl === validatedEl && lastInteractTime === validatedTime) {
      return lastInteractedEl;
    }
    if (lastInteractedEl && !lastInteractedEl.isConnected) {
      lastInteractedEl = null;
      cachedSelectorEl = null;
      validatedEl = null;
      return null;
    }
    validatedEl = lastInteractedEl;
    validatedTime = lastInteractTime;
    return lastInteractedEl;
  }

  function uniqueSelector(el: Element): string {
    if (!el || el === document.body) return 'body';
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts: string[] = [];
    let cur: Element | null = el;
    let reachedBody = false;
    while (cur && cur !== document.body) {
      const parent: HTMLElement | null = cur.parentElement;
      if (!parent) break;
      const idx = Array.from(parent.children).indexOf(cur) + 1;
      parts.unshift(`${cur.tagName.toLowerCase()}:nth-child(${idx})`);
      cur = parent;
      if (cur === document.body) reachedBody = true;
    }
    return reachedBody ? `body > ${parts.join(' > ')}` : parts.join(' > ');
  }

  function getCachedSelector(el: Element): string {
    if (el === cachedSelectorEl) return cachedSelector;
    cachedSelectorEl = el;
    cachedSelector = uniqueSelector(el);
    return cachedSelector;
  }

  function elementInfo(el: Element | null): ElementInfo | null {
    if (!el) return null;
    const htmlEl = el as HTMLElement;
    return {
      selector: getCachedSelector(el),
      label: (htmlEl.innerText || (htmlEl as HTMLInputElement).value || el.getAttribute('aria-label') || el.tagName)
               .toString().trim().slice(0, 60)
    };
  }

  function emit(data: Record<string, unknown>): void {
    window.postMessage({ __apiOverlay: true, ...data }, TARGET_ORIGIN);
  }

  // Headers are recorded whole, every one of them — a long token or CSP is exactly
  // what someone opens the headers pane to read. The detail pane wraps and scrolls.
  function pushHeader(out: HeaderPair[], name: string, value: unknown): void {
    out.push([name, String(value)]);
  }

  function serializeHeaders(input: HeadersInit | undefined | null): HeaderPair[] | null {
    if (input == null) return null;
    const out: HeaderPair[] = [];
    try {
      if (typeof Headers !== 'undefined' && input instanceof Headers) {
        input.forEach((value, name) => { pushHeader(out, name, value); });
      } else if (Array.isArray(input)) {
        for (const entry of input) {
          if (!entry || entry.length < 2) continue;
          pushHeader(out, String(entry[0]), entry[1]);
        }
      } else if (typeof input === 'object') {
        for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
          pushHeader(out, name, value);
        }
      }
    } catch { /* ignore malformed headers */ }
    return out.length ? out : null;
  }

  function headersFromObject(headers: Headers): HeaderPair[] | null {
    const out: HeaderPair[] = [];
    try { headers.forEach((value, name) => { pushHeader(out, name, value); }); }
    catch { /* ignore */ }
    return out.length ? out : null;
  }

  // Parse XHR's getAllResponseHeaders() output ("name: value\r\n" per line) into pairs.
  function parseRawHeaders(raw: string | null): HeaderPair[] | null {
    if (!raw) return null;
    const out: HeaderPair[] = [];
    for (const line of raw.split(/\r\n/)) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const name = line.slice(0, idx).trim();
      if (!name) continue;
      pushHeader(out, name, line.slice(idx + 1).trim());
    }
    return out.length ? out : null;
  }

  function extractBody(body: BodyInit | Document | null | undefined): string | null {
    if (body == null) return null;
    if (typeof body === 'string') return body.slice(0, MAX_BODY_BYTES);
    if (body instanceof URLSearchParams) return body.toString().slice(0, MAX_BODY_BYTES);
    if (body instanceof FormData) return '[FormData]';
    if (typeof Document !== 'undefined' && body instanceof Document) {
      try { return new XMLSerializer().serializeToString(body).slice(0, MAX_BODY_BYTES); }
      catch { return '[Document]'; }
    }
    return '[Binary]';
  }

  function isTextLikeResponse(res: Response): boolean {
    const ct = res.headers.get('content-type') ?? '';
    if (ct && !TEXTLIKE_CT.test(ct)) return false;
    const cl = res.headers.get('content-length');
    if (cl) {
      const n = Number(cl);
      if (Number.isFinite(n) && n > MAX_INSPECTED_BODY) return false;
    }
    // No content-length on chunked responses — that case is bounded by the
    // MAX_BODY_BYTES cap inside readBodyStreaming, which cancels the reader
    // once enough bytes have arrived.
    return true;
  }

  // Stream-decode up to maxBytes, then cancel — avoids loading huge bodies into memory.
  async function readBodyStreaming(res: Response, maxBytes: number): Promise<string> {
    const reader = res.body?.getReader();
    if (!reader) {
      // No stream available (e.g., opaque response); fall back to text() with truncation.
      try { return (await res.text()).slice(0, maxBytes); } catch { return ''; }
    }
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let result = '';
    let bytesRead = 0;
    try {
      while (bytesRead < maxBytes) {
        const { value, done } = await reader.read();
        if (done) break;
        bytesRead += value.byteLength;
        result += decoder.decode(value, { stream: true });
        if (result.length >= maxBytes) {
          result = result.slice(0, maxBytes);
          break;
        }
      }
      result += decoder.decode();
    } catch {
      /* ignore */
    } finally {
      reader.cancel().catch(() => {});
    }
    return result;
  }

  const _fetch = window.fetch;
  window.fetch = function (...args: Parameters<typeof fetch>): ReturnType<typeof fetch> {
    if (stopped || !capturing) return _fetch.apply(this, args);
    const id = ++requestId;
    let url: string;
    let method: string;
    let reqBody: string | null = null;
    let reqHeaders: HeaderPair[] | null = null;
    if (args[0] instanceof Request) {
      url = args[0].url;
      method = args[0].method.toUpperCase();
      reqHeaders = headersFromObject(args[0].headers);
      const init = args[1];
      if (init?.headers) reqHeaders = serializeHeaders(init.headers) ?? reqHeaders;
    } else {
      url = String(args[0]);
      const init = args[1];
      method = (init?.method ?? 'GET').toUpperCase();
      reqBody = extractBody(init?.body);
      reqHeaders = serializeHeaders(init?.headers);
    }
    const el = getInteractedElement();
    const t0 = Date.now();

    emit({ id, url, method, kind: 'fetch', status: 'pending', element: elementInfo(el), ts: t0, reqBody, reqHeaders });

    return _fetch.apply(this, args)
      .then(res => {
        const ms = Date.now() - t0;
        const resHeaders = headersFromObject(res.headers);
        emit({ id, url, method, kind: 'fetch', status: res.status, ms, element: elementInfo(el), ts: t0, reqBody, reqHeaders, resHeaders });
        if (isTextLikeResponse(res)) {
          readBodyStreaming(res.clone(), MAX_BODY_BYTES).then(text => {
            emit({ id, resBody: text });
          }).catch(() => {});
        }
        return res;
      })
      .catch(err => {
        emit({ id, url, method, kind: 'fetch', status: 'error', ms: Date.now() - t0, element: elementInfo(el), ts: t0, reqBody, reqHeaders });
        throw err;
      });
  };

  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;
  const _setRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  // Cast to any to bypass overload signature mismatch — we forward all args as-is
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (XMLHttpRequest.prototype as any).open = function (method: string, url: string | URL, ...rest: unknown[]): void {
    this.__ov_method = method.toUpperCase();
    this.__ov_url = String(url);
    // Per spec, open() resets the request header list — clear our shadow copy too.
    this.__ov_req_headers = undefined;
    if (this.__ov_load_listener) {
      this.removeEventListener('load', this.__ov_load_listener);
      this.__ov_load_listener = undefined;
    }
    if (this.__ov_error_listener) {
      this.removeEventListener('error', this.__ov_error_listener);
      this.__ov_error_listener = undefined;
    }
    (_open as (...a: unknown[]) => void).apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name: string, value: string): void {
    if (!this.__ov_req_headers) this.__ov_req_headers = [];
    pushHeader(this.__ov_req_headers, name, value);
    _setRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (...args: Parameters<typeof XMLHttpRequest.prototype.send>): void {
    if (stopped || !capturing) { _send.apply(this, args); return; }
    const id = ++requestId;
    const method = this.__ov_method ?? 'GET';
    const url = this.__ov_url ?? '';
    const reqBody = extractBody(args[0] as BodyInit | Document | null);
    const reqHeaders = this.__ov_req_headers ? this.__ov_req_headers.slice() : null;
    const el = getInteractedElement();
    const t0 = Date.now();

    emit({ id, url, method, kind: 'xhr', status: 'pending', element: elementInfo(el), ts: t0, reqBody, reqHeaders });

    if (this.__ov_load_listener) this.removeEventListener('load', this.__ov_load_listener);
    if (this.__ov_error_listener) this.removeEventListener('error', this.__ov_error_listener);

    const xhr = this;
    const onLoad = function (this: XMLHttpRequest): void {
      let resBody: string | null = null;
      const cl = xhr.getResponseHeader('content-length');
      const tooBig = cl ? (() => { const n = Number(cl); return Number.isFinite(n) && n > MAX_INSPECTED_BODY; })() : false;
      if (!tooBig && (xhr.responseType === '' || xhr.responseType === 'text')) {
        const ct = xhr.getResponseHeader('content-type') ?? '';
        if (!ct || TEXTLIKE_CT.test(ct)) {
          resBody = xhr.responseText?.slice(0, MAX_BODY_BYTES) ?? null;
        }
      }
      const resHeaders = parseRawHeaders(xhr.getAllResponseHeaders());
      emit({ id, url, method, kind: 'xhr', status: xhr.status, ms: Date.now() - t0, element: elementInfo(el), ts: t0, reqBody, resBody, reqHeaders, resHeaders });
    };
    const onError = function (this: XMLHttpRequest): void {
      emit({ id, url, method, kind: 'xhr', status: 'error', ms: Date.now() - t0, element: elementInfo(el), ts: t0, reqBody, reqHeaders });
    };
    this.__ov_load_listener = onLoad;
    this.__ov_error_listener = onError;
    this.addEventListener('load', onLoad, { once: true });
    this.addEventListener('error', onError, { once: true });

    _send.apply(this, args);
  };

  const _WebSocket = window.WebSocket;

  class WebSocketProxy extends _WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      if (stopped || !capturing) return;
      const id = ++requestId;
      const el = getInteractedElement();
      const t0 = Date.now();
      const wsUrl = String(url);

      emit({ id, url: wsUrl, method: 'WS', kind: 'ws', status: 'pending', element: elementInfo(el), ts: t0 });

      // Once-per-connection lifecycle: finalize even while paused (matches fetch/XHR), bail only when stopped.
      this.addEventListener('open', () => {
        if (stopped) return;
        emit({ id, url: wsUrl, method: 'WS', kind: 'ws', status: 101, ms: Date.now() - t0, element: elementInfo(el), ts: t0 });
      });

      this.addEventListener('close', (e: CloseEvent) => {
        if (stopped) return;
        emit({ id, url: wsUrl, method: 'WS', kind: 'ws', status: e.wasClean ? 'closed' : 'error', ms: Date.now() - t0, element: elementInfo(el), ts: t0 });
      });

      this.addEventListener('error', () => {
        if (stopped) return;
        emit({ id, url: wsUrl, method: 'WS', kind: 'ws', status: 'error', ms: Date.now() - t0, element: elementInfo(el), ts: t0 });
      });

      // Ongoing frame stream: pause must actually pause, not just hide.
      this.addEventListener('message', (e: MessageEvent) => {
        if (stopped || !capturing) return;
        const body = typeof e.data === 'string' ? e.data.slice(0, MAX_WS_BODY_BYTES) : '[Binary]';
        emit({ __wsMsg: true, wsId: id, dir: 'recv', body, ts: Date.now() });
      });

      type WSData = string | Blob | BufferSource;
      const origSend: (data: WSData) => void = _WebSocket.prototype.send.bind(this);
      this.send = (data: WSData): void => {
        if (!stopped && capturing) {
          const body = typeof data === 'string' ? data.slice(0, MAX_WS_BODY_BYTES) : '[Binary]';
          emit({ __wsMsg: true, wsId: id, dir: 'sent', body, ts: Date.now() });
        }
        origSend(data);
      };
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).WebSocket = WebSocketProxy;
})();
