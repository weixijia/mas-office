// Structure signature: a hash of everything that changes how the team behaves, so a run or a
// checkpoint can tell whether the team was redesigned. Cosmetic fields (title, names, emoji,
// why, serves, labels, rationale, gate titles) are left out, so renaming a role keeps it.

import { createHash } from 'node:crypto';
import { normalizeTeam } from './normalize.js';

/** JSON with object keys sorted at every level; arrays keep their order. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The part of a normalised team that determines behaviour. */
export function behaviourOf(team) {
  return {
    topology: team.topology,
    budget: team.budget,
    verify: team.verify,
    lead: {
      job: team.lead.job, backend: team.lead.backend, model: team.lead.model,
      tools: team.lead.tools, delegate: team.lead.delegate,
    },
    groups: team.groups.map((g) => ({ id: g.id, after: g.after })),
    roles: team.roles.map((r) => ({
      id: r.id, job: r.job, output: r.output, group: r.group, handsTo: r.handsTo,
      backend: r.backend, model: r.model, tools: r.tools, reviewerOf: r.reviewerOf,
      cleanContext: r.cleanContext, review: r.review ?? null, unknownTools: r.unknownTools,
    })),
    gates: team.gates.map((g) => ({ id: g.id, after: g.after, kind: g.kind, blocking: g.blocking })),
  };
}

function normalized(structure) {
  const { team, problems } = normalizeTeam(structure);
  if (!team) throw new Error(problems.map((p) => p.message).join('; '));
  return team;
}

/**
 * `sha256:<hex>` over the canonical JSON of what determines behaviour. Accepts a raw
 * structure or a normalised team (defaults are applied first, so both give the same hash).
 */
export function signTeam(team) {
  const canonical = canonicalJson(behaviourOf(normalized(team)));
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

/**
 * Lock a design: returns a copy with `locked: true` and `signature`. Nothing else changes.
 * Refuses a design with errors (thrown Error with `problems`), e.g. a tool outside the vocabulary.
 * @param {object} structure
 * @param {object} [env] the workspace, as for normalizeTeam
 */
export function lockTeam(structure, env) {
  const { team, problems } = normalizeTeam(structure, env);
  const errors = problems.filter((p) => p.level === 'error');
  if (!team || errors.length) {
    const err = new Error(`The team cannot be locked: ${errors.map((p) => `${p.path || '(root)'}: ${p.message}`).join('; ')}`);
    err.problems = problems;
    throw err;
  }
  return { ...structure, locked: true, signature: signTeam(team) };
}

/** Does the structure's `signature` match its content? False when missing or the design is broken. */
export function verifySignature(structure) {
  if (!structure || typeof structure.signature !== 'string') return false;
  try {
    return signTeam(structure) === structure.signature;
  } catch {
    return false;
  }
}
