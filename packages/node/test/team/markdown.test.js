import { test } from 'node:test';
import assert from 'node:assert/strict';
import { teamToMarkdown } from '../../src/team/markdown.js';
import { normalizeTeam } from '../../src/team/normalize.js';
import { lockTeam } from '../../src/team/sign.js';
import { v2Structure, ENV } from './fixtures.js';

test('the Markdown view shows roles in stage order with the v2 lines', () => {
  const md = teamToMarkdown(normalizeTeam(lockTeam(v2Structure(), ENV)).team);
  const expected = [
    '# Headphone deals — Lead',
    '- backend: claude-code',
    '- delegate: Approve web search and browse the web automatically.',
    '## 🔎 Retail finder',
    '- job: Find offers',
    '- output: A table of offers with price, seller, condition and link',
    '- backend: claude-code',
    '- tools: web search · browse the web (ask) · read my files',
    '- group: A',
    '- hands to: Catch checker',
    '## Market finder',
    '- tools: web search · cli:git log · mcp:prices',
    '## Catch checker',
    '- backend: codex',
    '- reviewer of: Retail finder and Market finder',
    '- clean context: yes (sees only work files and source cards)',
    '- review: up to 2 rounds, then ask me',
    '- hands to: Lead',
    '## Stages',
    '- A Search (first)',
    '- B Check (after A)',
    '## Gates',
    '- after A: Look at the offers',
    '- final: Approve the answer',
    '## Budget',
    '- up to 3 agents at once · 20 min per turn · 90 min per run · 3 questions to me per role · stalled after 5 min',
    '## Checks',
    '- claims: yes · links checked: yes',
    '- flag for me when: 1+ contradicted · 34%+ unchecked · 1+ made-up link',
  ];
  const lines = md.split('\n');
  let at = -1;
  for (const line of expected) {
    const i = lines.indexOf(line, at + 1);
    assert.ok(i > at, `"${line}" after line ${at}:\n${md}`);
    at = i;
  }
  assert.match(md, /\nLocked · sha256:[0-9a-f]{12}…\n$/);
});

test('roles without tools and non-blocking gates read plainly', () => {
  const s = v2Structure();
  s.roles[0].tools = [];
  s.roles[0].unknownTools = 'deny';
  s.gates[0].blocking = false;
  const md = teamToMarkdown(normalizeTeam(s).team);
  assert.ok(md.includes('- tools: none'));
  assert.ok(md.includes('- other tools: refused without asking'));
  assert.ok(md.includes('- after A: Look at the offers (just a note, does not wait)'));
  assert.ok(!md.includes('Locked'));
});
