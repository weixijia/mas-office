// Regression tests for permission bypasses found in review: letter case, broad searches,
// glob characters and local hosts in commands, and over-matching delegation words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideTool } from '../../src/team/decide.js';
import { compileRole } from '../../src/team/compile.js';
import { normalizeTeam } from '../../src/team/normalize.js';
import { subjectMatchesWord } from '../../src/team/subject.js';
import { matchDelegation } from '../../src/policy/index.js';
import { v2Structure, ENV, PROJECT, HOME } from './fixtures.js';

const team = (s = v2Structure()) => normalizeTeam(s, ENV).team;
const call = (tool, input = {}) => ({ type: 'tool_call', tool, input });
const effect = (compiled, subject) => decideTool(compiled, subject).effect;
const rule = (compiled, subject) => decideTool(compiled, subject).rule;

function compiled(roleIndex, tools) {
  const s = v2Structure();
  s.roles[roleIndex].tools = tools;
  return compileRole(team(s), s.roles[roleIndex].id, ENV);
}
const noRaw = compiled(1, ['web search']); // finder-b, no "read my files"
const askRaw = compiled(1, ['web search', { name: 'read my files', effect: 'ask' }]);
const withRaw = compiled(0, ['web search', 'read my files']); // finder-a
const catOnly = compiled(1, ['cli:cat', 'cli:curl', 'cli:git log']);
const runAll = compiled(1, ['run commands']);

test('1. case: deny and ask rules on raw/ match in any letter case', () => {
  for (const p of ['RAW/x.pdf', 'Raw/x.pdf', 'rAw/sub/x.pdf', `${PROJECT}/RAW/x.pdf`, '/WORK/Space/Deals/raw/x.pdf', 'sources/../RAW/x.pdf']) {
    assert.equal(effect(noRaw, call('Read', { file_path: p })), 'deny', p);
    assert.equal(effect(askRaw, call('Read', { file_path: p })), 'ask', p);
  }
  assert.equal(effect(noRaw, call('Glob', { pattern: 'RAW/**' })), 'deny');
  assert.equal(effect(noRaw, call('Grep', { pattern: 'x', path: 'Raw' })), 'deny');
  assert.equal(effect(withRaw, call('Read', { file_path: 'RAW/x.pdf' })), 'allow', 'a role with read my files may read it');
});

test('1. case: credential and protected names in any case; writes keep the exact case', () => {
  for (const p of ['.ENV', 'Sub/.Env.Local', 'raw/KEY.PEM', '/USERS/SAM/.SSH/id_rsa', '~/.Claude.json']) {
    assert.equal(rule(withRaw, call('Read', { file_path: p })), 'hard:credentials', p);
  }
  for (const p of ['sources/Claude.md', 'Sources/../AGENTS.MD', '.CLAUDE/settings.json', '.MCP.JSON']) {
    assert.equal(effect(withRaw, call('Write', { file_path: p })), 'deny', p);
  }
  for (const p of ['OUTPUTS/work/finder-a.md', 'outputs/Work/finder-a.md', 'outputs/work/Finder-A.md', 'Sources/x.md', '/WORK/space/deals/outputs/work/finder-a.md']) {
    const d = decideTool(withRaw, call('Write', { file_path: p }));
    assert.equal(d.effect, 'deny', p);
    assert.ok(['hard:not-writable', 'hard:outside-project'].includes(d.rule), `${p}: ${d.rule}`);
  }
  assert.equal(effect(withRaw, call('Write', { file_path: 'outputs/work/finder-a.md' })), 'allow');
});

