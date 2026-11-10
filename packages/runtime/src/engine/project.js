// One project's team at work: sessions, the scheduler, the review loop, gates, the Lead's turns
// and verification. The contract is docs/design/runtime.md §7.
//
// The scheduler is deterministic code. The Lead is a real session that advises it through
// structured turns; everything the Lead returns is validated before it has any effect.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readDocument, writeFileAtomic, isValidAgentId } from 'mas-office';
import { normalizeTeam, stageOrder, compileRole, compileLead, decideTool, verifySignature } from 'mas-office/team';
import { matchDelegation, countKey } from 'mas-office/policy';
import {
  parseClaims, claimEvents, readSourceCards, checkSources, evidenceEvents, parseReviewBlock, verdictEvents,
  mergeLanes, shouldFlag, summarize, leadWriteupRules, checkerRules, finderRules,
} from 'mas-office/verify';
import { createBroker } from './broker.js';
import {
  extractJson, semaphore, shortenHomeDeep, oneLine, shortId,
} from './util.js';
import {
  planPrompt, writeupPrompt, followUpPrompt, recoveryPrompt, delegatedDecisionPrompt, roleBrief, reviewBrief,
  claimCheckBrief, NUDGE,
} from './prompts.js';

export const ANSWER_FILE = 'outputs/result.md';
const TICK_MS = 15_000;
const MAX_GATE_REVISIONS = 3;
const ALLOW = new Set(['allow_once', 'allow_always']);

/** Thrown for things the caller did wrong (a run already active, a team that is not locked). */
export class RunError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// A regular file only (never through a symbolic link a role could have planted), of sane size.
const readText = (file, max = 512 * 1024) => {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > max) return null;
    return fs.readFileSync(file, 'utf8');
  } catch { return null; }
};
const text1000 = (v) => (typeof v === 'string' && v.trim() ? v.slice(0, 1000) : undefined);

/**
 * @param {object} deps
 * @param {string} deps.workspace
 * @param {string} deps.project folder name
 * @param {{emit(project: string, events: object[]): object, log(project: string): {snapshot(): object}}} deps.server
 * @param {Record<string, object>} deps.backends name → AgentBackend
 * @param {{maxParallel?: number, now?: () => number, tickMs?: number, verifyNetwork?: boolean, fetch?: Function, lookup?: Function}} [deps.options]
 */
