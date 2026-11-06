import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { reduce, createReducer, validateEvent, parseLog } from '../src/index.js';

const CONFORMANCE = new URL('../../../spec/conformance/', import.meta.url);

const cases = fs.readdirSync(CONFORMANCE, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(new URL(`${d.name}/events.jsonl`, CONFORMANCE)))
  .map((d) => d.name)
  .sort();

test('conformance cases exist', () => {
  assert.ok(cases.length >= 4, `found ${cases.length} cases`);
});

for (const name of cases) {
  test(`conformance: ${name}`, () => {
    const lines = fs.readFileSync(new URL(`${name}/events.jsonl`, CONFORMANCE), 'utf8').split('\n');
    const expected = JSON.parse(fs.readFileSync(new URL(`${name}/expected.json`, CONFORMANCE), 'utf8'));
    const got = reduce(lines);
    assert.deepStrictEqual(got, expected);
    assert.deepStrictEqual(Object.keys(got.statuses), Object.keys(expected.statuses), 'statuses key order');
  });

  test(`conformance: ${name} — incremental apply gives the same snapshot`, () => {
    const lines = fs.readFileSync(new URL(`${name}/events.jsonl`, CONFORMANCE), 'utf8').split('\n');
    const reducer = createReducer();
    for (const e of parseLog(lines)) reducer.apply(e);
    assert.deepStrictEqual(reducer.snapshot(), reduce(lines));
  });
}

const ev = (seq, type, extra = {}) => ({ v: '0.1', seq, ts: `2026-11-06T10:00:${String(seq).padStart(2, '0')}Z`, type, ...extra });

test('reduce of an empty log is the default snapshot', () => {
  const s = reduce([]);
  assert.equal(s.structure.title, 'Untitled MAS');
  assert.equal(s.structure.topology, 'dynamic');
  assert.deepEqual(Object.keys(s.statuses), ['lead']);
  assert.equal(s.statuses.lead.state, 'idle');
  assert.deepEqual(s.state, {
    mode: 'sdk', step: 4, phase: 'locked', locked: true, version: 1, run: 0, runId: null, updated: null,
    next: 'Waiting for the first run.',
  });
  assert.equal(s.result, null);
});

test('validateEvent: rule 2 of spec §4.1', () => {
  assert.equal(validateEvent(ev(1, 'run.started')).ok, true);
  assert.equal(validateEvent(ev(1, 'custom.anything', { data: { x: 1 } })).ok, true);
  assert.equal(validateEvent(ev(1, 'something.unknown')).ok, true, 'unknown types are accepted');
  const bad = [
    null, [], 'x',
    { seq: 1, ts: 't', type: 'run.started' },
    ev(0, 'run.started'),
    ev(1.5, 'run.started'),
    { ...ev(1, 'run.started'), ts: 5 },
    { ...ev(1, 'run.started'), type: undefined },
    ev(1, 'run.started', { data: [] }),
    ev(1, 'run.started', { data: null }),
    ev(1, 'agent.status', { data: {} }),
    ev(1, 'agent.status', { data: { state: 'sleeping' } }),
    ev(1, 'handoff', { data: { to: 3 } }),
    ev(1, 'message'),
    ev(1, 'tool.started', { data: {} }),
    ev(1, 'flag.raised', { data: { kind: 'concern' } }),
  ];
  for (const e of bad) {
    const r = validateEvent(e);
    assert.equal(r.ok, false, JSON.stringify(e));
    assert.ok(r.errors.length > 0);
  }
});

test('apply ignores invalid events and seq that is not increasing', () => {
  const r = createReducer();
  assert.equal(r.apply(ev(2, 'run.started')), true);
  assert.equal(r.apply(ev(2, 'run.finished')), false);
  assert.equal(r.apply(ev(1, 'run.finished')), false);
  assert.equal(r.apply(ev(3, 'agent.status', { data: { state: 'nope' } })), false);
  assert.equal(r.lastSeq, 2);
  assert.equal(r.snapshot().state.phase, 'running');
});

