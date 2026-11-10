import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import {
  checkUrl, checkSources, evidenceEvents, isPrivateAddress, isLocalName, pinnedFetch, USER_AGENT,
  looksBlocked, looksLikeWordList, looksLikeUnextractedPdf, looksLikeNotFound,
} from '../../src/verify/url-health.js';

const PUBLIC = '93.184.216.34';
const HTML = '<html><head><title>Sony WH-1000XM6</title></head><body><p>£279.00. Free delivery.</p></body></html>';
const wayback = (url) => `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
const dnsError = (code) => Object.assign(new Error(code), { code });

/**
 * A fake network. `routes` maps "METHOD url" or "url" to {status, headers, body} or a function(init).
 * `dns` maps host → address list or Error. Unknown hosts resolve to a public address.
 */
function fakeNet(routes = {}, dns = {}) {
  const calls = [];
  const lookups = [];
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, init });
    const r = routes[`${init.method} ${url}`] ?? routes[url];
    if (r === undefined) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    if (typeof r === 'function') return r(init);
    const body = init.method === 'HEAD' || [204, 304].includes(r.status) ? null : r.body ?? '';
    return new Response(body, { status: r.status ?? 200, headers: { 'content-type': 'text/html; charset=utf-8', ...r.headers } });
  };
  const lookup = async (host) => {
    lookups.push(host);
    const v = dns[host];
    if (v instanceof Error) throw v;
    return (v ?? [PUBLIC]).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  return { fetch, lookup, calls, lookups };
}

test('2xx page with content is live (HEAD, then GET to read the page)', async () => {
  const url = 'https://shop.example.com/xm6';
  const net = fakeNet({ [url]: { status: 200, body: HTML } });
  const r = await checkUrl(url, net);
  assert.deepEqual(r, { url, urlHealth: 'live', httpStatus: 200, finalUrl: url, archivedUrl: null, note: null });
  assert.deepEqual(net.calls.map((c) => c.method), ['HEAD', 'GET']);
  assert.equal(net.calls[0].init.headers['user-agent'], USER_AGENT);
  assert.match(USER_AGENT, /^mas-office-url-check\/\d+\.\d+\.\d+/);
  assert.equal(net.calls[0].init.redirect, 'manual');
  assert.deepEqual(net.calls[0].init.pinned, [{ address: PUBLIC, family: 4 }]);
});

test('HEAD rejected → GET decides; a 2xx non-text HEAD needs no GET', async () => {
  const url = 'https://a.example.com/page';
  const net = fakeNet({ [`HEAD ${url}`]: { status: 405 }, [`GET ${url}`]: { status: 200, body: HTML } });
  assert.equal((await checkUrl(url, net)).urlHealth, 'live');
  const pdf = 'https://a.example.com/paper.pdf';
  const net2 = fakeNet({ [pdf]: { status: 200, headers: { 'content-type': 'application/pdf' } } });
  const r = await checkUrl(pdf, net2);
  assert.equal(r.urlHealth, 'live');
  assert.deepEqual(net2.calls.map((c) => c.method), ['HEAD']);
});

test('HEAD 404 but GET 200 is live (servers that mishandle HEAD)', async () => {
  const url = 'https://a.example.com/x';
  const net = fakeNet({ [`HEAD ${url}`]: { status: 404 }, [`GET ${url}`]: { status: 200, body: HTML } });
  assert.equal((await checkUrl(url, net)).urlHealth, 'live');
});

test('404 / 410 with a Wayback snapshot → stale', async () => {
  const url = 'https://gone.example.com/offer';
  const snap = 'http://web.archive.org/web/20260101000000/https://gone.example.com/offer';
  const net = fakeNet({
    [url]: { status: 404, body: 'nope' },
    [wayback(url)]: { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archived_snapshots: { closest: { available: true, url: snap, status: '200' } } }) },
  });
  const r = await checkUrl(url, net);
  assert.equal(r.urlHealth, 'stale');
  assert.equal(r.httpStatus, 404);
  assert.equal(r.archivedUrl, snap.replace('http:', 'https:'));
});

test('404 / 410 without a snapshot → hallucinated; lookup failure or disabled → unknown', async () => {
  const url = 'https://gone.example.com/never';
  const none = fakeNet({ [url]: { status: 410 }, [wayback(url)]: { status: 200, body: '{"archived_snapshots": {}}' } });
  const r = await checkUrl(url, none);
  assert.equal(r.urlHealth, 'hallucinated');
  assert.equal(r.httpStatus, 410);
  const failing = fakeNet({ [url]: { status: 404 }, [wayback(url)]: { status: 503 } });
  assert.deepEqual([(await checkUrl(url, failing)).urlHealth, (await checkUrl(url, failing)).note], ['unknown', 'archive lookup failed']);
  const badJson = fakeNet({ [url]: { status: 404 }, [wayback(url)]: { status: 200, body: 'not json' } });
  assert.equal((await checkUrl(url, badJson)).urlHealth, 'unknown');
  const nonArchive = fakeNet({ [url]: { status: 404 }, [wayback(url)]: { status: 200, body: JSON.stringify({ archived_snapshots: { closest: { available: true, url: 'https://evil.example/x' } } }) } });
  assert.equal((await checkUrl(url, nonArchive)).urlHealth, 'hallucinated');
  const off = fakeNet({ [url]: { status: 404 } });
  const r2 = await checkUrl(url, { ...off, archive: false });
  assert.deepEqual([r2.urlHealth, r2.note], ['unknown', 'archive lookup skipped']);
  assert.ok(!off.calls.some((c) => c.url.startsWith('https://archive.org/')));
});

test('soft 404: a 200 whose title says not found goes through the archive rule', async () => {
  const url = 'https://soft.example.com/item';
  const net = fakeNet({ [url]: { status: 200, body: '<html><title>Page Not Found | Shop</title><body>Sorry</body></html>' }, [wayback(url)]: { status: 200, body: '{"archived_snapshots":{}}' } });
  const r = await checkUrl(url, net);
  assert.equal(r.urlHealth, 'hallucinated');
  assert.match(r.note, /soft 404/);
});

test('invalid URLs and NXDOMAIN are hallucinated; other DNS failures unknown', async () => {
  for (const bad of ['not a url', 'http://', '', 'https://exa mple.com/']) {
    assert.equal((await checkUrl(bad, fakeNet())).urlHealth, 'hallucinated', bad);
  }
  const nx = fakeNet({}, { 'made-up-shop.example': dnsError('ENOTFOUND') });
  assert.deepEqual(await checkUrl('https://made-up-shop.example/x', nx), {
    url: 'https://made-up-shop.example/x', urlHealth: 'hallucinated', httpStatus: null, finalUrl: 'https://made-up-shop.example/x', archivedUrl: null, note: 'DNS: no such host',
  });
  assert.equal(nx.calls.length, 0);
  assert.equal((await checkUrl('https://empty.example/', fakeNet({}, { 'empty.example': [] }))).urlHealth, 'hallucinated');
  const again = await checkUrl('https://flaky.example/', fakeNet({}, { 'flaky.example': dnsError('EAI_AGAIN') }));
  assert.deepEqual([again.urlHealth, again.note], ['unknown', 'DNS lookup failed (EAI_AGAIN)']);
});

test('401, 403, 429, 451 and 5xx are blocked; other statuses unknown', async () => {
  for (const status of [401, 403, 429, 451, 500, 503]) {
    const url = `https://b.example.com/${status}`;
    const r = await checkUrl(url, fakeNet({ [url]: { status } }));
    assert.equal(r.urlHealth, 'blocked', String(status));
    assert.equal(r.httpStatus, status);
  }
  const url = 'https://b.example.com/400';
  assert.deepEqual(await checkUrl(url, fakeNet({ [url]: { status: 400 } })), {
    url, urlHealth: 'unknown', httpStatus: 400, finalUrl: url, archivedUrl: null, note: 'HTTP 400',
  });
});

