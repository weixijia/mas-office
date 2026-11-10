import './keepalive.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createProjectRuntime, RunError } from '../src/engine/project.js';
import {
  TEAM, workspaceWith, fakeServer, fakeBackends, command, answer, pendingOf, waitFor, write, card, json, OPTIONS, sleep,
} from './helpers.js';

const ANSWER = `## Shortlist

<claim id="c1" src="currys-xm6">Currys sells the XM6 new for £279.</claim>
<claim id="c2" src="ebay-xm6">eBay has a refurbished unit for £199.</claim>

We suggest the Currys offer.`;

/** A team that behaves: finders write work and a card, the checker accepts, the Lead writes the answer. */
function wellBehaved(overrides = {}) {
  return async (ctx) => {
    const { agentId, text, spec } = ctx;
    if (overrides[agentId]) {
      const out = await overrides[agentId](ctx);
      if (out !== undefined) return out;
    }
    if (agentId === 'lead') {
      if (text.includes('Write one brief per role')) {
        return `Plan.${json({ plan: ['Search', 'Check'], briefs: { 'finder-a': 'Search Currys and Argos.', 'finder-b': 'Search eBay.', checker: 'Check each offer.' } })}`;
      }
      if (text.includes('asks a follow-up')) return json({ dispatch: ['finder-b'], briefs: { 'finder-b': 'Look for open-box units.' }, reason: 'Needs new search' });
      write(spec.cwd, 'outputs/result.md', ANSWER);
      return `Written.${json({ title: 'Headphone shortlist', satisfied: true, next: 'Buy from Currys.', open: [] })}`;
    }
    if (agentId === 'checker') {
      if (text.includes('Check its claims one by one')) {
        return json({ reviews: [], claims: [
          { claimId: 'c1', status: 'supported', sourceId: 'currys-xm6', relationship: 'supports' },
          { claimId: 'c2', status: 'supported', sourceId: 'ebay-xm6', relationship: 'supports' },
        ] });
      }
      write(spec.cwd, 'outputs/work/checker.md', '# Checked');
      const targets = [...text.matchAll(/outputs\/work\/(finder-[ab])\.md/g)].map((m) => m[1]);
      return json({ reviews: [...new Set(targets)].map((target) => ({ target, verdict: 'accept' })), claims: [] });
    }
    const slug = agentId === 'finder-a' ? 'currys-xm6' : 'ebay-xm6';
    const file = /Write your work to (\S+)\./.exec(text)[1];
    write(spec.cwd, file, `# ${agentId}\nFound an offer [${slug}].`);
    write(spec.cwd, `sources/${slug}.md`, card({ title: slug, url: `https://example.com/${slug}`, by: agentId }));
    return `Looked around.\nDONE: Found one offer at ${slug}`;
  };
}

function setup(team = TEAM, script = wellBehaved(), options = {}) {
  const { ws, project, dir } = workspaceWith(team);
  const server = fakeServer(ws);
  const { backends, record } = fakeBackends(script);
  const rt = createProjectRuntime({ workspace: ws, project, server, backends, options: { verifyNetwork: false, tickMs: 20, ...options } });
  const snap = () => server.log(project).snapshot();
  return { ws, project, dir, server, rt, record, snap };
}

const TASK = { task: 'Find the best price for Sony WH-1000XM6 headphones in the UK' };

