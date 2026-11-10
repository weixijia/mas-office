import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startServer, resolveRequestPath, parseEventsBody } from '../../src/cli/server.js';
import { tmpDir, write, readJson } from './helpers.js';

let ws;
let srv;

/**
 * A raw request: `path` is sent exactly as given (fetch would normalise `..`).
 * `chunks` sends the body with chunked encoding (no Content-Length).
 */
function request(urlPath, { method = 'GET', headers = {}, body, chunks } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: urlPath, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    for (const chunk of chunks ?? []) req.write(chunk);
    req.end(body);
  });
}

const post = (project, body, type = 'application/json') => request(`/v0/events?project=${project}`, {
  method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body),
});

/** Open the SSE stream and resolve with everything received once `predicate(buffer)` is true. */
function sseUntil(predicate, { timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const req = http.get({ host: '127.0.0.1', port: srv.port, path: '/v0/stream' }, (res) => {
      buffer += `content-type: ${res.headers['content-type']}\n`;
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buffer += c;
        if (predicate(buffer)) { clearTimeout(timer); req.destroy(); resolve(buffer); }
      });
    });
    const timer = setTimeout(() => { req.destroy(); reject(new Error(`SSE timeout; got: ${buffer}`)); }, timeout);
    req.on('error', () => {});
  });
}

before(async () => {
  ws = tmpDir();
  write(path.join(ws, 'home/projects.json'), { current: null, projects: [] });
  write(path.join(ws, 'proj/mas/state.json'), { phase: 'done' });
  write(path.join(ws, 'proj/mas/status/lead.json'), { state: 'done' });
  write(path.join(ws, 'proj/notes.md'), '# hi');
  write(path.join(ws, 'proj/page.html'), '<script>alert(1)</script>');
  write(path.join(ws, 'proj/pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  write(path.join(ws, 'proj/feed.xml'), '<x/>');
  write(path.join(ws, '.secret'), 'no');
  fs.symlinkSync(path.dirname(ws), path.join(ws, 'outside'));
  srv = await startServer({ workspace: ws, port: 0 });
});

after(async () => {
  await srv.close();
  fs.rmSync(ws, { recursive: true, force: true });
});

test('health, redirects and the panel', async () => {
  const health = await request('/v0/health');
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.text), { ok: true, spec: '0.2' });
  assert.equal((await request('/')).headers.location, '/office/');
  assert.equal((await request('/office')).headers.location, '/office/');
  const index = await request('/office/');
  assert.equal(index.status, 200);
  assert.match(index.headers['content-type'], /^text\/html/);
  assert.match(index.text, /<html/i);
  const app = await request('/office/app.js');
  assert.match(app.headers['content-type'], /^text\/javascript/);
  const csp = "script-src 'self'; object-src 'none'; base-uri 'none'";
  assert.equal(index.headers['content-security-policy'], csp);
  assert.equal(app.headers['content-security-policy'], csp);
  assert.equal(index.headers['x-content-type-options'], 'nosniff');
  assert.equal((await request('/office/fonts')).headers.location, '/office/fonts/');
  assert.equal((await request('/office/tests/model.test.js')).status, 200, 'the panel folder is served as is');
  assert.equal((await request('/v0/nope')).status, 404);
});

test('workspace files are read-only with content types', async () => {
  const state = await request('/proj/mas/state.json');
  assert.equal(state.status, 200);
  assert.match(state.headers['content-type'], /^application\/json/);
  assert.equal(state.headers['cache-control'], 'no-store');
  assert.equal(state.headers['x-content-type-options'], 'nosniff');
  assert.equal(state.headers['content-security-policy'], undefined, 'the panel fetches .json data');
  const notes = await request('/proj/notes.md');
  assert.match(notes.headers['content-type'], /^text\/markdown/);
  assert.equal(notes.headers['content-security-policy'], "sandbox; default-src 'none'");
  assert.equal(notes.headers['x-content-type-options'], 'nosniff');
  assert.equal((await request('/proj/mas/state.json', { method: 'PUT', body: '{}' })).status, 405);
  assert.equal((await request('/proj/mas/state.json', { method: 'HEAD' })).status, 200);
});

