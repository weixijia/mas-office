import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { reduce, createReducer, validateEvent, parseLog } from '../../src/sdk/index.js';

const CONFORMANCE = new URL('../../../../spec/conformance/', import.meta.url);

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
  assert.deepEqual(s.statuses.lead, {
    state: 'idle', say: 'Ready', to: null, flag: null, flagKind: null, progress: 0, t: null, waitingOn: [], stopReason: null,
  });
  assert.deepEqual(s.inbox, { pending: [], recent: [], commands: [] });
  assert.deepEqual(s.board, { tasks: [], ledger: null, reviews: [], recoveries: [], usage: {}, agents: {} });
  assert.equal(s.verification, null);
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
  assert.deepEqual(s.statuses.a, {
    state: 'failed', say: 'Failed', to: null, flag: null, flagKind: 'error', progress: 0, t: '2026-11-06T10:00:05Z', waitingOn: [], stopReason: null,
  });
  assert.deepEqual(s.result, { title: 'Untitled MAS — run 1', run: 1, updated: '2026-11-06T10:00:07Z', markdown: '', sources: [], flags: [], work: [{ by: 'a', summary: 's' }] });
  assert.deepEqual(s.statuses.lead, {
    state: 'failed', say: 'Run failed', to: 'a', flag: null, flagKind: 'error', progress: 0, t: '2026-11-06T10:00:08Z', waitingOn: [], stopReason: null,
  });
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

test('validateEvent: 0.2 required fields and listed values (spec §4.1)', () => {
  const good = [
    ev(1, 'request.opened', { data: { requestId: 'r', kind: 'anything', title: 'T' } }),
    ev(1, 'request.resolved', { data: { requestId: 'r', outcome: 'stale' } }),
    ev(1, 'command.message', { data: { cmdId: 'c', text: 'x' } }),
    ev(1, 'command.respond', { data: { cmdId: 'c', requestId: 'r', outcome: 'whatever' } }),
    ev(1, 'command.assign', { data: { cmdId: 'c', title: 'T' } }),
    ev(1, 'command.interrupt', { data: { cmdId: 'c' } }),
    ev(1, 'command.ack', { data: { cmdId: 'c', status: 'unsupported' } }),
    ev(1, 'task.assigned', { data: { taskId: 't', title: 'T' } }),
    ev(1, 'task.updated', { data: { taskId: 't' } }),
    ev(1, 'task.finished', { data: { taskId: 't' } }),
    ev(1, 'review.verdict', { data: { target: 'a', verdict: 'escalate' } }),
    ev(1, 'recovery.chosen', { data: { strategy: 'ask-human' } }),
    ev(1, 'claim.added', { data: { claimId: 'c', text: 'x' } }),
    ev(1, 'evidence.checked', { data: { sourceId: 's' } }),
    ev(1, 'verdict.recorded', { data: { claimId: 'c', status: 'not-checkworthy' } }),
    ev(1, 'agent.stopped'), ev(1, 'usage'), ev(1, 'lead.ledger'),
  ];
  for (const e of good) assert.equal(validateEvent(e).ok, true, JSON.stringify(e));
  const bad = [
    [ev(1, 'request.opened', { data: { requestId: 'r', kind: 'question' } }), '"request.opened" needs a string "data.title"'],
    [ev(1, 'request.opened'), '"request.opened" needs a string "data.requestId"'],
    [ev(1, 'request.resolved', { data: { requestId: 'r', outcome: 'maybe' } }), '"data.outcome" must be one of'],
    [ev(1, 'command.ack', { data: { cmdId: 'c', status: 'done' } }), '"data.status" must be one of'],
    [ev(1, 'command.respond', { data: { cmdId: 'c', outcome: 'selected' } }), '"command.respond" needs a string "data.requestId"'],
    [ev(1, 'review.verdict', { data: { target: 'a', verdict: 'maybe' } }), '"data.verdict" must be one of'],
    [ev(1, 'recovery.chosen', { data: { strategy: 'pray' } }), '"data.strategy" must be one of'],
    [ev(1, 'verdict.recorded', { data: { claimId: 'c', status: 'true' } }), '"data.status" must be one of'],
    [ev(1, 'claim.added', { data: { claimId: 1, text: 'x' } }), '"claim.added" needs a string "data.claimId"'],
    [ev(1, 'task.updated', { data: { taskId: null } }), '"task.updated" needs a string "data.taskId"'],
  ];
  for (const [e, message] of bad) {
    const r = validateEvent(e);
    assert.equal(r.ok, false, JSON.stringify(e));
    assert.ok(r.errors.some((m) => m.startsWith(message)), `${r.errors} vs ${message}`);
  }
  const inherited = Object.create({ requestId: 'r', kind: 'question', title: 'T' });
  assert.equal(validateEvent(ev(1, 'request.opened', { data: inherited })).ok, false, 'inherited fields are not given');
});

