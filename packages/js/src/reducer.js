// The MAS Office reducer: events in, snapshots out. Implements spec §4 exactly.
// It is pure (no I/O) and deterministic, so it can run in the SDK, the server or a test.

export const SPEC_VERSION = '0.1';

export const STATES = ['idle', 'waiting', 'working', 'handoff', 'flagged', 'done', 'failed'];

/** Required string field in `data`, per event type (bold in spec §3.2). */
const REQUIRED_DATA = {
  'agent.status': 'state',
  handoff: 'to',
  message: 'text',
  'tool.started': 'name',
  'flag.raised': 'text',
};

const STATUS_FIELDS = ['state', 'say', 'to', 'flag', 'flagKind', 'progress'];

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
const objects = (v) => (Array.isArray(v) ? v.filter(isObject) : []);

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
    const field = Object.hasOwn(REQUIRED_DATA, e.type) ? REQUIRED_DATA[e.type] : undefined;
    const value = field && isObject(e.data) && Object.hasOwn(e.data, field) ? e.data[field] : undefined;
    if (field && typeof value !== 'string') errors.push(`"${e.type}" needs a string "data.${field}"`);
    else if (e.type === 'agent.status' && !STATES.includes(value)) {
      errors.push(`"data.state" must be one of ${STATES.join(', ')}`);
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

const freshStatus = (state, say, t) => ({ state, say, to: null, flag: null, flagKind: null, progress: 0, t });

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

  const roleOf = (id) => structure.roles.find((r) => isObject(r) && r.id === id);
  const isKnown = (id) => id === 'lead' || roleOf(id) !== undefined;
  const nameOf = (id) => (id === 'lead' ? str(structure.lead?.name) ?? 'Lead' : str(roleOf(id)?.name) ?? id);

  // Merge `patch` into a status; `t` moves only when a field really changes (§4.2).
  function change(id, patch, ts) {
    const prev = statuses.get(id);
    const next = { ...prev, ...patch };
    if (STATUS_FIELDS.some((k) => next[k] !== prev[k])) statuses.set(id, { ...next, t: ts });
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
    const reset = { progress: 0, to: null, flag: null, flagKind: null };
    for (const role of structure.roles) {
      if (!isObject(role) || typeof role.id !== 'string' || role.id === 'lead') continue;
      if (!statuses.has(role.id)) statuses.set(role.id, freshStatus('waiting', 'Waiting for my turn', e.ts));
      change(role.id, { state: 'waiting', say: 'Waiting for my turn', ...reset }, e.ts);
    }
    change('lead', { state: 'working', say: 'Planning the run', ...reset }, e.ts);
    sources = [];
    flags = [];
    result = null;
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
    return {
      title: str(d.title) ?? `${str(structure.title) ?? 'Untitled MAS'} — run ${run}`,
      run,
      updated: e.ts,
      markdown: str(d.markdown) ?? '',
      sources: merged,
      flags: [...clone(flags), ...clone(objects(d.flags))],
      work: clone(objects(d.work)),
    };
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
        change(id, patch, ts);
        break;
      }
      case 'agent.finished':
        change(id, { state: 'done', say: str(d.say) ?? 'Done', progress: 100, to: null, flag: null, flagKind: null }, ts);
        break;
      case 'agent.failed':
        change(id, { state: 'failed', say: str(d.reason) ?? 'Failed', flag: str(d.reason) ?? null, flagKind: 'error', to: null }, ts);
        break;
      case 'handoff':
        if (!isKnown(d.to)) register(d.to, { name: d.to, parent: id }, ts);
        change(id, { state: 'handoff', to: d.to, say: str(d.say) ?? `Handing over to ${nameOf(d.to)}`, flag: null, flagKind: null }, ts);
        break;
      case 'message':
      case 'tool.started': {
        const say = e.type === 'message' ? d.text : str(d.say) ?? `Using ${d.name}`;
        const state = prev.state === 'idle' || prev.state === 'waiting' ? 'working' : prev.state;
        change(id, { say, state }, ts);
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
      default:
        // agent.registered (registration only), stage.*, tool.finished/failed, custom.*, unknown: no effect.
        break;
    }
    return true;
  }

  function snapshot() {
    const order = ['lead', ...structure.roles.filter(isObject).map((r) => r.id)];
    const out = {};
    // defineProperty, not `out[id] =`: an id such as "__proto__" must become an own key.
    for (const id of order) {
      if (statuses.has(id) && !Object.hasOwn(out, id)) {
        Object.defineProperty(out, id, { value: { ...statuses.get(id) }, enumerable: true, writable: true, configurable: true });
      }
    }
    return {
      structure: clone(structure),
      statuses: out,
      state: {
        mode: 'sdk', step: 4, phase, locked: true, version: structure.version,
        run, runId, updated, next: NEXT[phase],
      },
      result: clone(result) ?? null,
    };
  }

  for (const e of parseLog(lines)) apply(e);

  return {
    apply,
    snapshot,
    get lastSeq() { return lastSeq; },
  };
}

/** Reduce a whole log (array of JSON strings or event objects) to `{structure, statuses, state, result}`. */
export function reduce(lines) {
  return createReducer(lines).snapshot();
}