test('agent-written HTML, SVG and XML are never rendered: text/plain in a sandbox', async () => {
  for (const file of ['/proj/page.html', '/proj/pic.svg', '/proj/feed.xml']) {
    const res = await request(file);
    assert.equal(res.status, 200, file);
    assert.match(res.headers['content-type'], /^text\/plain/, file);
    assert.equal(res.headers['content-security-policy'], "sandbox; default-src 'none'", file);
    assert.equal(res.headers['x-content-type-options'], 'nosniff', file);
  }
});

test('directory redirects always have one leading slash (no open redirect)', async () => {
  const cases = { '//proj': '/proj/', '//proj/mas': '/proj/mas/', '///proj//mas': '/proj/mas/', '/office//fonts': '/office/fonts/' };
  for (const [from, to] of Object.entries(cases)) {
    const res = await request(from);
    assert.equal(res.status, 301, from);
    assert.equal(res.headers.location, to, from);
  }
});

test('path traversal, hidden files and escaping symlinks are refused', async () => {
  const attempts = [
    '/..%2f..%2fetc/passwd', '/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/proj/..%2f..%2f..%2fetc/passwd',
    '/%2e%2e%5c%2e%2e%5cetc%5cpasswd', '/proj/%00', '/.secret', '/%2esecret', '/outside/', '/outside/anything',
    '/office/..%2f..%2fpackage.json', '/office/../../package.json', '/%E0%A4%A', '//etc/passwd', '/C:/Windows/win.ini',
  ];
  for (const attempt of attempts) {
    const res = await request(attempt);
    assert.ok(res.status === 404 || res.status === 400, `${attempt} → ${res.status}`);
    assert.doesNotMatch(res.text, /root:|"name"/, attempt);
  }
  const root = '/srv/ws';
  assert.equal(resolveRequestPath(root, '/a/../../b'), null);
  assert.equal(resolveRequestPath(root, '/a%2f..%2f..%2fb'), null);
  assert.deepEqual(resolveRequestPath(root, '/a/b.json'), { abs: path.join(root, 'a', 'b.json'), rel: 'a/b.json', dir: false });
});

test('a missing .js twin is built from its .json', async () => {
  const res = await request('/proj/mas/state.js');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/javascript/);
  const window = {};
  new Function('window', res.text)(window);
  assert.deepEqual(window.MAS_STATE, { phase: 'done' });
  const status = await request('/proj/mas/status/lead.js');
  new Function('window', status.text)(window);
  assert.deepEqual(window.MAS_STATUS, { lead: { state: 'done' } });
  const home = await request('/home/projects.js');
  new Function('window', home.text)(window);
  assert.deepEqual(window.MAS_HOME, { current: null, projects: [] });
  assert.equal((await request('/proj/notes.js')).status, 404, 'only snapshot documents get twins');
  assert.equal((await request('/proj/mas/missing.js')).status, 404);
});

