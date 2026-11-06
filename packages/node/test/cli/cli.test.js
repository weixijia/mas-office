import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Office, reduce } from '../../src/sdk/index.js';
import { runDemo, DEMO_PROJECT } from '../../src/cli/demo-script.js';
import { validatePath } from '../../src/cli/commands/validate.js';
import { parseArgs, UsageError } from '../../src/cli/args.js';
import { selfCommand } from '../../src/cli/paths.js';
import { runCli, tmpDir, readJson, REPO } from './helpers.js';

const pkg = readJson(new URL('../../package.json', import.meta.url));

test('--help, --version and exit codes', async () => {
  const help = await runCli(['--help']);
  assert.equal(help.code, 0);
  for (const command of ['demo', 'serve', 'init', 'validate', 'reduce', 'export', 'hook']) assert.match(help.stdout, new RegExp(`\\n  ${command}`));
  assert.match((await runCli(['serve', '--help'])).stdout, /--host/);
  assert.match((await runCli(['help', 'init'])).stdout, /--kit/);
  assert.equal((await runCli(['--version'])).stdout.trim(), pkg.version);
  const unknown = await runCli(['frobnicate']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /Unknown command "frobnicate"/);
  assert.match(unknown.stderr, /run: node \S*mas-office\.js --help/, 'the hint is a command that works from source');
  for (const name of ['constructor', 'toString', '__proto__']) assert.equal((await runCli([name])).code, 2, name);
  assert.equal((await runCli(['validate', '--constructor'])).code, 2);
  assert.match((await runCli(['help', 'constructor'])).stdout, /^mas-office \S+ — /);
  const badOption = await runCli(['validate', '--strict']);
  assert.equal(badOption.code, 2);
  assert.match(badOption.stderr, /Unknown option --strict/);
  assert.equal((await runCli(['serve', '--port', 'abc'])).code, 2);
  assert.equal((await runCli(['reduce'])).code, 2);
  const missing = await runCli(['serve', path.join(REPO, 'no-such-folder')]);
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /Workspace folder not found/);
});

test('selfCommand prints how to run this CLI again', () => {
  assert.equal(selfCommand('/usr/local/bin/mas-office', '/home/me'), 'mas-office');
  assert.equal(selfCommand('C:\\npm\\mas-office.cmd', 'C:\\'), 'mas-office');
  assert.equal(selfCommand('/src/mas-office/packages/node/bin/mas-office.js', '/src/mas-office'), 'node packages/node/bin/mas-office.js');
  assert.equal(selfCommand('/src/mas-office/packages/node/bin/mas-office.js', '/elsewhere'), 'node /src/mas-office/packages/node/bin/mas-office.js');
  assert.equal(selfCommand('/My Code/mas-office/packages/node/bin/mas-office.js', '/tmp'), 'node "/My Code/mas-office/packages/node/bin/mas-office.js"');
});

test('parseArgs: values, =values, negation and errors', () => {
  const spec = { port: 'string', open: 'boolean' };
  assert.deepEqual(parseArgs(['a', '--port', '1', '--open', 'b'], spec), { positionals: ['a', 'b'], options: { port: '1', open: true } });
  assert.deepEqual(parseArgs(['--port=2', '--no-open', '--', '--x'], spec), { positionals: ['--x'], options: { port: '2', open: false } });
  assert.throws(() => parseArgs(['--port'], spec), UsageError);
  assert.throws(() => parseArgs(['--open=yes'], spec), UsageError);
  assert.throws(() => parseArgs(['-x'], spec), UsageError);
});