test('snapshots are copies: mutating one does not change the reducer', () => {
  const r = createReducer([ev(1, 'run.started', { data: { title: 'T' } })]);
  const s = r.snapshot();
  s.structure.title = 'changed';
  s.statuses.lead.state = 'failed';
  assert.equal(r.snapshot().structure.title, 'T');
  assert.equal(r.snapshot().statuses.lead.state, 'working');
});

test('status t moves only when the status really changes', () => {
  const r = createReducer([
    ev(1, 'run.started', { data: { title: 'T' } }),
    ev(2, 'agent.status', { agentId: 'a', data: { state: 'working', say: 'x' } }),
    ev(3, 'agent.status', { agentId: 'a', data: { state: 'working', say: 'x' } }),
    ev(4, 'flag.resolved', { agentId: 'a' }),
  ]);
  assert.equal(r.snapshot().statuses.a.t, '2026-11-06T10:00:02Z');
});

test('registration: data fields, groups and the handoff target', () => {
  const s = reduce([
    ev(1, 'run.started', { data: { structure: { lead: { id: 'lead', name: 'Boss' }, groups: [{ id: 'A', after: null }], roles: [] } } }),
    ev(2, 'agent.registered', { agentId: 'x', agentName: 'Ignored', data: { name: 'Xavier', group: 'B', role: 'critic' } }),
    ev(3, 'handoff', { agentId: 'x', data: { to: 'lead' } }),
  ]);
  assert.deepEqual(s.structure.groups[1], { id: 'B', label: 'Group B', after: 'A' });
  assert.equal(s.structure.roles[0].name, 'Xavier');
  assert.equal(s.structure.roles[0].role, 'critic');
  assert.equal(s.statuses.x.say, 'Handing over to Boss');
  assert.equal(s.statuses.x.to, 'lead');
});

test('result merges collected sources and flags, first source id wins', () => {
  const s = reduce([
    ev(1, 'run.started', { data: { title: 'T' } }),
    ev(2, 'artifact', { agentId: 'a', data: { kind: 'source', source: { id: 's1', title: 'one' } } }),
    ev(3, 'artifact', { agentId: 'b', data: { kind: 'source', source: { id: 's1', title: 'dup' } } }),
    ev(4, 'flag.raised', { agentId: 'b', data: { text: 'hmm' } }),
    ev(5, 'result', { data: { sources: [{ id: 's1', title: 'late' }, { id: 's2' }], flags: [{ text: 'extra' }] } }),
  ]);
  assert.deepEqual(s.result.sources, [{ id: 's1', title: 'one', foundBy: 'a' }, { id: 's2' }]);
  assert.deepEqual(s.result.flags, [{ by: 'b', kind: 'concern', text: 'hmm' }, { text: 'extra' }]);
  assert.equal(s.result.title, 'T — run 1');
  assert.equal(s.result.markdown, '');
});

test('seq must be a safe integer (spec §4.1: 1 ≤ seq ≤ 2^53 − 1)', () => {
  assert.equal(validateEvent(ev(Number.MAX_SAFE_INTEGER, 'run.started')).ok, true);
  assert.equal(validateEvent(ev(Number.MAX_SAFE_INTEGER + 1, 'run.started')).ok, false);
  assert.equal(validateEvent(ev(1e300, 'run.started')).ok, false);
  assert.deepEqual(parseLog(['{"v":"0.1","seq":9007199254740993,"ts":"t","type":"run.started"}']), []);
});

test('ids and types that are Object.prototype names are ordinary strings', () => {
  for (const type of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.equal(validateEvent(ev(1, type)).ok, true, type);
  }
  const ids = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'];
  const s = reduce([
    ev(1, 'run.started', { data: { title: 'T' } }),
    ...ids.map((id, i) => ev(i + 2, 'agent.status', { agentId: id, data: { state: 'working', say: `I am ${id}` } })),
    ev(20, 'handoff', { agentId: 'toString', data: { to: 'constructor' } }),
  ]);
  assert.deepEqual(Object.keys(s.statuses), ['lead', ...ids]);
  for (const id of ids) {
    assert.ok(Object.hasOwn(s.statuses, id), id);
    assert.equal(s.structure.roles.find((r) => r.id === id).name, id);
  }
  assert.equal(Object.getPrototypeOf(s.statuses), Object.prototype, 'statuses keeps a normal prototype');
  assert.equal(s.statuses.__proto__.say, 'I am __proto__'); // eslint-disable-line no-proto
  assert.equal(s.statuses.toString.say, 'Handing over to constructor');
  assert.equal(JSON.parse(JSON.stringify(s)).statuses.__proto__.state, 'working'); // eslint-disable-line no-proto
});

