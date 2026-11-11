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
    for (const rel of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'SETUP.md', 'harness/operations.md', '.claude/settings.json', '.claude/mas-statusline.mjs', '.claude/mas-guard.mjs', '.claude/mas-browser.pac.js', '.mcp.json']) {
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

/* ---------- up --json: the handshake a parent process (the Mac app) reads ---------- */
async function startJsonUp(argv, { printed = [] } = {}) {
  const { PassThrough } = await import('node:stream');
  const { upCommand } = await import('../../src/cli/commands/up.js');
  const ws = tmpDir();
  const lines = [];
  const errs = [];
  const app = { closed: 0 };
  const fake = {
    async up({ out, printUrl, maxParallel }) {
      out(printUrl ? 'Panel: http://127.0.0.1:1/office/?token=secret-token' : 'Serving on http://127.0.0.1:1');
      printed.push(printUrl);
      return {
        server: { url: 'http://127.0.0.1:1', port: 1, token: 'secret-token' },
        runtime: { info: () => ({ backends: { 'claude-code': { available: true, loggedIn: false } }, maxParallel }) },
        probes: { 'claude-code': { available: true, loggedIn: false, detail: 'probe only' } },
        close: async () => { app.closed += 1; },
      };
    },
  };
  const stdin = new PassThrough();
  let exited;
  const exit = new Promise((resolve) => { exited = resolve; });
  const before = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') };
  upCommand([ws, ...argv], { out: (l) => lines.push(String(l)), err: (l) => errs.push(String(l)), runtime: fake, stdin, exit: exited });
  const cleanup = () => {
    for (const sig of ['SIGINT', 'SIGTERM']) for (const l of process.listeners(sig)) if (!before[sig].includes(l)) process.off(sig, l);
  };
  for (let i = 0; i < 200 && !errs.some((l) => /stop/.test(l)) && !lines.some((l) => /stop/.test(l)); i++) await new Promise((r) => setTimeout(r, 5));
  return { lines, errs, stdin, exit, app, cleanup };
}

test('up --json prints exactly one handshake line on stdout and keeps the token out of the text', async () => {
  const printed = [];
  const t = await startJsonUp(['--json', '--port', '0', '--max-parallel', '2'], { printed });
  try {
    assert.equal(t.lines.length, 1, 'stdout is the handshake only');
    assert.deepEqual(JSON.parse(t.lines[0]), {
      url: 'http://127.0.0.1:1', port: 1, token: 'secret-token', maxParallel: 2,
      backends: { 'claude-code': { available: true, loggedIn: false } },
    });
    assert.deepEqual(printed, [false], 'the runtime is told not to print the panel link');
    assert.ok(t.errs.length > 0, 'text for people goes to stderr');
    assert.ok(t.errs.every((l) => !l.includes('secret-token')), 'the token never reaches stderr');
  } finally {
    t.stdin.end();
    await t.exit;
    t.cleanup();
  }
});

test('up --json shuts down cleanly when its stdin closes', async () => {
  const t = await startJsonUp(['--json']);
  try {
    assert.equal(t.app.closed, 0);
    t.stdin.end();
    assert.equal(await t.exit, 0, 'exit code 0');
    assert.equal(t.app.closed, 1, 'the runtime and server were closed once');
    t.stdin.destroy();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(t.app.closed, 1, 'end and close together still close once');
  } finally {
    t.cleanup();
  }
});

test('up without --json keeps printing for people on stdout and ignores stdin', async () => {
  const t = await startJsonUp([]);
  try {
    assert.ok(t.lines.some((l) => l.includes('Panel: ')), 'the panel link is printed as before');
    assert.ok(t.lines.every((l) => !l.startsWith('{')), 'no handshake line');
    t.stdin.end();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(t.app.closed, 0, 'stdin closing does not stop the human mode');
  } finally {
    t.cleanup();
  }
});

test('handshake falls back to the probes when the runtime has no info()', async () => {
  const { handshake } = await import('../../src/cli/commands/up.js');
  const app = { server: { url: 'u', port: 2, token: 't' }, probes: { codex: { available: false } } };
  assert.deepEqual(handshake(app, 3), { url: 'u', port: 2, token: 't', backends: { codex: { available: false } }, maxParallel: 3 });
});
