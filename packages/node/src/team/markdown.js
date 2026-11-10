// The human-readable view of a team design (`mas/structure.md`), in the kit's format
// (kit/harness/formats.md) plus the v2 lines. Fields the Markdown does not show are kept in
// `mas/structure.js`, which stays the complete record.

import { summarizeRule } from '../policy/delegate.js';
import { stageOrder } from './normalize.js';

const join = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

function toolsLine(tools) {
  if (!tools?.length) return 'none';
  return tools.map((t) => (t.effect === 'allow' ? t.name : `${t.name} (${t.effect})`)).join(' · ');
}

/**
 * Markdown for a normalised team.
 * @param {object} team normalizeTeam(...).team
 */
export function teamToMarkdown(team) {
  const nameOf = (id) => (id === 'lead' ? team.lead.name || 'Lead' : team.roles.find((r) => r.id === id)?.name ?? id);
  const heading = (emoji, text) => (emoji ? `${emoji} ${text}` : text);
  const lines = [];
  const lead = team.lead;
  lines.push(`# ${heading(lead.emoji, `${team.title ?? 'Team'} — ${lead.name || 'Lead'}`)}`);
  if (lead.job) lines.push(`- job: ${lead.job}`);
  if (lead.serves?.length) lines.push(`- serves: ${lead.serves.join(', ')}`);
  lines.push(`- backend: ${lead.backend}${lead.model ? ` (${lead.model})` : ''}`);
  if (lead.tools?.length) lines.push(`- tools: ${toolsLine(lead.tools)}`);
  for (const rule of lead.delegate ?? []) lines.push(`- delegate: ${summarizeRule(rule, team)}`);

  let order;
  try { order = stageOrder(team).flat(); } catch { order = team.roles.map((r) => r.id); }
  const roles = order.map((id) => team.roles.find((r) => r.id === id)).filter(Boolean);
  for (const r of team.roles) if (!roles.includes(r)) roles.push(r);
  for (const role of roles) {
    lines.push(`## ${heading(role.emoji, role.name)}`);
    if (role.serves?.length) lines.push(`- serves: ${role.serves.join(', ')}`);
    if (role.job) lines.push(`- job: ${role.job}`);
    if (role.output) lines.push(`- output: ${role.output}`);
    if (role.why) lines.push(`- why: ${role.why}`);
    lines.push(`- backend: ${role.backend}${role.model ? ` (${role.model})` : ''}`);
    lines.push(`- tools: ${toolsLine(role.tools)}`);
    if (role.reviewerOf?.length) {
      lines.push(`- reviewer of: ${join(role.reviewerOf.map(nameOf))}`);
      lines.push(`- clean context: ${role.cleanContext ? 'yes (sees only work files and source cards)' : 'no'}`);
      if (role.review) lines.push(`- review: up to ${role.review.maxRounds} round${role.review.maxRounds === 1 ? '' : 's'}, then ask me`);
    }
    if (role.unknownTools === 'deny') lines.push('- other tools: refused without asking');
    lines.push(`- group: ${role.group}`);
    lines.push(`- hands to: ${nameOf(role.handsTo)}`);
  }

  if (team.groups.length) {
    lines.push('## Stages');
    for (const g of team.groups) {
      lines.push(`- ${g.id}${g.label ? ` ${g.label}` : ''} (${g.after ? `after ${g.after}` : 'first'})`);
    }
  }
  if (team.gates.length) {
    lines.push('## Gates');
    for (const g of team.gates) {
      const where = g.kind === 'stage' ? `after ${g.after}` : g.kind;
      lines.push(`- ${where}: ${g.title || 'check with me'}${g.blocking ? '' : ' (just a note, does not wait)'}`);
    }
  }
  const b = team.budget;
  lines.push('## Budget');
  lines.push(`- up to ${b.maxParallel} agent${b.maxParallel === 1 ? '' : 's'} at once · ${b.maxTurnMinutes} min per turn · ${b.maxRunMinutes} min per run · ${b.maxQuestionsPerRole} question${b.maxQuestionsPerRole === 1 ? '' : 's'} to me per role · stalled after ${b.stallMinutes} min`);
  const v = team.verify;
  lines.push('## Checks');
  lines.push(`- claims: ${v.claims ? 'yes' : 'no'} · links checked: ${v.urlHealth ? 'yes' : 'no'}`);
  lines.push(`- flag for me when: ${v.flagWhen.contradicted}+ contradicted · ${Math.round(v.flagWhen.unknownShare * 100)}%+ unchecked · ${v.flagWhen.hallucinated}+ made-up link${v.flagWhen.hallucinated === 1 ? '' : 's'}`);
  if (team.locked) lines.push(`\nLocked${team.signature ? ` · ${team.signature.slice(0, 19)}…` : ''}`);
  return `${lines.join('\n')}\n`;
}
