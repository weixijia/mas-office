// Team design v2: defaults and design checks (docs/design/runtime.md §5).
// A 0.1 structure (the kit's `mas/structure`) is a valid v2 structure with defaults.

import { parseToolEntry, serverOf, prefixAllowed, BROWSER_SERVER } from './vocabulary.js';

export const BACKENDS = ['claude-code', 'codex'];
export const DEFAULT_BUDGET = Object.freeze({ maxParallel: 3, maxTurnMinutes: 20, maxRunMinutes: 90, maxQuestionsPerRole: 3, stallMinutes: 5 });
export const DEFAULT_REVIEW = Object.freeze({ maxRounds: 2, onExceed: 'ask-human' });
export const DEFAULT_VERIFY = Object.freeze({ claims: true, urlHealth: true, flagWhen: Object.freeze({ contradicted: 1, unknownShare: 0.34, hallucinated: 1 }) });
export const ROLE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const GATE_KINDS = ['plan', 'stage', 'final'];
export const TOPOLOGIES = ['staged', 'graph', 'dynamic'];
export const MAX_DIRECT_REPORTS = 6;
/** Above this many sessions at once, subscription limits (sized for one person) run out quickly. */
export const PARALLEL_WARNING = 3;

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPositive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * Apply defaults and check a team design.
 * @param {object} structure the `mas/structure` value (0.1 or v2)
 * @param {{mcpServers?: object, commands?: string[], backends?: object}} [env] the workspace: MCP
 *   servers from `.mcp.json`, the command allow-list `home/commands.json`, which backends are
 *   installed. Without `env` the workspace checks (`mcp:`, `cli:`, `browse the web`) are skipped.
 * @returns {{team: object|null, problems: {level: 'error'|'warning', path: string, message: string}[]}}
 */
