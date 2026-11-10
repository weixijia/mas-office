// Run: node panel/tests/inbox.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const I = require('../inbox.js');
const M = require('../model.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message.split('\n').join('\n       ')); }
}
const FX = path.join(__dirname, 'fixtures', 'mock-supervise', 'deals');
const load = (rel) => M.evalDataFile(fs.readFileSync(path.join(FX, rel), 'utf8'));
const S = load('mas/structure.js').MAS_STRUCTURE;
const INBOX = load('mas/inbox.js').MAS_INBOX;
const STATUSES = Object.assign({}, ...['lead', 'retail-finder', 'marketplace-finder', 'catch-checker'].map((id) => load('mas/status/' + id + '.js').MAS_STATUS));
const MIN = 60000;
const T0 = Date.parse('2026-11-10T09:00:00Z');
const req = (o) => I.normalizeRequest(Object.assign({ requestId: 'r', agentId: 'a', kind: 'approval', title: 't' }, o));

console.log('inbox.js');

test('wait time: nothing in the first minute, then minutes, then hours', () => {
  const now = T0 + 200 * MIN;
  assert.strictEqual(I.waited(now - 59000, now), '');
  assert.strictEqual(I.waited(now - 60000, now), '1 min');
  assert.strictEqual(I.waited(now - 4 * MIN - 30000, now), '4 min');
  assert.strictEqual(I.waited(now - 59 * MIN, now), '59 min');
  assert.strictEqual(I.waited(now - 65 * MIN, now), '1 h 05 min');
  assert.strictEqual(I.waited(now - 125 * MIN, now), '2 h 05 min');
  assert.strictEqual(I.waited(undefined, now), '');
  assert.strictEqual(I.waited(NaN, now), '');
});

test('a wait starts at openedAt unless it is missing or in the future, then at first sight', () => {
  const now = T0 + 30 * MIN;
  assert.strictEqual(I.sinceOf({ openedAt: new Date(T0).toISOString() }, 123, now), T0);
  assert.strictEqual(I.sinceOf({ openedAt: 'garbage' }, 123, now), 123);
  assert.strictEqual(I.sinceOf({ openedAt: new Date(now + 10 * MIN).toISOString() }, 456, now), 456, 'a skewed clock is not trusted');
  assert.strictEqual(I.sinceOf({}, null, now), now);
  assert.strictEqual(I.waitKey('finder', 5), 'finder@5');
});

test('durations for the HCI timings', () => {
  assert.deepStrictEqual([500, 12000, 60000, 100000, 3900000].map(I.durationText), ['<1 s', '12 s', '1 min', '1 min 40 s', '1 h 05 min']);
  assert.strictEqual(I.durationText(-1), '');
  assert.strictEqual(I.durationText(null), '');
});

test('normalisation drops malformed entries and fills defaults', () => {
  const box = I.normalizeInbox({ pending: [null, 5, { title: 'no id' }, { requestId: 'ok', kind: 'gate', title: 'G', urgency: 'extreme', options: [{ optionId: 'a', name: 'A', kind: 'allow_once' }, { name: 'no id' }, 'x'] }],
    recent: [{ requestId: 'r', outcome: 'weird' }], commands: [{ cmdId: 'c', status: 'nonsense' }, { status: 'applied' }] });
  assert.strictEqual(box.pending.length, 1);
  const r = box.pending[0];
  assert.deepStrictEqual([r.urgency, r.blocking, r.routeTo, r.resolver, r.options.length], ['normal', true, 'human', 'anyone', 1]);
  assert.strictEqual(box.recent[0].outcome, null);
  assert.deepStrictEqual(box.commands.map((c) => [c.cmdId, c.status]), [['c', 'sent']]);
  assert.strictEqual(I.normalizeInbox(null), null);
  assert.strictEqual(I.normalizeInbox([]), null);
  assert.strictEqual(I.kindInfo('weird').kind, 'question', 'unknown kinds read as a question');
});