test('inbox: recent keeps the newest 50, commands the newest 100', () => {
  const events = [ev(1, 'run.started')];
  for (let i = 0; i < 60; i += 1) {
    events.push(ev(events.length + 1, 'request.opened', { data: { requestId: `r${i}`, kind: 'question', title: `Q${i}`, blocking: false } }));
    events.push(ev(events.length + 1, 'request.resolved', { data: { requestId: `r${i}`, outcome: 'declined' } }));
  }
  for (let i = 0; i < 105; i += 1) events.push(ev(events.length + 1, 'command.message', { agentId: 'w', data: { cmdId: `c${i}`, text: 'x' } }));
  events.push(ev(events.length + 1, 'request.opened', { data: { requestId: 'r0', kind: 'question', title: 'Reused id', blocking: false } }));
  events.push(ev(events.length + 1, 'command.ack', { data: { cmdId: 'c0', status: 'applied' } }));
  const s = reduce(events);
  assert.equal(s.inbox.recent.length, 50);
  assert.deepEqual([s.inbox.recent[0].requestId, s.inbox.recent[49].requestId], ['r59', 'r10']);
  assert.deepEqual(s.inbox.pending.map((r) => r.title), ['Reused id'], 'an id that fell out of recent can be opened again');
  assert.equal(s.inbox.commands.length, 100);
  assert.deepEqual([s.inbox.commands[0].cmdId, s.inbox.commands[99].cmdId], ['c5', 'c104']);
  assert.ok(s.inbox.commands.every((c) => c.status === 'sent'), 'an ack for a dropped command has no effect');
});

test('stopReason: set by agent.stopped and agent.status, cleared on resuming work; t follows', () => {
  const r = createReducer([
    ev(1, 'run.started'),
    ev(2, 'agent.status', { agentId: 'a', data: { state: 'working' } }),
    ev(3, 'agent.stopped', { agentId: 'a' }),
  ]);
  assert.deepEqual([r.snapshot().statuses.a.state, r.snapshot().statuses.a.stopReason], ['idle', 'cancelled']);
  r.apply(ev(4, 'agent.status', { agentId: 'a', data: { state: 'idle', stopReason: 'cancelled' } }));
  assert.equal(r.snapshot().statuses.a.t, '2026-11-06T10:00:03Z', 'nothing changed');
  r.apply(ev(5, 'agent.status', { agentId: 'a', data: { state: 'idle', stopReason: 'end_turn' } }));
  assert.deepEqual([r.snapshot().statuses.a.stopReason, r.snapshot().statuses.a.t], ['end_turn', '2026-11-06T10:00:05Z']);
  r.apply(ev(6, 'handoff', { agentId: 'a', data: { to: 'lead' } }));
  assert.equal(r.snapshot().statuses.a.stopReason, null);
  r.apply(ev(7, 'agent.status', { agentId: 'a', data: { state: 'handoff', stopReason: 'odd' } }));
  r.apply(ev(8, 'agent.status', { agentId: 'a', data: { state: 'handoff' } }));
  assert.equal(r.snapshot().statuses.a.stopReason, 'odd', 'only entering working/waiting/handoff clears it');
});