export function normalizeTeam(structure, env) {
  const problems = [];
  const error = (path, message) => problems.push({ level: 'error', path, message });
  const warn = (path, message) => problems.push({ level: 'warning', path, message });
  if (!isObject(structure)) {
    error('', 'the structure must be an object');
    return { team: null, problems };
  }
  const backendsAvailable = isObject(env?.backends) ? BACKENDS.filter((b) => env.backends[b]) : BACKENDS;

  const tools = (list, at, backend) => {
    if (list === undefined) return [];
    if (!Array.isArray(list)) { error(at, 'must be a list'); return []; }
    const out = [];
    const seen = new Set();
    list.forEach((entry, i) => {
      const parsed = parseToolEntry(entry);
      if (!parsed.ok) { error(`${at}/${i}`, parsed.message); return; }
      const t = parsed.tool;
      if (seen.has(t.name)) { error(`${at}/${i}`, `"${t.name}" is listed twice`); return; }
      seen.add(t.name);
      if (env) {
        const server = serverOf(t);
        if (server && t.effect !== 'deny' && !isObject(env.mcpServers?.[server])) {
          error(`${at}/${i}`, t.word === 'browse the web'
            ? `"browse the web" needs the "${BROWSER_SERVER}" MCP server in the workspace .mcp.json`
            : `MCP server "${server}" is not in the workspace .mcp.json`);
        }
        if (t.word === 'cli' && t.effect !== 'deny' && !prefixAllowed(t.prefix, env.commands)) {
          error(`${at}/${i}`, `"${t.prefix}" is not on the workspace command allow-list (home/commands.json)`);
        }
      }
      if (backend === 'codex' && t.effect === 'ask') {
        if (t.word === 'web search') warn(`${at}/${i}`, 'Codex cannot ask before each web search, so "ask" on web search is treated as "deny" for this role');
        if (t.word === 'run commands' || t.word === 'cli') warn(`${at}/${i}`, 'Codex runs read-only commands without asking; only commands that need to write or use the network will ask');
      }
      out.push({ name: t.name, effect: t.effect });
    });
    return out;
  };

  const backend = (value, at) => {
    if (value === undefined || value === null) return 'claude-code';
    if (!BACKENDS.includes(value)) { error(at, `backend must be one of ${BACKENDS.join(', ')}`); return 'claude-code'; }
    if (!backendsAvailable.includes(value)) warn(at, `${value} is not installed or not signed in on this computer`);
    return value;
  };
  const model = (value, at) => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || !value) { error(at, 'model must be a model name or null'); return null; }
    return value;
  };
  const text = (value, at, fallback = '') => {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'string') { error(at, 'must be text'); return fallback; }
    return value;
  };

  // Budget
  const budget = { ...DEFAULT_BUDGET };
  if (structure.budget !== undefined) {
    if (!isObject(structure.budget)) error('/budget', 'must be an object');
    else {
      for (const [key, value] of Object.entries(structure.budget)) {
        if (!Object.hasOwn(DEFAULT_BUDGET, key)) { warn(`/budget/${key}`, 'is not a budget setting and is ignored'); continue; }
        if (!isPositive(value) || (key !== 'stallMinutes' && key !== 'maxTurnMinutes' && key !== 'maxRunMinutes' && !Number.isInteger(value))) {
          error(`/budget/${key}`, 'must be a positive number (a whole number for counts)');
          continue;
        }
        budget[key] = value;
      }
    }
  }
  if (budget.maxParallel > PARALLEL_WARNING) {
    warn('/budget/maxParallel', `more than ${PARALLEL_WARNING} sessions at once can use up a personal subscription quickly`);
  }

  // Groups (stages)
  const rawRoles = Array.isArray(structure.roles) ? structure.roles : [];
  if (!Array.isArray(structure.roles)) error('/roles', 'must be a list');
  let groups = [];
  if (structure.groups === undefined) {
    const ids = [...new Set(rawRoles.map((r) => (isObject(r) && typeof r.group === 'string' && r.group ? r.group : null)).filter(Boolean))];
    if (!ids.length) ids.push('A');
    groups = ids.map((id, i) => ({ id, label: '', after: i === 0 ? null : ids[i - 1] }));
  } else if (!Array.isArray(structure.groups)) {
    error('/groups', 'must be a list');
  } else {
    const seen = new Set();
    structure.groups.forEach((g, i) => {
      const at = `/groups/${i}`;
      if (!isObject(g) || typeof g.id !== 'string' || !g.id) { error(at, 'a group needs an id'); return; }
      if (seen.has(g.id)) { error(`${at}/id`, `group "${g.id}" is defined twice`); return; }
      seen.add(g.id);
      if (g.after !== undefined && g.after !== null && typeof g.after !== 'string') error(`${at}/after`, 'must be a group id or null');
      groups.push({ ...g, label: text(g.label, `${at}/label`), after: typeof g.after === 'string' ? g.after : null });
    });
  }
  const groupIds = new Set(groups.map((g) => g.id));
  groups.forEach((g, i) => {
    if (g.after === null) return;
    if (g.after === g.id) error(`/groups/${i}/after`, `group "${g.id}" cannot come after itself`);
    else if (!groupIds.has(g.after)) error(`/groups/${i}/after`, `"${g.after}" is not a group id`);
  });
  const cycle = findGroupCycle(groups);
  if (cycle) error('/groups', `the stages form a loop: ${cycle.join(' → ')}`);
  const firstGroup = groups.find((g) => g.after === null)?.id ?? groups[0]?.id ?? null;

  // Lead
  const rawLead = isObject(structure.lead) ? structure.lead : {};
  if (!isObject(structure.lead)) error('/lead', 'the Lead is required');
  else if (structure.lead.id !== 'lead') error('/lead/id', 'the Lead\'s id must be "lead"');
  const leadBackend = backend(rawLead.backend, '/lead/backend');
  const lead = {
    ...rawLead,
    id: 'lead',
    name: text(rawLead.name, '/lead/name', 'Lead') || 'Lead',
    job: text(rawLead.job, '/lead/job'),
    backend: leadBackend,
    model: model(rawLead.model, '/lead/model'),
    tools: tools(rawLead.tools, '/lead/tools', leadBackend),
    delegate: [],
  };

  // Roles
  const roles = [];
  const roleIds = new Set();
  const indexOf = new Map();
  rawRoles.forEach((r, i) => {
    const at = `/roles/${i}`;
    if (!isObject(r)) { error(at, 'a role must be an object'); return; }
    const id = r.id;
    if (typeof id !== 'string' || !ROLE_ID_PATTERN.test(id) || id.length > 64) {
      error(`${at}/id`, 'a role id uses lower-case letters, digits and hyphens (at most 64), starting with a letter or digit');
      return;
    }
    if (id === 'lead') { error(`${at}/id`, '"lead" is reserved for the Lead'); return; }
    if (/-round\d/.test(id)) { error(`${at}/id`, 'a role id cannot contain "-round" followed by a digit (it would clash with follow-up file names)'); return; }
    if (roleIds.has(id)) { error(`${at}/id`, `role id "${id}" is used twice`); return; }
    roleIds.add(id);
    indexOf.set(id, i);
    if (typeof r.name !== 'string' || !r.name.trim()) error(`${at}/name`, 'a role needs a name');
    const roleBackend = backend(r.backend, `${at}/backend`);
    let group = r.group;
    if (group === undefined || group === null) {
      group = firstGroup;
      warn(`${at}/group`, `no group given; the role runs in the first stage${firstGroup ? ` (${firstGroup})` : ''}`);
    } else if (typeof group !== 'string' || !groupIds.has(group)) {
      error(`${at}/group`, `"${group}" is not a group id`);
    }
    const reviewerOf = r.reviewerOf === undefined ? [] : r.reviewerOf;
    if (!Array.isArray(reviewerOf) || reviewerOf.some((t) => typeof t !== 'string')) error(`${at}/reviewerOf`, 'must be a list of role ids');
    const reviewing = Array.isArray(reviewerOf) ? [...new Set(reviewerOf.filter((t) => typeof t === 'string'))] : [];
    const role = {
      ...r,
      name: typeof r.name === 'string' ? r.name : id,
      job: text(r.job, `${at}/job`),
      output: text(r.output, `${at}/output`),
      group,
      handsTo: r.handsTo === undefined || r.handsTo === null ? 'lead' : r.handsTo,
      backend: roleBackend,
      model: model(r.model, `${at}/model`),
      tools: tools(r.tools, `${at}/tools`, roleBackend),
      reviewerOf: reviewing,
      cleanContext: r.cleanContext === undefined ? reviewing.length > 0 : r.cleanContext,
      unknownTools: r.unknownTools === undefined ? 'ask' : r.unknownTools,
    };
    if (typeof role.cleanContext !== 'boolean') { error(`${at}/cleanContext`, 'must be true or false'); role.cleanContext = reviewing.length > 0; }
    if (!['ask', 'deny'].includes(role.unknownTools)) { error(`${at}/unknownTools`, 'must be "ask" or "deny"'); role.unknownTools = 'ask'; }
    if (reviewing.length || r.review !== undefined) role.review = normalizeReview(r.review, `${at}/review`, error);
    else delete role.review;
    roles.push(role);
  });

  // Delegation rules (need role ids)
  if (rawLead.delegate !== undefined) {
    if (!Array.isArray(rawLead.delegate)) error('/lead/delegate', 'must be a list of rules');
    else rawLead.delegate.forEach((rule, i) => {
      const n = normalizeRule(rule, `/lead/delegate/${i}`, roleIds, error);
      if (n) lead.delegate.push(n);
    });
  }

  // References between roles
  const byId = new Map(roles.map((r) => [r.id, r]));
  const ancestors = groupAncestors(groups);
  const reports = new Map();
  for (const role of roles) {
    const at = `/roles/${indexOf.get(role.id)}`;
    if (typeof role.handsTo !== 'string' || (role.handsTo !== 'lead' && !byId.has(role.handsTo))) {
      error(`${at}/handsTo`, `"${role.handsTo}" is not a role id or "lead"`);
    } else if (role.handsTo === role.id) {
      error(`${at}/handsTo`, 'a role cannot hand work to itself');
    } else {
      reports.set(role.handsTo, (reports.get(role.handsTo) ?? 0) + 1);
    }
    for (const target of role.reviewerOf) {
      if (target === role.id) { error(`${at}/reviewerOf`, 'a role cannot review itself'); continue; }
      const t = byId.get(target);
      if (!t) { error(`${at}/reviewerOf`, `"${target}" is not a role id`); continue; }
      if (role.group !== t.group && !(ancestors.get(role.group)?.has(t.group))) {
        error(`${at}/reviewerOf`, `"${role.id}" reviews "${target}" but does not run after it (stage ${role.group} must come after stage ${t.group})`);
      }
    }
    const targets = role.reviewerOf.map((t) => byId.get(t)).filter(Boolean);
    if (targets.length && targets.every((t) => t.backend === role.backend) && backendsAvailable.some((b) => b !== role.backend)) {
      warn(`${at}/backend`, `this reviewer uses the same backend (${role.backend}) as everything it reviews; a different vendor catches different mistakes`);
    }
  }
  for (const [boss, count] of reports) {
    if (count > MAX_DIRECT_REPORTS) {
      const at = boss === 'lead' ? '/lead' : `/roles/${indexOf.get(boss)}`;
      warn(at, `${count} roles hand their work to ${boss === 'lead' ? 'the Lead' : `"${boss}"`}; more than ${MAX_DIRECT_REPORTS} is hard to oversee`);
    }
  }
  const sameStageCycle = findReviewCycle(roles);
  if (sameStageCycle) error('/roles', `reviewers in one stage review each other in a loop: ${sameStageCycle.join(' → ')}`);
  for (const g of groups) {
    if (!roles.some((r) => r.group === g.id)) warn(`/groups/${groups.indexOf(g)}`, `stage "${g.id}" has no roles`);
  }

  // Gates
  const gates = [];
  if (structure.gates !== undefined) {
    if (!Array.isArray(structure.gates)) error('/gates', 'must be a list');
    else {
      const seen = new Set();
      structure.gates.forEach((g, i) => {
        const at = `/gates/${i}`;
        if (!isObject(g) || typeof g.id !== 'string' || !g.id) { error(at, 'a gate needs an id'); return; }
        if (seen.has(g.id)) { error(`${at}/id`, `gate "${g.id}" is defined twice`); return; }
        seen.add(g.id);
        const after = g.after === undefined ? null : g.after;
        if (after !== null && (typeof after !== 'string' || !groupIds.has(after))) error(`${at}/after`, `"${after}" is not a group id`);
        const kind = g.kind === undefined ? (after === null ? 'final' : 'stage') : g.kind;
        if (!GATE_KINDS.includes(kind)) error(`${at}/kind`, `must be one of ${GATE_KINDS.join(', ')}`);
        else if (kind === 'stage' && after === null) error(`${at}/after`, 'a stage gate needs the stage it follows');
        else if (kind !== 'stage' && after !== null) error(`${at}/after`, `a ${kind} gate does not follow a stage; set "after" to null`);
        if (g.blocking !== undefined && typeof g.blocking !== 'boolean') error(`${at}/blocking`, 'must be true or false');
        gates.push({ ...g, after, kind, title: text(g.title, `${at}/title`), blocking: g.blocking !== false });
      });
    }
  }

  // Verification
  const verify = { ...DEFAULT_VERIFY, flagWhen: { ...DEFAULT_VERIFY.flagWhen } };
  if (structure.verify !== undefined) {
    const v = structure.verify;
    if (!isObject(v)) error('/verify', 'must be an object');
    else {
      for (const key of ['claims', 'urlHealth']) {
        if (v[key] === undefined) continue;
        if (typeof v[key] !== 'boolean') error(`/verify/${key}`, 'must be true or false');
        else verify[key] = v[key];
      }
      if (v.flagWhen !== undefined) {
        if (!isObject(v.flagWhen)) error('/verify/flagWhen', 'must be an object');
        else for (const [key, value] of Object.entries(v.flagWhen)) {
          if (!Object.hasOwn(DEFAULT_VERIFY.flagWhen, key)) { warn(`/verify/flagWhen/${key}`, 'is not a flag threshold and is ignored'); continue; }
          const ok = key === 'unknownShare' ? typeof value === 'number' && value >= 0 && value <= 1 : Number.isInteger(value) && value >= 1;
          if (!ok) error(`/verify/flagWhen/${key}`, key === 'unknownShare' ? 'must be a share from 0 to 1' : 'must be a whole number of at least 1');
          else verify.flagWhen[key] = value;
        }
      }
    }
  }

  const topology = structure.topology === undefined ? 'staged' : structure.topology;
  if (!TOPOLOGIES.includes(topology)) error('/topology', `must be one of ${TOPOLOGIES.join(', ')}`);

  const team = {
    ...structure,
    version: Number.isInteger(structure.version) && structure.version >= 1 ? structure.version : 1,
    locked: structure.locked === true,
    topology,
    budget,
    lead,
    groups,
    roles,
    gates,
    verify,
  };
  return { team, problems };
}

