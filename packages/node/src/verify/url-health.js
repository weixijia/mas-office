// Deterministic URL health checks for cited sources (protocol 0.2 `evidence.checked.urlHealth`).
//
// Decision table (first matching row wins):
//
// | What happened                                                          | urlHealth    | note                          |
// |------------------------------------------------------------------------|--------------|-------------------------------|
// | Not a parseable absolute URL                                           | hallucinated | invalid URL                   |
// | Scheme other than http/https                                           | unknown      | refused: only http and https  |
// | Host is (or resolves to) a non-public address or local name (below)    | unknown      | refused: private address      |
// | Host is an IPv6 literal                                                | unknown      | refused: IPv6 literal         |
// | Port other than the default or 80, 443, 8080, 8443                     | unknown      | refused: port N not allowed   |
// | User name or password in the URL                                       | unknown      | refused: credentials in URL   |
// | DNS says the name does not exist (ENOTFOUND, ENODATA, no addresses)    | hallucinated | DNS: no such host             |
// | Other DNS failure                                                      | unknown      | DNS lookup failed (CODE)      |
// | Timeout (default 10 s per request)                                     | unknown      | timeout                       |
// | Other network or TLS error                                             | unknown      | network error: CODE           |
// | More than 5 redirects, or a redirect without a usable Location         | unknown      | too many redirects / …        |
// | 404 or 410 (or a 200 "soft 404" whose <title> says not found):         |              |                               |
// |   Wayback Machine has a 2xx snapshot                                   | stale        | (+ archivedUrl)               |
// |   Wayback Machine has none                                             | hallucinated |                               |
// |   Wayback lookup failed or was disabled (`archive: false`)             | unknown      |                               |
// | 401, 403, 429, 451 or 5xx                                              | blocked      | HTTP N                        |
// | 2xx whose first 5000 characters look like a block or captcha page      | blocked      | block or captcha page         |
// | 2xx text page with an empty body                                       | unknown      | empty page                    |
// | 2xx otherwise                                                          | live         |                               |
// | Any other status                                                       | unknown      | HTTP N                        |
//
// Requests: HEAD first; GET when HEAD fails or is not 2xx (many servers reject HEAD), and also after a
// 2xx HEAD for text/HTML pages so the body can be checked for block pages. Redirects are followed by
// hand, at most 5, and every hop is validated again (scheme, port, name, DNS). A DNS failure on a
// redirect target is `unknown`, not `hallucinated`: the cited URL itself existed. Bodies are read up
// to 256 KiB. The User-Agent is `mas-office-url-check/<version>`: no contact details, no browser
// impersonation.
//
// SSRF protection (mandatory): only http/https on the ports above; refused names are `localhost`,
// `*.localhost`, `*.local`, `*.internal`, `*.lan`, `*.home.arpa` and single-label names; refused
// IPv4 ranges are 0/8, 10/8, 100.64/10 (CGNAT, includes 100.100.100.200 metadata), 127/8, 169.254/16
// (link-local, includes 169.254.169.254 metadata), 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24,
// 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4 (multicast) and 240/4 (reserved,
// broadcast) — a superset of the kit browser's PAC rules (`kit/.claude/mas-browser.pac.js`).
// IPv6 literals in URLs are refused outright, as the PAC does. Resolved IPv6 addresses are allowed
// only inside global unicast 2000::/3, minus 2001::/23 (Teredo and IETF assignments), 2001:db8::/32
// and 2002::/16 (6to4); this excludes loopback, unspecified, IPv4-mapped/compatible, NAT64, ULA,
// link-local, site-local and multicast. Numeric IPv4 spellings (`2130706433`, `0x7f.1`, `0177.0.0.1`)
// are normalised by the WHATWG URL parser before the check. Names are resolved first
// (`lookup(host, {all: true})`) and refused when ANY address is non-public (DNS rebinding such as
// `127.0.0.1.nip.io`). The default transport then connects only to those already-checked addresses
// (its socket `lookup` is pinned), so a second, different DNS answer cannot be used.
//
// `opts.fetch(url, init)` and `opts.lookup(host, {all: true})` are injectable (tests never touch the
// network). An injected fetch receives `init.pinned` (the checked addresses) and may ignore it.

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import dns from 'node:dns';

const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || '0';
  } catch {
    return '0';
  }
})();

