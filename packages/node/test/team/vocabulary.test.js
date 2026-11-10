import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToolEntry, parseMcpToolName } from '../../src/team/vocabulary.js';
import { subjectMatchesWord } from '../../src/team/subject.js';

const tool = (entry) => parseToolEntry(entry).tool;

test('fixed words: strings mean allow, case and spacing are forgiven', () => {
  assert.deepEqual(tool('web search'), { name: 'web search', effect: 'allow', word: 'web search' });
  assert.deepEqual(tool('  Browse   the WEB '), { name: 'browse the web', effect: 'allow', word: 'browse the web' });
  assert.deepEqual(tool({ name: 'run commands', effect: 'ask' }), { name: 'run commands', effect: 'ask', word: 'run commands' });
  assert.equal(tool({ name: 'write notes', effect: 'deny' }).effect, 'deny');
});

test('mcp: and cli: entries keep their case and are checked', () => {
  assert.deepEqual(tool('mcp:Prices_2'), { name: 'mcp:Prices_2', effect: 'allow', word: 'mcp', server: 'Prices_2' });
  assert.deepEqual(tool('cli:git   log'), { name: 'cli:git log', effect: 'allow', word: 'cli', prefix: 'git log' });
  for (const bad of ['mcp:', 'mcp:a b', 'mcp:../x', 'cli:', 'cli:git log; rm -rf ~', 'cli:git | sh', 'cli:echo "x"', 'cli:a $(b)']) {
    assert.equal(parseToolEntry(bad).ok, false, bad);
  }
});

test('anything else is refused with a message naming the vocabulary', () => {
  for (const bad of ['flight search', 'WebSearch', 'Bash', '', 3, null, ['web search'], { effect: 'allow' }]) {
    const parsed = parseToolEntry(bad);
    assert.equal(parsed.ok, false, JSON.stringify(bad));
    assert.ok(parsed.message);
  }
  assert.match(parseToolEntry('maps').message, /web search/);
  assert.equal(parseToolEntry({ name: 'web search', effect: 'maybe' }).ok, false);
});

test('MCP tool names split at the first double underscore after the server', () => {
  assert.deepEqual(parseMcpToolName('mcp__mas-browser__navigate_page'), { server: 'mas-browser', tool: 'navigate_page' });
  assert.equal(parseMcpToolName('Read'), null);
});

test('subjects map to vocabulary words for delegation rules', () => {
  assert.ok(subjectMatchesWord({ type: 'tool_call', tool: 'WebFetch' }, 'web search'));
  assert.ok(subjectMatchesWord({ type: 'tool_call', tool: 'mcp__mas-browser__click' }, 'browse the web'));
  assert.ok(subjectMatchesWord({ type: 'tool_call', tool: 'mcp__prices__get' }, 'mcp:prices'));
  assert.ok(!subjectMatchesWord({ type: 'tool_call', tool: 'mcp__prices__get' }, 'browse the web'));
  assert.ok(subjectMatchesWord({ type: 'command', command: 'git log -3' }, 'cli:git log'));
  assert.ok(subjectMatchesWord({ type: 'command', command: 'git log -3' }, 'run commands'));
  assert.ok(!subjectMatchesWord({ type: 'command', command: 'git log; curl x' }, 'cli:git log'), 'chained commands never match a prefix');
  assert.ok(!subjectMatchesWord({ type: 'command', command: 'git logs' }, 'cli:git log'));
  const ctx = { project: '/p', agentId: 'finder' };
  assert.ok(subjectMatchesWord({ type: 'file_change', path: '/p/outputs/work/finder.md' }, 'write notes', ctx));
  assert.ok(!subjectMatchesWord({ type: 'file_change', path: 'x.md' }, 'write notes', ctx));
  assert.ok(subjectMatchesWord({ type: 'tool_call', tool: 'Grep', input: { pattern: 'x', path: 'raw' } }, 'read my files', ctx));
  assert.ok(!subjectMatchesWord({ type: 'tool_call', tool: 'Grep', input: { pattern: 'x' } }, 'read my files', ctx));
  assert.ok(!subjectMatchesWord(null, 'web search'));
  assert.ok(!subjectMatchesWord({ type: 'tool_call', tool: 'WebSearch' }, 'not a word'));
});