test('what a request holds up: the handsTo chain, later stages, the Lead last', () => {
  assert.deepStrictEqual(I.holdsUp(req({ agentId: 'retail-finder' }), S), ['catch-checker', 'lead']);
  assert.deepStrictEqual(I.holdsUp(req({ agentId: 'catch-checker' }), S), ['lead']);
  assert.deepStrictEqual(I.holdsUp(req({ agentId: 'lead' }), S), []);
  // a gate on stage A holds up everyone in later stages, and the Lead
  assert.deepStrictEqual(I.holdsUp(req({ agentId: 'lead', kind: 'gate', subject: { type: 'stage', after: 'A' } }), S), ['catch-checker']);
  // agents already finished are not held up
  assert.deepStrictEqual(I.holdsUp(req({ agentId: 'retail-finder' }), S, { 'catch-checker': { state: 'done' } }), ['lead']);
  // cycles and unknown agents do not loop
  const cyc = { roles: [{ id: 'a', handsTo: 'b' }, { id: 'b', handsTo: 'a' }] };
  assert.deepStrictEqual(I.holdsUp(req({ agentId: 'a' }), cyc), ['b']);
  assert.deepStrictEqual(I.holdsUp(req({ agentId: 'ghost' }), S), []);
  assert.strictEqual(I.holdsUpText(['Catch checker', 'Lead']), 'Holds up Catch checker and Lead');
  assert.strictEqual(I.holdsUpText(['A', 'B', 'C']), 'Holds up A, B and C');
  assert.strictEqual(I.holdsUpText(['A', 'B', 'C', 'D', 'E']), 'Holds up A, B and 3 others');
  assert.strictEqual(I.holdsUpText([]), '');
});

test('sorting: urgency, then blocking more, then oldest', () => {
  const now = T0 + 60 * MIN;
  const at = (m) => new Date(T0 + m * MIN).toISOString();
  const box = I.normalizeInbox({ pending: [
    { requestId: 'low-old', agentId: 'retail-finder', kind: 'approval', title: 'x', urgency: 'low', openedAt: at(1) },
    { requestId: 'normal-new-chain', agentId: 'retail-finder', kind: 'approval', title: 'x', openedAt: at(30) },
    { requestId: 'normal-old-lead', agentId: 'lead', kind: 'approval', title: 'x', openedAt: at(2) },
    { requestId: 'normal-old-chain', agentId: 'marketplace-finder', kind: 'approval', title: 'x', openedAt: at(10) },
    { requestId: 'high-nonblocking', agentId: 'catch-checker', kind: 'flag', title: 'x', urgency: 'high', blocking: false, openedAt: at(50) },
    { requestId: 'normal-nonblocking', agentId: 'retail-finder', kind: 'flag', title: 'x', blocking: false, openedAt: at(0) },
    { requestId: 'via-lead', agentId: 'retail-finder', kind: 'approval', title: 'x', routeTo: 'lead', openedAt: at(0) }
  ] });
  const ar = I.arrangeInbox(box, S, {}, {}, now);
  assert.deepStrictEqual(ar.human.map((x) => x.req.requestId), ['high-nonblocking', 'normal-old-chain', 'normal-new-chain', 'normal-old-lead', 'normal-nonblocking', 'low-old']);
  assert.deepStrictEqual(ar.withLead.map((x) => x.req.requestId), ['via-lead']);
  assert.deepStrictEqual(ar.human.find((x) => x.req.requestId === 'normal-nonblocking').holds, [], 'a non-blocking request holds nobody up');
});

