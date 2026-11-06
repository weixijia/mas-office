import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir as tmp, evalTwin, listTree } from './helpers.js';
import { jsTwin, parseJsTwin, describeDocument, writeSnapshots, updateProjectsIndex, reduce, readDocument, splitJsTwin } from '../../src/sdk/index.js';

test('jsTwin: plain and status forms', () => {
  assert.deepEqual(evalTwin(jsTwin('MAS_STATE', { phase: 'done' })).MAS_STATE, { phase: 'done' });
  const w = evalTwin(jsTwin('MAS_STATUS', { state: 'working' }, 'finder-a'));
  evalTwin(jsTwin('MAS_STATUS', { state: 'done' }, 'lead'), w);
  assert.deepEqual(w.MAS_STATUS, { 'finder-a': { state: 'working' }, lead: { state: 'done' } });
  assert.deepEqual(parseJsTwin(jsTwin('MAS_HOME', { current: null, projects: [] })), { current: null, projects: [] });
  assert.equal(parseJsTwin('alert(1)'), undefined);
});

test('describeDocument maps paths to documents', () => {
  assert.deepEqual(describeDocument('home/projects.js'), { kind: 'projects', global: 'MAS_HOME' });
  assert.deepEqual(describeDocument('demo/mas/env.json'), { kind: 'env', global: 'MAS_ENV' });
  assert.deepEqual(describeDocument('/x/demo/mas/status/lead.json'), { kind: 'status', global: 'MAS_STATUS', statusId: 'lead' });
  assert.deepEqual(describeDocument('demo/outputs/result'), { kind: 'result', global: 'MAS_RESULT' });
  assert.equal(describeDocument('demo/outputs/work/a.md'), null);
});

test('writeSnapshots writes JSON + twins and skips unsafe status ids', () => {
  const dir = tmp();
  try {
    const snap = reduce([{ v: '0.1', seq: 1, ts: 't', type: 'run.started', data: { title: 'T' } }]);
    snap.statuses['../evil'] = { state: 'idle' };
    writeSnapshots(dir, snap);
    const files = listTree(dir);
    assert.deepEqual(files, ['mas', 'mas/state.js', 'mas/state.json', 'mas/status', 'mas/status/lead.js', 'mas/status/lead.json', 'mas/structure.js', 'mas/structure.json']);
    assert.deepEqual(evalTwin(fs.readFileSync(path.join(dir, 'mas/structure.js'), 'utf8')).MAS_STRUCTURE, snap.structure);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'mas/state.json'), 'utf8')), snap.state);
    assert.ok(!fs.existsSync(path.join(path.dirname(dir), 'evil.json')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('updateProjectsIndex keeps other projects and sets current', () => {
  const ws = tmp();
  try {
    updateProjectsIndex(ws, { folder: 'one', title: 'One', phase: 'done' });
    updateProjectsIndex(ws, { folder: 'two', title: 'Two', phase: 'running' });
    updateProjectsIndex(ws, { folder: 'one', phase: 'running' });
    const home = readDocument(path.join(ws, 'home/projects'));
    assert.equal(home.current, 'one');
    assert.deepEqual(home.projects, [{ folder: 'one', title: 'One', phase: 'running' }, { folder: 'two', title: 'Two', phase: 'running' }]);
    assert.deepEqual(evalTwin(fs.readFileSync(path.join(ws, 'home/projects.js'), 'utf8')).MAS_HOME, home);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('splitJsTwin reads both twin shapes statically and rejects everything else', () => {
  assert.deepEqual(splitJsTwin(jsTwin('MAS_STATE', { a: 1 })), { global: 'MAS_STATE', json: '{\n  "a": 1\n}' });
  assert.deepEqual(parseJsTwin(jsTwin('MAS_STATUS', { state: 'done' }, 'constructor')), { state: 'done' });
  assert.deepEqual(splitJsTwin(jsTwin('MAS_STATUS', {}, 'a-1')), { global: 'MAS_STATUS', statusId: 'a-1', json: '{}' });
  assert.deepEqual(
    splitJsTwin("\n\twindow.MAS_STATUS\n=window.MAS_STATUS ||{}\n;\nwindow.MAS_STATUS ['x'] =\n[1]\n;\n"),
    { global: 'MAS_STATUS', statusId: 'x', json: '[1]' },
  );
  for (const code of ['', 'while (true) {}', 'alert(1); window.X = {}', 'window.X.y = {}', 'window["X"] = {}',
    'window.A = window.B || {}; window.A["x"] = {}']) {
    assert.equal(parseJsTwin(code), undefined, code);
  }
  assert.equal(parseJsTwin('window.X = {}; alert(1)'), undefined, 'trailing code is not JSON');
  const start = Date.now();
  assert.equal(parseJsTwin(`window.X = ${' '.repeat(500_000)}x`), undefined);
  assert.ok(Date.now() - start < 1000, 'linear time on hostile input');
});