test('2xx block or captcha page → blocked; empty page → unknown', async () => {
  const url = 'https://c.example.com/';
  const cf = '<html><head><title>Attention Required! | Cloudflare</title></head><body>Sorry, you have been blocked</body></html>';
  assert.equal((await checkUrl(url, fakeNet({ [url]: { status: 200, body: cf } }))).urlHealth, 'blocked');
  const empty = await checkUrl(url, fakeNet({ [url]: { status: 200, body: '  ' } }));
  assert.deepEqual([empty.urlHealth, empty.note], ['unknown', 'empty page']);
});

test('timeouts and network errors are unknown', async () => {
  const url = 'https://slow.example.com/';
  const hang = fakeNet({ [url]: () => new Promise(() => {}) });
  const t0 = Date.now();
  const r = await checkUrl(url, { ...hang, timeoutMs: 50 });
  assert.deepEqual([r.urlHealth, r.note], ['unknown', 'timeout']);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(hang.calls.length, 1, 'no GET retry after a HEAD timeout');
  const slowDns = await checkUrl(url, { fetch: hang.fetch, lookup: () => new Promise(() => {}), timeoutMs: 50 });
  assert.equal(slowDns.urlHealth, 'unknown');
  const refused = await checkUrl('https://down.example.com/', fakeNet());
  assert.deepEqual([refused.urlHealth, refused.note], ['unknown', 'network error: ECONNREFUSED']);
});

