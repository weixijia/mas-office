// The kit's Claude Code status line (kit/.claude/mas-statusline.mjs) and the kit's Claude settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KIT = fileURLToPath(new URL('../../../../kit/', import.meta.url));
const SCRIPT = path.join(KIT, '.claude/mas-statusline.mjs');
const { readData, loadTeam, mainLines, subagentLines, matchRole, clean } = await import(SCRIPT);

const plain = (s) => s.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, '').replace(/\x1b\[[0-9;]*m/g, '');
const js = (name, v) => 'window.' + name + ' = ' + JSON.stringify(v, null, 2) + ';\n';
const status = (id, v) => 'window.MAS_STATUS = window.MAS_STATUS || {};\nwindow.MAS_STATUS["' + id + '"] = ' + JSON.stringify(v) + ';\n';

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-sl-'));
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  put('home/projects.js', js('MAS_HOME', { current: 'deals', projects: [{ folder: 'deals', title: 'Deals' }] }));
  put('deals/me/task.js', js('MAS_TASK', { title: 'Headphone deals', requirements: [] }));
  put('deals/mas/state.js', js('MAS_STATE', { step: 4, phase: 'running' }));
  put('deals/mas/structure.js', js('MAS_STRUCTURE', { title: 'Deals', locked: true,
    groups: [{ id: 'A', after: null }, { id: 'B', after: 'A' }],
    roles: [{ id: 'retail-finder', name: 'Retail finder', emoji: '🔎', group: 'A' }, { id: 'market-finder', name: 'Market finder', group: 'A' },
      { id: 'checker', name: 'Catch checker', group: 'B' }, { id: '../evil', name: 'Evil', group: 'B' }] }));
  put('deals/mas/status/lead.js', status('lead', { state: 'working', say: 'Group A running' }));
  put('deals/mas/status/retail-finder.js', status('retail-finder', { state: 'working', say: 'Searching Currys…', progress: 40 }));
  put('deals/mas/status/market-finder.js', status('market-finder', { state: 'done', say: 'Handed over' }));
  put('deals/mas/status/checker.js', status('checker', { state: 'flagged', flag: 'Refurbished — breaks R2' }));
  return { root, put };
}