test('the fixture inbox: needs-you list, the Lead\'s list, recent', () => {
  const box = I.normalizeInbox(INBOX), now = T0 + 31 * MIN;
  const ar = I.arrangeInbox(box, S, STATUSES, {}, now);
  assert.deepStrictEqual(ar.human.map((x) => x.req.requestId), ['req_flag', 'req_browse', 'req_q', 'req_gate', 'req_cmd']);
  assert.deepStrictEqual(ar.withLead.map((x) => x.req.requestId), ['req_lead1']);
  assert.strictEqual(ar.recent.length, 4);
  assert.strictEqual(I.waited(ar.human[1].since, now), '5 min');
  const w = I.waitingAgents(ar.human);
  assert.deepStrictEqual(w.map((x) => x.id), ['catch-checker', 'marketplace-finder', 'retail-finder', 'lead'], 'most urgent first, then longest waiting');
  assert.deepStrictEqual(I.waitingAgents(ar.human.map((x) => (x.req.requestId === 'req_flag' ? Object.assign({}, x, { req: Object.assign({}, x.req, { blocking: false }) }) : x))).map((x) => x.id),
    ['marketplace-finder', 'retail-finder', 'lead'], 'a non-blocking request raises no hand');
  assert.deepStrictEqual(w[1].requestIds.sort(), ['req_cmd', 'req_q'], 'one hand per agent, all its requests');
});

test('NextUp: round-robin, a new wait episode is new, `here` only when alone', () => {
  const nu = new I.NextUp();
  const list = [{ id: 'a', since: 1 }, { id: 'b', since: 2 }, { id: 'c', since: 3 }];
  assert.deepStrictEqual([nu.next(list), nu.next(list), nu.next(list), nu.next(list)].map((x) => x.id), ['a', 'b', 'c', 'a']);
  const nu2 = new I.NextUp();
  assert.strictEqual(nu2.next(list, 'a').id, 'b', 'skips the one you are at');
  assert.strictEqual(nu2.next(list, 'b').id, 'a', 'then the first not yet visited');
  assert.strictEqual(nu2.next(list, 'a').id, 'c');
  // a was visited at since 1; it starts a new wait (since 9): new to this round
  const nu3 = new I.NextUp();
  nu3.next(list); nu3.next(list);
  assert.strictEqual(nu3.next([{ id: 'a', since: 9 }, { id: 'b', since: 2 }, { id: 'c', since: 3 }]).id, 'a');
  assert.strictEqual(new I.NextUp().next([{ id: 'only', since: 1 }], 'only').id, 'only');
  assert.strictEqual(new I.NextUp().next([]), null);
});

test('idle agents for Shift+N', () => {
  assert.deepStrictEqual(I.idleAgents(S, { lead: { state: 'working' }, 'retail-finder': { state: 'done' }, 'marketplace-finder': { state: 'flagged' } }).map((x) => x.id), ['retail-finder', 'catch-checker']);
  assert.deepStrictEqual(I.idleAgents(null, {}), []);
});

test('A / D only for exactly one allow-once and one reject-once option', () => {
  const o = (kind, id) => ({ optionId: id || kind, name: kind, kind });
  assert.ok(I.quickPair(req({ options: [o('allow_once'), o('reject_once')] })));
  assert.strictEqual(I.quickPair(req({ options: [o('allow_once'), o('allow_always'), o('reject_once')] })), null, 'two allow kinds');
  assert.strictEqual(I.quickPair(req({ options: [o('allow_always'), o('reject_once')] })), null, 'never auto-pick always');
  assert.strictEqual(I.quickPair(req({ options: [o('allow_once'), o('reject_always')] })), null);
  assert.strictEqual(I.quickPair(req({ options: [o('choice', 'x'), o('choice', 'y')] })), null);
  assert.strictEqual(I.quickPair(req({ options: [] })), null);
  const box = I.normalizeInbox(INBOX), byId = (id) => box.pending.find((r) => r.requestId === id);
  assert.ok(I.quickPair(byId('req_browse')));
  assert.strictEqual(I.quickPair(byId('req_cmd')), null);
  assert.deepStrictEqual(I.quickPair(byId('req_browse')).allow.optionId, 'allow-once');
});

