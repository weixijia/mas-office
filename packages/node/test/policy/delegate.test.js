import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchDelegation, summarizeRule, countKey } from '../../src/policy/index.js';
import { normalizeTeam } from '../../src/team/normalize.js';

function team(delegate) {
  return normalizeTeam({
    lead: { id: 'lead', name: 'Lead', delegate },
    groups: [{ id: 'A', after: null }],
    roles: [
      { id: 'finder-a', name: 'Retail finder', group: 'A', tools: ['web search', 'browse the web', 'cli:git log'] },
      { id: 'finder-b', name: 'Market finder', group: 'A', tools: ['web search'] },
    ],
  }).team;
}

const approval = (agentId, subject, extra = {}) => ({ agentId, kind: 'approval', subject, ...extra });
const web = { type: 'tool_call', tool: 'WebSearch', input: { query: 'x' } };
const browser = { type: 'tool_call', tool: 'mcp__mas-browser__navigate_page', input: { url: 'https://x.test' } };
const NOW = Date.parse('2026-11-10T12:00:00Z');
const match = (t, req, counters = {}) => matchDelegation(t, req, counters, { now: NOW });

test('no rules, or no match: the person decides', () => {
  assert.equal(match(team([]), approval('finder-a', web)).effect, 'human');
  const t = team([{ effect: 'allow', tools: ['web search'] }]);
  const r = match(t, approval('finder-a', browser));
  assert.deepEqual([r.effect, r.rule, r.index], ['human', null, -1]);
  assert.equal(r.reason, 'No delegation rule covers this request');
});

test('first match wins', () => {
  const t = team([
    { effect: 'human', roles: ['finder-b'], tools: ['web search'] },
    { effect: 'allow', kind: 'approval', tools: ['web search', 'browse the web'] },
    { effect: 'lead' },
  ]);
  assert.equal(match(t, approval('finder-b', web)).effect, 'human');
  const a = match(t, approval('finder-a', web));
  assert.deepEqual([a.effect, a.index], ['allow', 1]);
  assert.equal(a.key, countKey(t.lead.delegate[1]));
  assert.equal(match(t, approval('finder-a', browser)).effect, 'allow');
  assert.deepEqual([match(t, { agentId: 'finder-a', kind: 'question', subject: { type: 'question' } }).effect, match(t, { agentId: 'finder-a', kind: 'question' }).index], ['lead', 2]);
});

test('gates, flags and human_only requests always go to the person', () => {
  const t = team([{ effect: 'allow' }]);
  assert.equal(match(t, { agentId: 'lead', kind: 'gate' }).effect, 'human');
  assert.equal(match(t, { agentId: 'checker', kind: 'flag' }).effect, 'human');
  assert.equal(match(t, approval('finder-a', web, { resolver: 'human_only' })).effect, 'human');
  assert.equal(match(t, approval('finder-a', web)).effect, 'allow');
});

test('max: a rule stops applying once the caller\'s counter reaches it', () => {
  const t = team([{ effect: 'allow', tools: ['web search'], max: 2 }, { effect: 'lead', tools: ['web search'] }]);
  const key = countKey(t.lead.delegate[0]);
  assert.equal(match(t, approval('finder-a', web), {}).effect, 'allow');
  assert.equal(match(t, approval('finder-a', web), { [key]: 1 }).effect, 'allow');
  assert.equal(match(t, approval('finder-a', web), { [key]: 2 }).effect, 'lead');
  assert.equal(countKey({ max: 2, effect: 'allow', tools: ['web search'] }), key, 'the key ignores key order');
  assert.notEqual(countKey({ effect: 'allow', tools: ['web search'], max: 3 }), key);
});

test('expires: past rules are skipped; a bare date lasts the whole day', () => {
  const t = team([{ effect: 'allow', expires: '2026-11-10' }, { effect: 'lead', expires: '2026-11-09T23:00:00Z' }, { effect: 'lead' }]);
  assert.equal(match(t, approval('finder-a', web)).index, 0);
  const late = matchDelegation(t, approval('finder-a', web), {}, { now: new Date('2026-11-11T00:00:01Z') });
  assert.equal(late.index, 2);
  const broken = { lead: { delegate: [{ effect: 'allow', expires: 'whenever' }] }, roles: [] };
  assert.equal(match(broken, approval('finder-a', web)).effect, 'human', 'an unreadable date never applies');
});

test('kind, roles, subjectTypes and tools all have to match', () => {
  const t = team([
    { effect: 'allow', kind: 'decision' },
    { effect: 'allow', roles: ['finder-b'] },
    { effect: 'allow', subjectTypes: ['command'] },
    { effect: 'lead', tools: ['cli:git log'] },
  ]);
  assert.equal(match(t, { agentId: 'finder-a', kind: 'decision' }).index, 0);
  assert.equal(match(t, approval('finder-b', web)).index, 1);
  assert.equal(match(t, approval('finder-a', { type: 'command', command: 'ls' })).index, 2);
  assert.equal(match(t, approval('finder-a', { type: 'tool_call', tool: 'Bash', input: { command: 'git log -2' } })).index, 3);
  assert.equal(match(t, approval('finder-a', { type: 'tool_call', tool: 'Bash', input: { command: 'git log; id' } })).effect, 'human');
  assert.equal(match(t, approval('finder-a', web)).effect, 'human');
});

test('an event envelope works as the request', () => {
  const t = team([{ effect: 'allow', roles: ['finder-a'], tools: ['web search'] }]);
  assert.equal(match(t, { agentId: 'finder-a', data: { kind: 'approval', requestId: 'r1', subject: web } }).effect, 'allow');
  assert.equal(match(t, { agentId: 'finder-b', data: { kind: 'approval', requestId: 'r1', subject: web } }).effect, 'human');
});

test('summarizeRule: one plain sentence', () => {
  const t = team([]);
  assert.equal(summarizeRule({ effect: 'lead', kind: 'approval', tools: ['web search'], roles: ['finder-a', 'finder-b'], max: 20 }, t),
    'The Lead may approve web search for Retail finder and Market finder, up to 20 times.');
  assert.equal(summarizeRule({ effect: 'allow', kind: 'approval', tools: ['web search', 'browse the web'] }), 'Approve web search and browse the web automatically.');
  assert.equal(summarizeRule({ effect: 'human', tools: ['run commands'], expires: '2026-12-31' }), 'Always ask me about run commands, until 2026-12-31.');
  assert.equal(summarizeRule({ effect: 'lead', kind: 'question', max: 1 }), 'The Lead may answer questions, up to 1 time.');
  assert.equal(summarizeRule({ effect: 'allow', subjectTypes: ['file_change'] }), 'Answer every request about file change automatically.');
  assert.equal(summarizeRule({ effect: 'lead', roles: ['ghost'] }, t), 'The Lead may approve every request for ghost.');
});