test('redirects are followed (relative too), capped at 5, and re-validated', async () => {
  const a = 'https://r.example.com/a';
  const net = fakeNet({
    [a]: { status: 301, headers: { location: '/b' } },
    'https://r.example.com/b': { status: 302, headers: { location: 'https://other.example.org/c' } },
    'https://other.example.org/c': { status: 200, body: HTML },
  });
  const r = await checkUrl(a, net);
  assert.deepEqual([r.urlHealth, r.finalUrl], ['live', 'https://other.example.org/c']);
  assert.ok(net.lookups.includes('other.example.org'));

  const loop = fakeNet({ 'https://loop.example.com/': { status: 302, headers: { location: 'https://loop.example.com/' } } });
  const l = await checkUrl('https://loop.example.com/', loop);
  assert.deepEqual([l.urlHealth, l.note], ['unknown', 'too many redirects']);
  assert.equal(loop.calls.filter((c) => c.method === 'HEAD').length, 6);

  const toNowhere = fakeNet({ 'https://r.example.com/x': { status: 301, headers: { location: 'https://gone-domain.example/' } } }, { 'gone-domain.example': dnsError('ENOTFOUND') });
  const n = await checkUrl('https://r.example.com/x', toNowhere);
  assert.deepEqual([n.urlHealth, n.note], ['unknown', 'redirect target: DNS: no such host']);
});