test('2. Grep over the project root or above is denied, whatever its glob', () => {
  for (const input of [{ pattern: '.' }, { pattern: '.', path: '.' }, { pattern: '.', path: './' }, { pattern: '.', path: PROJECT },
    { pattern: '.', glob: '*.pdf' }, { pattern: '.', glob: '**/*' }, { pattern: 'KEY', glob: '.env*' },
    { pattern: '.', glob: '!outputs/**' }, { pattern: '.', glob: '{raw,outputs}/*' }, { pattern: '.', path: '..' },
    { pattern: '.', path: '/work/space' }, { pattern: '.', path: '/' }, { pattern: '.', path: 'outputs/..' }, { pattern: '.', path: PROJECT.toUpperCase() }]) {
    for (const role of [noRaw, withRaw]) {
      const d = decideTool(role, call('Grep', input));
      assert.equal(d.effect, 'deny', JSON.stringify(input));
      assert.equal(d.rule, 'hard:broad-search', JSON.stringify(input));
      assert.match(d.reason, /narrower path/);
    }
  }
  assert.equal(effect(noRaw, call('Grep', { pattern: '.', path: 'outputs' })), 'allow');
  assert.equal(effect(noRaw, call('Grep', { pattern: '.', glob: 'sources/*.md' })), 'allow', 'a glob with a folder narrows the search');
  assert.equal(effect(noRaw, call('Grep', { pattern: '.', path: 'outputs', glob: '../raw/*' })), 'deny');
  assert.equal(effect(noRaw, call('Grep', { pattern: '.', path: 'raw' })), 'deny');
  assert.equal(effect(noRaw, call('Grep', { pattern: '.', glob: 'raw/**' })), 'deny', 'the glob narrows the search to raw/');
  assert.equal(effect(askRaw, call('Grep', { pattern: '.', glob: 'RAW/**' })), 'ask');
  assert.equal(effect(withRaw, call('Grep', { pattern: '.', glob: 'raw/**' })), 'allow');
  assert.equal(effect(withRaw, call('Grep', { pattern: '.', path: 'raw' })), 'allow');
  assert.equal(rule(withRaw, call('Grep', { pattern: '.', path: 'outputs', glob: '../../../Users/sam/.ssh/*' })), 'hard:credentials');
});

test('2. Glob at the project root lists raw/ only for roles that may read it', () => {
  for (const input of [{ pattern: '**/*' }, { pattern: '*' }, { pattern: '**/*.pdf', path: '.' }, { pattern: '*/x', path: PROJECT }]) {
    const d = decideTool(noRaw, call('Glob', input));
    assert.equal(d.effect, 'deny', JSON.stringify(input));
    assert.match(d.reason, /narrower path/);
    assert.equal(effect(askRaw, call('Glob', input)), 'ask', JSON.stringify(input));
    assert.equal(effect(withRaw, call('Glob', input)), 'allow', JSON.stringify(input));
  }
  assert.equal(effect(noRaw, call('Glob', { pattern: 'outputs/**/*.md' })), 'allow');
  assert.equal(effect(noRaw, call('Glob', { pattern: 'sources/*.md', path: '.' })), 'allow');
  assert.equal(effect(noRaw, call('Glob', { pattern: '*.md', path: 'outputs' })), 'allow');
});

test('3. a cli: prefix refuses glob, expansion and escape characters', () => {
  for (const cmd of ['cat ~/.ss*/id_*', 'cat .en?', 'cat .e[n]v', 'cat {a,.env}', 'cat \\.env', 'cat $PWD/x', 'cat ~/x', 'cat sources/*.md', 'git log -- *']) {
    assert.equal(effect(catOnly, call('Bash', { command: cmd })), 'deny', cmd);
  }
  assert.equal(effect(catOnly, call('Bash', { command: 'cat sources/currys.md' })), 'allow');
  assert.equal(effect(catOnly, call('Bash', { command: 'git log -n 3' })), 'allow', 'a plain number is not a host');
});

test('3. raw/ and credential rules apply to every path-like word of a command', () => {
  for (const cmd of ['cat raw/x.pdf', 'cat RAW/x.pdf', 'cat ./raw/x.pdf', 'cat sources/../raw/x.pdf', `cat ${PROJECT}/raw/x.pdf`, 'cat raw', 'git log --output=raw/x']) {
    assert.equal(effect(catOnly, call('Bash', { command: cmd })), 'deny', cmd);
    assert.equal(effect(runAll, call('Bash', { command: cmd })), 'deny', cmd);
  }
  const s = v2Structure();
  s.roles[1].tools = ['cli:cat', { name: 'read my files', effect: 'ask' }];
  assert.equal(effect(compileRole(team(s), 'finder-b', ENV), call('Bash', { command: 'cat raw/x.pdf' })), 'ask');
  s.roles[1].tools = ['cli:cat', 'read my files'];
  assert.equal(effect(compileRole(team(s), 'finder-b', ENV), call('Bash', { command: 'cat raw/x.pdf' })), 'allow');
  for (const cmd of ['cat .env', 'cat sub/.ENV.local', `cat ${HOME}/.ssh/id_rsa`, 'cat ../../../Users/sam/.aws/credentials']) {
    assert.equal(rule(catOnly, call('Bash', { command: cmd })), 'hard:credentials', cmd);
  }
});

