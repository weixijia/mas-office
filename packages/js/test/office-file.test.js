import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Office, reduce } from '../src/index.js';
import { tmpDir, evalTwin, readJson, captureWarnings } from './helpers.js';

const STRUCTURE = {
  title: 'Headphone deals',
  lead: { id: 'lead', name: 'Lead', emoji: '🧭', job: 'Write the shortlist' },
  groups: [{ id: 'A', label: 'Search', after: null }, { id: 'B', label: 'Check', after: 'A' }],
  roles: [
    { id: 'finder-a', name: 'Retail finder', emoji: '🔎', group: 'A', handsTo: 'checker' },
    { id: 'checker', name: 'Catch checker', emoji: '🛡️', group: 'B', handsTo: 'lead' },
  ],
};

const readLog = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('file transport end to end: log, snapshots, twins, task and home index', async () => {
  const ws = tmpDir();
  try {
    const office = new Office({ workspace: ws });
    const project = office.project('headphone-deals', {
      title: 'Headphone deals',
      task: { summary: 'Find a deal', requirements: [{ id: 'R1', text: 'Under £280' }] },
    });
    const run = project.run({ structure: STRUCTURE });
    const finder = run.agent('finder-a');
    const checker = run.agent('checker');
    const helper = run.agent('helper', { name: 'Helper', emoji: '🧰', parent: finder });

    finder.working('Searching Currys', { progress: 20 });
    const value = await finder.tool('web_search', async () => 42);
    assert.equal(value, 42);
    await assert.rejects(finder.tool('web_fetch', async () => { throw new Error('boom'); }), /boom/);
    finder.source({ id: 'currys-xm6', title: 'Sony XM6 — Currys', url: 'https://example.com/xm6', evidence: 'A' });
    helper.say('Found a cheaper seller');
    finder.handoff(checker, { say: 'Two offers for you' });
    finder.done('Handed over');
    checker.flag('Refurbished — breaks R2', { kind: 'concern' });
    checker.resolve();
    checker.done();
    run.result({ markdown: '## Shortlist\n- Currys £279', work: [{ by: 'checker', summary: 'Checked 2 offers.' }] });
    run.finish();
    await office.close();

    const dir = path.join(ws, 'headphone-deals');
    const log = readLog(path.join(dir, 'mas/events.jsonl'));
    assert.deepEqual(log.map((e) => e.seq), log.map((_, i) => i + 1), 'seq is 1, 2, 3, …');
    assert.ok(log.every((e) => e.v === '0.1' && typeof e.ts === 'string' && e.runId === run.id));
    assert.deepEqual(log.map((e) => e.type), [
      'run.started', 'agent.status', 'tool.started', 'tool.finished', 'tool.started', 'tool.failed', 'artifact',
      'agent.registered', 'message', 'handoff', 'agent.finished', 'flag.raised', 'flag.resolved', 'agent.finished',
      'result', 'run.finished',
    ]);
    assert.equal(log[7].agentId, 'helper');
    assert.equal(log[7].parentId, 'finder-a');

    // The snapshots on disk are exactly what a replay of the log gives.
    const snap = reduce(log);
    assert.deepEqual(readJson(path.join(dir, 'mas/structure.json')), snap.structure);
    assert.deepEqual(readJson(path.join(dir, 'mas/state.json')), snap.state);
    assert.deepEqual(readJson(path.join(dir, 'outputs/result.json')), snap.result);
    assert.equal(snap.state.phase, 'done');
    assert.equal(snap.result.sources[0].foundBy, 'finder-a');
    assert.deepEqual(snap.structure.roles.map((r) => r.id), ['finder-a', 'checker', 'helper']);

    // The .js twins are what the file:// panel loads.
    const read = (rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
    assert.deepEqual(evalTwin(read('mas/structure.js')).MAS_STRUCTURE, snap.structure);
    assert.deepEqual(evalTwin(read('mas/state.js')).MAS_STATE, snap.state);
    assert.deepEqual(evalTwin(read('outputs/result.js')).MAS_RESULT, snap.result);
    const window = {};
    for (const id of Object.keys(snap.statuses)) evalTwin(read(`mas/status/${id}.js`), window);
    assert.deepEqual(window.MAS_STATUS, snap.statuses);

    assert.deepEqual(evalTwin(read('me/task.js')).MAS_TASK, {
      title: 'Headphone deals', summary: 'Find a deal', requirements: [{ id: 'R1', text: 'Under £280' }],
    });
    const home = evalTwin(fs.readFileSync(path.join(ws, 'home/projects.js'), 'utf8')).MAS_HOME;
    assert.deepEqual(home, {
      current: 'headphone-deals',
      projects: [{ folder: 'headphone-deals', title: 'Headphone deals', step: 4, phase: 'done', agents: 4, runs: 1 }],
    });
    assert.deepEqual(readJson(path.join(ws, 'home/projects.json')), home);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('seq continues across two Office instances; the reducer state is rebuilt from the log', async () => {
  const ws = tmpDir();
  try {
    const first = new Office({ workspace: ws });
    const run1 = first.project('twice').run({ structure: STRUCTURE });
    run1.agent('finder-a').working('Searching');
    run1.finish();
    await first.close();

    const second = new Office({ workspace: ws });
    const project = second.project('twice', { title: 'Twice' });
    const run2 = project.run(); // no structure: keeps the one from the log
    run2.agent('checker').done();
    run2.finish();
    await second.close();

    const log = readLog(path.join(ws, 'twice/mas/events.jsonl'));
    assert.deepEqual(log.map((e) => e.seq), [1, 2, 3, 4, 5, 6]);
    const state = readJson(path.join(ws, 'twice/mas/state.json'));
    assert.equal(state.run, 2);
    assert.equal(state.runId, run2.id);
    assert.equal(readJson(path.join(ws, 'twice/mas/structure.json')).title, 'Headphone deals');
    assert.equal(readJson(path.join(ws, 'twice/mas/status/finder-a.json')).state, 'waiting', 'reset by the second run');
    assert.equal(readJson(path.join(ws, 'home/projects.json')).projects[0].runs, 2);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('a log with a torn last line still continues cleanly', async () => {
  const ws = tmpDir();
  try {
    fs.mkdirSync(path.join(ws, 'torn/mas'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'torn/mas/events.jsonl'),
      '{"v":"0.1","seq":7,"ts":"2026-11-06T10:00:00Z","type":"run.started","data":{"title":"Torn"}}\n{"v":"0.1","seq":8,"ts');
    const office = new Office({ workspace: ws });
    office.project('torn').run().finish();
    const lines = fs.readFileSync(path.join(ws, 'torn/mas/events.jsonl'), 'utf8').split('\n');
    // The torn line is not an event, so numbering continues after seq 7.
    assert.equal(JSON.parse(lines[2]).seq, 8);
    assert.equal(JSON.parse(lines[3]).seq, 9);
    assert.equal(readJson(path.join(ws, 'torn/mas/state.json')).run, 2);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('folder names and agent ids are validated up front', () => {
  const office = new Office({ workspace: tmpDir() });
  for (const bad of ['', 'Upper', '-dash', 'a/b', '..', 'a'.repeat(41), 'sp ace', 'ü']) {
    assert.throws(() => office.project(bad), TypeError, bad);
  }
  assert.ok(office.project('a'.repeat(40)));
  assert.ok(office.project('0-ok-1'));
  const run = office.project('ids').run();
  assert.throws(() => run.agent('Bad Id'), TypeError);
  assert.throws(() => run.agent('../x'), TypeError);
  assert.equal(run.agent('lead'), run.lead);
  assert.throws(() => new Office({}), TypeError);
  assert.throws(() => new Office({ workspace: 'a', url: 'http://x' }), TypeError);
});

test('emitting never throws: invalid events and write failures only warn once', async () => {
  const ws = tmpDir();
  try {
    await captureWarnings((warnings) => {
      const office = new Office({ workspace: ws });
      const run = office.project('safe').run();
      const a = run.agent('a');
      a.say(undefined);
      a.say(undefined);
      a.status('sleeping');
      assert.equal(warnings.length, 2, warnings.join('\n'));
      // Make the log unwritable by replacing it with a folder.
      fs.rmSync(path.join(ws, 'safe/mas/events.jsonl'));
      fs.mkdirSync(path.join(ws, 'safe/mas/events.jsonl'));
      a.working('still fine');
      a.working('still fine');
      assert.equal(warnings.length, 3, warnings.join('\n'));
      assert.match(warnings[2], /cannot write events/);
    });
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('a new run removes the previous run\'s result files (spec §4.5)', async () => {
  const workspace = tmpDir();
  const office = new Office({ workspace });
  const project = office.project('twice', { title: 'Twice' });
  const result = path.join(workspace, 'twice', 'outputs', 'result');
  const first = project.run();
  first.result({ markdown: 'first' });
  first.finish();
  assert.ok(fs.existsSync(`${result}.json`) && fs.existsSync(`${result}.js`));
  project.run();
  assert.ok(!fs.existsSync(`${result}.json`) && !fs.existsSync(`${result}.js`));
  await office.close();
});