test('snapshots of 0.2 state are copies too', () => {
  const r = createReducer([
    ev(1, 'run.started'),
    ev(2, 'request.opened', { agentId: 'a', data: { requestId: 'r1', kind: 'approval', title: 'T', options: [{ optionId: 'o' }] } }),
    ev(3, 'claim.added', { data: { claimId: 'c1', text: 'x', sources: ['s'] } }),
    ev(4, 'usage', { agentId: 'a', data: { turns: 1, limit: { kind: 'five_hour' } } }),
  ]);
  const s = r.snapshot();
  s.statuses.a.waitingOn.push('x');
  s.inbox.pending[0].options[0].optionId = 'changed';
  s.verification.claims[0].sources.push('y');
  s.board.usage.a.limit.kind = 'changed';
  const again = r.snapshot();
  assert.deepEqual(again.statuses.a.waitingOn, ['r1']);
  assert.equal(again.inbox.pending[0].options[0].optionId, 'o');
  assert.deepEqual(again.verification.claims[0].sources, ['s']);
  assert.equal(again.board.usage.a.limit.kind, 'five_hour');
});

test('board usage and agents are keyed safely by any agent id', () => {
  const s = reduce([
    ev(1, 'usage', { agentId: '__proto__', data: { turns: 2 } }),
    ev(2, 'agent.registered', { agentId: 'constructor', data: { backend: 'codex' } }),
  ]);
  assert.ok(Object.hasOwn(s.board.usage, '__proto__'));
  assert.equal(s.board.usage.__proto__.turns, 2); // eslint-disable-line no-proto
  assert.equal(Object.getPrototypeOf(s.board.usage), Object.prototype);
  assert.equal(s.board.agents.constructor.backend, 'codex');
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(s.board.usage))), ['__proto__']);
});

test('state.next counts pending requests routed to a human while running', () => {
  const opened = (seq, requestId, data = {}) => ev(seq, 'request.opened', { data: { requestId, kind: 'gate', title: 'G', ...data } });
  assert.equal(reduce([ev(1, 'run.started'), opened(2, 'a', { routeTo: 'lead' })]).state.next, 'Watch the office panel — the team is working.');
  assert.equal(reduce([ev(1, 'run.started'), opened(2, 'a')]).state.next, '1 thing needs you — open the inbox.');
  assert.equal(reduce([ev(1, 'run.started'), opened(2, 'a'), opened(3, 'b', { blocking: false })]).state.next, '2 things need you — open the inbox.');
  assert.equal(reduce([opened(1, 'a')]).state.next, 'Waiting for the first run.');
  assert.equal(reduce([ev(1, 'run.started'), opened(2, 'a'), ev(3, 'run.finished')]).state.next, 'Run finished — open the result.');
});

test('round.started: a follow-up round keeps the run, ignored before any run', () => {
  assert.deepEqual(reduce([ev(1, 'round.started', { data: { round: 2 } })]).state.phase, 'locked');
  assert.equal(reduce([ev(1, 'round.started')]).statuses.lead.state, 'idle');
  const s = reduce([
    ev(1, 'run.started'),
    ev(2, 'request.opened', { agentId: 'a', data: { requestId: 'r1', kind: 'gate', title: 'G', routeTo: 'lead' } }),
    ev(3, 'task.assigned', { agentId: 'a', data: { taskId: 't1', title: 'T' } }),
    ev(4, 'claim.added', { data: { claimId: 'c1', text: 'x' } }),
    ev(5, 'result', { data: { markdown: 'one' } }),
    ev(6, 'run.finished'),
    ev(7, 'round.started', { data: { round: 2, question: 'More?' } }),
  ]);
  assert.deepEqual([s.state.phase, s.state.run], ['running', 1]);
  assert.deepEqual([s.statuses.lead.state, s.statuses.lead.say, s.statuses.lead.progress], ['working', 'Working on your follow-up', 0]);
  assert.equal(s.statuses.a.state, 'flagged');
  assert.equal(s.result.markdown, 'one');
  assert.deepEqual([s.inbox.pending.length, s.board.tasks.length, s.verification.claims.length], [1, 1, 1]);
});