test('POST /v0/events assigns seq, writes the log and snapshots, and streams "mas" events', async () => {
  const stream = sseUntil((b) => b.includes('"type":"run.finished"'));
  await new Promise((r) => setTimeout(r, 100)); // let the stream connect
  const first = await post('live', { type: 'run.started', seq: 99, data: { title: 'Live' } });
  assert.equal(first.status, 200);
  assert.deepEqual(JSON.parse(first.text), { accepted: 1, lastSeq: 1 });
  const second = await post('live', [
    { type: 'agent.status', agentId: 'finder', data: { state: 'working', say: 'Searching', progress: 30 } },
    { type: 'message', agentId: 'finder', ts: '2026-11-06T10:00:00Z', data: { text: 'Found 3' } },
  ]);
  assert.deepEqual(JSON.parse(second.text), { accepted: 2, lastSeq: 3 });
  const ndjson = await post('live', '{"type":"result","data":{"markdown":"ok"}}\n{"type":"run.finished"}\n', 'application/x-ndjson');
  assert.deepEqual(JSON.parse(ndjson.text), { accepted: 2, lastSeq: 5 });

  const log = fs.readFileSync(path.join(ws, 'live/mas/events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((e) => e.seq), [1, 2, 3, 4, 5]);
  assert.ok(log.every((e) => e.v === '0.2' && typeof e.ts === 'string'));
  assert.equal(log[2].ts, '2026-11-06T10:00:00Z', 'a given ts is kept');
  assert.equal(readJson(path.join(ws, 'live/mas/state.json')).phase, 'done');
  assert.equal(readJson(path.join(ws, 'live/mas/status/finder.json')).say, 'Found 3');
  assert.equal(readJson(path.join(ws, 'live/outputs/result.json')).markdown, 'ok');
  assert.equal(readJson(path.join(ws, 'home/projects.json')).current, 'live');

  const sse = await stream;
  assert.match(sse, /^content-type: text\/event-stream/);
  const messages = [...sse.matchAll(/event: mas\nid: (\d+)\ndata: (.*)\n/g)].map((m) => [Number(m[1]), JSON.parse(m[2])]);
  assert.deepEqual(messages.map(([id, d]) => [id, d.event.type]),
    [[1, 'run.started'], [2, 'agent.status'], [3, 'message'], [4, 'result'], [5, 'run.finished']]);
  for (const [id, data] of messages) {
    assert.deepEqual(Object.keys(data), ['project', 'event'], 'spec §5: {"project", "event"}');
    assert.equal(data.project, 'live');
    assert.equal(data.event.seq, id);
  }
});

test('POST rejects bad batches as a whole, wrong types, bad projects and big bodies', async () => {
  const bad = await post('strict', [{ type: 'run.started' }, { type: 'message', data: {} }, { type: 'handoff', agentId: '../x', data: { to: 'y' } }]);
  assert.equal(bad.status, 400);
  const body = JSON.parse(bad.text);
  assert.match(body.error, /none of this batch was accepted/);
  assert.deepEqual(body.invalid.map((x) => x.index), [1, 2]);
  assert.ok(!fs.existsSync(path.join(ws, 'strict/mas/events.jsonl')), 'nothing written');
  assert.equal((await post('strict', 'not json\nat all', 'application/x-ndjson')).status, 400);
  assert.equal((await post('strict', '', 'application/json')).status, 400);
  assert.equal((await post('strict', '{}', 'text/plain')).status, 415);
  assert.equal((await post('../escape', '{}')).status, 400);
  assert.equal((await post('Upper', '{}')).status, 400);
  assert.equal((await request('/v0/events?project=x')).status, 405);
});

test('bodies over 1 MB get a 413 the client can read, with or without Content-Length', async () => {
  const text = JSON.stringify([{ type: 'message', data: { text: 'x'.repeat(1024 * 1024) } }]);
  for (let i = 0; i < 3; i += 1) { // the body is drained before the reply, so this never races
    const big = await post('strict', text);
    assert.equal(big.status, 413);
    assert.match(JSON.parse(big.text).error, /larger than 1 MB/);
    assert.equal(big.headers.connection, 'close');
  }
  const chunked = await request('/v0/events?project=strict', {
    method: 'POST', headers: { 'content-type': 'application/json' }, chunks: Array(5).fill('y'.repeat(300 * 1024)),
  });
  assert.equal(chunked.status, 413);
  assert.ok(!fs.existsSync(path.join(ws, 'strict/mas/events.jsonl')), 'nothing written');
  assert.equal((await request('/v0/health')).status, 200, 'the server keeps serving');
});

test('Host headers other than loopback are refused (DNS rebinding)', async () => {
  assert.equal((await request('/v0/health', { headers: { host: 'evil.example:4747' } })).status, 403);
  assert.equal((await request('/v0/health', { headers: { host: `localhost:${srv.port}` } })).status, 200);
});

test('file changes are streamed as "change" events (polling fallback)', async () => {
  const pollWs = tmpDir();
  const polling = await startServer({ workspace: pollWs, port: 0, poll: true });
  try {
    assert.equal(polling.watchMode, 'poll');
    const got = new Promise((resolve, reject) => {
      const req = http.get(`${polling.url}/v0/stream`, (res) => {
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          buffer += c;
          if (buffer.includes('a/mas/state.json')) { req.destroy(); resolve(buffer); }
        });
      });
      req.on('error', () => {});
      setTimeout(() => { req.destroy(); reject(new Error('no change event')); }, 5000);
    });
    await new Promise((r) => setTimeout(r, 200));
    write(path.join(pollWs, 'a/mas/state.json'), { phase: 'running' });
    write(path.join(pollWs, 'a/mas/.tmp-ignored'), 'x');
    const buffer = await got;
    assert.match(buffer, /event: change\ndata: {"path":"a\/mas\/state\.json"}/);
    assert.doesNotMatch(buffer, /tmp-ignored/);
  } finally {
    await polling.close();
    fs.rmSync(pollWs, { recursive: true, force: true });
  }
});