test('answers: buttons, gates, typed replies', () => {
  const gate = req({ kind: 'gate', options: [] });
  const opts = I.answerOptions(gate);
  assert.deepStrictEqual(opts.map((x) => [x.optionId, x.needsText, x.tone]), [['accept', false, 'allow'], ['revise', true, 'choice'], ['stop', false, 'reject']]);
  assert.deepStrictEqual(I.respondData(gate, opts[1], ' tighten the budget '), { requestId: 'r', outcome: 'selected', optionId: 'revise', payload: { text: 'tighten the budget' } });
  assert.deepStrictEqual(I.respondData(gate, null, 'just text'), { requestId: 'r', outcome: 'submitted', payload: { text: 'just text' } });
  assert.strictEqual(I.respondData(gate, null, '   '), null, 'an empty reply sends nothing');
  const ap = req({ options: [{ optionId: 'y', name: 'Yes', kind: 'allow_always' }] });
  assert.strictEqual(I.answerOptions(ap)[0].always, true);
  assert.deepStrictEqual(I.respondData(ap, I.answerOptions(ap)[0], ''), { requestId: 'r', outcome: 'selected', optionId: 'y' });
});

test('approval subjects are shown in full and marked long', () => {
  const box = I.normalizeInbox(INBOX), byId = (id) => box.pending.find((r) => r.requestId === id);
  const tool = I.subjectView(byId('req_browse').subject);
  assert.strictEqual(tool.label, 'Tool: browse the web');
  assert.ok(tool.text.includes('"note": "Read only: no clicks on Buy, no forms, no cookies kept."'), 'the whole input, nothing dropped');
  assert.ok(tool.long && tool.lines > 8);
  const cmd = I.subjectView(byId('req_cmd').subject);
  assert.strictEqual(cmd.label, 'Command');
  assert.ok(cmd.text.startsWith('curl -s') && cmd.text.endsWith('head -c 20000'));
  assert.strictEqual(I.subjectView(null), null);
  assert.strictEqual(I.subjectView({ type: 'file_change', path: 'notes.md', diff: '+a\n-b' }).text, '+a\n-b');
  assert.strictEqual(I.subjectView({ type: 'plan', steps: ['one', 'two'] }).text, '1. one\n2. two');
  assert.strictEqual(I.subjectView({ type: 'mystery', x: 1 }).label, 'mystery');
  assert.deepStrictEqual(I.subjectView({ type: 'stage', gate: 'g1', after: 'A', files: ['outputs/work/a.md', 7, 'outputs/work/b.md'] }), { type: 'stage', label: 'Stage after A', text: 'outputs/work/a.md\noutputs/work/b.md', lines: 2, long: false });
});

test('who decided and what, for the Recent list', () => {
  const name = (id) => (id === 'lead' ? 'Lead' : id);
  assert.strictEqual(I.byText({ kind: 'human' }, name), 'by you');
  assert.strictEqual(I.byText({ kind: 'agent', id: 'lead' }, name), 'by Lead');
  assert.strictEqual(I.byText({ kind: 'policy', rule: 'web search' }), 'by policy rule "web search"');
  assert.strictEqual(I.byText({ kind: 'terminal' }), 'in the terminal');
  assert.strictEqual(I.byText(null), 'by the system');
  const box = I.normalizeInbox(INBOX);
  assert.deepStrictEqual(box.recent.map(I.outcomeText), ['Answered elsewhere', 'Allow once', 'Replied: "No: the task says UK stock only."', 'Allow once']);
});

