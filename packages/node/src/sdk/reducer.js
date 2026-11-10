// The MAS Office reducer: events in, snapshots out. Implements spec §4 exactly.
// It is pure (no I/O) and deterministic, so it can run in the SDK, the server or a test.

export const SPEC_VERSION = '0.2';

export const STATES = ['idle', 'waiting', 'working', 'handoff', 'flagged', 'done', 'failed'];

/** Required string fields in `data`, per event type (bold in spec §3.2). */
const REQUIRED_DATA = {
  'agent.status': ['state'],
  handoff: ['to'],
  message: ['text'],
  'tool.started': ['name'],
  'flag.raised': ['text'],
  'request.opened': ['requestId', 'kind', 'title'],
  'request.resolved': ['requestId', 'outcome'],
  'command.message': ['cmdId', 'text'],
  'command.respond': ['cmdId', 'requestId', 'outcome'],
  'command.assign': ['cmdId', 'title'],
  'command.interrupt': ['cmdId'],
  'command.ack': ['cmdId', 'status'],
  'task.assigned': ['taskId', 'title'],
  'task.updated': ['taskId'],
  'task.finished': ['taskId'],
  'review.verdict': ['target', 'verdict'],
  'recovery.chosen': ['strategy'],
  'claim.added': ['claimId', 'text'],
  'evidence.checked': ['sourceId'],
  'verdict.recorded': ['claimId', 'status'],
};

const OUTCOMES = ['selected', 'submitted', 'declined', 'cancelled', 'expired', 'superseded', 'stale'];
const ACK_STATUSES = ['accepted', 'applied', 'rejected', 'unsupported', 'expired'];
const FINAL_ACKS = ['applied', 'rejected', 'unsupported', 'expired'];
const CLAIM_STATUSES = ['supported', 'partial', 'contradicted', 'unknown', 'not-checkworthy'];

/** Required fields that must also be one of a fixed list (spec §4.1). */
const ENUM_DATA = {
  'agent.status': ['state', STATES],
  'request.resolved': ['outcome', OUTCOMES],
  'command.ack': ['status', ACK_STATUSES],
  'review.verdict': ['verdict', ['accept', 'revise', 'escalate']],
  'recovery.chosen': ['strategy', ['retry', 'reassign', 'replan', 'split', 'ask-human']],
  'verdict.recorded': ['status', CLAIM_STATUSES],
};

const URGENCIES = ['high', 'normal', 'low']; // also the inbox sort order
const DELIVERIES = ['steer', 'queue', 'interrupt'];
const TASK_STATES = ['working', 'blocked', 'review'];
const TASK_OUTCOMES = ['success', 'failed', 'cancelled'];
const URL_HEALTH = ['live', 'stale', 'hallucinated', 'blocked', 'unknown'];
const GRADES = ['A', 'B', 'C', 'D'];
const RELATIONSHIPS = ['supports', 'refutes', 'irrelevant'];
const WAIT_FLAGS = ['needs_approval', 'needs_input'];
const RESUMED = ['working', 'waiting', 'handoff']; // entering one of these clears stopReason
const RECENT_LIMIT = 50;
const COMMAND_LIMIT = 100;

const STATUS_FIELDS = ['state', 'say', 'to', 'flag', 'flagKind', 'progress', 'waitingOn', 'stopReason'];

const NEXT = {
  locked: 'Waiting for the first run.',
  running: 'Watch the office panel — the team is working.',
  done: 'Run finished — open the result.',
  failed: "Run failed — see the Lead's desk.",
};

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const given = (v) => v !== undefined && v !== null;
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
// "Given" (spec §4.2): null, missing and wrong-type values all read as undefined, so `??` applies.
const str = (v) => (typeof v === 'string' ? v : undefined);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const bool = (v) => (typeof v === 'boolean' ? v : undefined);
const obj = (v) => (isObject(v) ? clone(v) : undefined);
const oneOf = (values, v) => (values.includes(v) ? v : undefined);
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : undefined);
const objects = (v) => (Array.isArray(v) ? v.filter(isObject) : []);
const same = (a, b) => (Array.isArray(a) && Array.isArray(b)
  ? a.length === b.length && a.every((x, i) => x === b[i])
  : a === b);
const system = () => ({ kind: 'system' });
const flagKindOf = (kind) => (kind === 'approval' ? 'needs_approval' : 'needs_input');
// defineProperty, not `out[id] =`: an id such as "__proto__" must become an own key.
const define = (out, key, value) => Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });

