// mas-office-runtime: drive a MAS Office team of real Claude Code and Codex sessions.
//
// `createRuntime` is what `mas-office serve` attaches to turn the viewer into a control room:
// it owns the sessions, applies commands and runs the locked team. `up` wires it all together.

import fs from 'node:fs';
import path from 'node:path';
import { isValidFolder } from 'mas-office';
import { createProjectRuntime, RunError } from './engine/project.js';
import { semaphore } from './engine/util.js';
import { createClaudeBackend } from './backends/claude.js';
import { createCodexBackend } from './backends/codex.js';

export { createProjectRuntime, RunError, ANSWER_FILE } from './engine/project.js';
export { createBroker } from './engine/broker.js';
export { extractJson, semaphore } from './engine/util.js';
export { createClaudeBackend } from './backends/claude.js';
export { createCodexBackend } from './backends/codex.js';
export { childEnv } from './backends/types.js';

const IDLE_CHECK_MS = 60_000;
const IDLE_LIMIT_MS = 30 * 60_000;

/** Ask each backend whether its official program is installed and signed in. */
export async function probeBackends(backends) {
  const entries = await Promise.all(Object.entries(backends).map(async ([name, backend]) => {
    try {
      return [name, await backend.probe()];
    } catch (err) {
      return [name, { available: false, detail: err.message }];
    }
  }));
  return Object.fromEntries(entries);
}

/**
 * @param {object} deps
 * @param {string} deps.workspace
 * @param {object} deps.server what `startServer` returned (`emit`, `log`, `clients`)
 * @param {Record<string, object>} [deps.backends] name → AgentBackend (default: Claude Code and Codex)
 * @param {object} [deps.probes] what `probeBackends` reported, shown to the panel
 * @param {{maxParallel?: number, idleLimitMs?: number}} [deps.options]
 */
export function createRuntime({ workspace, server, backends, probes = {}, options = {} }) {
  const root = path.resolve(workspace);
  const all = backends ?? { 'claude-code': createClaudeBackend(), codex: createCodexBackend() };
  // Only backends that are installed and signed in may be used; the rest are reported, not hidden.
  const usable = Object.fromEntries(Object.entries(all).filter(([name]) => probes[name]?.available !== false && probes[name]?.loggedIn !== false));
  /** @type {Map<string, ReturnType<typeof createProjectRuntime>>} */
  const projects = new Map();
  let idleSince = Date.now();
  // One limit for the whole daemon: three projects do not get three times the sessions.
  const pool = semaphore(Math.max(1, options.maxParallel ?? 3));

  function projectRuntime(project) {
    if (!isValidFolder(project) || !fs.existsSync(path.join(root, project))) {
      throw new RunError('no_project', `No project folder "${project}" in this workspace.`);
    }
    let rt = projects.get(project);
    if (!rt) {
      rt = createProjectRuntime({ workspace: root, project, server, backends: usable, options: { ...options, pool } });
      projects.set(project, rt);
    }
    return rt;
  }

  // A forgotten daemon must not keep sessions (and a subscription) busy: with nobody watching and
  // nothing running for a while, the sessions are closed. They resume by id when needed again.
  const idle = setInterval(() => {
    const busy = [...projects.values()].some((p) => p.active);
    if (busy || (server.clients?.() ?? 0) > 0) {
      idleSince = Date.now();
      return;
    }
    if (Date.now() - idleSince > (options.idleLimitMs ?? IDLE_LIMIT_MS)) {
      for (const p of projects.values()) p.close().catch(() => {});
      projects.clear();
      idleSince = Date.now();
    }
  }, IDLE_CHECK_MS);
  idle.unref?.();

  return {
    info: () => ({
      backends: Object.fromEntries(Object.entries(all).map(([name]) => [name, {
        available: probes[name]?.available !== false,
        loggedIn: probes[name]?.loggedIn !== false,
        ...(probes[name]?.version && { version: probes[name].version }),
      }])),
      maxParallel: options.maxParallel ?? 3,
    }),
    handleCommand: (project, event) => projectRuntime(project).handleCommand(event),
    /** Whether a request is still waited on here (the server asks before accepting an answer). */
    waitsOn: (project, requestId) => Boolean(projects.get(project)?.waitsOn(requestId)),
    async startRun(project, body) {
      const { runId, round } = await projectRuntime(project).startRun(body);
      return { runId, ...(round && { round }) };
    },
    /** For callers that want to wait for the run (the CLI's `--task`, tests). */
    run: (project, body) => projectRuntime(project).startRun(body),
    stop: (project, reason) => projects.get(project)?.stop(reason),
    /** Continue what a previous daemon left unfinished in every project of the workspace. */
    recover() {
      const out = {};
      for (const name of fs.readdirSync(root)) {
        if (!isValidFolder(name) || !fs.existsSync(path.join(root, name, 'mas', 'events.jsonl'))) continue;
        try { out[name] = projectRuntime(name).recover(); } catch (err) { out[name] = { error: err.message }; }
      }
      return out;
    },
    async close() {
      clearInterval(idle);
      await Promise.all([...projects.values()].map((p) => p.close().catch(() => {})));
      await Promise.all(Object.values(all).map((b) => b.close?.().catch(() => {})));
    },
  };
}

/**
 * `mas-office up`: serve the workspace with a runtime attached.
 * `printUrl: false` leaves out the panel link with its token (a parent process that read the token from
 * `--json` mode passes it on itself; the token must not land in a log).
 * @param {{workspace: string, port?: number, host?: string, maxParallel?: number, startServer: Function,
 *   backends?: object, out?: (line: string) => void, printUrl?: boolean}} options
 */
export async function up({
  workspace, port = 4747, host = '127.0.0.1', maxParallel = 3, startServer, backends, out = console.log, printUrl = true,
}) {
  const all = backends ?? { 'claude-code': createClaudeBackend(), codex: createCodexBackend() };
  const probes = await probeBackends(all);
  const server = await startServer({ workspace, port, host });
  const runtime = createRuntime({ workspace, server, backends: all, probes, options: { maxParallel } });
  server.attach(runtime);
  const recovered = runtime.recover();

  const label = { 'claude-code': 'Claude Code', codex: 'Codex' };
  const hint = { 'claude-code': 'claude auth login', codex: 'codex login' };
  out(`MAS Office is running the team in ${path.resolve(workspace)}`);
  for (const [name, p] of Object.entries(probes)) {
    if (!p.available) out(`  ${label[name] ?? name}: not installed${p.detail ? ` (${p.detail})` : ''}`);
    else if (p.loggedIn === false) out(`  ${label[name] ?? name} ${p.version ?? ''}: not signed in. Sign in yourself with: ${hint[name] ?? 'its own login command'}`);
    else out(`  ${label[name] ?? name} ${p.version ?? ''}: ready (your own sign-in; MAS Office never sees it)`);
  }
  out(`  At most ${maxParallel} roles work at once (plus the Lead). Each session uses your own plan's limits.`);
  for (const [name, r] of Object.entries(recovered)) {
    if (r.resumed) out(`  ${name}: a run was cut off. The panel asks whether to continue it.`);
    else if (r.expired) out(`  ${name}: ${r.expired} request(s) from a stopped session were closed.`);
  }
  if (printUrl) {
    out(`  Panel: ${server.url}/office/?token=${server.token}`);
    out('         (the token lets this browser answer requests and message agents; keep the link to yourself)');
  } else {
    out(`  Serving on ${server.url}`);
  }
  return {
    server,
    runtime,
    probes,
    async close() {
      await runtime.close();
      await server.close();
    },
  };
}
