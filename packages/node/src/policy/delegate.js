// Delegated approvals (`lead.delegate[]`, docs/design/runtime.md §5): who answers a request that
// `decideTool` sent to `ask`. First matching rule wins; no match means the person.
// `allow` = the policy answers at once (`by: policy`); `lead` = the Lead session answers;
// `human` = the request waits in the inbox. Gates, flags and `resolver: human_only` requests always
// go to the person, whatever the rules say.

import { canonicalJson } from '../team/sign.js';
import { subjectMatchesWord } from '../team/subject.js';

const ALWAYS_HUMAN_KINDS = new Set(['gate', 'flag']);

/** The counter key for a rule with `max`. The caller keeps `counters[key]` and adds 1 each time the rule is applied. */
export const countKey = (rule) => `delegate:${canonicalJson(rule)}`;

/** When a rule stops applying. A date without a time lasts to the end of that day (UTC). */
function expiresAt(expires) {
  if (typeof expires !== 'string') return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(expires);
  const t = Date.parse(dateOnly ? `${expires}T23:59:59.999Z` : expires);
  return Number.isNaN(t) ? -Infinity : t;
}

/**
 * @param {object} team a normalised team
 * @param {{kind: string, subject?: object, resolver?: string, agentId?: string, data?: object}} request
 *   the `request.opened` data plus the requesting `agentId` (an event envelope `{agentId, data}` works too)
 * @param {Record<string, number>} [counters] uses so far per `countKey(rule)`
 * @param {{now?: number|Date, project?: string, home?: string}} [options] `project` (and `home`) let
 *   path words match: `read my files` and `write notes` rules never match without `project`.
 * @returns {{effect: 'allow'|'lead'|'human', rule: object|null, index: number, key: string|null, reason: string}}
 */
export function matchDelegation(team, request, counters = {}, { now = Date.now(), project, home } = {}) {
  const req = request?.data && typeof request.data === 'object' ? { ...request.data, agentId: request.agentId ?? request.data.agentId } : (request ?? {});
  const human = (reason) => ({ effect: 'human', rule: null, index: -1, key: null, reason });
  if (ALWAYS_HUMAN_KINDS.has(req.kind)) return human(`A ${req.kind} always goes to you`);
  if (req.resolver === 'human_only') return human('Only you may answer this request');
  const time = now instanceof Date ? now.getTime() : Number(now);
  const rules = Array.isArray(team?.lead?.delegate) ? team.lead.delegate : [];
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (!rule || !['allow', 'lead', 'human'].includes(rule.effect)) continue;
    if (rule.expires !== undefined && time > expiresAt(rule.expires)) continue;
    const key = countKey(rule);
    if (rule.max !== undefined && (counters[key] ?? 0) >= rule.max) continue;
    if (rule.kind !== undefined && rule.kind !== req.kind) continue;
    if (rule.roles !== undefined && !rule.roles.includes(req.agentId)) continue;
    const subject = req.subject && typeof req.subject === 'object' ? req.subject : null;
    if (rule.subjectTypes !== undefined && !rule.subjectTypes.includes(subject?.type)) continue;
    if (rule.tools !== undefined && !rule.tools.some((name) => subjectMatchesWord(subject, name, { project, home, agentId: req.agentId }))) continue;
    return { effect: rule.effect, rule, index, key, reason: summarizeRule(rule, team) };
  }
  return human('No delegation rule covers this request');
}

const join = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

const KIND_WORDS = { approval: 'approval requests', question: 'questions', decision: 'decisions' };

/**
 * One English sentence for the UI, e.g.
 * "The Lead may approve web search for Retail finder, up to 20 times."
 * @param {object} rule
 * @param {object} [team] to show role names instead of ids
 */
export function summarizeRule(rule, team) {
  const nameOf = (id) => team?.roles?.find((r) => r.id === id)?.name ?? id;
  const tools = rule.tools?.length ? join(rule.tools) : null;
  const kind = rule.kind ? (KIND_WORDS[rule.kind] ?? `${rule.kind} requests`) : null;
  const types = rule.subjectTypes?.length ? ` about ${join(rule.subjectTypes.map((t) => t.replace(/_/g, ' ')))}` : '';
  let what;
  if (tools) what = tools;
  else if (kind) what = `${kind}${types}`;
  else what = `every request${types}`;
  const verb = !rule.kind || rule.kind === 'approval' ? 'approve' : 'answer';
  let sentence;
  if (rule.effect === 'allow') sentence = `${tools ? `Approve ${what}` : `Answer ${what}`} automatically`;
  else if (rule.effect === 'lead') sentence = `The Lead may ${verb} ${what}`;
  else sentence = `Always ask me about ${what}`;
  if (rule.roles?.length) sentence += ` for ${join(rule.roles.map(nameOf))}`;
  if (rule.max !== undefined) sentence += `, up to ${rule.max} time${rule.max === 1 ? '' : 's'}`;
  if (rule.expires !== undefined) sentence += `, until ${rule.expires}`;
  return `${sentence}.`;
}
