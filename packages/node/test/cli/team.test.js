import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { teamCommand, loadTeamEnv } from '../../src/cli/commands/team.js';
import { UsageError } from '../../src/cli/args.js';
import { verifySignature } from '../../src/team/index.js';
import { parseJsTwin, jsTwin } from '../../src/sdk/index.js';
import { tmpDir, write, capture, readJson, REPO } from './helpers.js';

const structure = (extra = {}) => ({
  title: 'Deals',
  lead: { id: 'lead', name: 'Lead' },
  groups: [{ id: 'A', after: null }],
  roles: [{ id: 'finder', name: 'Finder', group: 'A', tools: ['web search', 'browse the web', 'cli:git log'] }],
  ...extra,
});

function workspace(value = structure(), { js = false } = {}) {
  const ws = tmpDir('mas-office-team-');
  const base = path.join(ws, 'deals', 'mas', 'structure');
  if (js) write(`${base}.js`, jsTwin('MAS_STRUCTURE', value));
  else write(`${base}.json`, value);
  write(path.join(ws, '.mcp.json'), { mcpServers: { 'mas-browser': { command: 'npx', args: ['x'] } } });
  write(path.join(ws, 'home', 'commands.json'), ['git']);
  return { ws, project: path.join(ws, 'deals'), base };
}

test('loadTeamEnv reads .mcp.json and the command allow-list from the workspace', () => {
  const { ws, project } = workspace();
  try {
    const env = loadTeamEnv(project);
    assert.equal(env.workspace, ws);
    assert.deepEqual(Object.keys(env.mcpServers), ['mas-browser']);
    assert.deepEqual(env.commands, ['git']);
    write(path.join(ws, 'home', 'commands.json'), { commands: ['npm test', 3] });
    assert.deepEqual(loadTeamEnv(project).commands, ['npm test']);
    fs.rmSync(path.join(ws, '.mcp.json'));
    assert.deepEqual(loadTeamEnv(project).mcpServers, {});
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('team check: valid, then errors with paths', () => {
  const { ws, project, base } = workspace();
  try {
    let c = capture();
    assert.equal(teamCommand(['check', project], { out: c.out }), 0);
    assert.match(c.text(), /✓ The team design is valid/);
    write(`${base}.json`, structure({ roles: [{ id: 'finder', name: 'Finder', group: 'A', tools: ['flight search', 'cli:rm'] }] }));
    c = capture();
    assert.equal(teamCommand(['check', project], { out: c.out }), 1);
    assert.match(c.text(), /✗ \/roles\/0\/tools\/0: "flight search" is not a known tool/);
    assert.match(c.text(), /✗ \/roles\/0\/tools\/1: "rm" is not on the workspace command allow-list/);
    assert.match(c.text(), /2 errors: the team cannot be locked yet\./);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('team lock writes locked + signature to the files that exist; check then verifies it', () => {
  const { ws, project, base } = workspace(structure(), { js: true });
  try {
    const c = capture();
    assert.equal(teamCommand(['lock', project], { out: c.out }), 0);
    assert.match(c.text(), /✓ Locked .*: sha256:[0-9a-f]{64}/);
    assert.ok(!fs.existsSync(`${base}.json`), 'a kit project keeps only its .js twin');
    const locked = parseJsTwin(fs.readFileSync(`${base}.js`, 'utf8'));
    assert.equal(locked.locked, true);
    assert.ok(verifySignature(locked));
    assert.equal(teamCommand(['check', project], { out: capture().out }), 0);

    locked.roles[0].job = 'Changed after lock';
    fs.writeFileSync(`${base}.js`, jsTwin('MAS_STRUCTURE', locked));
    const after = capture();
    assert.equal(teamCommand(['check', project], { out: after.out }), 1);
    assert.match(after.text(), /the design changed after it was locked/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('team lock refuses a broken design and leaves the file alone', () => {
  const { ws, project, base } = workspace(structure({ roles: [{ id: 'finder', name: 'Finder', group: 'A', tools: ['maps'] }] }));
  try {
    const before = fs.readFileSync(`${base}.json`, 'utf8');
    const c = capture();
    assert.equal(teamCommand(['lock', project], { out: c.out }), 1);
    assert.match(c.text(), /the team was not locked/);
    assert.equal(fs.readFileSync(`${base}.json`, 'utf8'), before);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('team lock with both files updates both', () => {
  const { ws, project, base } = workspace();
  try {
    write(`${base}.js`, jsTwin('MAS_STRUCTURE', structure()));
    assert.equal(teamCommand(['lock', project], { out: capture().out }), 0);
    assert.deepEqual(readJson(`${base}.json`), parseJsTwin(fs.readFileSync(`${base}.js`, 'utf8')));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('team show prints the Markdown view of the v2 example', () => {
  const c = capture();
  assert.equal(teamCommand(['show', path.join(REPO, 'examples', 'price-compare')], { out: c.out }), 0);
  assert.match(c.text(), /## 🛡️ Catch checker[\s\S]*- backend: codex[\s\S]*- reviewer of: Sony deal finder and Similar-model finder/);
  assert.match(c.text(), /- delegate: Approve web search automatically\./);
});

test('usage errors and a missing design', () => {
  assert.throws(() => teamCommand([]), UsageError);
  assert.throws(() => teamCommand(['fix', '.']), UsageError);
  assert.throws(() => teamCommand(['check']), UsageError);
  const ws = tmpDir('mas-office-team-');
  try {
    assert.throws(() => teamCommand(['check', ws]), /No team design/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