test('receipts: sent → accepted → applied / rejected, never backwards, final states stay', () => {
  assert.strictEqual(I.receipt({ state: 'sending' }, null).text, 'Sending…');
  assert.strictEqual(I.receipt({ state: 'sent' }, null).state, 'sent');
  assert.strictEqual(I.receipt({ state: 'sent' }, { status: 'sent' }).state, 'sent');
  assert.strictEqual(I.receipt({ state: 'sent' }, { status: 'accepted' }).state, 'accepted');
  const ap = I.receipt({ state: 'sent' }, { status: 'applied', reason: 'delivered_after_the_current_turn' });
  assert.deepStrictEqual([ap.state, ap.final, ap.ok, ap.text], ['applied', true, true, 'Applied · delivered after the current turn']);
  const rj = I.receipt({ state: 'sent' }, { status: 'rejected', reason: 'already_resolved' });
  assert.deepStrictEqual([rj.state, rj.final, rj.ok, rj.text], ['rejected', true, false, 'Rejected: already resolved']);
  assert.strictEqual(I.receipt({ state: 'conflict' }, { status: 'applied' }).text, 'Already answered', 'a 409 settles it');
  assert.strictEqual(I.receipt({ state: 'failed', error: 'no connection' }, null).text, 'Not sent: no connection');
  assert.strictEqual(I.receipt(undefined, { status: 'accepted' }).state, 'accepted', 'a command this page did not send');
  assert.strictEqual(I.receipt({ state: 'sending' }, { status: 'bogus' }).state, 'sending');
  assert.strictEqual(I.receipt({ state: 'sent' }, { status: 'unsupported' }).text, 'This agent cannot take that');
});

test('Stop: requested until the status really changes; accepted is not stopped', () => {
  const stop = { state: 'sent', key: 'working|Searching' };
  assert.strictEqual(I.stopState(stop, { status: 'accepted' }, 'working|Searching', null).state, 'requested');
  assert.strictEqual(I.stopState(stop, { status: 'applied' }, 'working|Searching', null).state, 'requested', 'applied is still not a status change');
  assert.strictEqual(I.stopState(stop, { status: 'applied' }, 'idle|Stopped', null).state, 'stopped');
  assert.strictEqual(I.stopState(stop, null, 'working|Searching', 'cancelled').state, 'stopped');
  assert.strictEqual(I.stopState(stop, { status: 'rejected', reason: 'no_session' }, 'working|Searching', null).state, 'refused');
  assert.strictEqual(I.stopState(null), null);
});

test('notification admission: hidden tab, 30 s, blocking, routed to you, once per episode', () => {
  const ok = { enabled: true, permission: 'granted', hidden: true, blocking: true, routeTo: 'human', waitedMs: 30000, notified: false };
  assert.strictEqual(I.shouldNotify(ok), true);
  assert.strictEqual(I.shouldNotify(Object.assign({}, ok, { waitedMs: 29999 })), false);
  assert.strictEqual(I.shouldNotify(Object.assign({}, ok, { hidden: false })), false, 'never while you are looking');
  assert.strictEqual(I.shouldNotify(Object.assign({}, ok, { notified: true })), false, 'once per wait episode');
  assert.strictEqual(I.shouldNotify(Object.assign({}, ok, { routeTo: 'lead' })), false, 'the Lead handles it first');
  assert.strictEqual(I.shouldNotify(Object.assign({}, ok, { blocking: false })), false);
  assert.strictEqual(I.shouldNotify(Object.assign({}, ok, { permission: 'default' })), false);
  assert.strictEqual(I.shouldNotify(Object.assign({}, ok, { enabled: false })), false);
});

test('transcript: incremental JSONL reading keeps a half-written line for later', () => {
  let r = I.jsonlAppend(null, '{"kind":"user","text":"a"}\n{"kind":"assist');
  assert.deepStrictEqual([r.reset, r.entries.length], [true, 1]);
  r = I.jsonlAppend(r.state, '{"kind":"user","text":"a"}\n{"kind":"assistant","text":"b"}\nnot json\n[1]\n{"no":"kind"}\n');
  assert.deepStrictEqual([r.reset, r.entries.map((e) => e.kind)], [false, ['assistant']]);
  const again = I.jsonlAppend(r.state, '{"kind":"user","text":"a"}\n{"kind":"assistant","text":"b"}\nnot json\n[1]\n{"no":"kind"}\n');
  assert.strictEqual(again.entries.length, 0, 'nothing new');
  const rewritten = I.jsonlAppend(r.state, '{"kind":"system","text":"new file"}\n');
  assert.deepStrictEqual([rewritten.reset, rewritten.entries.length], [true, 1], 'a replaced file starts over');
});

