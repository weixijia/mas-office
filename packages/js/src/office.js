// The public SDK: Office → Project → Run → Agent handles that emit MAS Office events.

import { randomUUID } from 'node:crypto';
import { SPEC_VERSION } from './reducer.js';
import { eventErrors } from './log.js';
import { assertFolder, isValidAgentId } from './names.js';
import { FileTransport, HttpTransport, warner } from './transports.js';

const idOf = (agent) => (agent instanceof Agent ? agent.id : agent);

export class Office {
  #projects = new Map();
  #warn = warner();

  /**
   * @param {object} options
   * @param {string} [options.workspace] file transport: write the workspace folder in this process
   * @param {string} [options.url] HTTP transport: send events to `mas-office serve` at this URL
   * @param {typeof fetch} [options.fetch] HTTP transport: custom fetch (tests, proxies)
   */
  constructor({ workspace, url, fetch } = {}) {
    if (workspace && url) throw new TypeError('Pass either "workspace" or "url" to new Office(), not both.');
    if (url) this.transport = new HttpTransport(url, { fetch });
    else if (workspace) this.transport = new FileTransport(workspace);
    else throw new TypeError('new Office() needs { workspace: "./runs" } or { url: "http://127.0.0.1:4747" }.');
  }

  /**
   * Open (or reuse) a project folder.
   * @param {string} folder `[a-z0-9-]`, 1–40 characters
   * @param {{title?: string, task?: {summary?: string, requirements?: {id: string, text: string}[]}}} [options]
   */
  project(folder, options = {}) {
    assertFolder(folder);
    let project = this.#projects.get(folder);
    if (!project) {
      project = new Project(this, folder, options);
      this.#projects.set(folder, project);
      this.transport.open(folder, options);
    }
    return project;
  }

  /** Send everything still queued (HTTP transport). Safe to call more than once. */
  async close() {
    await this.transport.close();
  }

  /** @internal */
  _send(folder, event) {
    let clean;
    try {
      clean = JSON.parse(JSON.stringify({ v: SPEC_VERSION, ts: new Date().toISOString(), ...event }));
    } catch (err) {
      this.#warn('json', `dropping a "${event.type}" event that is not JSON-serialisable (${err.message}).`);
      return;
    }
    const errors = eventErrors({ ...clean, seq: 1 });
    if (errors.length) {
      this.#warn(`invalid:${event.type}`, `dropping an invalid "${event.type}" event: ${errors.join('; ')}.`);
      return;
    }
    this.transport.send(folder, clean);
  }
}

export class Project {
  constructor(office, folder, { title } = {}) {
    this.office = office;
    this.folder = folder;
    this.title = title;
  }

  /**
   * Start a run (emits `run.started`). Without a structure the team is dynamic:
   * agents appear as they first act.
   * @param {{structure?: object, title?: string, runId?: string}} [options]
   */
  run({ structure, title, runId } = {}) {
    return new Run(this, { structure, title: title ?? this.title, runId });
  }

  /** Low-level: emit any event (`seq`, `v` and `ts` are filled in). */
  emit(event) {
    this.office._send(this.folder, event);
  }
}

export class Run {
  #agents = new Map();
  #known;
  #calls = 0;

  constructor(project, { structure, title, runId }) {
    this.project = project;
    this.id = runId ?? `run-${randomUUID().slice(0, 8)}`;
    this.lead = new Agent(this, 'lead', {});
    this.#agents.set('lead', this.lead);
    this.emit('lead', 'run.started', { title, structure });
    // Without a structure the run keeps the previous one; the file transport knows it.
    const known = structure ?? project.office.transport.snapshot?.(project.folder)?.structure;
    const roles = Array.isArray(known?.roles) ? known.roles : [];
    this.#known = new Set(['lead', ...roles.map((r) => r?.id)]);
  }