function normalizeReview(review, at, error) {
  const out = { ...DEFAULT_REVIEW };
  if (review === undefined) return out;
  if (!isObject(review)) { error(at, 'must be an object'); return out; }
  if (review.maxRounds !== undefined) {
    if (!Number.isInteger(review.maxRounds) || review.maxRounds < 1) error(`${at}/maxRounds`, 'must be a whole number of at least 1');
    else out.maxRounds = review.maxRounds;
  }
  if (review.onExceed !== undefined) {
    if (review.onExceed !== 'ask-human') error(`${at}/onExceed`, 'must be "ask-human" (a review that runs out of rounds is never accepted silently)');
  }
  return out;
}

const RULE_EFFECTS = ['allow', 'lead', 'human'];

function normalizeRule(rule, at, roleIds, error) {
  if (!isObject(rule)) { error(at, 'a delegation rule must be an object'); return null; }
  let ok = true;
  const bad = (p, m) => { error(`${at}/${p}`, m); ok = false; };
  if (!RULE_EFFECTS.includes(rule.effect)) bad('effect', `must be one of ${RULE_EFFECTS.join(', ')}`);
  const out = { effect: rule.effect };
  if (rule.kind !== undefined) {
    if (typeof rule.kind !== 'string' || !rule.kind) bad('kind', 'must be a request kind such as "approval"');
    else out.kind = rule.kind;
  }
  if (rule.tools !== undefined) {
    if (!Array.isArray(rule.tools)) bad('tools', 'must be a list of tool names');
    else {
      out.tools = [];
      rule.tools.forEach((t, i) => {
        const parsed = typeof t === 'string' ? parseToolEntry(t) : { ok: false, message: 'must be a tool name' };
        if (!parsed.ok) bad(`tools/${i}`, parsed.message);
        else out.tools.push(parsed.tool.name);
      });
    }
  }
  if (rule.roles !== undefined) {
    if (!Array.isArray(rule.roles)) bad('roles', 'must be a list of role ids');
    else {
      rule.roles.forEach((r, i) => { if (!roleIds.has(r)) bad(`roles/${i}`, `"${r}" is not a role id`); });
      out.roles = rule.roles.filter((r) => roleIds.has(r));
    }
  }
  if (rule.subjectTypes !== undefined) {
    if (!Array.isArray(rule.subjectTypes) || rule.subjectTypes.some((s) => typeof s !== 'string' || !s)) bad('subjectTypes', 'must be a list of subject types');
    else out.subjectTypes = [...rule.subjectTypes];
  }
  if (rule.max !== undefined) {
    if (!Number.isInteger(rule.max) || rule.max < 1) bad('max', 'must be a whole number of at least 1');
    else out.max = rule.max;
  }
  if (rule.expires !== undefined) {
    if (typeof rule.expires !== 'string' || Number.isNaN(Date.parse(rule.expires))) bad('expires', 'must be a date such as "2026-12-31"');
    else out.expires = rule.expires;
  }
  for (const key of Object.keys(rule)) {
    if (!['effect', 'kind', 'tools', 'roles', 'subjectTypes', 'max', 'expires'].includes(key)) {
      bad(key, 'is not a delegation rule field');
    }
  }
  return ok ? out : null;
}