test('a run goes plan → stages → review → write-up → verification → result', async () => {
  const t = setup(TEAM, wellBehaved({
    // finder-b's web search is designed as "ask": it must reach the inbox.
    'finder-b': async ({ sink }) => {
      const res = await sink.ask({
        kind: 'approval', title: 'Search the web for "sony xm6 ebay"?', subject: { type: 'tool_call', tool: 'WebSearch', input: { query: 'sony xm6 ebay' } },
        toolCallId: 'tool_1', options: OPTIONS, source: { backend: 'claude-code', raw: 'can_use_tool' },
      });
      assert.equal(res.behavior, 'allow');
    },
    // finder-a's web search is designed as "allow": no request, no waiting.
    'finder-a': async ({ sink }) => {
      const res = await sink.ask({
        kind: 'approval', title: 'Search?', subject: { type: 'tool_call', tool: 'WebSearch', input: { query: 'x' } }, options: OPTIONS,
        source: { backend: 'claude-code', raw: 'can_use_tool' },
      });
      assert.equal(res.behavior, 'allow');
    },
  }));
  const { finished } = await t.rt.startRun(TASK);
  const { request, ack } = await answer(t.server, t.rt, t.project, (r) => r.agentId === 'finder-b', { optionId: 'allow' });
  assert.equal(request.kind, 'approval');
  assert.equal(request.routeTo, 'human');
  assert.equal(ack.status, 'applied');
  await finished;

  const s = t.snap();
  assert.equal(s.state.phase, 'done');
  assert.equal(s.result.title, 'Headphone shortlist');
  assert.match(s.result.markdown, /<claim id="c1"/);
  assert.deepEqual(s.result.sources.map((x) => x.id), ['currys-xm6', 'ebay-xm6']);
  assert.equal(s.result.sources[0].evidence, 'A');
  assert.deepEqual(s.result.work.map((w) => w.by).sort(), ['checker', 'finder-a', 'finder-b']);
  assert.equal(s.result.work.find((w) => w.by === 'checker').summary, 'Reviewed Retail finder, Market finder: 2 accept (round 1)');
  // Every role finished; nobody is left waiting.
  for (const id of ['finder-a', 'finder-b', 'checker']) assert.equal(s.statuses[id].state, 'done', id);
  assert.equal(s.inbox.pending.length, 0);
  // Only the designed "ask" reached the inbox, and a person answered it.
  const approvals = s.inbox.recent.filter((r) => r.kind === 'approval');
  assert.equal(approvals.length, 1);
  assert.deepEqual(approvals[0].by, { kind: 'human' });
  // Tasks: both finders, the review, the claim check.
  const tasks = s.board.tasks;
  assert.ok(tasks.every((x) => x.state === 'done' && x.outcome === 'success'), JSON.stringify(tasks));
  assert.ok(tasks.length >= 4);
  assert.deepEqual(s.board.reviews.map((r) => [r.reviewer, r.target, r.verdict]), [['checker', 'finder-a', 'accept'], ['checker', 'finder-b', 'accept']]);
  // Claims were parsed from the answer and judged by the checker.
  assert.equal(s.verification.summary.claims, 2);
  assert.equal(s.verification.summary.supported, 2);
  assert.equal(s.verification.evidence.length, 2);
  assert.equal(s.verification.evidence[0].grade, 'A');
  assert.equal(s.board.ledger.satisfied, true);
  // The reviewer never saw the finders' conversation, only their files.
  const review = t.record.turns.find((x) => x.agentId === 'checker');
  assert.match(review.text, /outputs\/work\/finder-a\.md/);
  // Sessions are remembered for the next start; the run file is gone.
  const sessions = JSON.parse(fs.readFileSync(path.join(t.dir, 'mas/sessions.json'), 'utf8'));
  assert.deepEqual(Object.keys(sessions).sort(), ['checker', 'finder-a', 'finder-b', 'lead']);
  assert.equal(fs.existsSync(path.join(t.dir, 'mas/run.json')), false);
  // Transcripts are per agent and carry the request.
  const transcript = fs.readFileSync(path.join(t.dir, 'mas/transcript/finder-b.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(transcript.map((e) => e.kind), ['user', 'request', 'resolved']);
  await t.rt.close();
});

test('a tool outside the role design is refused without bothering anyone', async () => {
  let refused;
  const t = setup(TEAM, wellBehaved({
    'finder-a': async ({ sink, spec }) => {
      refused = await sink.ask({
        kind: 'approval', title: 'Write ../../CLAUDE.md?', subject: { type: 'tool_call', tool: 'Write', input: { file_path: path.join(spec.cwd, '..', 'CLAUDE.md') } },
        options: OPTIONS, source: { backend: 'claude-code', raw: 'can_use_tool' },
      });
    },
  }));
  await (await t.rt.startRun(TASK)).finished;
  assert.equal(refused.behavior, 'deny');
  assert.match(refused.message, /Not allowed for your role/);
  assert.equal(t.snap().inbox.recent.filter((r) => r.kind === 'approval').length, 0);
  await t.rt.close();
});

test('a delegation rule lets the policy approve, and the decision is on record', async () => {
  const team = structuredClone(TEAM);
  team.lead.delegate = [{ effect: 'allow', kind: 'approval', tools: ['web search'], max: 1 }];
  let second;
  const t = setup(team, wellBehaved({
    'finder-b': async ({ sink }) => {
      const ask = () => sink.ask({
        kind: 'approval', title: 'Search the web?', subject: { type: 'tool_call', tool: 'WebSearch', input: { query: 'q' } }, options: OPTIONS,
        source: { backend: 'claude-code', raw: 'can_use_tool' },
      });
      assert.equal((await ask()).behavior, 'allow');
      second = ask(); // the rule's budget (max 1) is used up: this one is for the person
      await second;
    },
  }));
  const { finished } = await t.rt.startRun(TASK);
  const { request } = await answer(t.server, t.rt, t.project, (r) => r.agentId === 'finder-b' && r.routeTo === 'human', { optionId: 'deny' });
  assert.equal(request.kind, 'approval');
  assert.equal((await second).behavior, 'deny');
  await finished;
  const recent = t.snap().inbox.recent.filter((r) => r.kind === 'approval');
  const byPolicy = recent.find((r) => r.by.kind === 'policy');
  assert.ok(byPolicy, 'the policy decision is in the inbox history');
  assert.equal(byPolicy.routeTo, 'lead');
  assert.ok(byPolicy.by.rule);
  assert.ok(recent.some((r) => r.by.kind === 'human' && r.optionId === 'deny'));
  await t.rt.close();
});

test('the Lead decides a delegated request; when it escalates, the person gets it', async () => {
  const team = structuredClone(TEAM);
  team.lead.delegate = [{ effect: 'lead', kind: 'approval' }];
  let leadSays = 'allow';
  const outcomes = [];
  const t = setup(team, wellBehaved({
    lead: ({ text }) => (text.includes('delegated to you') ? json({ optionId: leadSays, note: 'needed for the task' }) : undefined),
    'finder-b': async ({ sink }) => {
      const ask = () => sink.ask({
        kind: 'approval', title: 'Search the web?', subject: { type: 'tool_call', tool: 'WebSearch', input: { query: 'q' } }, options: OPTIONS,
        source: { backend: 'claude-code', raw: 'can_use_tool' },
      });
      outcomes.push((await ask()).behavior);
      leadSays = 'escalate';
      outcomes.push((await ask()).behavior);
    },
  }));
  const { finished } = await t.rt.startRun(TASK);
  await answer(t.server, t.rt, t.project, (r) => r.agentId === 'finder-b' && r.routeTo === 'human', { optionId: 'allow' });
  await finished;
  assert.deepEqual(outcomes, ['allow', 'allow']);
  const recent = t.snap().inbox.recent.filter((r) => r.kind === 'approval');
  assert.ok(recent.some((r) => r.by.kind === 'agent' && r.by.id === 'lead' && r.outcome === 'selected'));
  assert.ok(recent.some((r) => r.outcome === 'superseded'), 'the escalation is visible in the history');
  assert.ok(recent.some((r) => r.by.kind === 'human'));
  await t.rt.close();
});

test('a reviewer sends work back; past the round limit the person decides, never a silent accept', async () => {
  let reviews = 0;
  const t = setup(TEAM, wellBehaved({
    checker: ({ text, spec }) => {
      if (text.includes('Check its claims')) return undefined;
      reviews += 1;
      write(spec.cwd, 'outputs/work/checker.md', '# Checked');
      const targets = [...new Set([...text.matchAll(/outputs\/work\/(finder-[ab])\.md/g)].map((m) => m[1]))];
      return json({ reviews: targets.map((target) => ({ target, verdict: target === 'finder-a' ? 'revise' : 'accept', note: 'The price is wrong.' })), claims: [] });
    },
  }));
  const { finished } = await t.rt.startRun(TASK);
  const { request } = await answer(t.server, t.rt, t.project, (r) => r.kind === 'flag', { optionId: 'accept' });
  assert.match(request.title, /still rejects Retail finder's work after 2 rounds/);
  assert.equal(request.resolver, 'human_only');
  await finished;
  assert.equal(reviews, 2);
  const s = t.snap();
  assert.equal(s.state.phase, 'done');
  // finder-a was sent back once, with the reviewer's note.
  const redo = t.record.turns.filter((x) => x.agentId === 'finder-a');
  assert.equal(redo.length, 2);
  assert.match(redo[1].text, /ATTEMPT 2[\s\S]*The price is wrong/);
  assert.deepEqual(s.board.reviews.filter((r) => r.target === 'finder-a').map((r) => [r.round, r.verdict]), [[1, 'revise'], [2, 'revise']]);
  assert.ok(s.result.flags.some((f) => f.by === 'checker'));
  await t.rt.close();
});

test('a reviewer that gives no verdict has not accepted', async () => {
  const t = setup(TEAM, wellBehaved({
    checker: ({ text }) => (text.includes('Check its claims') ? undefined : 'Looks fine to me.'),
  }));
  const { finished } = await t.rt.startRun(TASK);
  const first = await answer(t.server, t.rt, t.project, (r) => r.kind === 'flag', { optionId: 'accept' });
  assert.match(first.request.title, /cannot settle/);
  await answer(t.server, t.rt, t.project, (r) => r.kind === 'flag', { optionId: 'accept' });
  await finished;
  assert.equal(t.snap().state.phase, 'done');
  await t.rt.close();
});

test('a stage gate holds the next stage; a note sends the stage back', async () => {
  const team = structuredClone(TEAM);
  team.gates = [{ id: 'g1', after: 'A', kind: 'stage', title: 'Look at the offers' }, { id: 'g2', kind: 'final', title: 'Approve the answer' }];
  const t = setup(team);
  const { finished } = await t.rt.startRun(TASK);
  const gate = await waitFor(() => pendingOf(t.server, t.project).find((r) => r.kind === 'gate'), { what: 'the gate' });
  assert.equal(gate.title, 'Look at the offers');
  assert.equal(t.record.turns.some((x) => x.agentId === 'checker'), false, 'the checker has not started');
  assert.equal(t.snap().statuses.lead.state, 'flagged');
  await answer(t.server, t.rt, t.project, (r) => r.kind === 'gate', { text: 'Also look at Amazon.' });
  await waitFor(() => t.record.turns.filter((x) => x.agentId === 'finder-a').length === 2, { what: 'the stage to be redone' });
  assert.match(t.record.turns.filter((x) => x.agentId === 'finder-a')[1].text, /at the checkpoint: Also look at Amazon/);
  await answer(t.server, t.rt, t.project, (r) => r.kind === 'gate' && r.title === 'Look at the offers', { optionId: 'accept' });
  // The final gate comes after the result is written.
  const final = await waitFor(() => pendingOf(t.server, t.project).find((r) => r.title === 'Approve the answer'), { what: 'the final gate' });
  assert.ok(t.snap().result, 'the result is there to look at while the gate waits');
  assert.equal(t.snap().state.phase, 'running');
  await answer(t.server, t.rt, t.project, (r) => r.requestId === final.requestId, { optionId: 'accept' });
  await finished;
  assert.equal(t.snap().state.phase, 'done');
  await t.rt.close();
});

test('a role that fails twice is put to the person, who can go on without it', async () => {
  const t = setup(TEAM, wellBehaved({
    'finder-b': () => ({ ok: false, text: '', stopReason: 'error', error: 'rate limited' }),
  }));
  const { finished } = await t.rt.startRun(TASK);
  const { request } = await answer(t.server, t.rt, t.project, (r) => r.kind === 'decision', { optionId: 'skip' });
  assert.match(request.title, /Market finder failed twice/);
  await finished;
  const s = t.snap();
  assert.equal(s.state.phase, 'done');
  assert.equal(s.statuses['finder-b'].state, 'failed');
  assert.deepEqual(s.board.recoveries.map((r) => r.strategy), ['retry', 'ask-human']);
  assert.equal(t.record.turns.filter((x) => x.agentId === 'finder-b').length, 2);
  await t.rt.close();
});

test('stopping an agent is a fact only when its session stops; then the person decides', async () => {
  let release;
  const t = setup(TEAM, wellBehaved({
    'finder-a': ({ turnNo }) => (turnNo === 1 ? new Promise((r) => { release = r; }) : undefined),
  }));
  const { finished } = await t.rt.startRun(TASK);
  await waitFor(() => release, { what: 'finder-a to be working' });
  const ack = await command(t.server, t.rt, t.project, 'command.interrupt', 'finder-a', {});
  assert.equal(ack.status, 'applied');
  const { request } = await answer(t.server, t.rt, t.project, (r) => r.kind === 'decision', { optionId: 'retry' });
  assert.match(request.title, /You stopped Retail finder/);
  await finished;
  const s = t.snap();
  assert.equal(s.state.phase, 'done');
  assert.ok(t.server.events.some((e) => e.type === 'agent.stopped' && e.agentId === 'finder-a' && e.data.by.kind === 'human'));
  assert.equal(s.statuses['finder-a'].state, 'done');
  await t.rt.close();
});

test('messages reach the real session, or wait in the brief when it has not started', async () => {
  const team = structuredClone(TEAM);
  team.gates = [{ id: 'g1', after: 'A', kind: 'stage', title: 'Hold' }];
  let release;
  const t = setup(team, wellBehaved({
    'finder-a': ({ turnNo }) => (turnNo === 1 ? new Promise((r) => { release = r; }).then(() => undefined) : undefined),
  }));
  const { finished } = await t.rt.startRun(TASK);
  await waitFor(() => release, { what: 'finder-a to be working' });
  const steer = await command(t.server, t.rt, t.project, 'command.message', 'finder-a', { text: 'Check Argos too', delivery: 'steer' });
  assert.equal(steer.status, 'applied');
  assert.equal(steer.reason, 'delivered at the next break');
  assert.deepEqual(t.record.sent.at(-1), { agentId: 'finder-a', text: 'Check Argos too', delivery: 'steer' });
  // The checker has no session yet: the note waits for its brief.
  const early = await command(t.server, t.rt, t.project, 'command.message', 'checker', { text: 'Be strict about refurbished units' });
  assert.equal(early.status, 'accepted');
  const unknown = await command(t.server, t.rt, t.project, 'command.message', 'nobody', { text: 'hi' });
  assert.equal(unknown.status, 'rejected');
  release();
  await answer(t.server, t.rt, t.project, (r) => r.kind === 'gate', { optionId: 'accept' });
  await finished;
  assert.match(t.record.turns.find((x) => x.agentId === 'checker').text, /Read:/);
  await t.rt.close();
});

test('an answer to a request that is gone is rejected, and only a person may answer a gate', async () => {
  const team = structuredClone(TEAM);
  team.gates = [{ id: 'g1', after: 'A', kind: 'stage', title: 'Hold' }];
  const t = setup(team);
  const { finished } = await t.rt.startRun(TASK);
  const gate = await waitFor(() => pendingOf(t.server, t.project).find((r) => r.kind === 'gate'), { what: 'the gate' });
  const forged = await command(t.server, t.rt, t.project, 'command.respond', 'lead', { requestId: gate.requestId, outcome: 'selected', optionId: 'accept' }, { kind: 'agent', id: 'lead' });
  assert.deepEqual([forged.status, forged.reason], ['rejected', 'not_allowed']);
  const bad = await command(t.server, t.rt, t.project, 'command.respond', 'lead', { requestId: gate.requestId, outcome: 'selected', optionId: 'nope' });
  assert.deepEqual([bad.status, bad.reason], ['rejected', 'unknown_option']);
  const ok = await command(t.server, t.rt, t.project, 'command.respond', 'lead', { requestId: gate.requestId, outcome: 'selected', optionId: 'accept' });
  assert.equal(ok.status, 'applied');
  const late = await command(t.server, t.rt, t.project, 'command.respond', 'lead', { requestId: gate.requestId, outcome: 'selected', optionId: 'stop' });
  assert.deepEqual([late.status, late.reason], ['rejected', 'already_resolved']);
  await finished;
  assert.equal(t.snap().state.phase, 'done');
  await t.rt.close();
});

test('claims that do not check out hold the answer back until the person decides', async () => {
  const t = setup(TEAM, wellBehaved({
    checker: ({ text }) => (text.includes('Check its claims one by one')
      ? json({ reviews: [], claims: [{ claimId: 'c1', status: 'contradicted', sourceId: 'currys-xm6', relationship: 'refutes', note: '"£299.00"' }, { claimId: 'c2', status: 'supported' }] })
      : undefined),
  }));
  const { finished } = await t.rt.startRun(TASK);
  const { request } = await answer(t.server, t.rt, t.project, (r) => r.kind === 'flag', { optionId: 'publish' });
  assert.match(request.title, /did not check out/);
  assert.equal(t.snap().result, null, 'no answer was published before the decision');
  await finished;
  const s = t.snap();
  assert.equal(s.state.phase, 'done');
  assert.equal(s.verification.summary.contradicted, 1);
  assert.equal(s.verification.claims.find((c) => c.claimId === 'c1').status, 'contradicted');
  await t.rt.close();
});

test('a follow-up is the next round of the same run and sends back only what is needed', async () => {
  const t = setup();
  await (await t.rt.startRun(TASK)).finished;
  const before = t.record.turns.length;
  const { round, finished } = await t.rt.startRun({ followUp: 'Any open-box units?' });
  assert.equal(round, 2);
  assert.equal(t.snap().state.phase, 'running');
  await finished;
  const s = t.snap();
  assert.equal(s.state.phase, 'done');
  assert.equal(s.state.run, 1);
  assert.equal(s.result.round, 2);
  assert.equal(s.result.question, 'Any open-box units?');
  assert.equal(s.result.previous.length, 1);
  const turns = t.record.turns.slice(before);
  // finder-b went back, with a fresh session and its own round file; its reviewer came along.
  assert.equal(turns.some((x) => x.agentId === 'finder-a'), false);
  assert.match(turns.find((x) => x.agentId === 'finder-b').text, /outputs\/work\/finder-b-round2\.md/);
  assert.ok(turns.some((x) => x.agentId === 'checker'));
  assert.ok(fs.existsSync(path.join(t.dir, 'outputs/work/finder-b-round2.md')));
  assert.ok(t.record.starts.filter((x) => x.agentId === 'finder-b').length >= 2);
  await t.rt.close();
});

test('a quiet role is nudged, then stopped and retried', async () => {
  let clock = 1_000_000;
  let calls = 0;
  const t = setup(TEAM, wellBehaved({
    'finder-a': () => {
      calls += 1;
      return calls === 1 ? new Promise(() => {}) : undefined; // the first attempt never comes back
    },
    lead: ({ text }) => (text.includes('has shown no progress') ? json({ strategy: 'retry', note: 'try again' }) : undefined),
  }), { now: () => clock, tickMs: 10 });
  const { finished } = await t.rt.startRun(TASK);
  await waitFor(() => calls === 1, { what: 'finder-a to start' });
  clock += 6 * 60_000;
  await waitFor(() => t.record.sent.some((x) => x.agentId === 'finder-a'), { what: 'the nudge' });
  assert.equal(t.snap().board.ledger.progressing, false);
  clock += 6 * 60_000;
  await finished;
  const s = t.snap();
  assert.equal(s.state.phase, 'done');
  assert.equal(calls, 2);
  assert.ok(s.board.recoveries.some((r) => r.strategy === 'retry' && r.target === 'finder-a'));
  assert.equal(s.inbox.recent.filter((r) => r.kind === 'decision').length, 0, 'an automatic retry does not ask the person');
  await t.rt.close();
});

test('starting needs a locked, valid team and a task; one run at a time', async () => {
  const { ws, project } = workspaceWith(TEAM, { lock: false });
  const server = fakeServer(ws);
  const { backends } = fakeBackends(wellBehaved());
  const rt = createProjectRuntime({ workspace: ws, project, server, backends, options: { verifyNetwork: false } });
  await assert.rejects(() => rt.startRun(TASK), (e) => e instanceof RunError && e.code === 'not_locked');

  const t = setup();
  await assert.rejects(() => t.rt.startRun({}), (e) => e.code === 'no_task');
  await assert.rejects(() => t.rt.startRun({ followUp: 'x' }), (e) => e.code === 'no_result');
  const { finished } = await t.rt.startRun(TASK);
  await assert.rejects(() => t.rt.startRun(TASK), (e) => e.code === 'busy');
  await finished;

  const codexOnly = structuredClone(TEAM);
  codexOnly.roles[2].backend = 'codex';
  const c = workspaceWith(codexOnly);
  const only = fakeBackends(wellBehaved(), ['claude-code']);
  const rt2 = createProjectRuntime({ workspace: c.ws, project: c.project, server: fakeServer(c.ws), backends: only.backends });
  await assert.rejects(() => rt2.startRun(TASK), (e) => e.code === 'no_backend');
  await t.rt.close();
});

test('a design changed after locking is refused', async () => {
  const { ws, project, dir, structure } = workspaceWith();
  structure.roles[0].tools = ['web search', 'run commands'];
  fs.writeFileSync(path.join(dir, 'mas/structure.json'), JSON.stringify(structure));
  const { backends } = fakeBackends(wellBehaved());
  const rt = createProjectRuntime({ workspace: ws, project, server: fakeServer(ws), backends });
  await assert.rejects(() => rt.startRun(TASK), (e) => e.code === 'signature');
});

test('after a restart, orphaned requests expire and the run continues without redoing finished roles', async () => {
  const team = structuredClone(TEAM);
  team.gates = [{ id: 'g1', after: 'A', kind: 'stage', title: 'Hold' }];
  const first = setup(team);
  await first.rt.startRun(TASK);
  await waitFor(() => pendingOf(first.server, first.project).find((r) => r.kind === 'gate'), { what: 'the gate' });
  const saved = fs.readFileSync(path.join(first.dir, 'mas/run.json'), 'utf8');
  // The daemon dies here: its callbacks are gone, the log and the run file stay.
  await first.rt.close();
  fs.writeFileSync(path.join(first.dir, 'mas/run.json'), saved);
  await sleep(10);

  const server = fakeServer(first.ws);
  server.emit(first.project, [{ type: 'request.opened', agentId: 'lead', data: { requestId: 'orphan', kind: 'gate', title: 'Hold' } }]);
  const { backends, record } = fakeBackends(wellBehaved());
  const rt = createProjectRuntime({ workspace: first.ws, project: first.project, server, backends, options: { verifyNetwork: false } });
  const out = rt.recover();
  assert.equal(out.resumed, true);
  assert.ok(out.expired >= 1);
  // A restart does not spend the person's plan by itself: it asks first.
  assert.equal(record.turns.length, 0);
  const { request } = await answer(server, rt, first.project, (r) => r.kind === 'decision', { optionId: 'continue' });
  assert.match(request.title, /cut off mid-run/);
  await out.finished;
  const s = server.log(first.project).snapshot();
  assert.equal(s.state.phase, 'done');
  assert.equal(record.turns.some((x) => x.agentId.startsWith('finder')), false, 'finished roles are not run again');
  assert.ok(record.starts.some((x) => x.agentId === 'lead' && x.resume), 'the Lead session resumes by id');
  assert.ok(s.inbox.recent.some((r) => r.requestId === 'orphan' && r.outcome === 'expired'));
  await rt.close();
});

test('a question becomes buttons in the inbox, and each role has a question budget', async () => {
  const team = structuredClone(TEAM);
  team.budget = { maxQuestionsPerRole: 1 };
  const got = [];
  const t = setup(team, wellBehaved({
    'finder-a': async ({ sink }) => {
      const ask = () => sink.ask({
        kind: 'question', title: 'Question', subject: { type: 'question', tool: 'AskUserQuestion' }, options: [],
        questions: [{ question: 'New or refurbished?', header: 'Condition', options: [{ label: 'New only', description: 'Sealed units' }, { label: 'Either' }] }],
        source: { backend: 'claude-code', raw: 'can_use_tool' },
      });
      got.push(await ask(), await ask());
    },
  }));
  const { finished } = await t.rt.startRun(TASK);
  const { request } = await answer(t.server, t.rt, t.project, (r) => r.kind === 'question', { optionId: 'choice-0' });
  assert.equal(request.title, 'New or refurbished?');
  assert.deepEqual(request.options.map((o) => o.name), ['New only', 'Either']);
  assert.match(request.description, /New only: Sealed units/);
  await finished;
  assert.equal(got[0].behavior, 'allow');
  assert.deepEqual(got[0].answers, { 'New or refurbished?': 'New only' });
  assert.equal(got[1].behavior, 'deny');
  assert.match(got[1].message, /used your questions/);
  assert.equal(t.snap().inbox.recent.filter((r) => r.kind === 'question').length, 1);
  await t.rt.close();
});