function keyed(map) {
  const out = {};
  for (const [key, value] of map) define(out, key, clone(value));
  return out;
}

/**
 * Check one event against spec §4.1 rule 2.
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateEvent(e) {
  if (!isObject(e)) return { ok: false, errors: ['event must be a JSON object'] };
  const errors = [];
  if (!given(e.v)) errors.push('missing "v"');
  if (!Number.isSafeInteger(e.seq) || e.seq < 1) errors.push('"seq" must be an integer from 1 to 2^53 - 1');
  if (typeof e.ts !== 'string') errors.push('"ts" must be a string');
  if (typeof e.type !== 'string') errors.push('"type" must be a string');
  if (e.data !== undefined && !isObject(e.data)) {
    errors.push('"data" must be an object');
  } else {
    const data = isObject(e.data) ? e.data : {};
    const field = (name) => (Object.hasOwn(data, name) ? data[name] : undefined);
    const required = Object.hasOwn(REQUIRED_DATA, e.type) ? REQUIRED_DATA[e.type] : [];
    const missing = required.filter((name) => typeof field(name) !== 'string');
    for (const name of missing) errors.push(`"${e.type}" needs a string "data.${name}"`);
    if (!missing.length && Object.hasOwn(ENUM_DATA, e.type)) {
      const [name, values] = ENUM_DATA[e.type];
      if (!values.includes(field(name))) errors.push(`"data.${name}" must be one of ${values.join(', ')}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Parse a log (lines as strings or objects) into the events to apply, in order:
 * non-objects and invalid events dropped, sorted by seq (stable), first of each seq kept.
 */
export function parseLog(lines) {
  const events = [];
  for (const line of lines) {
    let e = line;
    if (typeof line === 'string') {
      if (!line.trim()) continue;
      try { e = JSON.parse(line); } catch { continue; }
    }
    if (validateEvent(e).ok) events.push(e);
  }
  events.sort((a, b) => a.seq - b.seq);
  return events.filter((e, i) => i === 0 || e.seq !== events[i - 1].seq);
}

function defaultStructure() {
  return {
    title: 'Untitled MAS', version: 1, locked: true, topology: 'dynamic',
    lead: { id: 'lead', name: 'Lead', emoji: '🧭', job: '', serves: [] },
    groups: [], roles: [],
  };
}

const freshStatus = (state, say, t) => ({
  state, say, to: null, flag: null, flagKind: null, progress: 0, t, waitingOn: [], stopReason: null,
});

/** Claim status from its verdicts (spec §4.3, "Claim status"). */
function claimStatus(claim) {
  if (!claim.checkworthy) return 'not-checkworthy';
  if (!claim.verdicts.length) return 'unchecked';
  const last = new Map(); // the last verdict of each distinct `by`
  for (const v of claim.verdicts) last.set(v.by, v.status);
  const statuses = [...last.values()];
  if (statuses.includes('contradicted')) return 'contradicted';
  return statuses.every((s) => s === statuses[0]) ? statuses[0] : 'unknown';
}

/**
 * Create an incremental reducer. `apply(event)` returns true when the event was applied;
 * invalid events and events whose seq is not above the last applied seq are ignored.
 * @param {Array<string|object>} [lines] an existing log to start from
 */
