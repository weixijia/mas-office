import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { verifyCommand } from '../../src/cli/commands/verify.js';
import { reduceCommand } from '../../src/cli/commands/reduce.js';
import { UsageError } from '../../src/cli/args.js';
import { tmpDir, capture, REPO } from '../cli/helpers.js';

const EXAMPLE = path.join(REPO, 'examples', 'thesis-feasibility');
const MARKDOWN = [
  '## Answer',
  '<claim id="c1" src="gdpr-article-9-biometrics">Biometric identification needs explicit consent under GDPR Article 9.</claim>',
  '<claim id="c2" src="ti-iwr6843-gait,missing-card">The TI IWR6843 reaches 95% on known subjects.</claim>',
  'The budget is £1000 for 9 months.',
  '<claim id="c3">broken',
].join('\n');

/** A copy of the example inside `parent`, with an event log holding a run and a tagged result. */
function project(parent, { log = true, home = true } = {}) {
  const dir = path.join(parent, 'thesis-feasibility');
  fs.cpSync(EXAMPLE, dir, { recursive: true });
  if (home) fs.mkdirSync(path.join(parent, 'home'), { recursive: true });
  if (log) {
    const ts = '2026-11-10T10:00:00Z';
    const events = [
      { v: '0.2', seq: 1, ts, type: 'run.started', data: {} },
      { v: '0.2', seq: 2, ts, type: 'result', agentId: 'lead', data: { title: 'Feasibility', markdown: MARKDOWN, sources: [{ id: 'listed-only', url: 'https://listed.example.org/x', evidence: 'C' }] } },
    ];
    fs.writeFileSync(path.join(dir, 'mas', 'events.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
    assert.equal(reduceCommand([dir], { out: () => {} }), 0);
  }
  return dir;
}

const logEvents = (dir) => fs.readFileSync(path.join(dir, 'mas', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('verify --no-network appends claim.added and evidence.checked through the project log', async () => {
  const ws = tmpDir('mas-office-verify-');
  const dir = project(ws);
  const io = capture();
  assert.equal(await verifyCommand([dir, '--no-network'], { out: io.out }), 0);
  const text = io.text();
  assert.match(text, /Claims: 2 tagged, citing 3 source\(s\)/);
  assert.match(text, /Sources: 5 \(links not checked: --no-network\)/);
  assert.match(text, /c2 → missing-card/);
  assert.match(text, /Claim tag problems \(1\):\n {4}at \d+: claim tag is never closed/);
  assert.match(text, /The budget is £1000 for 9 months\. {2}\[price\]/);
  assert.match(text, /Appended 7 event\(s\)/);

  const events = logEvents(dir);
  const added = events.slice(2);
  assert.deepEqual(added.map((e) => e.type), ['claim.added', 'claim.added', ...Array(5).fill('evidence.checked')]);
  assert.deepEqual(added.map((e) => e.seq), [3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(added[1].data, { claimId: 'c2', text: 'The TI IWR6843 reaches 95% on known subjects.', sources: ['ti-iwr6843-gait', 'missing-card'] });
  assert.equal(added[1].agentId, 'lead');
  const gdpr = added.find((e) => e.data.sourceId === 'gdpr-article-9-biometrics');
  assert.deepEqual(Object.keys(gdpr.data).sort(), ['grade', 'note', 'quote', 'sourceId', 'url']);
  assert.equal(gdpr.data.grade, 'A');
  assert.equal(gdpr.data.note, 'not checked (no network)');
  assert.ok(!('urlHealth' in gdpr.data));
  assert.ok(added.some((e) => e.data.sourceId === 'listed-only' && e.data.grade === 'C'));
  assert.ok(fs.existsSync(path.join(ws, 'home', 'projects.json')));
});

test('verify --json reports claims, evidence, summary and flag', async () => {
  const dir = project(tmpDir('mas-office-verify-'));
  const io = capture();
  assert.equal(await verifyCommand([dir, '--no-network', '--json'], { out: io.out }), 0);
  const report = JSON.parse(io.text());
  assert.equal(report.network, false);
  assert.deepEqual(report.claims.map((c) => c.claimId), ['c1', 'c2']);
  assert.equal(report.claimProblems.length, 1);
  assert.deepEqual(report.missingSources, [{ claimId: 'c2', sourceId: 'missing-card' }]);
  assert.deepEqual(report.summary, {
    claims: 2, checkworthy: 2, supported: 0, partial: 0, contradicted: 0, unknown: 0, unchecked: 2,
    sources: 5, live: 0, stale: 0, hallucinated: 0, blocked: 0, uncited: 3,
  });
  assert.deepEqual(report.flag, { flag: false, reasons: [] });
  assert.equal(report.appended, 7);
  assert.ok(report.evidence.every((e) => e.urlHealth === null));
});

test('verify with an (injected) network marks dead links and asks for a person', async () => {
  const dir = project(tmpDir('mas-office-verify-'));
  const dead = 'https://gdpr-info.eu/art-9-gdpr/';
  const fetch = async (url, init) => {
    if (url === dead) return new Response(null, { status: 404 });
    if (url.startsWith('https://archive.org/wayback/available')) return new Response('{"archived_snapshots":{}}', { status: 200 });
    if (url.startsWith('https://listed.example.org/')) return new Response(null, { status: 403 });
    return new Response(init.method === 'HEAD' ? null : '<html><title>ok</title>content</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const io = capture();
  assert.equal(await verifyCommand([dir], { out: io.out, fetch, lookup }), 0);
  const text = io.text();
  assert.match(text, /Sources: 5 \(live 3, stale 0, hallucinated 1, blocked 1, unknown 0\)/);
  assert.match(text, /✗ hallucinated +gdpr-article-9-biometrics {2}https:\/\/gdpr-info\.eu\/art-9-gdpr\/ {2}\(HTTP 404; not found and never archived\)/);
  assert.match(text, /✗ blocked +listed-only/);
  assert.match(text, /Needs a person:\n {4}- 1 cited link does not exist and was never archived\./);
  const gdpr = logEvents(dir).find((e) => e.type === 'evidence.checked' && e.data.sourceId === 'gdpr-article-9-biometrics');
  assert.deepEqual([gdpr.data.urlHealth, gdpr.data.httpStatus], ['hallucinated', 404]);
});

test('a project without an event log is read but never written', async () => {
  const parent = tmpDir('mas-office-verify-');
  const dir = project(parent, { log: false, home: false });
  const before = fs.readFileSync(path.join(dir, 'outputs', 'result.js'), 'utf8');
  const io = capture();
  assert.equal(await verifyCommand([dir, '--no-network'], { out: io.out }), 0);
  assert.match(io.text(), /Claims: 0 tagged/);
  assert.match(io.text(), /No event log at .*events\.jsonl; nothing appended\./);
  assert.equal(fs.readFileSync(path.join(dir, 'outputs', 'result.js'), 'utf8'), before);
  assert.ok(!fs.existsSync(path.join(dir, 'mas', 'events.jsonl')));
  assert.ok(!fs.existsSync(path.join(parent, 'home')));
});

test('a log outside a workspace is appended without creating home/', async () => {
  const parent = tmpDir('mas-office-verify-');
  const dir = project(parent, { home: false });
  const io = capture();
  assert.equal(await verifyCommand([dir, '--no-network'], { out: io.out }), 0);
  assert.equal(logEvents(dir).length, 9);
  assert.ok(!fs.existsSync(path.join(parent, 'home')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'outputs', 'result.json'), 'utf8')).markdown, MARKDOWN);
});

test('usage errors and a missing result', async () => {
  await assert.rejects(verifyCommand([]), UsageError);
  await assert.rejects(verifyCommand(['x', '--fast']), UsageError);
  const io = capture();
  assert.equal(await verifyCommand([tmpDir('mas-office-verify-')], { out: io.out }), 1);
  assert.match(io.text(), /No result at/);
});
