#!/usr/bin/env node
// MAS Office kit — the team in Claude Code's status line, so the office is visible in the terminal too.
//   node .claude/mas-statusline.mjs              → statusLine: the current MAS, its phase and every role
//   node .claude/mas-statusline.mjs --subagents  → subagentStatusLine: each running role's own row
// Reads only the kit's data files (home/, <mas>/mas/, <mas>/outputs/). Never writes, never throws:
// on any problem it prints a short fallback line. No dependencies.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const C = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', cyan: '\x1b[36m' };
const paint = (color, text) => C[color] + text + C.reset;
const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/;

/** Parse a kit data file (`window.X = {...};` or `window.MAS_STATUS["id"] = {...};`) without running it. */
const MAX_BYTES = 256 * 1024; // data files are small; a huge one is ignored rather than read every 2 s
export function readData(file) {
  try {
    if (fs.statSync(file).size > MAX_BYTES) return null;
    const text = fs.readFileSync(file, 'utf8');
    // `window.X = {...};` or `window.MAS_STATUS = window.MAS_STATUS || {};\nwindow.MAS_STATUS["id"] = {...};`
    // Linear-time slicing (no regex backtracking on agent-written text): the object after the last `] =`, else the first `=`.
    const keyed = text.lastIndexOf('] ='), eq = keyed >= 0 ? keyed + 2 : text.indexOf('=');
    const start = eq < 0 ? -1 : text.indexOf('{', eq), end = text.lastIndexOf('}');
    if (start < 0 || end < start || /[^\s;]/.test(text.slice(end + 1))) return null;
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

const PHASES = { setup: 'Setting up', describe: '1 Describe', design: '2 Design', refine: '3 Refine & lock', locked: 'Locked — ready to run', running: 'Running', done: 'Done', failed: 'Failed' };
const MARK = { working: ['●', 'yellow'], waiting: ['○', 'dim'], handoff: ['→', 'cyan'], flagged: ['⚑', 'yellow'], done: ['✓', 'green'], failed: ['✗', 'red'], idle: ['·', 'dim'] };
// Text from data files is written by agents and may carry terminal control sequences (colours, cursor moves,
// OSC 8 links, title changes) or bidi overrides that disguise text. Keep printable text only, on one line.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
export const clean = (s) => String(s == null ? '' : s).replace(CONTROL, ' ').replace(/ {2,}/g, ' ').trim();
const short = (s, n) => { s = clean(s); const a = Array.from(s); return a.length > n ? a.slice(0, n - 1).join('') + '…' : s; };
const mark = (st) => (st && Object.prototype.hasOwnProperty.call(MARK, st.state) ? MARK[st.state] : MARK.idle);
const stateWord = (st) => (st && Object.prototype.hasOwnProperty.call(MARK, st.state) ? st.state : 'idle');
const emoji = (role) => { const e = Array.from(clean(role.emoji)).slice(0, 8).join(''); return e ? e + ' ' : ''; };
const link = (file, text) => '\x1b]8;;' + pathToFileURL(file).href + '\x1b\\' + text + '\x1b]8;;\x1b\\';
const bar = (p) => { const n = Math.round(Math.max(0, Math.min(100, p)) / 20); return '▰'.repeat(n) + '▱'.repeat(5 - n); };

/** Everything the status lines need about the current MAS, or a reason it is not there. */
export function loadTeam(root) {
  const home = readData(path.join(root, 'home/projects.js'));
  if (!home) return { none: fs.existsSync(path.join(root, 'SETUP.md')) ? 'setup' : 'missing' };
  const folder = home.current;
  if (!folder || typeof folder !== 'string' || !SAFE_ID.test(folder)) return { none: 'choose', count: (home.projects || []).length };
  const dir = path.join(root, folder);
  const structure = readData(path.join(dir, 'mas/structure.js'));
  const state = readData(path.join(dir, 'mas/state.js')) || {};
  const task = readData(path.join(dir, 'me/task.js'));
  const roles = structure && Array.isArray(structure.roles) ? structure.roles.filter((r) => r && SAFE_ID.test(String(r.id))) : [];
  const ids = ['lead'].concat(roles.map((r) => r.id));
  const statuses = {};
  for (const id of ids) statuses[id] = readData(path.join(dir, 'mas/status', id + '.js')) || null;
  const result = readData(path.join(dir, 'outputs/result.js'));
  return { folder, dir, title: (task && task.title) || (structure && structure.title) || folder, structure, state, roles, statuses, result };
}

function chip(role, st) {
  const [m, color] = mark(st);
  const p = st && st.state === 'working' && Number.isFinite(st.progress) ? ' ' + Math.round(st.progress) + '%' : '';
  return paint(color, m) + ' ' + emoji(role) + short(role.name || role.id, 18) + p;
}

/** The main status line: up to two rows. */
export function mainLines(team, root) {
  if (team.none === 'setup') return [paint('bold', 'MAS Office kit') + paint('dim', ' · say: Read SETUP.md and set this folder up.')];
  if (team.none === 'missing') return [paint('bold', 'MAS Office') + paint('dim', ' · no kit files here')];
  if (team.none === 'choose') return [paint('bold', 'MAS Office') + paint('dim', ' · ' + (team.count || 0) + ' MAS here · choose one in the chat, or type new')];
  const { state, roles, statuses, structure } = team;
  const phase = Object.prototype.hasOwnProperty.call(PHASES, state.phase) ? PHASES[state.phase] : state.step ? 'Step ' + short(state.step, 6) : '';
  const done = roles.filter((r) => statuses[r.id] && ['done', 'failed'].includes(statuses[r.id].state)).length;
  const flags = ['lead'].concat(roles.map((r) => r.id)).filter((id) => statuses[id] && statuses[id].state === 'flagged').length;
  const office = path.join(root, 'office/index.html');
  const top = [paint('bold', 'MAS ' + short(team.folder, 28)), short(team.title, 40), phase && paint(state.phase === 'failed' ? 'red' : state.phase === 'done' ? 'green' : 'cyan', phase)];
  if (roles.length && ['running', 'done', 'failed', 'locked'].includes(state.phase)) top.push(done + '/' + roles.length + ' roles done');
  if (flags) top.push(paint('yellow', '⚑ ' + flags + (flags > 1 ? ' flags' : ' flag')));
  if (team.result && state.phase === 'done') top.push(paint('green', link(office, 'result ready ▸ open office')));
  else top.push(paint('dim', link(office, 'office ▸')));
  const lines = [top.filter(Boolean).join(paint('dim', ' · '))];
  if (!roles.length) return lines;
  const lead = statuses.lead;
  const parts = [paint('bold', '🧭 Lead') + (lead && lead.say ? ' ' + paint('dim', short(lead.say, 34)) : '')];
  const groups = structure && Array.isArray(structure.groups) && structure.groups.length ? structure.groups.map((g) => g.id) : [null];
  for (const g of groups) {
    const members = roles.filter((r) => g === null || r.group === g);
    if (members.length) parts.push((g ? paint('dim', short(g, 4) + ' ') : '') + members.map((r) => chip(r, statuses[r.id])).join('  '));
  }
  const loose = roles.filter((r) => groups[0] !== null && !groups.includes(r.group));
  if (loose.length) parts.push(loose.map((r) => chip(r, statuses[r.id])).join('  '));
  lines.push(parts.join(paint('dim', ' │ ')));
  return lines;
}

/** Which role a Claude Code subagent row belongs to: by its name, then by role id or name in its description. */
export function matchRole(task, roles) {
  const hay = [task.name, task.description, task.label].filter(Boolean).join(' ').toLowerCase();
  if (!hay) return null;
  const byId = roles.find((r) => task.name && String(task.name).toLowerCase() === r.id);
  if (byId) return byId;
  const scored = roles.map((r) => ({ r, hit: hay.includes(r.id) || (r.name && hay.includes(String(r.name).toLowerCase())) }))
    .filter((x) => x.hit);
  return scored.length === 1 ? scored[0].r : null;
}

/** One JSON line per subagent row that belongs to a role of the current MAS. */
export function subagentLines(team, input) {
  if (team.none || !Array.isArray(input.tasks)) return [];
  const width = Number(input.columns) || 100;
  const out = [];
  for (const task of input.tasks) {
    const role = task && task.id ? matchRole(task, team.roles) : null;
    if (!role) continue;
    const st = team.statuses[role.id] || {};
    const [m, color] = mark(st);
    const p = Number.isFinite(st.progress) ? ' ' + bar(st.progress) + ' ' + Math.round(st.progress) + '%' : '';
    const room = Math.max(20, width - 60);
    const say = st.state === 'flagged' && st.flag ? paint('yellow', short(st.flag, room)) : st.say ? short(st.say, room) : '';
    const tokens = Number.isFinite(task.tokenCount) ? paint('dim', ' · ' + (task.tokenCount / 1000).toFixed(1) + 'k tok') : '';
    const head = paint(color, m) + ' ' + emoji(role) + paint('bold', short(role.name || role.id, 30)) + paint('dim', ' · ' + stateWord(st)) + p;
    out.push(JSON.stringify({ id: task.id, content: head + (say ? paint('dim', ' · ') + say : '') + tokens }));
  }
  return out;
}

function main() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch { input = {}; }
  const ws = input.workspace || {};
  const root = ws.project_dir || ws.current_dir || input.cwd || process.cwd();
  try {
    const team = loadTeam(root);
    const lines = process.argv.includes('--subagents') ? subagentLines(team, input) : mainLines(team, root);
    if (lines.length) process.stdout.write(lines.join('\n') + '\n');
  } catch {
    if (!process.argv.includes('--subagents')) process.stdout.write('MAS Office\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) main();