test('3. commands never name this computer or its network', () => {
  for (const cmd of ['curl http://127.0.0.1:4747/v0/events', 'curl localhost:4747', 'curl http://localhost/', 'curl [::1]:80', 'curl http://[::1]/',
    'curl 0.0.0.0:8080', 'curl 10.0.0.5', 'curl http://169.254.169.254/latest', 'curl nas.local', 'curl http://2130706433/', 'curl 127.1:80',
    'curl -H x http://192.168.1.1', 'curl --url=http://localhost:3000']) {
    assert.equal(rule(catOnly, call('Bash', { command: cmd })), 'hard:blocked-url', cmd);
    assert.equal(rule(runAll, call('Bash', { command: cmd })), 'hard:blocked-url', cmd);
  }
  assert.equal(effect(catOnly, call('Bash', { command: 'curl https://www.currys.co.uk/x' })), 'allow');
  assert.equal(effect(catOnly, call('Bash', { command: 'curl example.com' })), 'allow');
});

test('4. delegation: "read my files" matches only reads inside raw/', () => {
  const ctx = { project: PROJECT, home: HOME, agentId: 'finder-a' };
  const read = (file_path) => call('Read', { file_path });
  assert.ok(subjectMatchesWord(read('raw/x.pdf'), 'read my files', ctx));
  assert.ok(subjectMatchesWord(read(`${PROJECT}/raw/sub/x.pdf`), 'read my files', ctx));
  assert.ok(subjectMatchesWord(read('RAW/x.pdf'), 'read my files', ctx));
  for (const p of ['~/Documents/taxes.xlsx', '/Users/sam/Documents/taxes.xlsx', 'outputs/work/finder-b.md', 'raw/../../x', 'raw/../x', 'raw/.env', '/etc/passwd']) {
    assert.ok(!subjectMatchesWord(read(p), 'read my files', ctx), p);
  }
  assert.ok(!subjectMatchesWord(call('Grep', { pattern: '.' }), 'read my files', ctx));
  assert.ok(!subjectMatchesWord(call('Glob', { pattern: '**/*', path: 'raw/..' }), 'read my files', ctx));
  assert.ok(!subjectMatchesWord(read('raw/x.pdf'), 'read my files', { agentId: 'finder-a' }), 'no project: no match');
  assert.ok(!subjectMatchesWord(call('read', { file_path: 'raw/x.pdf' }), 'read my files', ctx), 'odd case');

  const t = normalizeTeam({ ...v2Structure(), lead: { id: 'lead', name: 'Lead', delegate: [{ effect: 'allow', tools: ['read my files'] }] } }).team;
  const req = (file_path) => ({ agentId: 'finder-a', kind: 'approval', subject: read(file_path) });
  assert.equal(matchDelegation(t, req('~/Documents/taxes.xlsx'), {}, { project: PROJECT, home: HOME }).effect, 'human');
  assert.equal(matchDelegation(t, req('raw/x.pdf'), {}, { project: PROJECT, home: HOME }).effect, 'allow');
  assert.equal(matchDelegation(t, req('raw/x.pdf'), {}).effect, 'human', 'without the project folder path words never match');
});

test('4. delegation: "write notes" means the requesting role\'s own files; cli: and web words are strict', () => {
  const ctx = { project: PROJECT, home: HOME, agentId: 'finder-a' };
  const write = (file_path) => call('Write', { file_path });
  assert.ok(subjectMatchesWord(write('outputs/work/finder-a.md'), 'write notes', ctx));
  assert.ok(subjectMatchesWord({ type: 'file_change', path: `${PROJECT}/sources/x.md` }, 'write notes', ctx));
  for (const p of ['outputs/work/finder-b.md', 'outputs/result.md', 'CLAUDE.md', 'sources/claude.md', '/tmp/x.md', 'outputs/work/Finder-A.md', '~/x.md']) {
    assert.ok(!subjectMatchesWord(write(p), 'write notes', ctx), p);
  }
  assert.ok(!subjectMatchesWord(write('outputs/work/finder-a.md'), 'write notes', { project: PROJECT }), 'no agent: no match');
  assert.ok(subjectMatchesWord(write('outputs/result.md'), 'write notes', { project: PROJECT, agentId: 'lead' }));

  for (const cmd of ['git log; id', 'git log *', 'git log ~', 'git logs', 'git  log $X']) {
    assert.ok(!subjectMatchesWord({ type: 'command', command: cmd }, 'cli:git log', ctx), cmd);
  }
  assert.ok(subjectMatchesWord({ type: 'command', command: ['git', 'log', '-3'] }, 'cli:git log', ctx));
  assert.ok(!subjectMatchesWord(call('WebFetch', { url: 'http://localhost:4747/', prompt: 'x' }), 'web search', ctx));
  assert.ok(!subjectMatchesWord(call('webfetch', { url: 'https://x.test', prompt: 'x' }), 'web search', ctx));
  assert.ok(!subjectMatchesWord(call('mcp__mas-browser__take_screenshot', { filePath: 'x.png' }), 'browse the web', ctx));
  assert.ok(!subjectMatchesWord(call('mcp__mas-browser__navigate_page', { url: 'http://10.0.0.1/' }), 'browse the web', ctx));
  assert.ok(subjectMatchesWord(call('mcp__mas-browser__navigate_page', { url: 'https://x.test/' }), 'browse the web', ctx));
});