export function createReducer(lines = []) {
  let structure = defaultStructure();
  let structureGiven = false;
  const statuses = new Map([['lead', freshStatus('idle', 'Ready', null)]]);
  let run = 0;
  let runId = null;
  let phase = 'locked';
  let updated = null;
  let lastSeq = 0;
  let sources = [];
  let flags = [];
  let result = null;
  // Protocol 0.2: inbox, board and verification (spec §4.3).
  const pending = new Map(); // requestId → open request
  let recent = []; // closed requests, newest first
  const commands = new Map(); // cmdId → command
  const usage = new Map();
  const agents = new Map();
  let tasks = new Map();
  let ledger = null;
  let reviews = [];
  let recoveries = [];
  let claims = new Map();
  let evidence = new Map();

  const roleOf = (id) => structure.roles.find((r) => isObject(r) && r.id === id);
  const isKnown = (id) => id === 'lead' || roleOf(id) !== undefined;
  const nameOf = (id) => (id === 'lead' ? str(structure.lead?.name) ?? 'Lead' : str(roleOf(id)?.name) ?? id);
  const wake = (state) => (state === 'idle' || state === 'waiting' ? 'working' : state);

  // Merge `patch` into a status; `t` moves only when a field really changes (§4.2).
  function change(id, patch, ts) {
    const prev = statuses.get(id);
    const next = { ...prev, ...patch };
    // Entering working/waiting/handoff clears the last stop reason, unless this event sets one.
    if (!Object.hasOwn(patch, 'stopReason') && next.state !== prev.state && RESUMED.includes(next.state)) {
      next.stopReason = null;
    }
    if (STATUS_FIELDS.some((k) => !same(next[k], prev[k]))) statuses.set(id, { ...next, t: ts });
  }

  // Auto-registration, spec §4.3.
  function register(id, info, ts) {
    const role = {
      id,
      name: info.name ?? id,
      emoji: info.emoji ?? '🤖',
      job: info.job ?? '',
      serves: [],
      tools: [],
      group: info.group ?? 'dyn',
      handsTo: info.handsTo ?? 'lead',
      dynamic: true,
      parent: info.parent ?? 'lead',
    };
    if (info.role !== undefined) role.role = info.role;
    structure.roles.push(role);
    if (!Array.isArray(structure.groups)) structure.groups = [];
    const groups = structure.groups;
    if (!groups.some((g) => isObject(g) && g.id === role.group)) {
      groups.push({
        id: role.group,
        label: role.group === 'dyn' ? 'Spawned at runtime' : `Group ${role.group}`,
        after: groups[groups.length - 1]?.id ?? null,
      });
    }
    statuses.set(id, phase === 'running'
      ? freshStatus('waiting', 'Waiting for my turn', ts)
      : freshStatus('idle', 'Ready', ts));
  }

  // Move a pending request to the front of `recent` with its resolution.
  function close(request, resolution) {
    pending.delete(request.requestId);
    recent.unshift({ ...request, ...resolution });
    if (recent.length > RECENT_LIMIT) recent = recent.slice(0, RECENT_LIMIT);
  }

  // Cancel every pending request that `match`es, in the order they were opened.
  function cancelPending(match, by, ts) {
    for (const request of [...pending.values()]) {
      if (!match(request)) continue;
      close(request, {
        outcome: 'cancelled', optionId: null, payload: null, note: null, by: clone(by), cmdId: null, resolvedAt: ts,
      });
    }
  }

  function startRun(e, d) {
    run += 1;
    runId = e.runId ?? null;
    if (isObject(d.structure)) {
      const s = clone(d.structure);
      s.title = str(s.title) ?? str(d.title) ?? 'Untitled MAS';
      s.version ??= 1;
      s.locked = true;
      s.topology ??= 'staged';
      if (!isObject(s.lead)) s.lead = defaultStructure().lead;
      if (!Array.isArray(s.groups)) s.groups = [];
      if (!Array.isArray(s.roles)) s.roles = [];
      structure = s;
      structureGiven = true;
      for (const id of statuses.keys()) if (!isKnown(id)) statuses.delete(id);
    } else if (str(d.title) !== undefined && !structureGiven) {
      structure.title = d.title;
    }
    const reset = { progress: 0, to: null, flag: null, flagKind: null, waitingOn: [], stopReason: null };
    for (const role of structure.roles) {
      if (!isObject(role) || typeof role.id !== 'string' || role.id === 'lead') continue;
      if (!statuses.has(role.id)) statuses.set(role.id, freshStatus('waiting', 'Waiting for my turn', e.ts));
      change(role.id, { state: 'waiting', say: 'Waiting for my turn', ...reset }, e.ts);
    }
    change('lead', { state: 'working', say: 'Planning the run', ...reset }, e.ts);
    cancelPending(() => true, system(), e.ts);
    sources = [];
    flags = [];
    result = null;
    tasks = new Map();
    ledger = null;
    reviews = [];
    recoveries = [];
    claims = new Map();
    evidence = new Map();
    phase = 'running';
  }

  function buildResult(e, d) {
    const merged = [...clone(sources)];
    const seen = new Set(merged.map((s) => s.id));
    for (const s of objects(d.sources)) {
      if (typeof s.id !== 'string' || seen.has(s.id)) continue;
      seen.add(s.id);
      merged.push(clone(s));
    }
    const out = {
      title: str(d.title) ?? `${str(structure.title) ?? 'Untitled MAS'} — run ${run}`,
      run,
      updated: e.ts,
      markdown: str(d.markdown) ?? '',
      sources: merged,
      flags: [...clone(flags), ...clone(objects(d.flags))],
      work: clone(objects(d.work)),
    };
    // Result rounds: a run's first result keeps the 0.1 shape unless it names a round or question.
    const question = str(d.question);
    if (result === null && num(d.round) === undefined && question === undefined) return out;
    const p = result === null ? 0 : result.round ?? 1;
    out.round = Number.isInteger(d.round) && d.round > p ? d.round : p + 1;
    if (question !== undefined) out.question = question;
    out.previous = result === null ? [] : [...clone(result.previous ?? []), {
      round: p,
      ...(result.question !== undefined && { question: result.question }),
      title: result.title,
      markdown: result.markdown,
      updated: result.updated,
    }];
    return out;
  }

  function openRequest(id, e, d, ts) {
    if (pending.has(d.requestId) || recent.some((r) => r.requestId === d.requestId)) return;
    const request = {
      requestId: d.requestId,
      agentId: id,
      kind: d.kind,
      title: d.title,
      description: str(d.description) ?? null,
      subject: obj(d.subject) ?? null,
      toolCallId: str(d.toolCallId) ?? null,
      options: clone(objects(d.options).filter((o) => typeof o.optionId === 'string')),
      responseSchema: obj(d.responseSchema) ?? null,
      blocking: bool(d.blocking) ?? true,
      routeTo: str(d.routeTo) ?? 'human',
      resolver: str(d.resolver) ?? 'anyone',
      urgency: oneOf(URGENCIES, d.urgency) ?? 'normal',
      expiresAt: str(d.expiresAt) ?? null,
      onExpire: str(d.onExpire) ?? null,
      source: obj(d.source) ?? null,
      openedAt: ts,
      seq: e.seq,
      run,
    };
    pending.set(request.requestId, request);
    if (!request.blocking) return;
    const prev = statuses.get(id);
    const waitingOn = [...prev.waitingOn, request.requestId];
    if (prev.state === 'done' || prev.state === 'failed') change(id, { waitingOn }, ts);
    else change(id, { state: 'flagged', flag: request.title, flagKind: flagKindOf(request.kind), to: null, waitingOn }, ts);
  }

  function resolveRequest(d, ts) {
    const request = pending.get(d.requestId);
    if (!request) return; // unknown, or already answered: the first answer wins
    close(request, {
      outcome: d.outcome,
      optionId: str(d.optionId) ?? null,
      payload: given(d.payload) ? clone(d.payload) : null,
      note: str(d.note) ?? null,
      by: obj(d.by) ?? system(),
      cmdId: str(d.cmdId) ?? null,
      resolvedAt: ts,
    });
    const opener = statuses.get(request.agentId);
    if (!opener || !opener.waitingOn.includes(request.requestId)) return;
    const waitingOn = opener.waitingOn.filter((r) => r !== request.requestId);
    const patch = { waitingOn };
    if (opener.state === 'flagged' && WAIT_FLAGS.includes(opener.flagKind)) {
      const oldest = pending.get(waitingOn[0]);
      if (oldest) Object.assign(patch, { flag: oldest.title, flagKind: flagKindOf(oldest.kind) });
      else Object.assign(patch, { state: 'working', flag: null, flagKind: null });
    }
    change(request.agentId, patch, ts);
  }

  function recordCommand(id, e, d, ts) {
    if (commands.has(d.cmdId)) return;
    commands.set(d.cmdId, {
      cmdId: d.cmdId,
      type: e.type,
      agentId: id,
      origin: obj(d.origin) ?? { kind: 'agent', id: 'lead' },
      text: e.type === 'command.message' ? d.text : e.type === 'command.assign' ? d.title : null,
      delivery: e.type === 'command.message' ? oneOf(DELIVERIES, d.delivery) ?? 'steer' : null,
      requestId: e.type === 'command.respond' ? d.requestId : null,
      status: 'sent',
      reason: null,
      sentAt: ts,
      ackAt: null,
      seq: e.seq,
    });
    if (commands.size > COMMAND_LIMIT) commands.delete(commands.keys().next().value);
  }

  function apply(e) {
    if (!validateEvent(e).ok || e.seq <= lastSeq) return false;
    lastSeq = e.seq;
    updated = e.ts;
    const id = typeof e.agentId === 'string' && e.agentId ? e.agentId : 'lead';
    const d = e.data ?? {};
    const isRunEvent = e.type.startsWith('run.');

    if (!isKnown(id) && !(isRunEvent && id === 'lead')) {
      const fromRegistration = e.type === 'agent.registered';
      register(id, {
        name: (fromRegistration ? str(d.name) : undefined) ?? str(e.agentName),
        parent: str(e.parentId),
        ...(fromRegistration && {
          emoji: str(d.emoji), job: str(d.job), group: str(d.group), handsTo: str(d.handsTo), role: str(d.role),
        }),
      }, e.ts);
    }
    const prev = statuses.get(id);
    const ts = e.ts;

    switch (e.type) {
      case 'run.started':
        startRun(e, d);
        break;
      case 'agent.registered': {
        const info = {
          backend: str(d.backend), model: str(d.model), session: obj(d.session),
          accepts: strings(d.accepts), reviewerOf: strings(d.reviewerOf),
        };
        if (!Object.values(info).some((v) => v !== undefined)) break;
        const old = agents.get(id) ?? { backend: null, model: null, session: null, accepts: [], reviewerOf: [] };
        agents.set(id, Object.fromEntries(Object.entries(old).map(([k, v]) => [k, info[k] ?? v])));
        break;
      }
      case 'agent.status': {
        const state = d.state;
        const patch = {
          state,
          to: state === 'handoff' ? str(d.to) ?? prev.to : null,
          flag: state === 'flagged' ? str(d.flag) ?? prev.flag : null,
          flagKind: state === 'flagged' ? str(d.flagKind) ?? prev.flagKind ?? 'concern' : null,
        };
        if (str(d.say) !== undefined) patch.say = d.say;
        if (num(d.progress) !== undefined) patch.progress = Math.min(100, Math.max(0, Math.round(d.progress)));
        if (str(d.stopReason) !== undefined) patch.stopReason = d.stopReason;
        change(id, patch, ts);
        break;
      }
      case 'agent.finished':
        change(id, { state: 'done', say: str(d.say) ?? 'Done', progress: 100, to: null, flag: null, flagKind: null }, ts);
        break;
      case 'agent.failed':
        change(id, { state: 'failed', say: str(d.reason) ?? 'Failed', flag: str(d.reason) ?? null, flagKind: 'error', to: null }, ts);
        break;
      case 'agent.stopped': {
        cancelPending((r) => r.agentId === id, obj(d.by) ?? system(), ts);
        change(id, {
          state: d.scope === 'agent' ? 'done' : 'idle',
          say: str(d.reason) ?? 'Stopped',
          to: null, flag: null, flagKind: null, stopReason: 'cancelled', waitingOn: [],
        }, ts);
        break;
      }
      case 'handoff':
        if (!isKnown(d.to)) register(d.to, { name: d.to, parent: id }, ts);
        change(id, { state: 'handoff', to: d.to, say: str(d.say) ?? `Handing over to ${nameOf(d.to)}`, flag: null, flagKind: null }, ts);
        break;
      case 'message':
      case 'tool.started': {
        const say = e.type === 'message' ? d.text : str(d.say) ?? `Using ${d.name}`;
        change(id, { say, state: wake(prev.state) }, ts);
        break;
      }
      case 'flag.raised':
        change(id, { state: 'flagged', flag: d.text, flagKind: str(d.kind) ?? 'concern', to: null }, ts);
        flags.push({ by: id, kind: str(d.kind) ?? 'concern', text: d.text });
        break;
      case 'flag.resolved':
        if (prev.state === 'flagged') change(id, { state: 'working', flag: null, flagKind: null }, ts);
        break;
      case 'artifact':
        if (d.kind === 'source' && isObject(d.source) && typeof d.source.id === 'string'
            && !sources.some((s) => s.id === d.source.id)) {
          sources.push({ ...clone(d.source), foundBy: d.source.foundBy ?? id });
        }
        break;
      case 'result':
        result = buildResult(e, d);
        break;
      case 'run.finished':
        change('lead', { state: 'done', say: str(d.say) ?? 'Result ready', progress: 100, to: null, flag: null, flagKind: null }, ts);
        phase = 'done';
        break;
      case 'run.failed':
        change('lead', { state: 'failed', say: str(d.reason) ?? 'Run failed', flag: str(d.reason) ?? null, flagKind: 'error' }, ts);
        phase = 'failed';
        break;
      case 'round.started':
        // A follow-up round continues the current run: only the phase and the lead change.
        if (run === 0) break;
        change('lead', {
          state: 'working', say: 'Working on your follow-up', progress: 0, to: null, flag: null, flagKind: null, stopReason: null,
        }, ts);
        phase = 'running';
        break;
      case 'request.opened':
        openRequest(id, e, d, ts);
        break;
      case 'request.resolved':
        resolveRequest(d, ts);
        break;
      case 'command.message':
      case 'command.respond':
      case 'command.assign':
      case 'command.interrupt':
        recordCommand(id, e, d, ts);
        break;
      case 'command.ack': {
        const cmd = commands.get(d.cmdId);
        if (cmd && !FINAL_ACKS.includes(cmd.status)) Object.assign(cmd, { status: d.status, reason: str(d.reason) ?? null, ackAt: ts });
        break;
      }
      case 'usage': {
        const old = usage.get(id) ?? { inputTokens: 0, outputTokens: 0, costUsd: 0, turns: 0, limit: null };
        usage.set(id, {
          inputTokens: num(d.inputTokens) ?? old.inputTokens,
          outputTokens: num(d.outputTokens) ?? old.outputTokens,
          costUsd: num(d.costUsd) ?? old.costUsd,
          turns: num(d.turns) ?? old.turns,
          limit: obj(d.limit) ?? old.limit,
          updated: ts,
        });
        break;
      }
      case 'task.assigned': {
        const task = tasks.get(d.taskId);
        if (!task) {
          tasks.set(d.taskId, {
            taskId: d.taskId, agentId: id, title: d.title, brief: str(d.brief) ?? null, from: str(d.from) ?? 'lead',
            round: num(d.round) ?? 1, attempt: num(d.attempt) ?? 1, state: 'assigned', say: null,
            outcome: null, summary: null, assignedAt: ts, finishedAt: null,
          });
        } else {
          Object.assign(task, {
            title: d.title, brief: str(d.brief) ?? task.brief, round: num(d.round) ?? task.round,
            attempt: num(d.attempt) ?? task.attempt, state: 'assigned', outcome: null, summary: null, finishedAt: null,
          });
        }
        break;
      }
      case 'task.updated': {
        const task = tasks.get(d.taskId);
        if (task && oneOf(TASK_STATES, d.state) !== undefined) task.state = d.state;
        if (str(d.say) !== undefined) {
          if (task) task.say = d.say;
          change(id, { say: d.say, state: wake(prev.state) }, ts);
        }
        break;
      }
      case 'task.finished': {
        const task = tasks.get(d.taskId);
        if (task) {
          Object.assign(task, {
            state: 'done', outcome: oneOf(TASK_OUTCOMES, d.outcome) ?? 'success', summary: str(d.summary) ?? null, finishedAt: ts,
          });
        }
        break;
      }
      case 'lead.ledger':
        ledger = {
          satisfied: bool(d.satisfied) ?? null,
          looping: bool(d.looping) ?? null,
          progressing: bool(d.progressing) ?? null,
          next: str(d.next) ?? null,
          instruction: str(d.instruction) ?? null,
          reason: str(d.reason) ?? null,
          plan: Array.isArray(d.plan) && d.plan.every((p) => typeof p === 'string') ? [...d.plan] : null,
          stalls: num(d.stalls) ?? null,
          updated: ts,
        };
        break;
      case 'review.verdict':
        reviews.push({ reviewer: id, target: d.target, verdict: d.verdict, round: num(d.round) ?? 1, note: str(d.note) ?? null, at: ts });
        break;
      case 'recovery.chosen':
        recoveries.push({ by: id, strategy: d.strategy, target: str(d.target) ?? null, note: str(d.note) ?? null, at: ts });
        break;
      case 'claim.added': {
        const claim = claims.get(d.claimId) ?? {
          claimId: d.claimId, text: d.text, sources: [], serves: null, checkworthy: true, author: id, status: null, verdicts: [],
        };
        Object.assign(claim, {
          text: d.text,
          sources: strings(d.sources) ?? claim.sources,
          serves: str(d.serves) ?? claim.serves,
          checkworthy: bool(d.checkworthy) ?? claim.checkworthy,
        });
        claim.status = claimStatus(claim);
        claims.set(d.claimId, claim);
        break;
      }
      case 'evidence.checked': {
        const old = evidence.get(d.sourceId) ?? {
          url: null, urlHealth: null, httpStatus: null, archivedUrl: null, grade: null, quote: null, note: null,
        };
        evidence.set(d.sourceId, {
          sourceId: d.sourceId,
          url: str(d.url) ?? old.url,
          urlHealth: oneOf(URL_HEALTH, d.urlHealth) ?? old.urlHealth,
          httpStatus: num(d.httpStatus) ?? old.httpStatus,
          archivedUrl: str(d.archivedUrl) ?? old.archivedUrl,
          grade: oneOf(GRADES, d.grade) ?? old.grade,
          quote: str(d.quote) ?? old.quote,
          note: str(d.note) ?? old.note,
          checkedBy: id,
          at: ts,
        });
        break;
      }
      case 'verdict.recorded': {
        const claim = claims.get(d.claimId);
        if (!claim) break;
        claim.verdicts.push({
          by: id, status: d.status, sourceId: str(d.sourceId) ?? null,
          relationship: oneOf(RELATIONSHIPS, d.relationship) ?? null,
          method: str(d.method) ?? null, note: str(d.note) ?? null, backend: str(d.backend) ?? null, at: ts,
        });
        claim.status = claimStatus(claim);
        break;
      }
      default:
        // stage.*, tool.finished/failed, custom.*, unknown: no effect.
        break;
    }
    return true;
  }

  function verification() {
    if (!claims.size && !evidence.size) return null;
    const all = [...claims.values()];
    const checkworthy = all.filter((c) => c.checkworthy);
    const sourcesList = [...evidence.values()];
    const cited = new Set(all.flatMap((c) => c.sources));
    const byStatus = (s) => checkworthy.filter((c) => c.status === s).length;
    const byHealth = (h) => sourcesList.filter((x) => x.urlHealth === h).length;
    return {
      claims: clone(all),
      evidence: clone(sourcesList),
      summary: {
        claims: all.length,
        checkworthy: checkworthy.length,
        supported: byStatus('supported'),
        partial: byStatus('partial'),
        contradicted: byStatus('contradicted'),
        unknown: byStatus('unknown'),
        unchecked: byStatus('unchecked'),
        sources: sourcesList.length,
        live: byHealth('live'),
        stale: byHealth('stale'),
        hallucinated: byHealth('hallucinated'),
        blocked: byHealth('blocked'),
        uncited: sourcesList.filter((x) => !cited.has(x.sourceId)).length,
      },
    };
  }

  function nextLine() {
    const waiting = [...pending.values()].filter((r) => r.routeTo === 'human').length;
    if (phase !== 'running' || waiting === 0) return NEXT[phase];
    return waiting === 1 ? '1 thing needs you — open the inbox.' : `${waiting} things need you — open the inbox.`;
  }

  function snapshot() {
    const order = ['lead', ...structure.roles.filter(isObject).map((r) => r.id)];
    const out = {};
    for (const id of order) {
      if (statuses.has(id) && !Object.hasOwn(out, id)) define(out, id, clone(statuses.get(id)));
    }
    const byUrgency = (a, b) => URGENCIES.indexOf(a.urgency) - URGENCIES.indexOf(b.urgency) || a.seq - b.seq;
    return {
      structure: clone(structure),
      statuses: out,
      state: {
        mode: 'sdk', step: 4, phase, locked: true, version: structure.version,
        run, runId, updated, next: nextLine(),
      },
      result: clone(result) ?? null,
      inbox: {
        pending: clone([...pending.values()].sort(byUrgency)),
        recent: clone(recent),
        commands: clone([...commands.values()]),
      },
      board: {
        tasks: clone([...tasks.values()]),
        ledger: clone(ledger),
        reviews: clone(reviews),
        recoveries: clone(recoveries),
        usage: keyed(usage),
        agents: keyed(agents),
      },
      verification: verification(),
    };
  }

  for (const e of parseLog(lines)) apply(e);

  return {
    apply,
    snapshot,
    get lastSeq() { return lastSeq; },
  };
}

/** Reduce a whole log (array of JSON strings or event objects) to snapshots (spec §4.5). */
export function reduce(lines) {
  return createReducer(lines).snapshot();
}