test('parseEventsBody accepts an object, an array or NDJSON', () => {
  assert.deepEqual(parseEventsBody('{"type":"a"}'), [{ type: 'a' }]);
  assert.deepEqual(parseEventsBody('[{"type":"a"},{"type":"b"}]'), [{ type: 'a' }, { type: 'b' }]);
  assert.deepEqual(parseEventsBody('{"type":"a"}\r\n\n{"type":"b"}\n'), [{ type: 'a' }, { type: 'b' }]);
  assert.throws(() => parseEventsBody('  '), /Empty body/);
  assert.throws(() => parseEventsBody('{"type":"a"}\nnope'), /line 2/);
});

// ---- Protocol 0.2: token, commands, replay (docs/design/runtime.md §3) ----

const bearer = () => ({ authorization: `Bearer ${srv.token}` });
const command = (project, body, headers = bearer()) => request(`/v0/commands?project=${project}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const openRequest = (project, requestId, extra = {}) => post(project, [
  { type: 'run.started', data: { title: 'T' } },
  { type: 'request.opened', agentId: 'finder', data: { requestId, kind: 'approval', title: 'Search the web?', ...extra } },
]);

test('session reports whether the caller holds the token', async () => {
  const anon = JSON.parse((await request('/v0/session')).text);
  assert.equal(anon.token, false);
  assert.equal(anon.runtime, false);
  const mine = JSON.parse((await request('/v0/session', { headers: bearer() })).text);
  assert.equal(mine.token, true);
  const wrong = JSON.parse((await request('/v0/session', { headers: { authorization: 'Bearer nope' } })).text);
  assert.equal(wrong.token, false);
});

test('commands need the token', async () => {
  const res = await command('cmd-a', { type: 'command.message', agentId: 'finder', data: { text: 'hi' } }, {});
  assert.equal(res.status, 401);
  assert.equal(fs.existsSync(path.join(ws, 'cmd-a')), false);
});

test('a malformed command is refused and nothing is logged', async () => {
  for (const body of [
    { type: 'command.ack', data: { cmdId: 'x', status: 'applied' } },
    { type: 'command.message', agentId: 'finder', data: {} },
    { type: 'command.message', agentId: '../x', data: { text: 'hi' } },
    { type: 'command.message', agentId: 'finder', data: { text: 'hi', delivery: 'now' } },
    { type: 'command.respond', agentId: 'finder', data: { requestId: 'r', outcome: 'expired' } },
    { type: 'command.interrupt', agentId: 'finder', data: { scope: 'world' } },
    { type: 'command.message', agentId: 'finder', data: { text: 'hi', cmdId: 'a b' } },
  ]) {
    assert.equal((await command('cmd-bad', body)).status, 400, JSON.stringify(body));
  }
  assert.equal(fs.existsSync(path.join(ws, 'cmd-bad')), false);
});

test('without a runtime a message goes to the mailbox and is acknowledged as accepted', async () => {
  const res = await command('cmd-b', { type: 'command.message', agentId: 'finder', data: { text: 'Check eBay too' } });
  assert.equal(res.status, 200);
  const { cmdId } = JSON.parse(res.text);
  const mail = fs.readFileSync(path.join(ws, 'cmd-b/mas/commands/finder.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(mail.length, 1);
  assert.deepEqual(mail[0].data.origin, { kind: 'human' });
  const inbox = readJson(path.join(ws, 'cmd-b/mas/inbox.json'));
  const logged = inbox.commands.find((c) => c.cmdId === cmdId);
  assert.equal(logged.status, 'accepted');
  assert.equal(logged.text, 'Check eBay too');
  assert.deepEqual(logged.origin, { kind: 'human' });
});

test('a caller cannot choose the origin', async () => {
  const res = await command('cmd-c', { type: 'command.message', agentId: 'finder', data: { text: 'x', origin: { kind: 'policy' } } });
  const { cmdId } = JSON.parse(res.text);
  const inbox = readJson(path.join(ws, 'cmd-c/mas/inbox.json'));
  assert.deepEqual(inbox.commands.find((c) => c.cmdId === cmdId).origin, { kind: 'human' });
});

test('answering a request resolves it once; the second answer is a 409', async () => {
  await openRequest('cmd-d', 'req-1', { options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] });
  assert.equal(readJson(path.join(ws, 'cmd-d/mas/status/finder.json')).state, 'flagged');
  const first = await command('cmd-d', { type: 'command.respond', agentId: 'finder', data: { requestId: 'req-1', outcome: 'selected', optionId: 'allow' } });
  assert.equal(first.status, 200);
  const inbox = readJson(path.join(ws, 'cmd-d/mas/inbox.json'));
  assert.equal(inbox.pending.length, 0);
  assert.equal(inbox.recent[0].outcome, 'selected');
  assert.deepEqual(inbox.recent[0].by, { kind: 'human' });
  assert.equal(readJson(path.join(ws, 'cmd-d/mas/status/finder.json')).state, 'working');
  const second = await command('cmd-d', { type: 'command.respond', agentId: 'finder', data: { requestId: 'req-1', outcome: 'declined' } });
  assert.equal(second.status, 409);
  assert.equal(JSON.parse(second.text).reason, 'already_resolved');
});

test('the same cmdId twice is one command', async () => {
  const body = { type: 'command.message', agentId: 'finder', data: { text: 'once', cmdId: 'cmd_fixed' } };
  const a = JSON.parse((await command('cmd-e', body)).text);
  const b = JSON.parse((await command('cmd-e', body)).text);
  assert.equal(b.duplicate, true);
  assert.equal(a.seq, b.seq);
  const mail = fs.readFileSync(path.join(ws, 'cmd-e/mas/commands/finder.jsonl'), 'utf8').trim().split('\n');
  assert.equal(mail.length, 1);
});

test('/v0/events refuses commands and forged human answers', async () => {
  const cmd = await post('cmd-f', { type: 'command.message', agentId: 'finder', data: { cmdId: 'c1', text: 'x' } });
  assert.equal(cmd.status, 400);
  await openRequest('cmd-f', 'req-2');
  const forged = await post('cmd-f', { type: 'request.resolved', agentId: 'finder', data: { requestId: 'req-2', outcome: 'selected', by: { kind: 'human' } } });
  assert.equal(forged.status, 403);
  assert.equal(readJson(path.join(ws, 'cmd-f/mas/inbox.json')).pending.length, 1);
  const policy = await post('cmd-f', { type: 'request.resolved', agentId: 'finder', data: { requestId: 'req-2', outcome: 'selected', by: { kind: 'policy', rule: 'web' } } });
  assert.equal(policy.status, 200);
  const ackOnly = await post('cmd-f', { type: 'command.ack', agentId: 'finder', data: { cmdId: 'c1', status: 'applied' } });
  assert.equal(ackOnly.status, 200);
});

test('an attached runtime receives the command and its failure becomes a rejected ack', async () => {
  const seen = [];
  srv.attach({
    info: () => ({ backends: { 'claude-code': true } }),
    handleCommand: async (project, event) => {
      seen.push([project, event.type, event.data.origin.kind]);
      if (event.data.text === 'boom') throw new Error('no session');
      srv.emit(project, [{ type: 'command.ack', agentId: event.agentId, data: { cmdId: event.data.cmdId, status: 'applied' } }]);
    },
  });
  try {
    const session = JSON.parse((await request('/v0/session', { headers: bearer() })).text);
    assert.equal(session.runtime, true);
    assert.deepEqual(session.backends, { 'claude-code': true });
    const ok = JSON.parse((await command('cmd-g', { type: 'command.message', agentId: 'finder', data: { text: 'go' } })).text);
    const bad = JSON.parse((await command('cmd-g', { type: 'command.message', agentId: 'finder', data: { text: 'boom' } })).text);
    await new Promise((r) => setTimeout(r, 50));
    const { commands } = readJson(path.join(ws, 'cmd-g/mas/inbox.json'));
    assert.equal(commands.find((c) => c.cmdId === ok.cmdId).status, 'applied');
    const failed = commands.find((c) => c.cmdId === bad.cmdId);
    assert.equal(failed.status, 'rejected');
    assert.match(failed.reason, /no session/);
    assert.deepEqual(seen.map((s) => s[2]), ['human', 'human']);
    assert.equal(fs.existsSync(path.join(ws, 'cmd-g/mas/commands')), false);
  } finally {
    srv.attach(null);
  }
});

test('runs need a runtime', async () => {
  const res = await request('/v0/runs?project=cmd-h', {
    method: 'POST', headers: { 'content-type': 'application/json', ...bearer() }, body: JSON.stringify({ task: 'Find headphones' }),
  });
  assert.equal(res.status, 409);
  assert.equal(JSON.parse(res.text).reason, 'no_runtime');
});

test('the stream replays logged events after `since`', async () => {
  await post('cmd-i', [{ type: 'run.started', data: { title: 'R' } }, { type: 'message', data: { text: 'one' } }, { type: 'message', data: { text: 'two' } }]);
  const text = await new Promise((resolve, reject) => {
    let buffer = '';
    const req = http.get({ host: '127.0.0.1', port: srv.port, path: '/v0/stream?project=cmd-i&since=1' }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buffer += c;
        if (buffer.includes('"two"')) { req.destroy(); resolve(buffer); }
      });
    });
    setTimeout(() => { req.destroy(); reject(new Error(`no replay: ${buffer}`)); }, 3000);
    req.on('error', () => {});
  });
  assert.equal(text.includes('"Planning the run"'), false);
  assert.match(text, /id: 2\n/);
  assert.match(text, /id: 3\n/);
  assert.equal(/id: 1\n/.test(text), false);
});

test('while a runtime is attached, its facts cannot be posted without the token', async () => {
  const waiting = new Set(['req-live']);
  srv.attach({ handleCommand: async () => {}, waitsOn: (_project, id) => waiting.has(id) });
  try {
    for (const type of ['verdict.recorded', 'request.resolved', 'result', 'run.finished', 'evidence.checked', 'agent.stopped']) {
      const data = { claimId: 'c1', status: 'supported', requestId: 'r', outcome: 'declined', sourceId: 's' };
      assert.equal((await post('cmd-j', { type, agentId: 'checker', data })).status, 403, type);
    }
    assert.equal((await post('cmd-j', { type: 'message', agentId: 'checker', data: { text: 'hello' } })).status, 200);
    const trusted = await request('/v0/events?project=cmd-j', {
      method: 'POST', headers: { 'content-type': 'application/json', ...bearer() }, body: JSON.stringify({ type: 'run.started', data: {} }),
    });
    assert.equal(trusted.status, 200);
    // "Still waiting" is the runtime's word, not the log's.
    const gone = await command('cmd-j', { type: 'command.respond', agentId: 'lead', data: { requestId: 'req-gone', outcome: 'declined' } });
    assert.equal(gone.status, 409);
    const live = await command('cmd-j', { type: 'command.respond', agentId: 'lead', data: { requestId: 'req-live', outcome: 'declined' } });
    assert.equal(live.status, 200);
  } finally {
    srv.attach(null);
  }
});

test('a prompt from a terminal session is not answerable from the panel; notes are bounded', async () => {
  await post('cmd-k', [
    { type: 'run.started', data: {} },
    { type: 'request.opened', agentId: 'lead', data: { requestId: 'hook_1', kind: 'approval', title: 'Run rm?', options: [], source: { backend: 'claude-code', raw: 'hook:PermissionRequest' } } },
  ]);
  const res = await command('cmd-k', { type: 'command.respond', agentId: 'lead', data: { requestId: 'hook_1', outcome: 'declined' } });
  assert.equal(res.status, 409);
  assert.equal(JSON.parse(res.text).reason, 'answer_in_terminal');
  const long = await command('cmd-k', { type: 'command.respond', agentId: 'lead', data: { requestId: 'hook_1', outcome: 'declined', note: 'x'.repeat(1001) } });
  assert.equal(long.status, 400);
});