test('5. URLs: every non-public IPv4 range, local names and names that spell out a private address', async () => {
  const { isBlockedUrl, isBlockedHostToken } = await import('../../src/team/paths.js');
  const blocked = [
    'http://198.18.0.1/', 'http://198.19.255.255/', 'http://224.0.0.1/', 'http://239.255.255.250/', 'http://240.0.0.1/',
    'http://255.255.255.255/', 'http://192.0.0.8/', 'http://192.0.2.1/', 'http://203.0.113.5/', 'http://100.127.0.1/',
    'http://127.0.0.1.nip.io/', 'https://10.0.0.1.sslip.io/x', 'http://app.192.168.1.1.nip.io/', 'http://192-168-1-1.sslip.io/',
    'http://www-10-0-0-1.nip.io/', 'http://127-0-0-1.nip.io:4747/', 'http://169.254.169.254.nip.io/', 'http://intranet/',
    'http://LOCALHOST./', 'http://0x7f.0.0.1/', 'http://0177.0.0.1/', 'http://[::ffff:127.0.0.1]/',
  ];
  for (const url of blocked) {
    assert.equal(isBlockedUrl(url), true, url);
    assert.equal(rule(withRaw, call('WebFetch', { url, prompt: 'x' })), 'hard:blocked-url', url);
  }
  for (const url of ['https://www.currys.co.uk/x', 'http://8.8.8.8/', 'http://8.8.8.8.nip.io/', 'https://198.20.0.1/', 'https://v1-2-3.example.com/', 'https://a.10.example.com/']) {
    assert.equal(isBlockedUrl(url), false, url);
  }
  for (const token of ['198.18.0.1', '224.0.0.251:5353', '127.0.0.1.nip.io', 'http://10-0-0-1.sslip.io/', 'intranet:8080']) {
    assert.equal(isBlockedHostToken(token), true, token);
    assert.equal(rule(catOnly, call('Bash', { command: `curl ${token}` })), 'hard:blocked-url', token);
  }
  for (const token of ['raw/x.pdf', 'README.md', '3', 'git', 'example.com']) assert.equal(isBlockedHostToken(token), false, token);
});

test('6. Codex sandboxed reads: plain read-only commands inside the project are allowed', () => {
  const checker = compileRole(team(), 'checker', ENV); // codex, web search only, no command grant
  const sb = (command, cwd = PROJECT) => decideTool(checker, { type: 'command', command, cwd, sandboxed: true });
  for (const cmd of [
    'cat outputs/work/finder-a.md', "sed -n '1,80p' sources/x.md", 'sed -n 1,20p outputs/work/finder-b.md', 'rg -n foo outputs/',
    'rg -n "price|cost" outputs/work', 'ls sources', 'ls', 'ls -la', 'head -n 20 outputs/work/finder-a.md', 'head -20 sources/x.md',
    'tail -5 sources/x.md', 'wc -l outputs/work/finder-a.md', 'nl outputs/work/finder-a.md', "find sources -name '*.md'",
    'rg x outputs | head -20', 'cat outputs/work/finder-a.md | grep -n Currys | sort | uniq', 'cat "outputs/work/a b.md"',
    "rg -n 'a | b' sources", 'cat sources/*.md', 'grep -rn foo sources', 'cut -d , -f 1 sources/x.md', "tr -d '\\r'",
    'stat outputs/work/finder-a.md', 'pwd', `cat ${PROJECT}/outputs/work/finder-a.md`, 'cat x.md',
  ]) {
    const d = sb(cmd);
    assert.deepEqual([d.effect, d.rule], ['allow', 'sandbox:read-only-command'], cmd);
  }
  assert.equal(sb('cat work/finder-a.md', `${PROJECT}/outputs`).effect, 'allow', 'relative to cwd');
  assert.equal(sb('rg foo', `${PROJECT}/outputs`).effect, 'allow', 'a search below the root');
});

