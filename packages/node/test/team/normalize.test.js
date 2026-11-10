import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeTeam, stageOrder, DEFAULT_BUDGET } from '../../src/team/normalize.js';
import { parseJsTwin } from '../../src/sdk/index.js';
import { v2Structure, ENV } from './fixtures.js';

const EXAMPLES = fileURLToPath(new URL('../../../../examples/', import.meta.url));
const errors = (problems) => problems.filter((p) => p.level === 'error').map((p) => `${p.path} ${p.message}`);
const warnings = (problems) => problems.filter((p) => p.level === 'warning').map((p) => `${p.path} ${p.message}`);
const clone = (v) => structuredClone(v);

test('every example structure (0.1 and v2) normalises without errors', () => {
  for (const name of fs.readdirSync(EXAMPLES)) {
    const file = path.join(EXAMPLES, name, 'mas', 'structure.js');
    if (!fs.existsSync(file)) continue;
    const { team, problems } = normalizeTeam(parseJsTwin(fs.readFileSync(file, 'utf8')));
    assert.deepEqual(errors(problems), [], name);
    assert.ok(team.roles.length > 0);
  }
});

test('a minimal 0.1 structure gets every default', () => {
  const { team, problems } = normalizeTeam({
    lead: { id: 'lead', name: 'Lead' },
    groups: [{ id: 'A', after: null }],
    roles: [{ id: 'finder', name: 'Finder', tools: ['web search'], group: 'A' }],
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(team.budget, DEFAULT_BUDGET);
  assert.equal(team.topology, 'staged');
  assert.equal(team.version, 1);
  assert.equal(team.locked, false);
  assert.deepEqual(team.lead.delegate, []);
  assert.equal(team.lead.backend, 'claude-code');
  const [role] = team.roles;
  assert.equal(role.backend, 'claude-code');
  assert.equal(role.model, null);
  assert.equal(role.handsTo, 'lead');
  assert.deepEqual(role.tools, [{ name: 'web search', effect: 'allow' }]);
  assert.deepEqual(role.reviewerOf, []);
  assert.equal(role.cleanContext, false);
  assert.equal(role.unknownTools, 'ask');
  assert.equal(role.review, undefined);
  assert.deepEqual(team.gates, []);
  assert.deepEqual(team.verify, { claims: true, urlHealth: true, flagWhen: { contradicted: 1, unknownShare: 0.34, hallucinated: 1 } });
});

test('groups are derived from the roles when the structure has none', () => {
  const { team, problems } = normalizeTeam({
    lead: { id: 'lead', name: 'Lead' },
    roles: [{ id: 'a', name: 'A', group: 'X' }, { id: 'b', name: 'B', group: 'Y' }, { id: 'c', name: 'C' }],
  });
  assert.deepEqual(errors(problems), []);
  assert.deepEqual(team.groups.map((g) => [g.id, g.after]), [['X', null], ['Y', 'X']]);
  assert.equal(team.roles[2].group, 'X');
  assert.match(warnings(problems).join('\n'), /\/roles\/2\/group no group given/);
  assert.deepEqual(stageOrder(team), [['a', 'c'], ['b']]);
});

test('the v2 fixture: defaults for reviewers, no errors with its workspace', () => {
  const { team, problems } = normalizeTeam(v2Structure(), ENV);
  assert.deepEqual(errors(problems), []);
  const checker = team.roles.find((r) => r.id === 'checker');
  assert.deepEqual(checker.review, { maxRounds: 2, onExceed: 'ask-human' });
  assert.equal(checker.cleanContext, true);
  assert.deepEqual(team.roles[0].tools, [
    { name: 'web search', effect: 'allow' }, { name: 'browse the web', effect: 'ask' }, { name: 'read my files', effect: 'allow' },
  ]);
  assert.deepEqual(team.gates[1], { id: 'g-final', after: null, kind: 'final', title: 'Approve the answer', blocking: true });
  assert.deepEqual(team.lead.delegate, [{ effect: 'allow', kind: 'approval', tools: ['web search', 'browse the web'] }]);
});

test('unknown tools, bad entries and duplicates are errors', () => {
  const s = v2Structure();
  s.roles[0].tools = ['web search', 'flight search', { name: 'web search', effect: 'ask' }, { name: 'run commands', effect: 'sometimes' }];
  const errs = errors(normalizeTeam(s, ENV).problems);
  assert.ok(errs.some((e) => e.startsWith('/roles/0/tools/1 "flight search" is not a known tool')), errs.join('\n'));
  assert.ok(errs.some((e) => e.startsWith('/roles/0/tools/2 "web search" is listed twice')));
  assert.ok(errs.some((e) => e.startsWith('/roles/0/tools/3 effect must be')));
});

test('mcp:, cli: and browse the web are checked against the workspace when it is given', () => {
  const s = v2Structure();
  s.roles[1].tools = ['mcp:unknown', 'cli:rm -rf', 'cli:git log --oneline', { name: 'mcp:other', effect: 'deny' }];
  const errs = errors(normalizeTeam(s, ENV).problems);
  assert.ok(errs.some((e) => /\/roles\/1\/tools\/0 MCP server "unknown" is not in the workspace \.mcp\.json/.test(e)));
  assert.ok(errs.some((e) => /\/roles\/1\/tools\/1 "rm -rf" is not on the workspace command allow-list/.test(e)));
  assert.ok(!errs.some((e) => e.startsWith('/roles/1/tools/2')), '"git log --oneline" is covered by "git"');
  assert.ok(!errs.some((e) => e.startsWith('/roles/1/tools/3')), 'a denied server needs no configuration');
  const noBrowser = { ...ENV, mcpServers: {} };
  assert.ok(errors(normalizeTeam(v2Structure(), noBrowser).problems).some((e) => /"browse the web" needs the "mas-browser" MCP server/.test(e)));
  assert.deepEqual(errors(normalizeTeam(v2Structure()).problems), [], 'without env the workspace checks are skipped');
});

test('references: handsTo, reviewerOf, groups and gates', () => {
  const s = v2Structure();
  s.roles[0].handsTo = 'nobody';
  s.roles[1].handsTo = 'finder-b';
  s.roles[2].reviewerOf = ['checker', 'ghost', 'finder-a'];
  s.roles[2].group = 'Z';
  s.groups.push({ id: 'C', after: 'missing' });
  s.gates = [{ id: 'g1', after: 'nope' }, { id: 'g1', after: null }, { id: 'g2', after: null, kind: 'stage' }, { id: 'g3', after: 'A', kind: 'final' }, { id: 'g4', kind: 'party', after: null }, { after: 'A' }];
  const errs = errors(normalizeTeam(s, ENV).problems);
  const has = (re) => assert.ok(errs.some((e) => re.test(e)), `${re} in\n${errs.join('\n')}`);
  has(/^\/roles\/0\/handsTo "nobody" is not a role id or "lead"/);
  has(/^\/roles\/1\/handsTo a role cannot hand work to itself/);
  has(/^\/roles\/2\/reviewerOf a role cannot review itself/);
  has(/^\/roles\/2\/reviewerOf "ghost" is not a role id/);
  has(/^\/roles\/2\/group "Z" is not a group id/);
  has(/^\/groups\/2\/after "missing" is not a group id/);
  has(/^\/gates\/0\/after "nope" is not a group id/);
  has(/^\/gates\/1\/id gate "g1" is defined twice/);
  has(/^\/gates\/2\/after a stage gate needs the stage it follows/);
  has(/^\/gates\/3\/after a final gate does not follow a stage/);
  has(/^\/gates\/4\/kind must be one of plan, stage, final/);
  has(/^\/gates\/5 a gate needs an id/);
});

test('ids: pattern, reserved, round suffix and duplicates', () => {
  const s = v2Structure();
  s.roles.push({ id: 'Finder', name: 'x', group: 'A' }, { id: 'lead', name: 'x', group: 'A' }, { id: 'finder-round2', name: 'x', group: 'A' }, { id: 'finder-a', name: 'x', group: 'A' }, { id: 'a'.repeat(65), name: 'x', group: 'A' });
  s.lead.id = 'boss';
  s.groups.push({ id: 'A' });
  const errs = errors(normalizeTeam(s, ENV).problems);
  const has = (re) => assert.ok(errs.some((e) => re.test(e)), `${re} in\n${errs.join('\n')}`);
  has(/^\/roles\/3\/id a role id uses lower-case/);
  has(/^\/roles\/4\/id "lead" is reserved/);
  has(/^\/roles\/5\/id a role id cannot contain "-round"/);
  has(/^\/roles\/6\/id role id "finder-a" is used twice/);
  has(/^\/roles\/7\/id a role id uses lower-case/);
  has(/^\/lead\/id the Lead's id must be "lead"/);
  has(/^\/groups\/2\/id group "A" is defined twice/);
});

test('stage loops and reviewer placement are errors', () => {
  const loop = v2Structure();
  loop.groups = [{ id: 'A', after: 'B' }, { id: 'B', after: 'A' }];
  assert.ok(errors(normalizeTeam(loop).problems).some((e) => /^\/groups the stages form a loop: A → B → A/.test(e)));
  assert.throws(() => stageOrder(normalizeTeam(loop).team), /loop/);

  const early = v2Structure();
  early.roles[2].group = 'A';
  early.roles[0].group = 'B';
  assert.ok(errors(normalizeTeam(early).problems).some((e) => /"checker" reviews "finder-a" but does not run after it/.test(e)));

  const parallel = v2Structure();
  parallel.groups.push({ id: 'C', after: null });
  parallel.roles[2].group = 'C';
  assert.ok(errors(normalizeTeam(parallel).problems).some((e) => /does not run after it/.test(e)), 'a sibling stage is not "after"');

  const mutual = v2Structure();
  mutual.roles[0].reviewerOf = ['finder-b'];
  mutual.roles[1].reviewerOf = ['finder-a'];
  assert.ok(errors(normalizeTeam(mutual).problems).some((e) => /review each other in a loop: finder-a → finder-b → finder-a/.test(e)));
});

test('stageOrder: dependency order, reviewers after their targets inside a stage', () => {
  const s = v2Structure();
  s.groups = [{ id: 'B', after: 'A' }, { id: 'A', after: null }, { id: 'C', after: 'B' }];
  s.roles.push({ id: 'second-look', name: 'Second look', group: 'B', reviewerOf: ['checker'] });
  s.roles.unshift({ id: 'early-reviewer', name: 'Early reviewer', group: 'B', reviewerOf: ['checker'] });
  const { team, problems } = normalizeTeam(s);
  assert.deepEqual(errors(problems), []);
  assert.deepEqual(stageOrder(team), [['finder-a', 'finder-b'], ['checker', 'early-reviewer', 'second-look']]);
  assert.match(warnings(problems).join('\n'), /stage "C" has no roles/);
});

test('warnings: span of control, cross-vendor hint, missing backend, parallel budget', () => {
  const s = v2Structure();
  for (let i = 0; i < 6; i += 1) s.roles.push({ id: `extra-${i}`, name: `Extra ${i}`, group: 'A' });
  s.roles[2].backend = 'claude-code';
  s.budget.maxParallel = 6;
  const warns = warnings(normalizeTeam(s, ENV).problems);
  const has = (re) => assert.ok(warns.some((w) => re.test(w)), `${re} in\n${warns.join('\n')}`);
  has(/^\/lead 7 roles hand their work to the Lead; more than 6/);
  has(/^\/roles\/2\/backend this reviewer uses the same backend \(claude-code\)/);
  has(/^\/budget\/maxParallel more than 3 sessions/);
  const onlyClaude = { ...ENV, backends: { 'claude-code': true, codex: false } };
  const w2 = warnings(normalizeTeam(s, onlyClaude).problems);
  assert.ok(!w2.some((w) => /same backend/.test(w)), 'no hint when no other backend is available');
  assert.ok(warnings(normalizeTeam(v2Structure(), onlyClaude).problems).some((w) => /^\/roles\/2\/backend codex is not installed/.test(w)));
});

test('Codex roles: ask on web search is reported as deny', () => {
  const s = v2Structure();
  s.roles[2].tools = [{ name: 'web search', effect: 'ask' }];
  assert.ok(warnings(normalizeTeam(s).problems).some((w) => /Codex cannot ask before each web search/.test(w)));
});

test('budget, verify, review and delegation rules are validated', () => {
  const s = v2Structure();
  s.budget = { maxParallel: 0, maxRunMinutes: -1, stallMinutes: 2.5, extra: 1 };
  s.verify = { claims: 'yes', flagWhen: { unknownShare: 2, contradicted: 0, other: 1 } };
  s.roles[2].review = { maxRounds: 0, onExceed: 'accept' };
  s.roles[2].cleanContext = 'yes';
  s.roles[2].unknownTools = 'allow';
  s.topology = 'mesh';
  s.lead.delegate = [
    { effect: 'maybe' }, { effect: 'allow', tools: ['flight search'] }, { effect: 'lead', roles: ['ghost'] },
    { effect: 'allow', max: 0 }, { effect: 'allow', expires: 'soon' }, { effect: 'allow', colour: 'red' }, 'x',
  ];
  const { team, problems } = normalizeTeam(s);
  const errs = errors(problems);
  const has = (re) => assert.ok(errs.some((e) => re.test(e)), `${re} in\n${errs.join('\n')}`);
  has(/^\/budget\/maxParallel must be a positive number/);
  has(/^\/budget\/maxRunMinutes must be a positive number/);
  has(/^\/verify\/claims must be true or false/);
  has(/^\/verify\/flagWhen\/unknownShare must be a share from 0 to 1/);
  has(/^\/verify\/flagWhen\/contradicted must be a whole number/);
  has(/^\/roles\/2\/review\/maxRounds must be a whole number/);
  has(/^\/roles\/2\/review\/onExceed must be "ask-human"/);
  has(/^\/roles\/2\/cleanContext must be true or false/);
  has(/^\/roles\/2\/unknownTools must be "ask" or "deny"/);
  has(/^\/topology must be one of/);
  has(/^\/lead\/delegate\/0\/effect must be one of allow, lead, human/);
  has(/^\/lead\/delegate\/1\/tools\/0 "flight search" is not a known tool/);
  has(/^\/lead\/delegate\/2\/roles\/0 "ghost" is not a role id/);
  has(/^\/lead\/delegate\/3\/max must be a whole number/);
  has(/^\/lead\/delegate\/4\/expires must be a date/);
  has(/^\/lead\/delegate\/5\/colour is not a delegation rule field/);
  has(/^\/lead\/delegate\/6 a delegation rule must be an object/);
  assert.equal(team.budget.stallMinutes, 2.5);
  assert.equal(team.lead.delegate.length, 0, 'invalid rules are dropped');
  assert.ok(warnings(problems).some((w) => w.startsWith('/budget/extra')));
});

test('not an object, or no roles list', () => {
  assert.deepEqual(normalizeTeam(null), { team: null, problems: [{ level: 'error', path: '', message: 'the structure must be an object' }] });
  const { problems } = normalizeTeam({ lead: { id: 'lead', name: 'Lead' }, roles: 'x' });
  assert.ok(errors(problems).includes('/roles must be a list'));
  assert.ok(errors(normalizeTeam({ roles: [] }).problems).includes('/lead the Lead is required'));
});

test('normalising twice gives the same team', () => {
  const once = normalizeTeam(v2Structure(), ENV).team;
  const twice = normalizeTeam(clone(once), ENV);
  assert.deepEqual(errors(twice.problems), []);
  assert.deepEqual(twice.team, once);
});