export function createProjectRuntime({ workspace, project, server, backends, options = {} }) {
  // The real path: sessions report absolute paths, and the permission rules compare against it.
  const dir = fs.realpathSync(path.join(workspace, project));
  const now = options.now ?? Date.now;
  const snapshot = () => server.log(project).snapshot();
  const emitMany = (events) => server.emit(project, events);
  const emit = (type, agentId, data = {}) => emitMany([{ type, agentId, ...(run && { runId: run.runId }), data }]);
  const broker = createBroker({ emit: emitMany, snapshot });

  /** @type {Map<string, {session: object, backend: string, compiled: object, lastEventAt: number}>} */
  const sessions = new Map();
  const remembered = new Set(); // "agent|tool|detail" the person allowed for the session
  let delegationCounters = {}; // uses so far per delegation rule (countKey)
  const personNotes = new Map(); // agentId → notes sent before the agent had a session
  let team = null;
  let env = null;
  let run = null; // the active run's state (also persisted in mas/run.json)
  let pool = semaphore(3);
  // One limit for the whole daemon (all projects), on top of the team's own.
  const shared = options.pool ?? { run: (fn) => fn() };
  let ticker = null;
  let closed = false;
  let starting = false; // between "may I start" and `run` being set: a second start must not slip in

  // ---- loading -----------------------------------------------------------------------------

  function loadEnv() {
    const mcp = readDocument(path.join(workspace, '.mcp')) ?? {};
    const commands = readDocument(path.join(workspace, 'home', 'commands')) ?? {};
    return {
      workspace,
      project: dir,
      home: os.homedir(),
      mcpServers: mcp.mcpServers ?? {},
      // home/commands.json: a list of command prefixes, or {"commands": [...]} (as `mas-office team` reads it)
      commands: (Array.isArray(commands) ? commands : Array.isArray(commands.commands) ? commands.commands : []).filter((c) => typeof c === 'string'),
      backends: Object.fromEntries(Object.keys(backends).map((name) => [name, true])),
    };
  }

  function loadTeam() {
    const structure = readDocument(path.join(dir, 'mas', 'structure'));
    if (!structure) throw new RunError('no_team', `No team design found in ${project}/mas/structure.json.`);
    if (structure.locked !== true) throw new RunError('not_locked', 'The team design is not locked yet. Lock it first.');
    if (structure.signature && !verifySignature(structure)) {
      throw new RunError('signature', 'The team design changed after it was locked. Lock it again to confirm the change.');
    }
    env = loadEnv();
    const { team: normal, problems } = normalizeTeam(structure, env);
    const errors = problems.filter((p) => p.level === 'error');
    if (errors.length) {
      throw new RunError('bad_team', `The team design has problems: ${errors.map((p) => `${p.path}: ${p.message}`).join('; ')}`);
    }
    for (const who of [normal.lead, ...normal.roles]) {
      const name = who.backend ?? 'claude-code';
      if (!backends[name]) throw new RunError('no_backend', `${who.name} needs the "${name}" backend, which is not available here.`);
    }
    team = normal;
    pool = semaphore(Math.max(1, Math.min(options.maxParallel ?? Infinity, team.budget?.maxParallel ?? 3)));
    return structure;
  }

  const roleOf = (id) => (id === 'lead' ? team.lead : team.roles.find((r) => r.id === id));
  const nameOf = (id) => roleOf(id)?.name ?? id;
  const compiledFor = (id) => (id === 'lead' ? compileLead(team, env) : compileRole(team, id, env));

  // ---- run state ---------------------------------------------------------------------------

  const runFile = path.join(dir, 'mas', 'run.json');
  const sessionsFile = path.join(dir, 'mas', 'sessions.json');
  const saveRun = () => { if (run) writeFileAtomic(runFile, `${JSON.stringify({ ...run, elapsedMs: now() - run.startedAt }, null, 2)}\n`); };
  const saveSessions = () => writeFileAtomic(sessionsFile, `${JSON.stringify(
    Object.fromEntries([...sessions].map(([id, s]) => [id, { backend: s.backend, sessionId: s.session.id }])), null, 2,
  )}\n`);
  const savedSessions = () => {
    try { return JSON.parse(fs.readFileSync(sessionsFile, 'utf8')); } catch { return {}; }
  };

  // ---- transcript --------------------------------------------------------------------------

  function transcript(agentId, entry) {
    if (!isValidAgentId(agentId)) return;
    const file = path.join(dir, 'mas', 'transcript', `${agentId}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(shortenHomeDeep({ ts: new Date(now()).toISOString(), ...entry }))}\n`);
  }

  // ---- asks: policy, delegation, inbox -----------------------------------------------------

  // "Always allow" means exactly this call again (same tool, same input), for this agent, in this run.
  const rememberKey = (agentId, subject) => `${agentId}|${subject.tool ?? subject.type}|${JSON.stringify([subject.command ?? null, subject.path ?? null, subject.paths ?? null, subject.input ?? null])}`;

  /**
   * A question from a session, made answerable in the inbox: one question with choices becomes
   * buttons; several questions are listed and answered in one line of text.
   */
  function presentQuestion(request) {
    const questions = (request.questions ?? []).filter((q) => q && typeof q.question === 'string');
    if (!questions.length) return request;
    const [first] = questions;
    const single = questions.length === 1;
    const options = single && Array.isArray(first.options)
      ? first.options.filter((o) => o && typeof o.label === 'string').map((o, i) => ({ optionId: `choice-${i}`, name: o.label, kind: 'choice' }))
      : [];
    return {
      ...request,
      title: single ? first.question : `${questions.length} questions`,
      description: single
        ? (first.options ?? []).filter((o) => o?.description).map((o) => `${o.label}: ${o.description}`).join('\n') || request.description
        : questions.map((q, i) => `${i + 1}. ${q.question}`).join('\n'),
      options: request.options?.length ? request.options : options,
      questions,
    };
  }

  function answerFrom(request, res) {
    const kind = res.option?.kind;
    if (request.kind === 'question') {
      const questions = request.questions ?? [];
      const text = res.outcome === 'selected' ? res.option?.name : typeof res.payload?.text === 'string' ? res.payload.text : null;
      if ((res.outcome === 'selected' || res.outcome === 'submitted') && text) {
        // One question: the answer belongs to it. Several: the text answers them together.
        return questions.length === 1
          ? { behavior: 'allow', optionId: res.optionId, answers: { [questions[0].question]: text }, message: text }
          : { behavior: 'allow', message: text };
      }
      if (res.outcome === 'expired') return { behavior: 'deny', message: 'Nobody answered in time. Decide yourself and write down the assumption you made.' };
      if (res.outcome === 'declined' || res.outcome === 'selected' || res.outcome === 'submitted') {
        return { behavior: 'deny', message: res.note ?? 'The person did not answer. Decide yourself and write down the assumption you made.' };
      }
      return { behavior: 'cancel' };
    }
    if (res.outcome === 'selected') {
      if (ALLOW.has(kind)) return { behavior: 'allow', optionId: res.optionId, remember: kind === 'allow_always', message: text1000(res.note) };
      return { behavior: 'deny', optionId: res.optionId, message: text1000(res.note) ?? 'The person said no.' };
    }
    if (res.outcome === 'submitted') {
      const text = typeof res.payload?.text === 'string' ? res.payload.text : JSON.stringify(res.payload ?? {});
      return { behavior: 'deny', message: `The person answered instead of approving: ${text}` };
    }
    if (res.outcome === 'declined') return { behavior: 'deny', message: text1000(res.note) ?? 'Declined.' };
    if (res.outcome === 'expired') return { behavior: 'deny', message: 'Nobody answered in time. Go on without it and note what you could not do.' };
    return { behavior: 'cancel' };
  }

  async function leadDecides(requestId, request, agentId) {
    const lead = sessions.get('lead');
    if (!lead || lead.busy || lead.side) return false;
    lead.side = true;
    try {
      const result = await lead.session.turn(delegatedDecisionPrompt(request, nameOf(agentId)));
      const choice = extractJson(result.text);
      // The Lead decides this one call; it never grants "always".
      const option = request.options.find((o) => o.optionId === choice?.optionId && o.kind !== 'allow_always' && o.kind !== 'reject_always');
      if (!result.ok || !option) return false;
      return broker.close(requestId, {
        outcome: 'selected', optionId: option.optionId, note: typeof choice.note === 'string' ? oneLine(choice.note, 200) : undefined,
        by: { kind: 'agent', id: 'lead' },
      });
    } catch {
      return false;
    } finally {
      lead.side = false;
    }
  }

  /** The single place a tool call or a question from a session is decided. */
  async function handleAsk(agentId, asked) {
    const request = asked.kind === 'question' ? presentQuestion(asked) : asked;
    const entry = sessions.get(agentId);
    const compiled = entry?.compiled ?? compiledFor(agentId);
    if (request.kind === 'approval') {
      const decision = decideTool(compiled, request.subject);
      if (decision.effect === 'allow') return { behavior: 'allow' };
      if (decision.effect === 'deny') {
        transcript(agentId, { kind: 'system', text: `Refused by the team design: ${request.title} (${decision.reason})` });
        return { behavior: 'deny', message: `Not allowed for your role: ${decision.reason}` };
      }
      if (remembered.has(rememberKey(agentId, request.subject))) return { behavior: 'allow' };
    } else {
      const limit = team.budget?.maxQuestionsPerRole ?? 3;
      const count = (run?.questions?.[agentId] ?? 0) + 1;
      if (run) { run.questions ??= {}; run.questions[agentId] = count; }
      if (count > limit) {
        emit('custom.question.refused', agentId, { title: oneLine(request.title, 160), limit });
        return { behavior: 'deny', message: 'You have used your questions for this run. Decide yourself, and write down the assumption you made.' };
      }
    }

    const data = {
      kind: request.kind,
      title: oneLine(request.title, 160),
      description: request.description,
      subject: shortenHomeDeep(request.subject),
      toolCallId: request.toolCallId,
      options: request.options,
      blocking: true,
      source: request.source,
      onExpire: `${nameOf(agentId)} waits for you. Nothing else is touched meanwhile.`,
      ...(request.questions && { questions: request.questions }),
    };
    if (request.subject?.humanOnly) data.resolver = 'human_only';
    const delegation = matchDelegation(team, { ...data, agentId }, delegationCounters, { project: dir, home: os.homedir() });
    const routeTo = delegation.effect === 'human' ? 'human' : 'lead';
    const { requestId, answer } = broker.open(agentId, { ...data, routeTo });
    transcript(agentId, { kind: 'request', requestId, title: data.title });

    if (delegation.effect === 'allow') {
      const option = request.options.find((o) => o.kind === 'allow_once') ?? request.options.find((o) => ALLOW.has(o.kind));
      if (option) {
        const key = delegation.key ?? countKey(delegation.rule);
        delegationCounters[key] = (delegationCounters[key] ?? 0) + 1;
        broker.close(requestId, { outcome: 'selected', optionId: option.optionId, by: { kind: 'policy', rule: delegation.reason } });
      } else {
        // Nothing here can be "allowed" (a question, say): a rule cannot answer it, the person must.
        broker.reroute(requestId, { routeTo: 'human' }, 'This needs an answer, not an approval.');
      }
    } else if (delegation.effect === 'lead') {
      leadDecides(requestId, request, agentId).then((decided) => {
        // The Lead did not decide (busy, unsure, or it chose to escalate): the person must.
        if (!decided) broker.reroute(requestId, { routeTo: 'human' }, 'The Lead passed this on to you.');
      }).catch(() => { broker.reroute(requestId, { routeTo: 'human' }, 'The Lead passed this on to you.'); });
    }

    const res = await answer;
    transcript(agentId, { kind: 'resolved', requestId, outcome: res.outcome, by: res.by?.kind ?? 'system' });
    const out = answerFrom(request, res);
    if (out.remember) remembered.add(rememberKey(agentId, request.subject));
    return out;
  }

  // ---- sessions ----------------------------------------------------------------------------

  async function ensureSession(agentId, { fresh = false } = {}) {
    const existing = sessions.get(agentId);
    if (existing && !fresh && existing.session.state !== 'closed') return existing;
    if (existing) await existing.session.close().catch(() => {});
    const who = roleOf(agentId);
    const backendName = who.backend ?? 'claude-code';
    const compiled = compiledFor(agentId);
    const saved = savedSessions()[agentId];
    const entry = { session: null, backend: backendName, compiled, lastEventAt: now(), busy: false };
    const sink = {
      event: (type, data = {}) => {
        entry.lastEventAt = now();
        emit(type, agentId, data);
      },
      transcript: (item) => {
        entry.lastEventAt = now();
        transcript(agentId, item);
      },
      ask: (request) => handleAsk(agentId, request),
      // The hard rules also cover calls the backend would run without asking (reads, harmless commands).
      precheck: (subject) => {
        const decision = decideTool(compiled, subject);
        if (decision.effect === 'deny') transcript(agentId, { kind: 'system', text: `Refused by the team design: ${decision.reason}` });
        return decision;
      },
      resolvedElsewhere: (toolCallId) => {
        const pending = snapshot().inbox?.pending ?? [];
        for (const r of pending) {
          if (r.agentId === agentId && r.toolCallId === toolCallId) broker.close(r.requestId, { outcome: 'superseded', by: { kind: 'terminal' } });
        }
      },
    };
    entry.session = await backends[backendName].start({
      agentId,
      cwd: dir,
      systemPrompt: compiled.systemPrompt,
      compiled,
      model: who.model ?? undefined,
      resume: !fresh && saved?.backend === backendName ? saved.sessionId : undefined,
    }, sink);
    sessions.set(agentId, entry);
    saveSessions();
    return entry;
  }

  /** One turn with the turn budget: time spent waiting for a person does not count. */
  async function turn(agentId, text, { fresh = false } = {}) {
    let entry;
    try {
      entry = await ensureSession(agentId, { fresh });
    } catch (err) {
      return { ok: false, text: '', stopReason: 'error', error: `Could not start the session: ${err.message}` };
    }
    transcript(agentId, { kind: 'user', text, origin: agentId === 'lead' ? 'system' : 'lead' });
    const minutes = team.budget?.maxTurnMinutes ?? 20;
    const budgetMs = minutes * 60_000;
    let active = 0;
    let timedOut = false;
    const clock = setInterval(() => {
      if (broker.countFor(agentId) === 0) active += 1000;
      if (active >= budgetMs && !timedOut) {
        timedOut = true;
        entry.session.interrupt().catch(() => {});
      }
    }, 1000);
    clock.unref?.();
    entry.busy = true;
    try {
      const result = await entry.session.turn(text);
      return timedOut ? { ...result, ok: false, stopReason: 'error', error: `Stopped after ${minutes} minutes (turn budget).` } : result;
    } catch (err) {
      return { ok: false, text: '', stopReason: 'error', error: err.message };
    } finally {
      entry.busy = false;
      clearInterval(clock);
    }
  }

  async function leadJson(prompt) {
    const result = await turn('lead', prompt);
    // The person stopped the Lead itself: that stops the run, not just this turn.
    if (result.stopReason === 'cancelled' && run && run.stoppedBy.lead) {
      emit('agent.stopped', 'lead', { reason: 'Stopped', scope: 'turn', by: run.stoppedBy.lead });
      run.stopping = 'Stopped by you';
    }
    return { result, json: result.ok ? extractJson(result.text) : null };
  }

  // ---- requests the engine itself opens ----------------------------------------------------

  async function askPerson(agentId, { kind, title, description, options, subject, urgency, onExpire }) {
    const { answer } = broker.open(agentId, {
      kind, title, description, subject, options, urgency, onExpire, blocking: true, routeTo: 'human', resolver: 'human_only',
      source: { backend: 'mas-office', raw: kind },
    });
    return answer;
  }

  const choice = (optionId, name, kind = 'choice') => ({ optionId, name, kind });

  // ---- running roles -----------------------------------------------------------------------

  const workFile = (id, round) => (round > 1 ? `outputs/work/${id}-round${round}.md` : `outputs/work/${id}.md`);
  const doneLine = (text) => /(?:^|\n)\s*DONE:\s*(.+)\s*$/i.exec(text ?? '')?.[1];

  function inputsFor(role) {
    const upstream = team.roles.filter((r) => r.handsTo === role.id || (role.reviewerOf ?? []).includes(r.id));
    return upstream.flatMap((r) => [workFile(r.id, 1), ...(run.round > 1 ? [workFile(r.id, run.round)] : [])])
      .filter((f) => fs.existsSync(path.join(dir, f)));
  }

  const takeNotes = (id) => {
    const notes = personNotes.get(id) ?? [];
    personNotes.delete(id);
    return notes;
  };

  /** Run one role's task. Returns `{ok, summary, stopped?}`. */
  async function runRole(role, { brief, attempt = 1, note, kind = 'work', prompt, fresh = false }) {
    const taskId = `${run.runId}-${role.id}${run.round > 1 ? `-r${run.round}` : ''}${kind === 'work' ? '' : `-${kind}`}`;
    emit('task.assigned', role.id, { taskId, title: oneLine(brief, 140), brief, round: run.round, attempt });
    const notes = prompt ? [] : takeNotes(role.id);
    const text = prompt ?? roleBrief({
      role, task: run.task, brief, inputs: inputsFor(role), attempt, note, round: run.round, personNotes: notes,
    });
    // A role that was still queued when the run was stopped never starts its turn.
    const result = await pool.run(() => shared.run(() => {
      if (run?.stopping || closed) return { ok: false, text: '', stopReason: 'cancelled' };
      emit('task.updated', role.id, { taskId, state: 'working' });
      return turn(role.id, text, { fresh });
    }));
    if (!run) return { ok: false, stopped: true, text: '' };
    if (result.stopReason === 'cancelled') {
      emit('agent.stopped', role.id, { reason: 'Stopped', scope: 'turn', by: run.stoppedBy?.[role.id] ?? { kind: 'system' } });
      emit('task.finished', role.id, { taskId, outcome: 'cancelled' });
      return { ok: false, stopped: true, text: result.text };
    }
    if (!result.ok) {
      emit('task.finished', role.id, { taskId, outcome: 'failed', summary: oneLine(result.error ?? 'Failed', 200) });
      return { ok: false, error: result.error ?? 'The turn failed.', text: result.text };
    }
    const summary = oneLine(doneLine(result.text) ?? result.text, 200);
    emit('task.finished', role.id, { taskId, outcome: 'success', summary: kind === 'work' ? summary : `Finished: ${oneLine(brief, 120)}` });
    // A reviewer's turn ends in a JSON block; its summary is written from the verdicts instead.
    if (kind === 'work') run.summaries[role.id] = summary;
    return { ok: true, summary, text: result.text };
  }

  /** A role's work with recovery: one automatic retry, then the person decides. */
  async function runRoleWithRecovery(role, args) {
    let attempt = args.attempt ?? 1;
    let failures = 0;
    for (;;) {
      const result = await runRole(role, { ...args, attempt });
      if (result.ok) return result;
      if (closed || run.stopping) return result;
      if (result.stopped && run.autoRetry[role.id]) {
        // The engine stopped it after a stall: that is a retry, not a decision for the person.
        delete run.autoRetry[role.id];
        attempt += 1;
        continue;
      }
      if (!result.stopped) {
        failures += 1;
        if (failures === 1) {
          emit('recovery.chosen', 'lead', { strategy: 'retry', target: role.id, note: oneLine(result.error, 160) });
          attempt += 1;
          continue;
        }
        emit('agent.failed', role.id, { reason: oneLine(result.error, 120) });
      }
      emit('recovery.chosen', 'lead', { strategy: 'ask-human', target: role.id });
      const res = await askPerson(role.id, {
        kind: 'decision',
        title: result.stopped ? `You stopped ${role.name}. What now?` : `${role.name} failed twice. What now?`,
        description: result.stopped ? undefined : oneLine(result.error, 300),
        options: [choice('retry', 'Try again'), choice('skip', 'Go on without this role'), choice('stop', 'Stop the run')],
        onExpire: 'The run waits here.',
      });
      if (res.outcome === 'selected' && res.optionId === 'retry') {
        attempt += 1;
        args = { ...args, note: res.note ?? args.note };
        continue;
      }
      if (res.outcome === 'submitted' && typeof res.payload?.text === 'string') {
        attempt += 1;
        args = { ...args, note: `The person says: ${res.payload.text}` };
        continue;
      }
      if (res.outcome === 'selected' && res.optionId === 'skip') return { ok: false, skipped: true };
      run.stopping = 'Stopped by you';
      return { ok: false };
    }
  }

  function handOver(role) {
    const to = role.handsTo && (role.handsTo === 'lead' || roleOf(role.handsTo)) ? role.handsTo : 'lead';
    emit('handoff', role.id, { to });
  }

  /** A reviewer's loop over its targets: accept, send back (bounded), or put it to the person. */
  async function runReviewer(role) {
    const targets = (role.reviewerOf ?? []).filter((id) => run.done.includes(id) && run.scope.includes(id));
    if (!targets.length) return true;
    const maxRounds = Math.min(5, Math.max(1, role.review?.maxRounds ?? 2));
    let pending = targets;
    for (let round = 1; pending.length && !run.stopping; round += 1) {
      const result = await runRoleWithRecovery(role, {
        brief: `Review the work of ${pending.map(nameOf).join(', ')}`,
        kind: `review${round}`,
        prompt: reviewBrief({ role, task: run.task, targets: pending, round, files: pending.flatMap((t) => [workFile(t, 1), ...(run.round > 1 ? [workFile(t, run.round)] : [])]).filter((f) => fs.existsSync(path.join(dir, f))), notes: takeNotes(role.id), checkerRules: checkerRules({ targets: pending, maxSteps: 5 }) }),
      });
      if (!result.ok) return false;
      const parsed = parseReviewBlock(result.text);
      const verdicts = new Map(parsed.reviews.filter((r) => pending.includes(r.target)).map((r) => [r.target, r]));
      const events = [];
      for (const target of pending) {
        // A reviewer that says nothing about a target has not accepted it.
        const v = verdicts.get(target) ?? { target, verdict: 'escalate', note: 'The reviewer gave no verdict for this role.' };
        events.push({ type: 'review.verdict', agentId: role.id, runId: run.runId, data: { target, verdict: v.verdict, round, ...(v.note && { note: v.note }) } });
        run.reviews.push(`${role.name} on ${nameOf(target)} (round ${round}): ${v.verdict}${v.note ? ` — ${v.note}` : ''}`);
        verdicts.set(target, v);
      }
      emitMany(events);
      const counts = [...verdicts.values()].reduce((acc, v) => ({ ...acc, [v.verdict]: (acc[v.verdict] ?? 0) + 1 }), {});
      run.summaries[role.id] = `Reviewed ${targets.map(nameOf).join(', ')}: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ')} (round ${round})`;

      const sendBack = [];
      for (const target of pending) {
        const v = verdicts.get(target);
        if (v.verdict === 'accept') continue;
        if (v.verdict === 'revise' && round < maxRounds) {
          sendBack.push(target);
          continue;
        }
        // Past the rounds, or the reviewer escalated: never a silent accept.
        emit('flag.raised', role.id, { text: `${nameOf(target)}: ${v.note ?? v.verdict}`, kind: 'concern' });
        const res = await askPerson(role.id, {
          kind: 'flag',
          title: v.verdict === 'escalate'
            ? `${role.name} cannot settle ${nameOf(target)}'s work`
            : `${role.name} still rejects ${nameOf(target)}'s work after ${round} round${round === 1 ? '' : 's'}`,
          description: v.note,
          subject: { type: 'review', reviewer: role.id, target, round },
          options: [choice('accept', 'Accept it as it is'), choice('again', 'Send it back once more'), choice('stop', 'Stop the run')],
          onExpire: 'The run waits here; nothing is accepted without you.',
        });
        emit('flag.resolved', role.id);
        if (res.outcome === 'selected' && res.optionId === 'again') sendBack.push(target);
        else if (res.outcome === 'submitted' && typeof res.payload?.text === 'string') {
          verdicts.set(target, { ...v, note: `${v.note ?? ''}\nThe person adds: ${res.payload.text}`.trim() });
          sendBack.push(target);
        } else if (!(res.outcome === 'selected' && res.optionId === 'accept')) {
          run.stopping = 'Stopped by you';
          return false;
        }
      }
      if (!sendBack.length) break;
      await Promise.all(sendBack.map(async (target) => {
        const targetRole = roleOf(target);
        const attempt = (run.attempts[target] = (run.attempts[target] ?? 1) + 1);
        const redo = await runRoleWithRecovery(targetRole, { brief: run.briefs[target], attempt, note: verdicts.get(target).note });
        if (redo.ok) handOver(targetRole);
      }));
      pending = sendBack;
    }
    return !run.stopping;
  }

  async function runGate(gate, stageRoles) {
    for (let revision = 0; revision <= MAX_GATE_REVISIONS; revision += 1) {
      const files = stageRoles.map((r) => workFile(r.id, run.round)).filter((f) => fs.existsSync(path.join(dir, f)));
      if (gate.blocking === false) {
        emit('custom.gate.passed', 'lead', { gate: gate.id, audit: true });
        return true;
      }
      const res = await askPerson('lead', {
        kind: 'gate',
        title: gate.title ?? 'Checkpoint',
        description: files.length ? `Look at: ${files.join(', ')}. Reply with a note to send the stage back with your comments.` : undefined,
        subject: { type: 'stage', gate: gate.id, after: gate.after ?? null, files },
        options: [choice('accept', 'Looks good, continue', 'allow_once'), choice('stop', 'Stop the run', 'reject_once')],
        onExpire: 'The next stage does not start until you answer.',
      });
      if (res.outcome === 'selected' && res.optionId === 'accept') return true;
      if (res.outcome === 'submitted' && typeof res.payload?.text === 'string' && revision < MAX_GATE_REVISIONS && stageRoles.length) {
        const noteText = res.payload.text;
        run.gateNotes.push(`${gate.title ?? gate.id}: ${noteText}`);
        // Workers redo their part with the note; their reviewers then review the new work.
        await Promise.all(stageRoles.filter((r) => !(r.reviewerOf ?? []).length).map(async (role) => {
          const attempt = (run.attempts[role.id] = (run.attempts[role.id] ?? 1) + 1);
          const redo = await runRoleWithRecovery(role, { brief: run.briefs[role.id], attempt, note: `The person, at the checkpoint: ${noteText}` });
          if (redo.ok) handOver(role);
        }));
        for (const reviewer of stageRoles.filter((r) => (r.reviewerOf ?? []).length)) {
          if (!run.stopping) await runReviewer(reviewer);
        }
        if (run.stopping) return false;
        continue;
      }
      if (res.outcome === 'submitted' && typeof res.payload?.text === 'string') {
        run.gateNotes.push(`${gate.title ?? gate.id}: ${res.payload.text}`);
        return true;
      }
      run.stopping = 'Stopped by you';
      return false;
    }
    return true;
  }

  // `stageOrder` leaves out empty stages, so the group comes from the roles, not from the index.
  const stageOf = (stageRoleIds) => (team.groups ?? []).find((g) => g.id === roleOf(stageRoleIds[0])?.group);

  async function runStage(stageRoleIds) {
    const stage = stageOf(stageRoleIds);
    if (stage) emit('stage.started', 'lead', { group: stage.id });
    const todo = stageRoleIds.map(roleOf).filter((r) => r && !run.done.includes(r.id) && !run.skipped.includes(r.id));
    const workers = todo.filter((r) => !(r.reviewerOf ?? []).length);
    const reviewers = todo.filter((r) => (r.reviewerOf ?? []).length);

    await Promise.all(workers.map(async (role) => {
      const result = await runRoleWithRecovery(role, { brief: run.briefs[role.id], attempt: run.attempts[role.id] ?? 1, fresh: run.round > 1 });
      if (result.ok) {
        run.done.push(role.id);
        handOver(role);
      } else if (result.skipped) run.skipped.push(role.id);
      saveRun();
    }));
    if (run.stopping) return;

    await Promise.all(reviewers.map(async (role) => {
      if (await runReviewer(role)) {
        run.done.push(role.id);
        handOver(role);
      } else if (!run.stopping) run.skipped.push(role.id);
      saveRun();
    }));
    if (run.stopping) return;

    emitMany(todo.filter((r) => run.done.includes(r.id)).map((r) => ({
      type: 'agent.finished', agentId: r.id, runId: run.runId, data: { say: oneLine(run.summaries[r.id] ?? 'Done', 60) },
    })));
    if (stage) emit('stage.finished', 'lead', { group: stage.id });
    // Checkpoints belong to the run's first pass; a follow-up round only has the final one.
    const gate = stage && run.round === 1 && (team.gates ?? []).find((g) => g.kind !== 'final' && g.kind !== 'plan' && g.after === stage.id);
    if (gate && todo.length) await runGate(gate, todo.filter((r) => run.done.includes(r.id)));
  }

  // ---- the Lead's turns --------------------------------------------------------------------

  async function plan() {
    emit('agent.status', 'lead', { state: 'working', say: 'Briefing the team' });
    const { json } = await leadJson(planPrompt(team, run.task));
    const briefs = {};
    for (const role of team.roles) {
      const given = json?.briefs?.[role.id];
      // No usable brief from the Lead: the role's own job description is the brief.
      briefs[role.id] = typeof given === 'string' && given.trim() ? given.trim().slice(0, 4000) : (role.job || `Do your part for: ${run.task.title}`);
    }
    run.briefs = briefs;
    const steps = Array.isArray(json?.plan) ? json.plan.filter((s) => typeof s === 'string').map((s) => oneLine(s, 160)).slice(0, 12) : [];
    emit('lead.ledger', 'lead', {
      satisfied: false, progressing: true, looping: false, plan: steps, stalls: 0,
      next: stageOf(stageOrder(team)[0] ?? [])?.label ?? 'Start', ...(json ? {} : { reason: 'The Lead gave no usable plan; roles start from their job descriptions.' }),
    });
    saveRun();
    const gate = (team.gates ?? []).find((g) => g.kind === 'plan');
    if (gate && !run.stopping) {
      const res = await askPerson('lead', {
        kind: 'gate',
        title: gate.title ?? 'Approve the plan',
        description: Object.entries(briefs).map(([id, b]) => `${nameOf(id)}: ${b}`).join('\n'),
        subject: { type: 'plan', gate: gate.id, plan: steps, briefs },
        options: [choice('accept', 'Start', 'allow_once'), choice('stop', 'Stop', 'reject_once')],
        onExpire: 'Nobody starts until you answer.',
      });
      if (res.outcome === 'submitted' && typeof res.payload?.text === 'string') run.gateNotes.push(`On the plan: ${res.payload.text}`);
      else if (!(res.outcome === 'selected' && res.optionId === 'accept')) run.stopping = 'Stopped by you';
    }
  }

  function resultSources(cards) {
    return cards.map((c) => ({
      id: c.id, title: c.title ?? c.id, ...(c.url && { url: c.url }), ...(c.evidence && { evidence: c.evidence }), ...(c.foundBy && { foundBy: c.foundBy }),
    }));
  }

  /** Claims, link health, reviewer verdicts; returns the markdown to publish and whether to go on. */
  async function verify(markdown, cards) {
    const settings = team.verify ?? {};
    if (settings.claims === false) return true;
    const { claims } = parseClaims(markdown);
    let evidence = [];
    let perClaim = {};
    if (claims.length) emitMany(claimEvents(claims).map((e) => ({ ...e, agentId: 'lead', runId: run.runId })));

    if (settings.urlHealth !== false && cards.length) {
      emit('agent.status', 'lead', { state: 'working', say: `Checking ${cards.length} source link${cards.length === 1 ? '' : 's'}` });
      // Deterministic code, not a model: a link is live, dead, archived or blocked.
      const checked = await checkSources(cards, {
        network: options.verifyNetwork !== false, ...(options.fetch && { fetch: options.fetch }), ...(options.lookup && { lookup: options.lookup }),
      });
      const events = evidenceEvents(checked).map((e) => ({ ...e, agentId: 'lead', runId: run.runId }));
      if (events.length) emitMany(events);
      evidence = checked;
    }

    const checkers = team.roles.filter((r) => (r.reviewerOf ?? []).length && !run.skipped.includes(r.id));
    if (claims.length && checkers.length) {
      const lanes = await Promise.all(checkers.map(async (role) => {
        const result = await runRole(role, {
          brief: `Check the ${claims.length} claims in the answer`,
          kind: `claims${run.round}`,
          prompt: claimCheckBrief({ answerFile: ANSWER_FILE, claims, notes: takeNotes(role.id), checkerRules: checkerRules({ targets: ['lead'], maxSteps: 5 }) }),
        });
        if (!result.ok) return null;
        const parsed = parseReviewBlock(result.text);
        const events = verdictEvents(parsed, { backend: role.backend ?? 'claude-code' })
          .map((e) => ({ ...e, agentId: role.id, runId: run.runId }));
        if (events.length) emitMany(events);
        return { by: role.id, backend: role.backend ?? 'claude-code', claims: parsed.claims };
      }));
      const merged = mergeLanes(lanes.filter(Boolean));
      for (const d of merged.disagreements) run.reviews.push(d.note);
      perClaim = merged.perClaim;
    }

    // The decision rests on what the engine itself parsed, fetched and was told by the checkers'
    // sessions, never on the log: anything able to append to the log could otherwise vouch for itself.
    if (!claims.length && !evidence.length) return true;
    const summary = summarize(claims.map((c) => ({ ...c, checkworthy: perClaim[c.claimId]?.status !== 'not-checkworthy', status: perClaim[c.claimId]?.status ?? 'unchecked' })), evidence);
    const verdict = shouldFlag(summary, settings.flagWhen ?? {});
    if (!verdict.flag) return true;
    emit('flag.raised', 'lead', { text: verdict.reasons.join(' '), kind: 'concern' });
    const res = await askPerson('lead', {
      kind: 'flag',
      title: 'The answer has claims that did not check out',
      description: verdict.reasons.join('\n'),
      subject: { type: 'claim', summary },
      options: [choice('publish', 'Show me the answer with the warnings'), choice('fix', 'Send it back to the Lead to fix'), choice('stop', 'Stop the run')],
      onExpire: 'The answer is held back until you decide.',
    });
    emit('flag.resolved', 'lead');
    if (res.outcome === 'selected' && res.optionId === 'publish') return true;
    if (res.outcome === 'selected' && res.optionId === 'fix') return 'fix';
    if (res.outcome === 'submitted' && typeof res.payload?.text === 'string') {
      run.gateNotes.push(`On the checked answer: ${res.payload.text}`);
      return 'fix';
    }
    run.stopping = 'Stopped by you';
    return false;
  }

  async function writeUp() {
    for (let pass = 1; pass <= 2 && !run.stopping; pass += 1) {
      emit('agent.status', 'lead', { state: 'working', say: pass === 1 ? 'Writing the answer' : 'Fixing the answer' });
      const cards = readSourceCards(dir);
      const workFiles = [...run.done, ...team.roles.map((r) => r.id).filter((id) => !run.done.includes(id))]
        .flatMap((id) => [workFile(id, 1), ...(run.round > 1 ? [workFile(id, run.round)] : [])])
        .filter((f) => fs.existsSync(path.join(dir, f)));
      // The previous answer steps aside, so what is published is what the Lead writes now.
      const answerPath = path.join(dir, ANSWER_FILE);
      try {
        if (fs.lstatSync(answerPath)) fs.renameSync(answerPath, path.join(dir, 'outputs', `result.previous.md`));
      } catch { /* no earlier answer */ }
      const warnings = pass === 2 ? [...run.reviews, 'Fix or remove every claim the checkers did not support, and every dead link.'] : run.reviews;
      const { result, json } = await leadJson(writeupPrompt({
        task: run.task, answerFile: ANSWER_FILE, workFiles, sourceIds: cards.map((c) => c.id), reviews: warnings,
        gateNotes: run.gateNotes, writeupRules: leadWriteupRules(), round: run.round,
      }));
      if (!result.ok) {
        run.failure = `The Lead could not write the answer: ${result.error ?? result.stopReason}`;
        return null;
      }
      // The file is the answer. A Lead that only replied in chat still has its text used.
      const markdown = readText(answerPath) ?? result.text.replace(/```json[\s\S]*?```\s*$/, '').trim();
      if (!markdown) {
        run.failure = 'The Lead wrote no answer.';
        return null;
      }
      const verdict = await verify(markdown, cards);
      if (verdict === false) return null;
      if (verdict === 'fix' && pass === 1) continue;
      if (verdict === 'fix') {
        // Sent back twice and still not right: that is a failed run, not a published answer.
        run.failure = 'The answer still had unsupported claims after one more pass.';
        return null;
      }
      return {
        markdown,
        title: typeof json?.title === 'string' && json.title.trim() ? oneLine(json.title, 120) : undefined,
        next: typeof json?.next === 'string' ? oneLine(json.next, 200) : undefined,
        satisfied: json?.satisfied === true,
        sources: resultSources(cards),
      };
    }
    return null;
  }

  // ---- stall detection ---------------------------------------------------------------------

  async function onStall(agentId, entry, minutes) {
    if (!run) return;
    const role = roleOf(agentId);
    const count = (run.stalls[agentId] = (run.stalls[agentId] ?? 0) + 1);
    const lastSay = snapshot().statuses?.[agentId]?.say ?? '';
    emit('lead.ledger', 'lead', {
      satisfied: false, progressing: false, looping: false, stalls: count,
      next: role.id, instruction: `${role.name} has been quiet for ${minutes} min`,
    });
    entry.lastEventAt = now();
    if (count === 1) {
      const sent = await entry.session.send(NUDGE, 'steer').catch((err) => ({ status: 'rejected', reason: err.message }));
      transcript(agentId, { kind: 'command', text: NUDGE, delivery: 'steer', status: sent.status, origin: 'system' });
      return;
    }
    if (count === 2) {
      let strategy = 'retry';
      const lead = sessions.get('lead');
      if (lead && !lead.busy && !lead.side) {
        lead.side = true;
        try {
          const result = await lead.session.turn(recoveryPrompt({ role, minutes, lastSay, strategies: ['retry', 'replan', 'ask-human'] }));
          const json = extractJson(result.text);
          if (!run) return;
          if (['retry', 'replan', 'ask-human'].includes(json?.strategy)) strategy = json.strategy;
          if (strategy === 'replan' && typeof json?.brief === 'string' && json.brief.trim()) run.briefs[agentId] = json.brief.trim();
        } catch { /* keep the default */ } finally { lead.side = false; }
      }
      if (strategy !== 'ask-human') {
        // Interrupting makes the role's turn fail; runRoleWithRecovery then retries with the brief.
        emit('recovery.chosen', 'lead', { strategy, target: agentId, note: `No progress for ${minutes} min` });
        run.autoRetry[agentId] = true;
        await entry.session.interrupt().catch(() => {});
        return;
      }
    }
    emit('recovery.chosen', 'lead', { strategy: 'ask-human', target: agentId });
    const res = await askPerson(agentId, {
      kind: 'decision',
      title: `${role.name} seems stuck`,
      description: `No progress for ${minutes} minutes. Last line: "${lastSay}"`,
      options: [choice('wait', 'Let it go on'), choice('interrupt', 'Stop it')],
      urgency: 'high',
      onExpire: 'It keeps running and keeps using your plan.',
    });
    if (!run) return;
    if (res.outcome === 'selected' && res.optionId === 'interrupt') {
      run.stoppedBy[agentId] = { kind: 'human' };
      await entry.session.interrupt().catch(() => {});
    } else {
      run.stalls[agentId] = 0;
    }
  }

  function tick() {
    if (!run || closed) return;
    const stallMs = (team.budget?.stallMinutes ?? 5) * 60_000;
    for (const [agentId, entry] of sessions) {
      if (agentId === 'lead' || !entry.busy || entry.stallCheck) continue;
      // Waiting for a person is not a stall.
      if (broker.countFor(agentId)) { entry.lastEventAt = now(); continue; }
      const quiet = now() - entry.lastEventAt;
      if (quiet < stallMs) continue;
      entry.stallCheck = true;
      onStall(agentId, entry, Math.round(quiet / 60_000)).catch(() => {}).finally(() => { entry.stallCheck = false; });
    }
    const limit = (team.budget?.maxRunMinutes ?? 90) * 60_000;
    if (!run.stopping && now() - run.startedAt > limit) {
      run.stopping = `Stopped after ${team.budget?.maxRunMinutes ?? 90} minutes (run budget)`;
      for (const entry of sessions.values()) if (entry.busy) entry.session.interrupt().catch(() => {});
      broker.cancelAll();
    }
  }

  // ---- a run -------------------------------------------------------------------------------

  async function execute() {
    ticker = setInterval(tick, options.tickMs ?? TICK_MS);
    ticker.unref?.();
    try {
      await ensureSession('lead');
      if (!run.planned) {
        await plan();
        run.planned = true;
        saveRun();
      }
      const stages = stageOrder(team);
      for (let i = run.stage; i < stages.length && !run.stopping; i += 1) {
        emit('lead.ledger', 'lead', {
          satisfied: false, progressing: true, looping: false, stalls: 0,
          next: stageOf(stages[i])?.label ?? `Stage ${i + 1}`,
        });
        await runStage(stages[i]);
        if (!run.stopping) run.stage = i + 1;
        saveRun();
      }
      const answer = run.stopping ? null : await writeUp();
      if (!answer) {
        emit('run.failed', 'lead', { reason: oneLine(run.failure ?? run.stopping ?? 'The run did not produce an answer.', 120) });
        return;
      }
      const final = (team.gates ?? []).find((g) => g.kind === 'final');
      // A checker's last turn (the claim check) left it idle; everyone who did their part is done.
      const statuses = snapshot().statuses ?? {};
      const settle = run.done.filter((id) => statuses[id] && statuses[id].state !== 'done');
      if (settle.length) {
        emitMany(settle.map((id) => ({ type: 'agent.finished', agentId: id, runId: run.runId, data: { say: oneLine(run.summaries[id] ?? 'Done', 60) } })));
      }
      emit('result', 'lead', {
        ...(answer.title && { title: answer.title }),
        markdown: answer.markdown,
        sources: answer.sources,
        work: Object.entries(run.summaries).map(([by, summary]) => ({ by, summary })),
        ...(run.round > 1 && { round: run.round, question: run.task.question }),
      });
      emit('lead.ledger', 'lead', { satisfied: answer.satisfied, progressing: true, looping: false, stalls: 0, ...(answer.next && { next: answer.next }) });
      if (final && final.blocking !== false) {
        const res = await askPerson('lead', {
          kind: 'gate',
          title: final.title ?? 'Approve the answer',
          subject: { type: 'stage', gate: final.id, after: null, files: [ANSWER_FILE] },
          options: [choice('accept', 'Approve', 'allow_once'), choice('stop', 'Reject', 'reject_once')],
          onExpire: 'The answer stays marked as not approved.',
        });
        if (!(res.outcome === 'selected' && res.optionId === 'accept')) {
          const why = res.by?.kind === 'human' ? (res.note ? oneLine(`Not approved: ${res.note}`, 120) : 'Not approved by you') : 'Stopped before the answer was approved';
          emit('run.failed', 'lead', { reason: why });
          return;
        }
      }
      emit('run.finished', 'lead', { say: 'Result ready' });
    } catch (err) {
      emit('run.failed', 'lead', { reason: oneLine(`Engine error: ${err.message}`, 120) });
      throw err;
    } finally {
      clearInterval(ticker);
      ticker = null;
      broker.cancelAll();
      fs.rmSync(runFile, { force: true });
      run = null;
    }
  }

  function newRunState(task, round = 1) {
    return {
      runId: shortId('run'), task, round, startedAt: now(), planned: false, stage: 0,
      briefs: {}, done: [], skipped: [], attempts: {}, summaries: {}, reviews: [], gateNotes: [], stalls: {}, stoppedBy: {}, autoRetry: {}, questions: {},
      scope: team.roles.map((r) => r.id),
      stopping: null, failure: null,
    };
  }

  function taskFrom(text) {
    const saved = readDocument(path.join(dir, 'me', 'task'));
    if (!text && saved) return saved;
    const title = oneLine(text.split('\n')[0], 80);
    return saved?.requirements ? { ...saved, title, summary: text } : { title, summary: text };
  }

  // ---- public ------------------------------------------------------------------------------

  return {
    get active() { return run !== null; },
    /** Is someone in this daemon still waiting for an answer to this request? */
    waitsOn: (requestId) => broker.has(requestId),
    get team() { return team; },

    /** Start a run of the locked team, or a follow-up round on its last result. */
    async startRun({ task, followUp } = {}) {
      if (run || starting) throw new RunError('busy', 'This team is already working. Wait for it or stop it first.');
      const structure = loadTeam();
      if (followUp) return this.startFollowUp(followUp);
      const described = taskFrom(task ?? '');
      if (!described.title && !described.summary) throw new RunError('no_task', 'Give the team a task first.');
      // A new run starts from clean contexts: nothing carries over from an earlier task.
      starting = true;
      try {
        await Promise.all([...sessions.values()].map((e) => e.session.close().catch(() => {})));
      } finally {
        starting = false;
      }
      sessions.clear();
      fs.rmSync(sessionsFile, { force: true });
      remembered.clear();
      delegationCounters = {};
      run = newRunState(described);
      emitMany([
        { type: 'run.started', agentId: 'lead', runId: run.runId, data: { title: structure.title ?? run.task.title, structure } },
        ...[team.lead, ...team.roles].map((who) => ({
          type: 'agent.registered', agentId: who.id, runId: run.runId,
          data: {
            backend: who.backend ?? 'claude-code', accepts: ['message', 'interrupt'],
            ...(who.model && { model: who.model }), ...(who.reviewerOf?.length && { reviewerOf: who.reviewerOf }),
          },
        })),
      ]);
      saveRun();
      const finished = execute();
      finished.catch(() => {});
      return { runId: run.runId, finished };
    },

    /**
     * A follow-up round on the last answer: the Lead decides whether the files already answer it
     * or which roles go back to work (a reviewer comes along with its target). Same run, next round.
     */
    startFollowUp(question) {
      const snap = snapshot();
      if (!snap.result) throw new RunError('no_result', 'There is no answer yet to follow up on.');
      const round = (snap.result.round ?? 1) + 1;
      run = newRunState({ ...taskFrom(''), question }, round);
      run.runId = snap.state.runId ?? run.runId;
      run.planned = true;
      run.scope = [];
      run.done = team.roles.map((r) => r.id);
      emit('round.started', 'lead', { round, question });
      const finished = (async () => {
        try {
          // A design re-locked since the last round: no session keeps its old rules.
          const stale = [...sessions].filter(([id, e]) => !roleOf(id) || JSON.stringify(e.compiled) !== JSON.stringify(compiledFor(id)));
          await Promise.all(stale.map(([id, e]) => { sessions.delete(id); return e.session.close().catch(() => {}); }));
          await ensureSession('lead');
          const workFiles = team.roles.map((r) => workFile(r.id, 1)).filter((f) => fs.existsSync(path.join(dir, f)));
          const { json } = await leadJson(followUpPrompt(team, question, [ANSWER_FILE, ...workFiles]));
          const wanted = new Set((Array.isArray(json?.dispatch) ? json.dispatch : []).filter((id) => id !== 'lead' && roleOf(id)));
          for (const role of team.roles) if ((role.reviewerOf ?? []).some((t) => wanted.has(t))) wanted.add(role.id);
          run.scope = [...wanted];
          run.done = team.roles.map((r) => r.id).filter((id) => !wanted.has(id));
          for (const id of wanted) {
            const given = json?.briefs?.[id];
            run.briefs[id] = typeof given === 'string' && given.trim() ? given.trim() : `Help answer the follow-up: ${question}`;
          }
          emit('lead.ledger', 'lead', {
            satisfied: false, progressing: true, looping: false, stalls: 0,
            next: wanted.size ? `Sending back: ${[...wanted].map(nameOf).join(', ')}` : 'Answering from what the team already found',
            ...(typeof json?.reason === 'string' && { reason: oneLine(json.reason, 200) }),
          });
        } catch (err) {
          run.failure = `The Lead could not read the follow-up: ${err.message}`;
          run.stopping = run.failure;
        }
        return execute();
      })();
      finished.catch(() => {});
      return { runId: run.runId, round, finished };
    },

    /** A command from the panel (origin human) or from the Lead. Always ends in an ack. */
    async handleCommand(event) {
      const { agentId, type, data } = event;
      const ack = (status, reason) => emit('command.ack', agentId, { cmdId: data.cmdId, status, ...(reason && { reason }) });
      try {
        if (type === 'command.respond') {
          const outcome = broker.respond(event);
          return ack(outcome.status, outcome.reason);
        }
        if (!team) loadTeam();
        if (!roleOf(agentId)) return ack('rejected', 'unknown_agent');
        const entry = sessions.get(agentId);
        if (type === 'command.interrupt') {
          if (!entry || (!entry.busy && entry.session.state !== 'running')) return ack('rejected', 'not_running');
          if (run) run.stoppedBy[agentId] = data.origin ?? { kind: 'human' };
          ack('accepted');
          await entry.session.interrupt();
          // The stop is a fact only once the session reports it (the turn resolves as cancelled).
          return ack('applied', 'The agent was told to stop.');
        }
        if (type === 'command.message') {
          const delivery = data.delivery ?? 'steer';
          if (!entry || entry.session.state === 'closed') {
            if (run && !run.done.includes(agentId)) {
              personNotes.set(agentId, [...(personNotes.get(agentId) ?? []), data.text]);
              return ack('accepted', 'Not started yet: it will read this with its brief.');
            }
            const fresh = await ensureSession(agentId);
            transcript(agentId, { kind: 'command', cmdId: data.cmdId, text: data.text, delivery, status: 'applied', origin: data.origin?.kind ?? 'agent' });
            fresh.session.send(data.text, 'queue').catch(() => {});
            return ack('applied', 'Started a new turn.');
          }
          const sent = await entry.session.send(data.text, delivery);
          transcript(agentId, { kind: 'command', cmdId: data.cmdId, text: data.text, delivery, status: sent.status, origin: data.origin?.kind ?? 'agent' });
          return ack(sent.status, sent.reason);
        }
        if (type === 'command.assign') {
          if (run) return ack('rejected', 'A run is active: message the agent instead.');
          const live = await ensureSession(agentId);
          const taskId = data.taskId ?? shortId('task');
          emit('task.assigned', agentId, { taskId, title: oneLine(data.title, 140), ...(data.brief && { brief: data.brief }), from: data.origin?.kind === 'human' ? 'you' : 'lead' });
          ack('applied');
          const text = data.brief ? `${data.title}\n\n${data.brief}` : data.title;
          void live;
          const result = await shared.run(() => turn(agentId, text));
          return emit('task.finished', agentId, { taskId, outcome: result.ok ? 'success' : result.stopReason === 'cancelled' ? 'cancelled' : 'failed', summary: oneLine(result.text || result.error, 200) });
        }
        return ack('unsupported');
      } catch (err) {
        return ack('rejected', oneLine(err.message, 160));
      }
    },

    /**
     * After a daemon restart: close requests nobody waits on any more, and continue a run that
     * was cut off (sessions resume by id; finished roles are not run again).
     */
    recover() {
      const expired = broker.expireOrphans();
      let saved = null;
      try { saved = JSON.parse(fs.readFileSync(runFile, 'utf8')); } catch { /* no run was active */ }
      if (!saved) return { expired, resumed: false };
      try {
        loadTeam();
      } catch (err) {
        emit('run.failed', 'lead', { reason: oneLine(`Cannot continue the run: ${err.message}`, 120) });
        fs.rmSync(runFile, { force: true });
        return { expired, resumed: false };
      }
      // The budget keeps counting from where it was: a daemon that keeps restarting gets no new budget.
      run = { ...saved, startedAt: now() - (saved.elapsedMs ?? 0), stopping: null, failure: null };
      const finished = (async () => {
        // Going on spends the person's plan again: that is theirs to decide, not a restart's.
        const res = await askPerson('lead', {
          kind: 'decision',
          title: 'The team was cut off mid-run. Continue?',
          description: `Finished so far: ${run.done.map(nameOf).join(', ') || 'nobody'}. Finished roles are not run again.`,
          options: [choice('continue', 'Continue the run'), choice('stop', 'Leave it stopped')],
          onExpire: 'Nothing runs until you answer.',
        });
        if (!(res.outcome === 'selected' && res.optionId === 'continue')) {
          emit('run.failed', 'lead', { reason: 'Cut off by a restart and not continued' });
          fs.rmSync(runFile, { force: true });
          run = null;
          return;
        }
        emit('agent.status', 'lead', { state: 'working', say: 'Picking up where the team stopped' });
        await execute();
      })();
      finished.catch(() => {});
      return { expired, resumed: true, finished };
    },

    /** Stop the active run: sessions are interrupted and the run ends as failed with the reason. */
    async stop(reason = 'Stopped by you') {
      if (!run) return;
      run.stopping = reason;
      broker.cancelAll({ kind: 'human' });
      await Promise.all([...sessions.values()].filter((e) => e.busy).map((e) => e.session.interrupt().catch(() => {})));
    },

    async close() {
      closed = true;
      clearInterval(ticker);
      broker.cancelAll();
      await Promise.all([...sessions.values()].map((e) => e.session.close().catch(() => {})));
      sessions.clear();
    },
  };
}

// Exposed for role prompts built elsewhere (the kit migration uses the same finder rules).
export { finderRules };
