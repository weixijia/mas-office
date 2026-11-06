import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Office } from '../src/index.js';
import { HttpTransport, MAX_BATCH_BYTES } from '../src/transports.js';
import { captureWarnings } from './helpers.js';

/** A tiny stand-in for `mas-office serve` that records what it receives. */
async function fakeServer(status = 200) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, type: req.headers['content-type'], bytes: Buffer.byteLength(body), body: JSON.parse(body) });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accepted: 1, lastSeq: 1 }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { requests, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test('HTTP transport batches events per project and flushes on close', async () => {
  const srv = await fakeServer();
  try {
    const office = new Office({ url: `${srv.url}/` });
    const run = office.project('remote', { title: 'Remote' }).run({ title: 'Remote' });
    const a = run.agent('worker-1', { name: 'Worker 1', emoji: '🤖' });
    a.working('Reading', { progress: 10 });
    a.done();
    run.finish();
    await office.close();
    const events = srv.requests.flatMap((r) => r.body);
    assert.ok(srv.requests.every((r) => r.method === 'POST' && r.url === '/v0/events?project=remote'));
    assert.ok(srv.requests.every((r) => r.type === 'application/json' && Array.isArray(r.body)));
    assert.ok(srv.requests.length < events.length, 'events are batched');
    assert.deepEqual(events.map((e) => e.type), ['run.started', 'agent.registered', 'agent.status', 'agent.finished', 'run.finished']);
    assert.ok(events.every((e) => e.v === '0.1' && typeof e.ts === 'string' && e.seq === undefined), 'the server assigns seq');
    assert.equal(events[1].agentName, 'Worker 1');
    assert.equal(events[1].data.emoji, '🤖');
  } finally {
    await srv.close();
  }
});

test('HTTP transport never throws into user code: failures warn once and drop', async () => {
  const srv = await fakeServer(500);
  const warnings = await captureWarnings(async (seen) => {
    try {
      const office = new Office({ url: srv.url });
      const run = office.project('remote').run();
      run.lead.say('one');
      await office.close();
      run.lead.say('two');
      await office.close();
      assert.equal(seen.length, 1);
      assert.match(seen[0], /HTTP 500/);
    } finally {
      await srv.close();
    }
    const dead = new Office({ url: 'http://127.0.0.1:9' });
    dead.project('remote').run().finish();
    await dead.close();
  });
  assert.equal(warnings.length, 2);
  assert.match(warnings[1], /cannot send events/);
});

test('HTTP transport splits batches by size; an event over the limit is dropped with one warning', async () => {
  const srv = await fakeServer();
  try {
    const warnings = await captureWarnings(async () => {
      const t = new HttpTransport(srv.url, { maxBatchBytes: 300 });
      const ev = (i, text) => ({ v: '0.1', ts: 't', type: 'message', data: { text: `${i}:${text}` } });
      for (let i = 0; i < 6; i += 1) t.send('p', ev(i, 'é'.repeat(40))); // 2 bytes per "é"
      t.send('p', ev(6, 'x'.repeat(400)));
      t.send('p', ev(7, 'x'.repeat(400)));
      t.send('p', ev(8, 'last'));
      await t.close();
    });
    assert.ok(srv.requests.length >= 3, `${srv.requests.length} requests`);
    assert.ok(srv.requests.every((r) => r.bytes <= 300), srv.requests.map((r) => r.bytes).join(','));
    assert.deepEqual(srv.requests.flatMap((r) => r.body).map((e) => e.data.text.split(':')[0]), ['0', '1', '2', '3', '4', '5', '8']);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /dropping a "message" event of \d+ bytes/);
  } finally {
    await srv.close();
  }
});

test('HTTP transport keeps every request within the server\'s 1 MB limit by default', async () => {
  const srv = await fakeServer();
  try {
    const office = new Office({ url: srv.url });
    const run = office.project('big').run();
    for (let i = 0; i < 5; i += 1) run.lead.say('y'.repeat(300 * 1024));
    await office.close();
    assert.ok(srv.requests.length >= 2);
    assert.ok(srv.requests.every((r) => r.bytes <= MAX_BATCH_BYTES));
    assert.equal(srv.requests.flatMap((r) => r.body).length, 6);
  } finally {
    await srv.close();
  }
});