export const USER_AGENT = `mas-office-url-check/${VERSION}`;
export const URL_HEALTH = ['live', 'stale', 'hallucinated', 'blocked', 'unknown'];
export const DEFAULTS = Object.freeze({
  timeoutMs: 10_000, maxRedirects: 5, maxBodyBytes: 256 * 1024, ports: [80, 443, 8080, 8443], archive: true, concurrency: 4,
});
const WAYBACK = 'https://archive.org/wayback/available?url=';
const REFUSED_PRIVATE = 'refused: private address';

// ---------- address rules ----------

const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => [v4ToInt(base), bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0]);

function v4ToInt(ip) {
  return ip.split('.').reduce((n, part) => ((n << 8) | Number(part)) >>> 0, 0);
}

function privateV4(ip) {
  const n = v4ToInt(ip);
  return V4_BLOCKS.some(([base, mask]) => ((n & mask) >>> 0) === base);
}

/** Parse an IPv6 address (no brackets, no zone) into 8 numbers, or null. */
function parseV6(ip) {
  let s = ip;
  const lastColon = s.lastIndexOf(':');
  if (s.includes('.', lastColon)) { // embedded IPv4 tail (::ffff:1.2.3.4) → two hex words
    const v4 = s.slice(lastColon + 1);
    if (!net.isIPv4(v4)) return null;
    const n = v4ToInt(v4);
    s = `${s.slice(0, lastColon + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = (h) => (h === '' ? [] : h.split(':').map((x) => (/^[0-9a-f]{1,4}$/i.test(x) ? parseInt(x, 16) : NaN)));
  const head = part(halves[0]);
  const rest = halves.length === 2 ? part(halves[1]) : [];
  const gap = 8 - head.length - rest.length;
  if (halves.length === 2 ? gap < 1 : gap !== 0) return null;
  const words = halves.length === 2 ? [...head, ...new Array(gap).fill(0), ...rest] : head;
  return words.some((w) => Number.isNaN(w)) ? null : words;
}

function privateV6(ip) {
  const w = parseV6(ip);
  if (!w) return true;
  if ((w[0] & 0xe000) !== 0x2000) return true; // outside global unicast 2000::/3
  if (w[0] === 0x2001 && w[1] < 0x200) return true; // 2001::/23: Teredo, benchmarking, ORCHID …
  if (w[0] === 0x2001 && w[1] === 0xdb8) return true; // documentation
  if (w[0] === 0x2002) return true; // 6to4 embeds an arbitrary IPv4 address
  return false;
}

/** True when `address` is not a public unicast IP (anything that is not an IP counts as private). */
export function isPrivateAddress(address) {
  if (typeof address !== 'string') return true;
  let a = address.trim();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  if (a.includes('%')) return true; // zone ids only exist for link-local scopes
  const v = net.isIP(a);
  if (v === 4) return privateV4(a);
  if (v === 6) return privateV6(a);
  return true;
}

/** True for names that never point at the public web: localhost, mDNS, internal zones, single labels. */
export function isLocalName(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!h || !h.includes('.')) return true;
  return h === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(h);
}

// ---------- page heuristics ----------
// Adapted from assafelovic/gpt-researcher@3582a6841fe7dc801e2a34e34ee408641aea9bce
// gpt_researcher/scraper/scraper.py L40–106 (Apache-2.0). Licensed under the Apache License, Version 2.0.
// Changes: ported from Python to JavaScript; block markers added for Akamai, Imperva/Distil and Google
// "unusual traffic" pages; `looksLikeNotFound` is ours.

const BLOCK_MARKERS = [
  'anubis uses a proof-of-work scheme',
  "making sure you're not a bot",
  'checking your browser before accessing',
  'enable javascript and cookies to continue',
  'researchgate - temporarily unavailable',
  'please verify you are a human',
  'attention required! | cloudflare',
  'sorry, you have been blocked',
  // Added for MAS Office.
  "you don't have permission to access",
  'pardon our interruption',
  'request unsuccessful. incapsula incident id',
  'our systems have detected unusual traffic',
];
const BLOCK_PREFIX = 5000;
const WORDLIST_MIN_LENGTH = 200_000;
const WORDLIST_MAX_DENSITY = 1 / 5000;
const SENTENCE_END = new Set(['.', '!', '?', '。', '！', '？']);
const PDF_MARKERS = ['endobj', 'endstream', '/FlateDecode', 'xref', 'trailer'];

/** A block, challenge or captcha page (checked on the first 5000 characters only). */
export function looksBlocked(text) {
  const prefix = String(text ?? '').slice(0, BLOCK_PREFIX).toLowerCase();
  return BLOCK_MARKERS.some((m) => prefix.includes(m));
}

/** A word-list or vocabulary dump: 200 000+ characters with almost no sentence-ending punctuation. */
export function looksLikeWordList(text) {
  const s = String(text ?? '');
  if (s.length < WORDLIST_MIN_LENGTH) return false;
  let ends = 0;
  for (const ch of s) if (SENTENCE_END.has(ch)) ends += 1;
  return ends / s.length < WORDLIST_MAX_DENSITY;
}

/** Raw PDF bytes read as text (PDF structure tokens), not the document's extracted words. */
export function looksLikeUnextractedPdf(text) {
  const s = String(text ?? '');
  if (s.startsWith('%PDF-')) return true;
  return PDF_MARKERS.filter((m) => s.includes(m)).length >= 2;
}

/** A "soft 404": a 200 page whose <title> says the page was not found. */
export function looksLikeNotFound(html) {
  const head = String(html ?? '').slice(0, BLOCK_PREFIX);
  const lower = head.toLowerCase();
  const open = lower.indexOf('<title');
  if (open === -1) return false;
  const gt = lower.indexOf('>', open);
  const close = lower.indexOf('</title', gt);
  if (gt === -1 || close === -1) return false;
  const title = lower.slice(gt + 1, close);
  return /\b404\b|page not found|not found|no longer (available|exists)|does(n't| not) exist/.test(title);
}

// ---------- transport ----------

/** Default fetch: node:http(s) with the socket lookup pinned to the already-checked addresses. */
export function pinnedFetch(url, { method = 'GET', headers = {}, signal, pinned } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const addrs = Array.isArray(pinned) && pinned.length ? pinned : null;
    if (!addrs) {
      reject(Object.assign(new Error('no checked address to connect to'), { code: 'ENOPIN' }));
      return;
    }
    const lookup = (_host, options, cb) => {
      if (options && options.all) cb(null, addrs.map((a) => ({ address: a.address, family: a.family })));
      else cb(null, addrs[0].address, addrs[0].family);
    };
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method, headers, signal, lookup, agent: false });
    req.on('error', reject);
    req.on('response', (res) => {
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      let body = res;
      if (enc === 'gzip' || enc === 'x-gzip') body = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') body = res.pipe(zlib.createInflate());
      else if (enc === 'br') body = res.pipe(zlib.createBrotliDecompress());
      if (body !== res) body.on('error', () => res.destroy());
      resolve({
        status: res.statusCode,
        headers: { get: (name) => { const v = res.headers[String(name).toLowerCase()]; return Array.isArray(v) ? v.join(', ') : v ?? null; } },
        body,
        cancel: () => { res.destroy(); if (body !== res) body.destroy(); },
      });
    });
    req.end();
  });
}

function discard(res) {
  try {
    if (typeof res.cancel === 'function') res.cancel();
    else if (res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {});
    else if (res.body && typeof res.body.destroy === 'function') res.body.destroy();
  } catch { /* already closed */ }
}

async function readBody(res, max) {
  const chunks = [];
  let size = 0;
  const add = (chunk) => {
    const buf = Buffer.from(chunk);
    chunks.push(buf);
    size += buf.length;
  };
  const body = res.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      while (size < max) {
        const { done, value } = await reader.read();
        if (done) break;
        add(value);
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  } else if (body && typeof body[Symbol.asyncIterator] === 'function') {
    try {
      for await (const chunk of body) {
        add(chunk);
        if (size >= max) break;
      }
    } finally {
      discard(res);
    }
  } else if (typeof res.text === 'function') {
    add(String(await res.text()));
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks).subarray(0, max));
}

class TimeoutError extends Error {
  constructor() {
    super('timeout');
    this.name = 'TimeoutError';
  }
}

/** Run `work(signal)` with a deadline: the signal aborts and the promise rejects when it passes. */
async function withDeadline(ms, work) {
  const ac = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new TimeoutError());
    }, ms);
  });
  try {
    return await Promise.race([work(ac.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const isTimeout = (err) => err instanceof TimeoutError || err?.name === 'TimeoutError' || err?.name === 'AbortError' ||
  err?.code === 'ETIMEDOUT' || err?.code === 'UND_ERR_CONNECT_TIMEOUT';
const errCode = (err) => err?.cause?.code || err?.code || err?.name || 'error';

function defaultLookup(host, options) {
  return dns.promises.lookup(host, { ...options, all: true, verbatim: true });
}

function normalizeOptions(opts) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  o.fetch = typeof o.fetch === 'function' ? o.fetch : pinnedFetch;
  o.lookup = typeof o.lookup === 'function' ? o.lookup : defaultLookup;
  o.ports = Array.isArray(o.ports) ? o.ports.map(Number) : DEFAULTS.ports;
  return o;
}

/**
 * Validate one hop before any connection: scheme, name, literal address, port, credentials, DNS.
 * @returns {Promise<{pinned: {address: string, family: number}[]} | {urlHealth: string, note: string}>}
 */
async function guard(u, o, hop) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { urlHealth: 'unknown', note: 'refused: only http and https' };
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[')) {
    return { urlHealth: 'unknown', note: isPrivateAddress(host) ? REFUSED_PRIVATE : 'refused: IPv6 literal' };
  }
  const literal = net.isIPv4(host);
  if (literal ? isPrivateAddress(host) : isLocalName(host)) return { urlHealth: 'unknown', note: REFUSED_PRIVATE };
  if (u.port && !o.ports.includes(Number(u.port))) return { urlHealth: 'unknown', note: `refused: port ${u.port} not allowed` };
  if (u.username || u.password) return { urlHealth: 'unknown', note: 'refused: credentials in URL' };
  if (literal) return { pinned: [{ address: host, family: 4 }] };
  let found;
  try {
    found = await withDeadline(o.timeoutMs, () => Promise.resolve(o.lookup(host, { all: true })));
  } catch (err) {
    const code = errCode(err);
    if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'EAI_NONAME') {
      return hop === 0 ? { urlHealth: 'hallucinated', note: 'DNS: no such host' } : { urlHealth: 'unknown', note: 'redirect target: DNS: no such host' };
    }
    return { urlHealth: 'unknown', note: isTimeout(err) ? 'DNS lookup timed out' : `DNS lookup failed (${code})` };
  }
  const list = (Array.isArray(found) ? found : [found])
    .map((a) => (typeof a === 'string' ? { address: a, family: net.isIP(a) } : a))
    .filter((a) => a && typeof a.address === 'string');
  if (!list.length) {
    return hop === 0 ? { urlHealth: 'hallucinated', note: 'DNS: no such host' } : { urlHealth: 'unknown', note: 'redirect target: DNS: no such host' };
  }
  if (list.some((a) => isPrivateAddress(a.address))) return { urlHealth: 'unknown', note: REFUSED_PRIVATE };
  return { pinned: list.map((a) => ({ address: a.address, family: a.family === 6 || net.isIPv6(a.address) ? 6 : 4 })) };
}

/**
 * Request `start` with `method`, following redirects by hand.
 * @returns {Promise<{kind: 'response', status: number, contentType: string, finalUrl: string, body?: string}
 *   | {kind: 'result', urlHealth: string, note: string, finalUrl: string}
 *   | {kind: 'error', timeout: boolean, note: string, finalUrl: string}>}
 */
async function follow(start, method, o, wantBody, maxBody = o.maxBodyBytes) {
  let cur = start;
  for (let hop = 0; ; hop += 1) {
    const g = await guard(cur, o, hop);
    if (!g.pinned) return { kind: 'result', urlHealth: g.urlHealth, note: g.note, finalUrl: cur.href };
    let step;
    try {
      step = await withDeadline(o.timeoutMs, async (signal) => {
        const headers = { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8', 'accept-encoding': 'identity' };
        const res = await o.fetch(cur.href, { method, headers, redirect: 'manual', signal, pinned: g.pinned });
        const status = Number(res.status);
        const location = status >= 300 && status < 400 ? res.headers?.get?.('location') : null;
        const contentType = String(res.headers?.get?.('content-type') || '');
        if (location) {
          discard(res);
          return { status, location };
        }
        if (wantBody && method === 'GET' && status >= 200 && status < 300) return { status, contentType, body: await readBody(res, maxBody) };
        discard(res);
        return { status, contentType };
      });
    } catch (err) {
      return { kind: 'error', timeout: isTimeout(err), note: isTimeout(err) ? 'timeout' : `network error: ${errCode(err)}`, finalUrl: cur.href };
    }
    if (!step.location) return { kind: 'response', status: step.status, contentType: step.contentType, body: step.body, finalUrl: cur.href };
    if (hop >= o.maxRedirects) return { kind: 'result', urlHealth: 'unknown', note: 'too many redirects', finalUrl: cur.href };
    try {
      cur = new URL(step.location, cur);
    } catch {
      return { kind: 'result', urlHealth: 'unknown', note: 'redirect to an invalid URL', finalUrl: cur.href };
    }
  }
}

/** Ask the Wayback Machine for a snapshot. @returns {Promise<{archivedUrl: string|null} | null>} null = lookup failed */
async function waybackLookup(url, o) {
  const r = await follow(new URL(WAYBACK + encodeURIComponent(url)), 'GET', o, true, 64 * 1024);
  if (r.kind !== 'response' || r.status < 200 || r.status >= 300 || typeof r.body !== 'string') return null;
  let j;
  try {
    j = JSON.parse(r.body);
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object' || typeof j.archived_snapshots !== 'object' || j.archived_snapshots === null) return null;
  const c = j.archived_snapshots.closest;
  const ok = c && c.available === true && typeof c.url === 'string' && /^https?:\/\/web\.archive\.org\//.test(c.url) &&
    (c.status === undefined || /^2\d\d$/.test(String(c.status)));
  return { archivedUrl: ok ? c.url.replace(/^http:/, 'https:') : null };
}

const isTextual = (ct) => !ct || /text\/|html|xml|json/i.test(ct);

/**
 * Check one URL. Never throws.
 * @param {string} url
 * @param {{fetch?: Function, lookup?: Function, timeoutMs?: number, maxRedirects?: number, maxBodyBytes?: number,
 *   ports?: number[], archive?: boolean}} [opts]
 * @returns {Promise<{url: string, urlHealth: 'live'|'stale'|'hallucinated'|'blocked'|'unknown', httpStatus: number|null,
 *   finalUrl: string|null, archivedUrl: string|null, note: string|null}>}
 */
export async function checkUrl(url, opts = {}) {
  const out = { url: String(url ?? ''), urlHealth: 'unknown', httpStatus: null, finalUrl: null, archivedUrl: null, note: null };
  try {
    const o = normalizeOptions(opts);
    let u;
    try {
      u = new URL(out.url.trim());
    } catch {
      return { ...out, urlHealth: 'hallucinated', note: 'invalid URL' };
    }
    const head = await follow(u, 'HEAD', o, false);
    if (head.kind === 'result') return { ...out, urlHealth: head.urlHealth, note: head.note, finalUrl: head.finalUrl };
    if (head.kind === 'error' && head.timeout) return { ...out, note: head.note, finalUrl: head.finalUrl };
    const headOk = head.kind === 'response' && head.status >= 200 && head.status < 300;
    const r = headOk && !isTextual(head.contentType) ? head : await follow(headOk ? new URL(head.finalUrl) : u, 'GET', o, true);
    if (r.kind === 'result') return { ...out, urlHealth: r.urlHealth, note: r.note, finalUrl: r.finalUrl };
    if (r.kind === 'error') return { ...out, note: r.note, finalUrl: r.finalUrl };
    const base = { ...out, httpStatus: r.status, finalUrl: r.finalUrl };
    const s = r.status;
    let gone = s === 404 || s === 410;
    let note = null;
    if (s >= 200 && s < 300 && typeof r.body === 'string') {
      if (looksBlocked(r.body)) return { ...base, urlHealth: 'blocked', note: 'block or captcha page' };
      if (isTextual(r.contentType) && looksLikeNotFound(r.body)) {
        gone = true;
        note = 'soft 404: the page title says not found';
      } else if (isTextual(r.contentType) && !r.body.trim()) return { ...base, urlHealth: 'unknown', note: 'empty page' };
    }
    if (gone) {
      if (!o.archive) return { ...base, urlHealth: 'unknown', note: note ? `${note}; archive lookup skipped` : 'archive lookup skipped' };
      const w = await waybackLookup(out.url, o);
      if (!w) return { ...base, urlHealth: 'unknown', note: note ? `${note}; archive lookup failed` : 'archive lookup failed' };
      if (w.archivedUrl) return { ...base, urlHealth: 'stale', archivedUrl: w.archivedUrl, note };
      return { ...base, urlHealth: 'hallucinated', note: note ?? 'not found and never archived' };
    }
    if (s >= 200 && s < 300) return { ...base, urlHealth: 'live' };
    if (s === 401 || s === 403 || s === 429 || s === 451) return { ...base, urlHealth: 'blocked', note: `HTTP ${s}` };
    if (s >= 500 && s < 600) return { ...base, urlHealth: 'blocked', note: `HTTP ${s} (server error)` };
    return { ...base, urlHealth: 'unknown', note: s >= 300 && s < 400 ? `HTTP ${s} without a usable Location` : `HTTP ${s}` };
  } catch (err) {
    return { ...out, note: `check failed: ${err?.message || err}` };
  }
}

// ---------- many sources ----------

const GRADE = /^[A-D]$/;
const QUOTE_MAX = 1000;

/**
 * Check the URLs of many sources. Same URL → checked once. At most `concurrency` (4) requests at a
 * time and one at a time per host. With `network: false` nothing is fetched and `urlHealth` is null.
 * @param {{id: string, url?: string|null, evidence?: string, grade?: string, quote?: string|null}[]} sources
 * @param {object} [opts] `checkUrl` options plus `concurrency` and `network`
 * @returns {Promise<{sourceId: string, url: string|null, urlHealth: string|null, httpStatus: number|null,
 *   finalUrl: string|null, archivedUrl: string|null, grade: string|null, quote: string|null, note: string|null}[]>}
 */
export async function checkSources(sources, opts = {}) {
  const seen = new Set();
  const list = (Array.isArray(sources) ? sources : []).filter((s) => {
    if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !s.id || seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
  const urlOf = (s) => (typeof s.url === 'string' && s.url.trim() ? s.url.trim() : null);
  const results = new Map();
  if (opts.network !== false) {
    const byHost = new Map();
    for (const s of list) {
      const url = urlOf(s);
      if (!url || results.has(url)) continue;
      results.set(url, null);
      let host;
      try { host = new URL(url).hostname; } catch { host = url; }
      if (!byHost.has(host)) byHost.set(host, []);
      byHost.get(host).push(url);
    }
    const queue = [...byHost.values()];
    const limit = Math.max(1, Math.min(Number(opts.concurrency) || DEFAULTS.concurrency, queue.length));
    const worker = async () => {
      while (queue.length) {
        for (const url of queue.shift()) results.set(url, await checkUrl(url, opts));
      }
    };
    await Promise.all(Array.from({ length: limit }, worker));
  }
  return list.map((s) => {
    const url = urlOf(s);
    const r = url ? results.get(url) : null;
    const grade = typeof (s.evidence ?? s.grade) === 'string' ? String(s.evidence ?? s.grade).trim().toUpperCase() : '';
    let note = r ? r.note : null;
    if (!url) note = 'no URL on the source';
    else if (opts.network === false) note = 'not checked (no network)';
    return {
      sourceId: s.id,
      url,
      urlHealth: r ? r.urlHealth : null,
      httpStatus: r ? r.httpStatus : null,
      finalUrl: r ? r.finalUrl : null,
      archivedUrl: r ? r.archivedUrl : null,
      grade: GRADE.test(grade) ? grade : null,
      quote: typeof s.quote === 'string' && s.quote.trim() ? s.quote.trim().slice(0, QUOTE_MAX) : null,
      note,
    };
  });
}

/**
 * `evidence.checked` events for `checkSources` results; null fields are left out.
 * @param {object[]} results
 * @param {{agentId?: string}} [options] who checked (omitted when not given)
 */
export function evidenceEvents(results, { agentId } = {}) {
  return (Array.isArray(results) ? results : []).filter((r) => r && typeof r.sourceId === 'string').map((r) => {
    const data = { sourceId: r.sourceId };
    if (typeof r.url === 'string') data.url = r.url;
    if (URL_HEALTH.includes(r.urlHealth)) data.urlHealth = r.urlHealth;
    if (Number.isFinite(r.httpStatus)) data.httpStatus = r.httpStatus;
    if (typeof r.archivedUrl === 'string') data.archivedUrl = r.archivedUrl;
    if (typeof r.grade === 'string' && GRADE.test(r.grade)) data.grade = r.grade;
    if (typeof r.quote === 'string') data.quote = r.quote;
    if (typeof r.note === 'string') data.note = r.note;
    return agentId ? { type: 'evidence.checked', agentId, data } : { type: 'evidence.checked', data };
  });
}
