import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validatePath, validateCommand } from '../src/commands/validate.js';
import { tmpDir, write, capture, REPO } from './helpers.js';

const errorsByFile = (results, root) => Object.fromEntries(
  results.filter((r) => r.errors.length).map((r) => [path.relative(root, r.file).split(path.sep).join('/'), r.errors]),
);

test('the examples in the repo are valid', () => {
  const examples = path.join(REPO, 'examples');
  const results = validatePath(examples);
  assert.ok(results.length > 10, `checked ${results.length} files`);
  assert.deepEqual(errorsByFile(results, examples), {});
  for (const name of fs.readdirSync(examples)) {
    if (fs.statSync(path.join(examples, name)).isDirectory()) {
      assert.ok(results.some((r) => r.file.includes(`${path.sep}${name}${path.sep}`)), `${name} was checked`);
    }
  }
});

test('a broken workspace reports every problem with a path', () => {
  const ws = tmpDir();
  try {
    write(path.join(ws, 'home/projects.json'), { current: 'p', projects: [{ folder: 'Bad Folder' }] });
    write(path.join(ws, 'p/mas/structure.json'), {
      lead: { id: 'boss', name: 'Lead' },
      roles: [{ id: 'a', name: 'A', handsTo: 'nobody' }, { name: 'No id' }],
    });
    write(path.join(ws, 'p/mas/state.json'), { phase: 'party', step: 4 });
    write(path.join(ws, 'p/mas/state.js'), 'window.MAS_STATE = {"phase": "done", "step": 4};');
    write(path.join(ws, 'p/mas/status/a.js'), 'window.MAS_STATUS = window.MAS_STATUS || {}; window.MAS_STATUS["b"] = {"state": "done"};');
    write(path.join(ws, 'p/mas/status/lead.js'), '\n window.MAS_STATUS =\n\twindow.MAS_STATUS||{} ;\r\nwindow.MAS_STATUS[ "lead" ]= {"state": "working", "progress": 140}\n');
    write(path.join(ws, 'p/mas/status/b.js'), 'window.MAS_STATUS = {}; window.MAS_STATUS["b"] = {"state": "done"};');
    write(path.join(ws, 'p/mas/status/c.js'), 'window.MAS_STATUS = window.MAS_STATUS || {}; window.MAS_STATUS["c"] = Promise.resolve().then(function f(){return Promise.resolve().then(f)});');
    write(path.join(ws, 'p/outputs/result.js'), 'window.MAS_RESULT = {oops');
    write(path.join(ws, 'p/me/task.js'), 'while (true) {}');
    write(path.join(ws, 'p/mas/env.js'), 'window.MAS_ENV = process.env;');
    write(path.join(ws, 'p/mas/events.jsonl'), [
      '{"v":"0.1","seq":1,"ts":"t","type":"run.started"}',
      'not json',
      '{"v":"0.1","seq":1,"ts":"t","type":"message","data":{}}',
      '{"v":"0.2","seq":3,"ts":"t","type":"run.finished"}',
      '',
    ].join('\n'));

    const errors = errorsByFile(validatePath(ws), ws);
    assert.deepEqual(errors['home/projects.json'], ['/projects/0/folder: must match ^[a-z0-9][a-z0-9-]{0,39}$']);
    assert.deepEqual(errors['p/mas/structure.json'], [
      '/lead/id: must be "lead"', '/roles/1/id: is required', '/roles/0/handsTo: "nobody" is not a role id or "lead"',
    ]);
    assert.deepEqual(errors['p/mas/state.json'], ['/phase: must be one of "setup", "describe", "design", "refine", "locked", "running", "done", "failed"']);
    assert.deepEqual(errors['p/mas/state.js'], ['differs from state.json']);
    assert.deepEqual(errors['p/mas/status/a.js'], ['does not set window.MAS_STATUS["a"]']);
    assert.deepEqual(errors['p/mas/status/lead.js'], ['/progress: must be <= 100']);
    assert.deepEqual(errors['p/mas/status/b.js'], [
      'not a recognised data file: expected window.MAS_STATUS = window.MAS_STATUS || {}; window.MAS_STATUS["b"] = {...};',
    ]);
    assert.match(errors['p/mas/status/c.js'][0], /^the value assigned to window\.MAS_STATUS\["c"\] is not valid JSON/, 'twins are never run');
    assert.match(errors['p/outputs/result.js'][0], /^the value assigned to window\.MAS_RESULT is not valid JSON/);
    assert.deepEqual(errors['p/me/task.js'], ['not a recognised data file: expected window.MAS_TASK = {...};']);
    assert.match(errors['p/mas/env.js'][0], /^the value assigned to window\.MAS_ENV is not valid JSON/);
    assert.deepEqual(errors['p/mas/events.jsonl'], [
      'line 2: not valid JSON',
      'line 3: "message" needs a string "data.text"',
      'line 3: seq 1 is not greater than the previous seq 1',
      'line 4 /v: must match ^0\\.1$',
    ]);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('validate never runs a twin: a twin that would hang the event loop is just invalid', async () => {
  const ws = tmpDir();
  try {
    const file = path.join(ws, 'p/mas/state.js');
    write(file, 'Promise.resolve().then(function f(){return Promise.resolve().then(f)}); window.MAS_STATE = {};');
    globalThis.__masTwinRan = false;
    write(path.join(ws, 'p/me/task.js'), 'globalThis.__masTwinRan = true; window.MAS_TASK = {};');
    const errors = errorsByFile(validatePath(ws), ws);
    assert.deepEqual(errors['p/mas/state.js'], ['not a recognised data file: expected window.MAS_STATE = {...};']);
    assert.ok(errors['p/me/task.js']);
    await new Promise((resolve) => setImmediate(resolve)); // the event loop is still free
    assert.equal(globalThis.__masTwinRan, false);
  } finally {
    delete globalThis.__masTwinRan;
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('validate command: exit codes and summary; a single file works too', () => {
  const ws = tmpDir();
  try {
    write(path.join(ws, 'p/mas/state.json'), { phase: 'done' });
    let c = capture();
    assert.equal(validateCommand([ws], c), 0);
    assert.match(c.text(), /✓ .*state\.json/);
    assert.match(c.text(), /1 files checked: all valid\./);

    write(path.join(ws, 'p/mas/status/x.json'), { state: 'asleep' });
    c = capture();
    assert.equal(validateCommand([path.join(ws, 'p/mas/status/x.json')], c), 1);
    assert.match(c.text(), /✗ .*x\.json\n {4}\/state: must be one of/);
    assert.match(c.text(), /1 with problems \(1 error\)/);

    c = capture();
    assert.equal(validateCommand([path.join(ws, 'nothing-here')], c), 1);
    assert.match(c.text(), /Not found/);

    fs.mkdirSync(path.join(ws, 'empty'));
    c = capture();
    assert.equal(validateCommand([path.join(ws, 'empty')], c), 1);
    assert.match(c.text(), /No MAS Office files found/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