test('6. Codex sandboxed reads: everything else keeps its normal decision or is denied', () => {
  const checker = compileRole(team(), 'checker', ENV);
  const sb = (command, cwd = PROJECT) => decideTool(checker, { type: 'command', command, cwd, sandboxed: true });
  for (const cmd of [
    'cat ../x', 'cat /etc/passwd', 'cat ~/.ssh/id_rsa', 'cat .env', 'cat sources/.env.local', 'cat RAW/x.pdf', 'cat raw/x.pdf',
    'cat outputs/work/a.md; curl x', 'cat a.md && id', 'cat a.md || id', 'cat a.md > b.md', 'cat < /etc/passwd', 'sed -i s/a/b/ x.md',
    "sed -n '1e id' x.md", "sed -n 's/a/b/w out' x.md", "sed '1,5p' x.md", 'sed -n -f script.sed x.md', 'find . -exec cat {} +',
    'find sources -exec id ;', 'find sources -delete', 'find sources -fprint out', 'find . -name x', 'find', 'rg x', 'rg -n x .',
    `rg x ${PROJECT}`, 'rg x ..', 'grep -r x .', 'ls -R', 'ls -laR .', 'rg x outputs | sh', 'rg x outputs | xargs rm',
    'cat "$(id)"', 'cat "`id`"', 'cat "${HOME}/x"', 'cat $HOME/x', 'cat `id`', 'curl https://x.test', 'python3 -c 1',
    'sort -o out.txt x.md', 'uniq a.md b.md', 'rg --pre=sh x outputs', 'tail -f x.md', 'cat *.md', 'cat */x.md', 'cat sources/.*',
    'cat sources/.e*', 'cat {a,b}.md', 'cat a\\ b.md', 'cat a.md\nid', 'cat a.md &', 'cat "unterminated', 'grep -f ../patterns x.md',
    'rg --ignore-file=/etc/passwd x outputs', 'FOO=1 cat x.md', '/bin/cat x.md', 'cat CLAUDE.md', 'cat x.md | | wc',
  ]) {
    assert.notEqual(sb(cmd).effect, 'allow', cmd);
  }
  assert.equal(sb('cat outputs/work/finder-a.md', '/tmp').effect, 'deny', 'cwd outside the project');
  assert.equal(sb('cat ../../tmp/x', `${PROJECT}/outputs`).effect, 'deny');
  assert.match(sb('rg x').reason, /narrower path/);
  assert.match(sb('ls -R').reason, /narrower path/);
  assert.equal(decideTool(checker, { type: 'command', command: 'cat outputs/work/finder-a.md', cwd: PROJECT }).effect, 'deny', 'without sandboxed nothing changes');
  assert.equal(decideTool(checker, { type: 'command', command: 'cat outputs/work/finder-a.md', cwd: PROJECT, sandboxed: 'yes' }).effect, 'deny');
});

test('6. Codex sandboxed reads follow the role\'s raw/ rule', () => {
  const s = v2Structure();
  s.roles[2].tools = ['web search', { name: 'read my files', effect: 'ask' }];
  const asking = compileRole(team(s), 'checker', ENV);
  assert.equal(decideTool(asking, { type: 'command', command: 'cat raw/notes.txt', cwd: PROJECT, sandboxed: true }).effect, 'ask');
  s.roles[2].tools = ['web search', 'read my files'];
  const reading = compileRole(team(s), 'checker', ENV);
  assert.equal(decideTool(reading, { type: 'command', command: 'cat RAW/notes.txt', cwd: PROJECT, sandboxed: true }).effect, 'allow');
  assert.equal(decideTool(reading, { type: 'command', command: 'cat raw/.env', cwd: PROJECT, sandboxed: true }).effect, 'deny');
  assert.equal(decideTool(reading, { type: 'command', command: 'rg x', cwd: PROJECT, sandboxed: true }).effect, 'deny', 'root search still reaches .env files');
});

test('relative path words are not mistaken for hosts', async () => {
  const { isBlockedHostToken } = await import('../../src/team/paths.js');
  for (const token of ['.', '..', './x', '../x', './sources/x.md', '.env', 'a..b']) assert.equal(isBlockedHostToken(token), false, token);
  assert.equal(effect(catOnly, call('Bash', { command: 'cat ./sources/x.md' })), 'allow');
});
