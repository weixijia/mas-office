// Test helpers: a workspace on disk, a log-backed stand-in for the server, and scripted backends.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectLog } from 'mas-office';
import { lockTeam } from 'mas-office/team';

export const tmpDir = (prefix = 'mas-runtime-') => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 4000, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(5);
  }
}

export const TEAM = {
  title: 'Headphone deals',
  version: 2,
  topology: 'staged',
  lead: { id: 'lead', name: 'Lead', emoji: '🧭', job: 'Write the shortlist' },
  groups: [{ id: 'A', label: 'Search', after: null }, { id: 'B', label: 'Check', after: 'A' }],
  roles: [
    { id: 'finder-a', name: 'Retail finder', job: 'Search retailers', group: 'A', handsTo: 'checker', tools: ['web search'] },
    { id: 'finder-b', name: 'Market finder', job: 'Search marketplaces', group: 'A', handsTo: 'checker', tools: [{ name: 'web search', effect: 'ask' }] },
    { id: 'checker', name: 'Catch checker', job: 'Check the offers', group: 'B', handsTo: 'lead', tools: ['web search'], reviewerOf: ['finder-a', 'finder-b'], cleanContext: true },
  ],
};

/** A workspace with one project whose team design is `team` (locked). */
export function workspaceWith(team = TEAM, { project = 'deals', lock = true } = {}) {
  const ws = tmpDir();
  const structure = lock ? lockTeam(structuredClone(team)) : structuredClone(team);
  fs.mkdirSync(path.join(ws, project, 'mas'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'home'), { recursive: true });
  fs.writeFileSync(path.join(ws, project, 'mas', 'structure.json'), JSON.stringify(structure));
  return { ws, project, dir: path.join(ws, project), structure };
}

/** What the engine needs from `startServer`: one log per project, `emit` and `log`. */
export function fakeServer(ws) {
  const logs = new Map();
  const log = (project) => {
    if (!logs.has(project)) logs.set(project, new ProjectLog(ws, project));
    return logs.get(project);
  };
  const events = [];
  return {
    events,
    log,
    emit(project, batch) {
      const result = log(project).append(batch);
      events.push(...result.events);
      return result;
    },
    clients: () => 1,
  };
}

let cmd = 0;
/** Send a command the way the server would: log it first, then hand it to the runtime. */
export async function command(server, rt, project, type, agentId, data, origin = { kind: 'human' }) {
  cmd += 1;
  const [event] = server.emit(project, [{ type, agentId, data: { cmdId: `cmd_t${cmd}`, origin, ...data } }]).events;
  await rt.handleCommand(event);
  return server.log(project).snapshot().inbox.commands.find((c) => c.cmdId === event.data.cmdId);
}

export const pendingOf = (server, project) => server.log(project).snapshot().inbox.pending;

/** Answer the first pending request matching `match` by choosing `optionId` (or submitting `text`). */
export async function answer(server, rt, project, match, { optionId, text } = {}) {
  const request = await waitFor(() => pendingOf(server, project).find(match), { what: 'a matching request' });
  const data = text !== undefined
    ? { requestId: request.requestId, outcome: 'submitted', payload: { text } }
    : { requestId: request.requestId, outcome: 'selected', optionId };
  return { request, ack: await command(server, rt, project, 'command.respond', request.agentId, data) };
}

export const OPTIONS = [
  { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
];

/**
 * Backends whose sessions are driven by `script({agentId, text, sink, spec, backend, turnNo})`.
 * The script returns the turn's final text (or a full TurnResult). `sessions` records every start.
 */
export function fakeBackends(script, names = ['claude-code', 'codex']) {
  const record = { starts: [], sent: [], turns: [] };
  let n = 0;
  const make = (name) => ({
    name,
    probe: async () => ({ available: true, loggedIn: true, version: 'fake' }),
    async start(spec, sink) {
      n += 1;
      const id = spec.resume ?? `${name}-${spec.agentId}-${n}`;
      record.starts.push({ agentId: spec.agentId, backend: name, id, resume: spec.resume ?? null, spec });
      let state = 'idle';
      let cancel = null;
      let turnNo = 0;
      sink.event('agent.registered', { backend: name, session: { backend: name, id, resumable: true }, accepts: ['message', 'respond', 'interrupt', 'assign'] });
      return {
        id,
        get state() { return state; },
        async turn(text) {
          turnNo += 1;
          record.turns.push({ agentId: spec.agentId, text, turnNo });
          state = 'running';
          sink.event('agent.status', { state: 'working' });
          const cancelled = new Promise((resolve) => { cancel = () => resolve({ ok: false, text: '', stopReason: 'cancelled' }); });
          const out = await Promise.race([
            Promise.resolve().then(() => script({ agentId: spec.agentId, text, sink, spec, backend: name, turnNo })),
            cancelled,
          ]);
          cancel = null;
          state = 'idle';
          const result = typeof out === 'string' ? { ok: true, text: out, stopReason: 'end_turn' } : out;
          sink.event('agent.status', { state: 'idle', ...(result.stopReason !== 'end_turn' && { stopReason: result.stopReason }) });
          return result;
        },
        async send(text, delivery) {
          record.sent.push({ agentId: spec.agentId, text, delivery });
          return { status: 'applied', reason: delivery === 'steer' ? 'delivered at the next break' : undefined };
        },
        async interrupt() { cancel?.(); },
        async close() { cancel?.(); state = 'closed'; },
      };
    },
    close: async () => {},
  });
  return { backends: Object.fromEntries(names.map((name) => [name, make(name)])), record };
}

export const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

export const card = ({ title, url, grade = 'A', by }) => `---\ntitle: ${title}\nurl: ${url}\nevidence: ${grade}\nfound by: ${by}\n---\n> "£279.00"\n\nRelevance: R1\n`;

export const json = (value) => `\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