test('redirects to private hosts are refused before any request', async () => {
  const targets = ['http://127.0.0.1/admin', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://localhost:8080/', 'http://rebind.example/'];
  for (const target of targets) {
    const start = 'https://r.example.com/go';
    const net = fakeNet({ [start]: { status: 302, headers: { location: target } } }, { 'rebind.example': ['10.1.2.3'] });
    const r = await checkUrl(start, net);
    assert.equal(r.urlHealth, 'unknown', target);
    assert.equal(r.note, 'refused: private address', target);
    assert.ok(net.calls.every((c) => c.url === start), `${target} was fetched`);
  }
});

test('SSRF: private, local and odd URLs are refused and never fetched', async () => {
  const cases = {
    'http://127.0.0.1/': 'refused: private address',
    'http://2130706433/': 'refused: private address',
    'http://0x7f.1/': 'refused: private address',
    'http://0177.0.0.1/': 'refused: private address',
    'http://127.1/': 'refused: private address',
    'http://0/': 'refused: private address',
    'http://0.0.0.0/': 'refused: private address',
    'http://10.0.0.5/': 'refused: private address',
    'http://172.16.3.4/': 'refused: private address',
    'http://172.31.255.255/': 'refused: private address',
    'http://192.168.1.1/': 'refused: private address',
    'http://169.254.169.254/latest/meta-data/': 'refused: private address',
    'http://100.100.100.200/': 'refused: private address',
    'http://100.64.0.1/': 'refused: private address',
    'http://224.0.0.1/': 'refused: private address',
    'http://255.255.255.255/': 'refused: private address',
    'http://198.18.0.1/': 'refused: private address',
    'http://[::1]/': 'refused: private address',
    'http://[::]/': 'refused: private address',
    'http://[::ffff:127.0.0.1]/': 'refused: private address',
    'http://[::ffff:8.8.8.8]/': 'refused: private address',
    'http://[fd00:ec2::254]/': 'refused: private address',
    'http://[fe80::1]/': 'refused: private address',
    'http://[ff02::1]/': 'refused: private address',
    'http://[2606:4700:4700::1111]/': 'refused: IPv6 literal',
    'http://localhost/': 'refused: private address',
    'http://LOCALHOST./': 'refused: private address',
    'http://app.localhost/': 'refused: private address',
    'http://printer.local/': 'refused: private address',
    'http://metadata.google.internal/computeMetadata/v1/': 'refused: private address',
    'http://router.home.arpa/': 'refused: private address',
    'http://intranet/': 'refused: private address',
    'http://a@127.0.0.1/': 'refused: private address',
    'http://user:pw@example.com/': 'refused: credentials in URL',
    'http://example.com:22/': 'refused: port 22 not allowed',
    'https://example.com:6379/': 'refused: port 6379 not allowed',
    'file:///etc/passwd': 'refused: only http and https',
    'ftp://example.com/x': 'refused: only http and https',
    'javascript:alert(1)': 'refused: only http and https',
    'data:text/html,hi': 'refused: only http and https',
    'gopher://example.com/': 'refused: only http and https',
  };
  for (const [url, note] of Object.entries(cases)) {
    const net = fakeNet();
    const r = await checkUrl(url, net);
    assert.equal(r.urlHealth, 'unknown', url);
    assert.equal(r.note, note, url);
    assert.equal(net.calls.length, 0, `${url} was fetched`);
  }
});

test('SSRF: names that resolve to any private address are refused (DNS rebinding)', async () => {
  const dns = {
    '127.0.0.1.nip.io': ['127.0.0.1'],
    'mixed.example': [PUBLIC, '10.0.0.1'],
    'v6-loop.example': ['::1'],
    'v6-mapped.example': ['::ffff:7f00:1'],
    'v6-ula.example': ['fd12:3456::1'],
    'v6-nat64.example': ['64:ff9b::a00:1'],
    'meta.example': ['169.254.169.254'],
  };
  for (const host of Object.keys(dns)) {
    const net = fakeNet({}, dns);
    const r = await checkUrl(`https://${host}/`, net);
    assert.deepEqual([r.urlHealth, r.note], ['unknown', 'refused: private address'], host);
    assert.equal(net.calls.length, 0, host);
  }
  const ok = fakeNet({ 'https://v6.example/': { status: 200, body: HTML }, 'http://example.com:8080/': { status: 200, body: HTML } }, { 'v6.example': ['2606:4700::6810:84e5'] });
  assert.equal((await checkUrl('https://v6.example/', ok)).urlHealth, 'live');
  assert.deepEqual(ok.calls[0].init.pinned, [{ address: '2606:4700::6810:84e5', family: 6 }]);
  assert.equal((await checkUrl('http://example.com:8080/', ok)).urlHealth, 'live');
});

test('isPrivateAddress and isLocalName', () => {
  for (const ip of ['8.8.8.8', PUBLIC, '2606:4700:4700::1111', '2a00:1450:4009:81f::200e']) assert.equal(isPrivateAddress(ip), false, ip);
  for (const ip of ['127.0.0.1', '10.255.0.1', '172.20.0.1', '192.168.0.1', '169.254.1.1', '100.127.255.255', '0.1.2.3', '192.0.2.5',
    '203.0.113.9', '240.0.0.1', '::', '::1', '::ffff:8.8.8.8', '::ffff:127.0.0.1', '::8.8.8.8', '64:ff9b::808:808', 'fc00::1', 'fdff::1',
    'fe80::1', 'fe80::1%en0', 'fec0::1', 'ff00::1', '2001:db8::1', '2001::1', '2002:7f00:1::1', '[::1]', 'not-an-ip', '', null]) {
    assert.equal(isPrivateAddress(ip), true, String(ip));
  }
  assert.equal(isPrivateAddress('100.63.255.255'), false);
  assert.equal(isPrivateAddress('172.32.0.1'), false);
  for (const h of ['localhost', 'a.localhost', 'x.local', 'y.internal', 'z.lan', 'r.home.arpa', 'single', '']) assert.equal(isLocalName(h), true, h);
  for (const h of ['example.com', 'local.example.com', 'internal.example.org']) assert.equal(isLocalName(h), false, h);
});

test('the body is read only up to maxBodyBytes', async () => {
  const url = 'https://big.example.com/';
  let pulled = 0;
  const chunk = new Uint8Array(64 * 1024).fill(97);
  const net = fakeNet({
    [`HEAD ${url}`]: { status: 200 },
    [`GET ${url}`]: () => new Response(new ReadableStream({
      pull(controller) {
        pulled += 1;
        if (pulled > 50) controller.close();
        else controller.enqueue(chunk);
      },
    }), { status: 200, headers: { 'content-type': 'text/html' } }),
  });
  const r = await checkUrl(url, { ...net, maxBodyBytes: 128 * 1024 });
  assert.equal(r.urlHealth, 'live');
  assert.ok(pulled <= 4, `pulled ${pulled} chunks`);
});

test('page heuristics (adapted from gpt-researcher)', () => {
  assert.equal(looksBlocked('<title>Just a moment...</title> Checking your browser before accessing example.com'), true);
  assert.equal(looksBlocked(`${'x'.repeat(6000)} please verify you are a human`), false, 'only the first 5000 characters');
  assert.equal(looksBlocked('An article about outages: the site was temporarily unavailable.'), false);
  assert.equal(looksLikeWordList('apple banana cherry '.repeat(15_000)), true);
  assert.equal(looksLikeWordList('A sentence. '.repeat(20_000)), false);
  assert.equal(looksLikeWordList('short list of words'), false);
  assert.equal(looksLikeUnextractedPdf('%PDF-1.7 ...'), true);
  assert.equal(looksLikeUnextractedPdf('1 0 obj << /Filter /FlateDecode >> stream ... endstream endobj'), true);
  assert.equal(looksLikeUnextractedPdf('The trailer for the film was released.'), false);
  assert.equal(looksLikeNotFound('<html><head><title>404 - Not here</title>'), true);
  assert.equal(looksLikeNotFound('<html><head><title>Sony XM6</title></head><body>404 errors explained</body>'), false);
});

test('checkSources: dedupe by URL, at most 4 at a time, one at a time per host', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const perHost = new Map();
  let maxPerHost = 0;
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    const host = new URL(url).hostname;
    inFlight += 1;
    perHost.set(host, (perHost.get(host) ?? 0) + 1);
    maxInFlight = Math.max(maxInFlight, inFlight);
    maxPerHost = Math.max(maxPerHost, perHost.get(host));
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    perHost.set(host, perHost.get(host) - 1);
    return new Response(init.method === 'HEAD' ? null : HTML, { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const lookup = async () => [{ address: PUBLIC, family: 4 }];
  const sources = [];
  for (let h = 0; h < 8; h += 1) for (let p = 0; p < 3; p += 1) sources.push({ id: `s${h}-${p}`, url: `https://h${h}.example.com/${p}`, evidence: 'a', quote: ' "q" ' });
  sources.push({ id: 'dup', url: 'https://h0.example.com/0' }, { id: 's0-0', url: 'https://ignored.example.com/' }, { id: 'nourl', evidence: 'D' });
  const results = await checkSources(sources, { fetch, lookup });
  assert.equal(results.length, 26);
  assert.ok(maxInFlight <= 4 && maxInFlight >= 2, `max in flight ${maxInFlight}`);
  assert.equal(maxPerHost, 1);
  assert.equal(calls.filter((c) => c === 'HEAD https://h0.example.com/0').length, 1);
  assert.ok(!calls.some((c) => c.includes('ignored')));
  const first = results[0];
  assert.deepEqual(first, { sourceId: 's0-0', url: 'https://h0.example.com/0', urlHealth: 'live', httpStatus: 200, finalUrl: 'https://h0.example.com/0', archivedUrl: null, grade: 'A', quote: '"q"', note: null });
  assert.equal(results.find((r) => r.sourceId === 'dup').urlHealth, 'live');
  assert.deepEqual(results.at(-1), { sourceId: 'nourl', url: null, urlHealth: null, httpStatus: null, finalUrl: null, archivedUrl: null, grade: 'D', quote: null, note: 'no URL on the source' });
});

test('checkSources with network: false fetches nothing', async () => {
  const net = fakeNet();
  const r = await checkSources([{ id: 'a', url: 'https://x.example.com/', evidence: 'B' }], { ...net, network: false });
  assert.deepEqual(r, [{ sourceId: 'a', url: 'https://x.example.com/', urlHealth: null, httpStatus: null, finalUrl: null, archivedUrl: null, grade: 'B', quote: null, note: 'not checked (no network)' }]);
  assert.equal(net.calls.length + net.lookups.length, 0);
});

test('evidenceEvents leaves out null fields', () => {
  assert.deepEqual(evidenceEvents([
    { sourceId: 'a', url: 'https://x/', urlHealth: 'stale', httpStatus: 404, finalUrl: 'https://x/', archivedUrl: 'https://web.archive.org/x', grade: 'A', quote: 'q', note: null },
    { sourceId: 'b', url: null, urlHealth: null, httpStatus: null, grade: 'E', note: 'no URL on the source' },
    { nope: true },
  ], { agentId: 'lead' }), [
    { type: 'evidence.checked', agentId: 'lead', data: { sourceId: 'a', url: 'https://x/', urlHealth: 'stale', httpStatus: 404, archivedUrl: 'https://web.archive.org/x', grade: 'A', quote: 'q' } },
    { type: 'evidence.checked', agentId: 'lead', data: { sourceId: 'b', note: 'no URL on the source' } },
  ]);
});

test('default transport connects only to the pinned address (local server, no DNS)', async () => {
  const gz = zlib.gzipSync(Buffer.from(HTML));
  const server = http.createServer((req, res) => {
    if (req.url === '/gz') {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      res.end(gz);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain', 'x-host': req.headers.host, 'x-ua': req.headers['user-agent'] });
    res.end('hello');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    // "rebind.invalid" cannot resolve; the request still reaches the server because the socket uses the pinned address.
    const res = await pinnedFetch(`http://rebind.invalid:${port}/`, { headers: { 'user-agent': USER_AGENT }, pinned: [{ address: '127.0.0.1', family: 4 }] });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-host'), `rebind.invalid:${port}`);
    assert.equal(res.headers.get('x-ua'), USER_AGENT);
    let text = '';
    for await (const c of res.body) text += c;
    assert.equal(text, 'hello');
    const gzRes = await pinnedFetch(`http://any.invalid:${port}/gz`, { pinned: [{ address: '127.0.0.1', family: 4 }] });
    let html = '';
    for await (const c of gzRes.body) html += c;
    assert.equal(html, HTML);
    await assert.rejects(pinnedFetch(`http://x.invalid:${port}/`, {}), /no checked address/);
  } finally {
    server.close();
  }
});