/** Each group's transitive predecessors (`after` chain). Loops are cut. */
function groupAncestors(groups) {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const out = new Map();
  for (const g of groups) {
    const seen = new Set();
    let cur = byId.get(g.after);
    while (cur && !seen.has(cur.id) && cur.id !== g.id) {
      seen.add(cur.id);
      cur = byId.get(cur.after);
    }
    out.set(g.id, seen);
  }
  return out;
}

function findGroupCycle(groups) {
  const byId = new Map(groups.map((g) => [g.id, g]));
  for (const g of groups) {
    const path = [g.id];
    let cur = byId.get(g.after);
    while (cur) {
      if (cur.id === g.id) return [...path, g.id];
      if (path.includes(cur.id)) break;
      path.push(cur.id);
      cur = byId.get(cur.after);
    }
  }
  return null;
}

function findReviewCycle(roles) {
  const byId = new Map(roles.map((r) => [r.id, r]));
  const edges = (r) => r.reviewerOf.map((t) => byId.get(t)).filter((t) => t && t.group === r.group && t.id !== r.id);
  const state = new Map();
  const stack = [];
  const visit = (r) => {
    state.set(r.id, 1);
    stack.push(r.id);
    for (const t of edges(r)) {
      if (state.get(t.id) === 1) return [...stack.slice(stack.indexOf(t.id)), t.id];
      if (!state.has(t.id)) { const c = visit(t); if (c) return c; }
    }
    stack.pop();
    state.set(r.id, 2);
    return null;
  };
  for (const r of roles) {
    if (!state.has(r.id)) { const c = visit(r); if (c) return c; }
  }
  return null;
}