test('transcript grouping: same-tool calls collapse, failures mark the row, other entries pass through', () => {
  const rows = I.groupTranscript(fs.readFileSync(path.join(FX, 'mas/transcript/retail-finder.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
  const tools = rows.filter((g) => g.kind === 'tools');
  assert.deepStrictEqual(tools.map((g) => [g.tool, g.count, g.failed, g.running]), [['WebSearch', 4, 1, 0], ['WebFetch', 1, 0, 0], ['browse the web', 1, 0, 1]]);
  assert.deepStrictEqual(rows.filter((g) => g.kind === 'entry').map((g) => g.entry.kind), ['system', 'user', 'thinking', 'assistant', 'request', 'resolved', 'command', 'assistant', 'request', 'request']);
  // a result whose call is far back still finds it; a different tool starts a new row; a stray result is its own row
  const g = I.groupTranscript([{ kind: 'tool_call', callId: '1', tool: 'A' }, { kind: 'assistant', text: 'x' }, { kind: 'tool_result', callId: '1', ok: true }, { kind: 'tool_call', callId: '2', tool: 'B' },
    { kind: 'tool_call', callId: '3', tool: 'B' }, { kind: 'tool_result', callId: '9', ok: false }, null, 7]);
  assert.deepStrictEqual(g.map((x) => (x.kind === 'tools' ? x.tool + 'x' + x.count : x.entry.kind)), ['Ax1', 'assistant', 'Bx2', 'toolx1']);
  assert.strictEqual(g[0].steps[0].result.ok, true);
  assert.strictEqual(g[3].failed, 1);
});

test('the tool in use right now', () => {
  assert.deepStrictEqual(I.currentTool([{ kind: 'tool_call', callId: '1', tool: 'WebSearch', summary: 'q' }]), { tool: 'WebSearch', summary: 'q' });
  assert.strictEqual(I.currentTool([{ kind: 'tool_call', callId: '1', tool: 'WebSearch' }, { kind: 'tool_result', callId: '1' }]), null);
  assert.strictEqual(I.currentTool([{ kind: 'tool_call', callId: '1', tool: 'X' }, { kind: 'assistant', text: 'done' }]), null);
  assert.strictEqual(I.currentTool([]), null);
});

test('edge pointers: only for points outside the box, on its edge, spread apart', () => {
  const box = { left: 100, right: 500, top: 100, bottom: 400 };
  assert.deepStrictEqual(I.edgeMarks([{ id: 'in', x: 300, y: 250 }], box), []);
  const m = I.edgeMarks([{ id: 'r1', x: 700, y: 250 }, { id: 'r2', x: 700, y: 252 }, { id: 'up', x: 300, y: -50 }], box);
  const r1 = m.find((x) => x.id === 'r1'), r2 = m.find((x) => x.id === 'r2'), up = m.find((x) => x.id === 'up');
  assert.deepStrictEqual([r1.edge, Math.round(r1.x)], ['right', 500]);
  assert.ok(Math.abs(r2.y - r1.y) >= 56, 'marks on one edge keep apart');
  assert.deepStrictEqual([up.edge, Math.round(up.y)], ['top', 100]);
  assert.ok(Math.abs(r1.angle) < 0.1, 'points right');
  // pushed off the end: backed up inside the box
  const many = I.edgeMarks([0, 1, 2, 3, 4, 5].map((i) => ({ id: 'p' + i, x: 900, y: 390 + i })), box);
  assert.ok(many.every((p) => p.y >= 100 && p.y <= 400));
});

test('the module is pure: no DOM, no network, no clock', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'inbox.js'), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  ['document', 'fetch(', 'XMLHttpRequest', 'Date.now', 'localStorage', 'innerHTML', 'Notification('].forEach((k) => assert.ok(!src.includes(k), k));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
