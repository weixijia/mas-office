import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { JsonRpcPeer, JsonRpcError, ErrorCodes, NO_RESPONSE } from '../src/backends/jsonrpc.js';

/** A peer wired to in-memory streams, plus helpers to play the other side. */
function harness(options = {}) {
  const toPeer = new PassThrough();
  const fromPeer = new PassThrough();
  const written = [];
  let buffer = '';
  fromPeer.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      written.push(JSON.parse(buffer.slice(0, i)));
      buffer = buffer.slice(i + 1);
    }
  });
  const problems = [];
  const closes = [];
  const peer = new JsonRpcPeer({
    input: toPeer,
    output: fromPeer,
    onProtocolError: (problem) => problems.push(problem),
    onClose: (reason) => closes.push(reason),
    ...options,
  });
  const send = (message) => toPeer.write(`${JSON.stringify(message)}\n`);
  return { peer, toPeer, written, problems, closes, send };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('request resolves with the matching result; ids are unique; no jsonrpc header by default', async () => {
  const h = harness();
  const a = h.peer.request('alpha', { x: 1 });
  const b = h.peer.request('beta');
  await tick();
  assert.equal(h.written.length, 2);
  assert.deepEqual(h.written[0], { id: 1, method: 'alpha', params: { x: 1 } });
  assert.deepEqual(h.written[1], { id: 2, method: 'beta' });
  h.send({ id: 2, result: 'B' });
  h.send({ id: 1, result: { ok: true } });
  assert.deepEqual(await a, { ok: true });
  assert.equal(await b, 'B');
});

test('jsonrpcHeader: true adds "jsonrpc": "2.0"', async () => {
  const h = harness({ jsonrpcHeader: true });
  h.peer.notify('ping');
  await tick();
  assert.deepEqual(h.written[0], { jsonrpc: '2.0', method: 'ping' });
});

test('error responses reject with a JsonRpcError carrying code and data', async () => {
  const h = harness();
  const p = h.peer.request('fail');
  h.send({ id: 1, error: { code: -32600, message: 'no active turn to steer', data: { why: 1 } } });
  await assert.rejects(p, (error) => error instanceof JsonRpcError && error.code === -32600 && error.message === 'no active turn to steer' && error.data.why === 1);
});

test('requests time out and a late response is skipped', async () => {
  const h = harness({ requestTimeoutMs: 20 });
  await assert.rejects(h.peer.request('slow'), /slow timed out after 20 ms/);
  h.send({ id: 1, result: 'late' });
  await tick();
  assert.ok(h.problems.some((p) => /unknown id/.test(p)));
  // timeoutMs: 0 disables the timeout for one call
  const p = h.peer.request('patient', undefined, { timeoutMs: 0 });
  await new Promise((r) => setTimeout(r, 40));
  h.send({ id: 2, result: 'done' });
  assert.equal(await p, 'done');
});

test('notifications are delivered; malformed lines are skipped; split chunks and multibyte text reassemble', async () => {
  const seen = [];
  const h = harness({ onNotification: (method, params) => seen.push([method, params]) });
  h.toPeer.write('not json\n');
  h.toPeer.write('[1,2]\n');
  h.toPeer.write('{"what": "no method or id"}\n');
  const line = Buffer.from(`${JSON.stringify({ method: 'note', params: { text: 'héllo ✓' } })}\n`);
  h.toPeer.write(line.subarray(0, 25));
  h.toPeer.write(line.subarray(25, 27)); // may cut through a multibyte character
  h.toPeer.write(line.subarray(27));
  h.toPeer.write('\n\n');
  await tick();
  assert.deepEqual(seen, [['note', { text: 'héllo ✓' }]]);
  assert.equal(h.problems.length, 3);
  assert.equal(h.peer.closed, false);
});

test('a throwing notification handler does not break the peer', async () => {
  const h = harness({ onNotification: () => { throw new Error('boom'); } });
  h.send({ method: 'x' });
  await tick();
  assert.ok(h.problems.some((p) => /threw: boom/.test(p)));
  const p = h.peer.request('still-works');
  h.send({ id: 1, result: 1 });
  assert.equal(await p, 1);
});

test('incoming requests are answered by the handler: result, error, JsonRpcError code, null for undefined', async () => {
  const h = harness({
    onRequest: async (method, params) => {
      if (method === 'add') return params.a + params.b;
      if (method === 'void') return undefined;
      if (method === 'typed') throw new JsonRpcError(ErrorCodes.methodNotFound, 'nope', { m: method });
      throw new Error('handler failed');
    },
  });
  h.send({ id: 'a', method: 'add', params: { a: 1, b: 2 } });
  h.send({ id: 7, method: 'void' });
  h.send({ id: 8, method: 'typed' });
  h.send({ id: 9, method: 'other' });
  await tick(); await tick();
  const byId = Object.fromEntries(h.written.map((m) => [m.id, m]));
  assert.deepEqual(byId.a, { id: 'a', result: 3 });
  assert.deepEqual(byId[7], { id: 7, result: null });
  assert.deepEqual(byId[8], { id: 8, error: { code: -32601, message: 'nope', data: { m: 'typed' } } });
  assert.deepEqual(byId[9], { id: 9, error: { code: -32603, message: 'handler failed' } });
});

test('without a handler, incoming requests get "method not found"', async () => {
  const h = harness();
  h.send({ id: 3, method: 'mystery' });
  await tick();
  assert.equal(h.written[0].id, 3);
  assert.equal(h.written[0].error.code, ErrorCodes.methodNotFound);
});

test('NO_RESPONSE sends nothing for that request', async () => {
  const h = harness({ onRequest: () => NO_RESPONSE });
  h.send({ id: 4, method: 'cleared' });
  await tick(); await tick();
  assert.equal(h.written.length, 0);
});

test('close rejects pending requests once, refuses new ones and reports the reason', async () => {
  const h = harness();
  const p = h.peer.request('pending');
  h.peer.close('bye');
  h.peer.close('again');
  await assert.rejects(p, /closed \(bye\) before pending answered/);
  await assert.rejects(h.peer.request('later'), /closed \(bye\)/);
  assert.equal(h.peer.notify('n'), false);
  assert.deepEqual(h.closes, ['bye']);
});

test('the input ending closes the peer', async () => {
  const h = harness();
  const p = h.peer.request('pending');
  h.toPeer.end();
  await assert.rejects(p, /input ended/);
  assert.equal(h.peer.closed, true);
  assert.deepEqual(h.closes, ['input ended']);
});