/**
 * Role ids per stage, stages in dependency order (ties keep the design's order). Inside a
 * stage, reviewers come after the roles they review. Empty stages are left out.
 * @param {object} team a normalised team
 * @returns {string[][]}
 */
export function stageOrder(team) {
  const groups = team.groups ?? [];
  const done = new Set();
  const order = [];
  while (order.length < groups.length) {
    const next = groups.find((g) => !done.has(g.id) && (g.after === null || done.has(g.after) || !groups.some((x) => x.id === g.after)));
    if (!next) throw new Error('The stages form a loop; run normalizeTeam to see where');
    done.add(next.id);
    order.push(next.id);
  }
  return order
    .map((gid) => orderWithinStage(team.roles.filter((r) => r.group === gid)))
    .filter((ids) => ids.length);
}

function orderWithinStage(roles) {
  const ids = new Set(roles.map((r) => r.id));
  const placed = [];
  const remaining = [...roles];
  while (remaining.length) {
    const i = remaining.findIndex((r) => (r.reviewerOf ?? []).every((t) => !ids.has(t) || t === r.id || placed.includes(t)));
    if (i === -1) throw new Error('Reviewers in one stage review each other in a loop; run normalizeTeam to see where');
    placed.push(remaining[i].id);
    remaining.splice(i, 1);
  }
  return placed;
}
