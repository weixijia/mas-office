#!/usr/bin/env node
// Expected values for MASOfficeChecks, computed by the panel's own JS (panel/inbox.js, panel/model.js) so the
// Swift ports are checked against the real rules, not against a copy of them.
// Usage: node js-expected.cjs <cases.json>   → prints one JSON object on stdout.
// cases.json: {fixture: <project dir>, now: <ms>, claims: [string], receipts: [{local, cmd}], durations: [ms],
//              waits: [[sinceMs|null, nowMs]], rounds: [result], names: [[string]], subjects: [object|null]}
'use strict';
const fs = require('fs');
const path = require('path');
const repo = path.resolve(__dirname, '..', '..', '..');
const I = require(path.join(repo, 'panel', 'inbox.js'));
const M = require(path.join(repo, 'panel', 'model.js'));

const cases = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const load = (rel) => M.evalDataFile(fs.readFileSync(path.join(cases.fixture, rel), 'utf8'));
const s = load('mas/structure.js').MAS_STRUCTURE;
const inbox = I.normalizeInbox(load('mas/inbox.js').MAS_INBOX);
const statuses = Object.assign({}, ...['lead'].concat(s.roles.map((r) => r.id)).map((id) => load('mas/status/' + id + '.js').MAS_STATUS));
const now = cases.now;
const ar = I.arrangeInbox(inbox, s, statuses, {}, now);
const item = (x) => ({ id: x.req.requestId, since: x.since, holds: x.holds, waited: I.waited(x.since, now) });
const waiting = I.waitingAgents(ar.human);
const nu = new I.NextUp();
const nextUp = [];
for (let i = 0; i < 6; i++) { const w = nu.next(waiting, i === 3 ? 'catch-checker' : null); nextUp.push(w ? w.id : null); }
const nu2 = new I.NextUp();
const idle = [];
const idleList = I.idleAgents(s, statuses);
for (let i = 0; i < 3; i++) { const w = nu2.next(idleList, null); idle.push(w ? w.id : null); }

const transcripts = {};
const tdir = path.join(cases.fixture, 'mas', 'transcript');
for (const f of fs.readdirSync(tdir)) {
  const r = I.jsonlAppend(null, fs.readFileSync(path.join(tdir, f), 'utf8'));
  const rows = I.groupTranscript(r.entries);
  const cur = I.currentTool(r.entries);
  transcripts[f.replace(/\.jsonl$/, '')] = {
    entries: r.entries.length,
    rows: rows.map((g) => (g.kind === 'tools' ? 'tools:' + g.tool + ':' + g.count + ':' + g.failed + ':' + g.running : 'entry:' + g.entry.kind)),
    current: cur ? cur.tool : null,
  };
}

const ver = M.normalizeVerification(load('outputs/verification.js').MAS_VERIFICATION);
const out = {
  human: ar.human.map(item),
  withLead: ar.withLead.map(item),
  recent: ar.recent.map((r) => ({ id: r.requestId, outcome: I.outcomeText(r), by: I.byText(r.by, (id) => 'N:' + id) })),
  waiting: waiting.map((w) => ({ id: w.id, count: w.count, requestIds: w.requestIds })),
  nextUp,
  idle,
  answers: inbox.pending.map((r) => ({ id: r.requestId, options: I.answerOptions(r).map((o) => [o.optionId, o.tone, o.needsText, o.always]), quick: !!I.quickPair(r) })),
  subjects: inbox.pending.map((r) => { const v = I.subjectView(r.subject); return v && { type: v.type, label: v.label, lines: v.lines, long: v.long }; }),
  extraSubjects: (cases.subjects || []).map((x) => { const v = I.subjectView(x); return v && { type: v.type, label: v.label, text: v.text, lines: v.lines, long: v.long }; }),
  receipts: (cases.receipts || []).map((c) => { const r = I.receipt(c.local, c.cmd); return { state: r.state, final: r.final, ok: r.ok, text: r.text }; }),
  durations: (cases.durations || []).map((ms) => I.durationText(ms)),
  waits: (cases.waits || []).map(([since, n]) => I.waited(since, n)),
  names: (cases.names || []).map((n) => [I.namesText(n), I.holdsUpText(n)]),
  claims: (cases.claims || []).map((t) => M.claimSegments(t).map((x) => (x.claim ? { text: x.text, id: x.claim.id, src: x.claim.src } : { text: x.text }))),
  rounds: (cases.rounds || []).map((r) => M.resultRounds(r).map((x) => [x.round, x.question, x.markdown, x.latest])),
  credibility: M.credibility(ver.summary).text,
  transcripts,
  // Supervision views (MASOfficeChecks SupervisionChecks.swift)
  stops: (cases.stops || []).map((c) => I.stopState(c.stop, c.cmd, c.keyNow, c.stopReason)),
  notify: (cases.notify || []).map((o) => I.shouldNotify(o)),
  statusKeys: (cases.statusKeys || []).map((st) => M.statusKey(st) + '|' + ((st && st.stopReason) || '')),
  usage: (cases.usage || []).map((u) => { const r = M.usageInfo(u); return r && { text: r.text, warn: r.warn, tokens: r.tokens, cost: r.cost }; }),
  ledgers: (cases.ledgers || []).map((l) => M.ledgerLine(l, (x) => 'N:' + x)),
  clocks: (cases.clocks || []).map((ms) => M.formatClock(ms)),
};
process.stdout.write(JSON.stringify(out));