test('init creates a workspace, never overwrites without --force, and copies the kit', async () => {
  const ws = tmpDir();
  try {
    const first = await runCli(['init', ws]);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /or run: node \S*mas-office\.js serve /, 'the hint works from source');
    assert.deepEqual(readJson(path.join(ws, 'home/projects.json')), { current: null, projects: [] });
    const window = {};
    new Function('window', fs.readFileSync(path.join(ws, 'home/projects.js'), 'utf8'))(window);
    assert.deepEqual(window.MAS_HOME, { current: null, projects: [] });
    assert.ok(fs.existsSync(path.join(ws, 'office/index.html')));
    assert.ok(fs.existsSync(path.join(ws, 'office/app.js')));
    assert.ok(!fs.existsSync(path.join(ws, 'office/tests')), 'panel tests are not copied');
    assert.ok(!fs.existsSync(path.join(ws, 'AGENTS.md')));

    fs.writeFileSync(path.join(ws, 'office/app.js'), '// mine');
    const again = await runCli(['init', ws, '--kit']);
    assert.equal(again.code, 0);
    assert.match(again.stdout, /Kept \d+ existing file/);
    assert.equal(fs.readFileSync(path.join(ws, 'office/app.js'), 'utf8'), '// mine');
    for (const rel of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'SETUP.md', 'harness/operations.md', '.claude/settings.json']) {
      assert.ok(fs.existsSync(path.join(ws, rel)), rel);
    }
    await runCli(['init', ws, '--force']);
    assert.notEqual(fs.readFileSync(path.join(ws, 'office/app.js'), 'utf8'), '// mine');
    assert.deepEqual(validatePath(ws).filter((r) => r.errors.length), []);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('reduce rebuilds snapshots from the log', async () => {
  const ws = tmpDir();
  try {
    const dir = path.join(ws, 'staged');
    fs.mkdirSync(path.join(dir, 'mas'), { recursive: true });
    const source = path.join(REPO, 'spec/conformance/01-staged-team');
    fs.copyFileSync(path.join(source, 'events.jsonl'), path.join(dir, 'mas/events.jsonl'));
    const res = await runCli(['reduce', dir]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /from 14 event\(s\)/);
    const expected = readJson(path.join(source, 'expected.json'));
    assert.deepEqual(readJson(path.join(dir, 'mas/structure.json')), expected.structure);
    assert.deepEqual(readJson(path.join(dir, 'mas/state.json')), expected.state);
    assert.deepEqual(readJson(path.join(dir, 'outputs/result.json')), expected.result);
    for (const [id, status] of Object.entries(expected.statuses)) assert.deepEqual(readJson(path.join(dir, `mas/status/${id}.json`)), status);
    assert.ok(!fs.existsSync(path.join(ws, 'home')), 'no home/ created outside a workspace');

    fs.mkdirSync(path.join(ws, 'home'));
    await runCli(['reduce', dir]);
    assert.equal(readJson(path.join(ws, 'home/projects.json')).current, 'staged');
    assert.equal((await runCli(['reduce', path.join(ws, 'nope')])).code, 1);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('the demo storyline produces a valid, finished project', async () => {
  const ws = tmpDir();
  try {
    const office = new Office({ workspace: ws });
    await runDemo(office, { speed: 400 });
    await office.close();
    const dir = path.join(ws, DEMO_PROJECT);
    const lines = fs.readFileSync(path.join(dir, 'mas/events.jsonl'), 'utf8').trim().split('\n');
    const snap = reduce(lines);
    assert.equal(snap.state.phase, 'done');
    assert.deepEqual(Object.keys(snap.statuses), ['lead', 'flight-finder', 'stay-finder', 'budget-checker', 'day-planner', 'fee-scout']);
    assert.ok(Object.values(snap.statuses).every((s) => s.state === 'done'));
    assert.equal(snap.structure.roles.find((r) => r.id === 'fee-scout').parent, 'budget-checker');
    assert.equal(snap.result.sources.length, 4);
    assert.equal(snap.result.flags[0].kind, 'concern');
    assert.equal(snap.result.work.length, 5);
    assert.ok(Object.values(snap.statuses).every((s) => s.say.length <= 60), 'say lines stay short');
    assert.deepEqual(validatePath(ws).filter((r) => r.errors.length), []);
    assert.ok(fs.existsSync(path.join(dir, 'me/task.json')));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('demo command serves, plays and exits with --exit', async () => {
  const res = await runCli(['demo', '--no-open', '--exit', '--port', '0', '--speed', '200']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /Panel: +http:\/\/127\.0\.0\.1:\d+\/office\//);
  assert.match(res.stdout, /Run finished/);
  const workspace = /Workspace: (.*)/.exec(res.stdout)[1].trim();
  assert.equal(readJson(path.join(workspace, DEMO_PROJECT, 'mas/state.json')).phase, 'done');
  fs.rmSync(workspace, { recursive: true, force: true });
  assert.equal((await runCli(['demo', '--speed', '0'])).code, 2);
});