test('"given" ignores wrong-type fields; run.failed keeps the lead\'s to', () => {
  const s = reduce([
    ev(1, 'run.started', { data: { title: 5, structure: { title: null, roles: [{ id: 'a', name: 7 }] } } }),
    ev(2, 'agent.status', { agentId: 'a', data: { state: 'flagged', say: 3, flag: ['x'], flagKind: {}, progress: '50' } }),
    ev(3, 'agent.registered', { agentId: 'n', agentName: 'From envelope', data: { name: 1, emoji: false, job: [], handsTo: 2, role: {} } }),
    ev(4, 'handoff', { agentId: 'n', data: { to: 'a', say: 9 } }),
    ev(5, 'agent.failed', { agentId: 'a', data: { reason: 1 } }),
    ev(6, 'handoff', { data: { to: 'a' } }),
    ev(7, 'result', { data: { title: 1, markdown: {}, sources: 'x', flags: { text: 'no' }, work: [null, 'w', { by: 'a', summary: 's' }] } }),
    ev(8, 'run.failed', { data: { reason: 42 } }),
  ]);
  assert.equal(s.structure.title, 'Untitled MAS');
  assert.deepEqual(s.structure.lead, { id: 'lead', name: 'Lead', emoji: '🧭', job: '', serves: [] });
  assert.deepEqual(s.structure.groups, [{ id: 'dyn', label: 'Spawned at runtime', after: null }]);
  const n = s.structure.roles.find((r) => r.id === 'n');
  assert.deepEqual(n, {
    id: 'n', name: 'From envelope', emoji: '🤖', job: '', serves: [], tools: [], group: 'dyn', handsTo: 'lead', dynamic: true, parent: 'lead',
  });
  assert.equal(s.statuses.n.say, 'Handing over to a', 'a role whose name is not a string is shown by its id');
  assert.deepEqual(s.statuses.a, { state: 'failed', say: 'Failed', to: null, flag: null, flagKind: 'error', progress: 0, t: '2026-11-06T10:00:05Z' });
  assert.deepEqual(s.result, { title: 'Untitled MAS — run 1', run: 1, updated: '2026-11-06T10:00:07Z', markdown: '', sources: [], flags: [], work: [{ by: 'a', summary: 's' }] });
  assert.deepEqual(s.statuses.lead, { state: 'failed', say: 'Run failed', to: 'a', flag: null, flagKind: 'error', progress: 0, t: '2026-11-06T10:00:08Z' });
});

test('progress rounds like Math.round and clamps to 0–100', () => {
  const at = (progress) => reduce([ev(1, 'agent.status', { agentId: 'a', data: { state: 'working', progress } })]).statuses.a.progress;
  assert.equal(at(0.49999999999999994), 0);
  assert.equal(at(2.5), 3);
  assert.equal(at(-0.5), 0);
  assert.equal(at(250), 100);
});

test('envelope agentName and parentId of the wrong type count as not given', () => {
  const s = reduce([
    ev(1, 'agent.status', { agentId: 'a', agentName: 42, parentId: 7, data: { state: 'working' } }),
    ev(2, 'agent.registered', { agentId: 'b', agentName: null, parentId: { id: 'x' }, data: { name: null } }),
    ev(3, 'agent.registered', { agentId: 'c', agentName: 'Cee', parentId: 'a', data: {} }),
  ]);
  const role = (id) => s.structure.roles.find((r) => r.id === id);
  assert.deepEqual([role('a').name, role('a').parent], ['a', 'lead']);
  assert.deepEqual([role('b').name, role('b').parent], ['b', 'lead']);
  assert.deepEqual([role('c').name, role('c').parent], ['Cee', 'a']);
});