test('readData reads both data-file shapes without running them, and refuses broken files', () => {
  const { root, put } = workspace();
  try {
    assert.equal(readData(path.join(root, 'deals/mas/status/checker.js')).state, 'flagged');
    assert.equal(readData(path.join(root, 'home/projects.js')).current, 'deals');
    put('x.js', 'window.X = {"a": 1,};');
    assert.equal(readData(path.join(root, 'x.js')), null);
    put('y.js', 'globalThis.pwned = 1; window.Y = {"a": 1};');
    assert.deepEqual(readData(path.join(root, 'y.js')), { a: 1 }, 'only the JSON object is read; nothing is executed');
    assert.equal(globalThis.pwned, undefined);
    assert.equal(readData(path.join(root, 'missing.js')), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the main status line shows the MAS, its phase, every safe role, progress and flags', () => {
  const { root } = workspace();
  try {
    const team = loadTeam(root);
    assert.deepEqual(team.roles.map((r) => r.id), ['retail-finder', 'market-finder', 'checker'], 'unsafe ids are never read');
    const [top, roles] = mainLines(team, root).map(plain);
    assert.match(top, /MAS deals · Headphone deals · Running · 1\/3 roles done · ⚑ 1 flag · office ▸/);
    assert.match(roles, /Lead Group A running/);
    assert.match(roles, /A ● 🔎 Retail finder 40%  ✓ Market finder/);
    assert.match(roles, /B ⚑ Catch checker/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a finished run links the result; other states get a short hint', () => {
  const { root, put } = workspace();
  try {
    put('deals/mas/state.js', js('MAS_STATE', { step: 4, phase: 'done' }));
    put('deals/outputs/result.js', js('MAS_RESULT', { markdown: 'x' }));
    const raw = mainLines(loadTeam(root), root)[0];
    assert.match(plain(raw), /Done · .* · result ready ▸ open office/);
    assert.match(raw, /\x1b\]8;;file:\/\/[^\x1b]*office\/index\.html\x1b\\/, 'a clickable link to the office');
    put('home/projects.js', js('MAS_HOME', { current: '../outside', projects: [{}, {}] }));
    assert.match(plain(mainLines(loadTeam(root), root)[0]), /2 MAS here · choose one/, 'an unsafe current folder is never followed');
    fs.rmSync(path.join(root, 'home'), { recursive: true });
    put('SETUP.md', '# setup');
    assert.match(plain(mainLines(loadTeam(root), root)[0]), /Read SETUP\.md/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('subagent rows: matched to a role by name or a unique mention, otherwise left alone', () => {
  const { root } = workspace();
  try {
    const team = loadTeam(root);
    assert.equal(matchRole({ name: 'checker' }, team.roles).id, 'checker');
    assert.equal(matchRole({ description: 'Run the Retail finder role' }, team.roles).id, 'retail-finder');
    assert.equal(matchRole({ description: 'retail-finder and market-finder' }, team.roles), null, 'ambiguous rows keep the default');
    assert.equal(matchRole({ description: 'explore the repo' }, team.roles), null);
    const rows = subagentLines(team, { columns: 120, tasks: [
      { id: 't1', description: 'Catch checker', tokenCount: 2500 }, { id: 't2', description: 'unrelated' }, { description: 'no id' }] }).map((l) => JSON.parse(l));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 't1');
    assert.match(plain(rows[0].content), /⚑ Catch checker · flagged · Refurbished — breaks R2 · 2\.5k tok/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('agent-written text cannot inject terminal sequences, links or bidi overrides', () => {
  const { root, put } = workspace();
  try {
    const evil = 'Bad\x1b]8;;https://evil.example\x1b\\click\x1b]8;;\x1b\\\x1b[2J\x07‮override\u009b31m';
    put('deals/mas/structure.js', js('MAS_STRUCTURE', { locked: true, groups: [{ id: 'A\x1b[31m' }],
      roles: [{ id: 'retail-finder', name: evil, emoji: '\x1b[5m🔎', group: 'A\x1b[31m' }] }));
    put('deals/mas/status/retail-finder.js', status('retail-finder', { state: 'flagged', flag: evil, say: evil }));
    put('deals/mas/status/lead.js', status('lead', { state: '__proto__', say: evil }));
    const team = loadTeam(root);
    const lines = mainLines(team, root).concat(subagentLines(team, { tasks: [{ id: 't', name: 'retail-finder' }] }).map((l) => JSON.parse(l).content));
    for (const line of lines) {
      const ours = line.replace(/\x1b\[(?:0|1|2|31|32|33|34|36)m/g, '').replace(/\x1b\]8;;file:\/\/[^\x1b]*\x1b\\/g, '').replace(/\x1b\]8;;\x1b\\/g, '');
      assert.doesNotMatch(ours, /[\x00-\x1f\x7f-\x9f‪-‮]/, 'only the script\'s own colours and its file link remain');
      assert.doesNotMatch(line, /evil\.example\x1b|\x1b\[2J|\x1b\[5m/);
    }
    assert.equal(clean('a\x1b[31mb‮c'), 'a [31mb c');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the script reads the project from stdin, and never fails on bad input', () => {
  const { root } = workspace();
  try {
    const run = (input, args = []) => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: 'utf8' });
    const ok = run(JSON.stringify({ workspace: { project_dir: root, current_dir: '/elsewhere' } }));
    assert.equal(ok.status, 0);
    assert.match(plain(ok.stdout), /MAS deals/);
    const bad = run('not json');
    assert.equal(bad.status, 0);
    assert.ok(bad.stdout.length > 0, 'a fallback line, never a crash');
    const sub = run(JSON.stringify({ workspace: { project_dir: root }, tasks: [{ id: 'a', name: 'retail-finder' }] }), ['--subagents']);
    assert.equal(sub.status, 0);
    assert.equal(JSON.parse(sub.stdout.trim()).id, 'a');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('kit Claude settings: browser pinned and confined, settings files protected, status lines wired', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(KIT, '.claude/settings.json'), 'utf8'));
  const mcp = JSON.parse(fs.readFileSync(path.join(KIT, '.mcp.json'), 'utf8'));
  const browser = mcp.mcpServers['mas-browser'];
  assert.ok(browser, 'the browser server is named mas-browser');
  const pkg = browser.args.find((a) => a.startsWith('chrome-devtools-mcp@'));
  assert.match(pkg, /@\d+\.\d+\.\d+$/, 'an exact version, never @latest');
  for (const flag of ['--isolated', '--fileNavigations=false', '--javascriptEvaluation=false', '--usageStatistics=false',
    '--blockedUrlPattern=*://localhost:*/*', '--blockedUrlPattern=*://127.0.0.1:*/*', '--blockedUrlPattern=*://169.254.169.254:*/*']) assert.ok(browser.args.includes(flag), flag);
  assert.ok(!browser.args.includes('--headless'), 'headed: headless Chrome is blocked by the bot walls the browser exists for');
  assert.ok(!browser.args.includes('--autoConnect') && !browser.args.some((a) => a.startsWith('--userDataDir')), 'never the student\'s own Chrome profile');
  assert.deepEqual(settings.enabledMcpjsonServers, ['mas-browser']);
  assert.ok(settings.permissions.allow.includes('mcp__mas-browser__*'));
  for (const rule of ['mcp__mas-browser__upload_file', 'Edit(/.claude/**)', 'Edit(/.mcp.json)']) assert.ok(settings.permissions.deny.includes(rule), rule);
  for (const key of ['statusLine', 'subagentStatusLine']) {
    assert.equal(settings[key].type, 'command');
    const file = settings[key].command.split(' ')[1];
    assert.ok(fs.existsSync(path.join(KIT, file)), key + ' points at a shipped file');
  }
});

test('a role cannot stall the status line with a huge or crafted data file', () => {
  const { root, put } = workspace();
  try {
    put('big.js', 'window.X = ' + '= {'.repeat(200000));
    let t = Date.now();
    assert.equal(readData(path.join(root, 'big.js')), null);
    put('crafted.js', 'window.X = ' + '= {'.repeat(60000));
    assert.equal(readData(path.join(root, 'crafted.js')), null);
    assert.ok(Date.now() - t < 200, 'no backtracking blow-up');
    put('trail.js', 'window.X = {"a": 1}; alert(1)');
    assert.equal(readData(path.join(root, 'trail.js')), null, 'code after the object is refused');
    put('deals/mas/state.js', js('MAS_STATE', { phase: 'constructor', step: '4\x1b]8;;https://evil.example\x1b\\x' }));
    const top = mainLines(loadTeam(root), root)[0];
    assert.doesNotMatch(top, /evil\.example/);
    assert.match(plain(top), /Step 4 ]8;…/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the browser guard blocks file writes by the browser server and passes everything else', () => {
  const guard = path.join(KIT, '.claude/mas-guard.mjs');
  const run = (input) => spawnSync(process.execPath, [guard], { input: JSON.stringify(input), encoding: 'utf8' });
  const blocked = run({ tool_name: 'mcp__mas-browser__take_screenshot', tool_input: { filePath: 'raw/notes.txt' } });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /without filePath/);
  assert.equal(run({ tool_name: 'mcp__mas-browser__take_snapshot', tool_input: { pageId: 1 } }).status, 0);
  assert.equal(run({ tool_name: 'Write', tool_input: { filePath: 'x' } }).status, 0, 'only the browser is guarded here');
  assert.equal(spawnSync(process.execPath, [guard], { input: 'garbage', encoding: 'utf8' }).status, 0);
  const settings = JSON.parse(fs.readFileSync(path.join(KIT, '.claude/settings.json'), 'utf8'));
  const hook = settings.hooks.PreToolUse.find((h) => new RegExp(h.matcher).test('mcp__mas-browser__take_snapshot'));
  assert.match(hook.hooks[0].command, /\$CLAUDE_PROJECT_DIR\/\.claude\/mas-guard\.mjs/);
  for (const rule of ['Edit(**/CLAUDE.md)', 'Edit(**/AGENTS.md)', 'Edit(**/.claude/**)', 'Edit(**/.mcp.json)', 'Edit(~/.claude/**)'])
    assert.ok(settings.permissions.deny.includes(rule), rule);
});

test('the browser network rules: shipped PAC source matches .mcp.json, private ranges are mapped away', () => {
  const args = JSON.parse(fs.readFileSync(path.join(KIT, '.mcp.json'), 'utf8')).mcpServers['mas-browser'].args;
  const pacArg = args.find((a) => a.startsWith('--chromeArg=--proxy-pac-url=data:application/x-ns-proxy-autoconfig;base64,'));
  const shipped = fs.readFileSync(path.join(KIT, '.claude/mas-browser.pac.js'), 'utf8');
  assert.equal(Buffer.from(pacArg.split('base64,')[1], 'base64').toString('utf8'), shipped, 'the readable copy is the one in use');
  const FindProxyForURL = new Function('dnsResolve', 'isInNet', shipped + '\nreturn FindProxyForURL;')(
    (h) => ({ 'rebind.example': '192.168.1.1', 'public.example': '93.184.215.14' })[h] || null,
    (ip, net, mask) => { const n = (x) => x.split('.').reduce((a, b) => a * 256 + Number(b), 0); return (n(ip) & n(mask)) >>> 0 === (n(net) & n(mask)) >>> 0; });
  for (const host of ['10.1.2.3', '172.20.0.1', '192.168.0.1', '127.0.0.2', '169.254.169.254', '100.75.80.76', 'rebind.example', '::1', 'fe80::1'])
    assert.equal(FindProxyForURL('http://' + host + '/', host), 'PROXY 0.0.0.0:9', host);
  for (const host of ['public.example', '8.8.8.8', '172.32.0.1', 'unknown.example'])
    assert.equal(FindProxyForURL('http://' + host + '/', host), 'DIRECT', host);
  const rules = args.find((a) => a.startsWith('--chromeArg=--host-resolver-rules='));
  for (const h of ['localhost', '*.localhost', '*.local', '::1', '127.*', '10.*', '192.168.*', '172.16.*', '172.31.*', '169.254.*', '100.64.*', '100.127.*'])
    assert.ok(rules.includes('MAP ' + h + ' ~NOTFOUND'), h);
});