  /**
   * Get the handle of an agent. Agents not in the run's structure are registered
   * (`agent.registered`) the first time they emit anything.
   * @param {string} id `[a-z0-9-]`, up to 64 characters
   * @param {{name?: string, emoji?: string, job?: string, group?: string, handsTo?: string, parent?: string|Agent, role?: string}} [options]
   */
  agent(id, options = {}) {
    if (id === 'lead') return this.lead;
    if (!isValidAgentId(id)) throw new TypeError(`Invalid agent id ${JSON.stringify(id)}: use lowercase letters, digits and dashes.`);
    let agent = this.#agents.get(id);
    if (!agent) {
      agent = new Agent(this, id, options);
      this.#agents.set(id, agent);
    }
    return agent;
  }

  /** The lead posts the final answer. Sources and flags collected during the run are merged in. */
  result({ title, markdown, sources, flags, work } = {}) {
    this.emit('lead', 'result', { title, markdown, sources, flags, work });
    return this;
  }

  finish(say) {
    this.emit('lead', 'run.finished', { say });
    return this;
  }

  fail(reason) {
    this.emit('lead', 'run.failed', { reason });
    return this;
  }

  /** @internal */
  emit(agentId, type, data = {}, extra = {}) {
    this.project.emit({ runId: this.id, type, agentId, ...extra, data });
  }

  /** @internal true the first time an unknown agent asks */
  _claim(id) {
    if (this.#known.has(id)) return false;
    this.#known.add(id);
    return true;
  }

  /** @internal */
  _callId(name) {
    this.#calls += 1;
    return `${name}-${this.#calls}`;
  }
}

export class Agent {
  #run;
  #options;

  constructor(run, id, options) {
    this.#run = run;
    this.id = id;
    this.#options = options;
  }

  /** Emit `agent.registered` now if this agent is not known yet (otherwise automatic). */
  register() {
    if (this.#run._claim(this.id)) {
      const { name, emoji, job, group, handsTo, role, parent } = this.#options;
      this.#run.emit(this.id, 'agent.registered', { name, emoji, job, group, handsTo, role },
        { agentName: name, parentId: idOf(parent) });
    }
    return this;
  }

  #emit(type, data) {
    this.register();
    this.#run.emit(this.id, type, data);
    return this;
  }

  /** Any of the seven states: idle, waiting, working, handoff, flagged, done, failed. */
  status(state, { say, progress, to, flag, flagKind } = {}) {
    return this.#emit('agent.status', { state, say, progress, to: idOf(to), flag, flagKind });
  }

  working(say, { progress } = {}) {
    return this.status('working', { say, progress });
  }

  /** A short line of what the agent says or did (`message`). */
  say(text, { to } = {}) {
    return this.#emit('message', { text, to: idOf(to) });
  }

  /**
   * Run `fn` as a tool call: emits `tool.started`, then `tool.finished` or `tool.failed`.
   * Returns what `fn` returns; errors from `fn` are re-thrown.
   */
  async tool(name, fn, { say, callId } = {}) {
    const id = callId ?? this.#run._callId(name);
    this.#emit('tool.started', { name, say, callId: id });
    try {
      const value = await fn();
      this.#emit('tool.finished', { name, callId: id });
      return value;
    } catch (err) {
      this.#emit('tool.failed', { name, callId: id, error: String(err?.message ?? err) });
      throw err;
    }
  }

  /** Record an evidence card: `{id, title?, url?, evidence?: 'A'|'B'|'C'|'D'}`. */
  source(source) {
    return this.#emit('artifact', { kind: 'source', source });
  }

  handoff(to, { say, reason } = {}) {
    if (to instanceof Agent) to.register();
    return this.#emit('handoff', { to: idOf(to), say, reason });
  }

  /** Raise a problem; `kind`: concern (default), needs_input, needs_approval. */
  flag(text, { kind } = {}) {
    return this.#emit('flag.raised', { text, kind });
  }

  resolve() {
    return this.#emit('flag.resolved', {});
  }

  done(say) {
    return this.#emit('agent.finished', { say });
  }

  fail(reason) {
    return this.#emit('agent.failed', { reason });
  }
}
