// A project's event log on disk: `<workspace>/<folder>/mas/events.jsonl`.
// Appends events, keeps an in-memory reducer and rewrites the snapshots after every append.
// Used by the SDK's file transport, `mas-office serve` and the Claude Code hook.
//
// One writer process per project: two processes appending to the same log at the same
// time can assign the same seq. For several processes, run `mas-office serve` and send
// events over HTTP instead.

import fs from 'node:fs';
import path from 'node:path';
import { createReducer, validateEvent, SPEC_VERSION } from './reducer.js';
import { writeSnapshots, updateProjectsIndex } from './files.js';
import { assertFolder, isValidAgentId } from './names.js';

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Thrown by `ProjectLog.append` when a batch holds invalid events; nothing was written. */
export class EventError extends Error {
  /** @param {{index: number, errors: string[]}[]} invalid */
  constructor(invalid) {
    super(`${invalid.length} invalid event(s): ${invalid.map((x) => `#${x.index} ${x.errors.join('; ')}`).join(' | ')}`);
    this.name = 'EventError';
    this.invalid = invalid;
  }
}

/** `validateEvent` errors plus what writers also refuse: ids that cannot become file names or role ids. */
export function eventErrors(e) {
  const errors = validateEvent(e).errors;
  if (isObject(e)) {
    if (e.agentId !== undefined && !isValidAgentId(e.agentId)) errors.push('"agentId" must match ^[a-z0-9][a-z0-9-]{0,63}$');
    if (e.type === 'handoff' && typeof e.data?.to === 'string' && !isValidAgentId(e.data.to)) {
      errors.push('"data.to" must match ^[a-z0-9][a-z0-9-]{0,63}$');
    }
  }
  return errors;
}

function maxSeq(lines) {
  let max = 0;
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (isObject(e) && Number.isSafeInteger(e.seq) && e.seq > max) max = e.seq;
    } catch { /* not an event line */ }
  }
  return max;
}

export class ProjectLog {
  #reducer;
  #lastSeq = 0;
  #size = 0;
  #endsWithNewline = true;
  #cache = new Map();

  /**
   * @param {string} workspace the workspace folder (holds `home/` and the project folders)
   * @param {string} folder the project folder name
   * @param {{title?: string}} [options] title shown in `home/projects`
   */
  constructor(workspace, folder, { title } = {}) {
    assertFolder(folder);
    this.workspace = path.resolve(workspace);
    this.folder = folder;
    this.title = title;
    this.dir = path.join(this.workspace, folder);
    this.file = path.join(this.dir, 'mas', 'events.jsonl');
    this.#load();
  }

  #load() {
    let text = '';
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const lines = text.split('\n');
    this.#reducer = createReducer(lines);
    this.#lastSeq = maxSeq(lines);
    this.#size = Buffer.byteLength(text);
    this.#endsWithNewline = text === '' || text.endsWith('\n');
  }

  #fileSize() {
    try { return fs.statSync(this.file).size; } catch { return 0; }
  }

  /** The highest seq in the log (the next event gets `lastSeq + 1`). */
  get lastSeq() {
    return this.#lastSeq;
  }

  snapshot() {
    return this.#reducer.snapshot();
  }

  /**
   * Append events: assigns `seq`, fills `v` and `ts` when missing, appends them to the log,
   * applies them and rewrites the snapshots and `home/projects`.
   * The batch is all or nothing: if any event is invalid, throws `EventError` and writes nothing.
   * @returns {{accepted: number, lastSeq: number, events: object[]}}
   */
  append(events) {
    if (this.#fileSize() !== this.#size) this.#load(); // someone else appended: catch up first
    let seq = this.#lastSeq;
    const now = new Date().toISOString();
    const stamped = events.map((e) => {
      if (!isObject(e)) return e;
      const { v, seq: _ignored, ts, ...rest } = e;
      return { v: v ?? SPEC_VERSION, seq: ++seq, ts: ts ?? now, ...rest };
    });
    const invalid = stamped
      .map((e, index) => ({ index, errors: eventErrors(e) }))
      .filter((x) => x.errors.length);
    if (invalid.length) throw new EventError(invalid);
    if (stamped.length) {
      const text = (this.#endsWithNewline ? '' : '\n') + stamped.map((e) => JSON.stringify(e)).join('\n') + '\n';
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, text);
      this.#size += Buffer.byteLength(text);
      this.#endsWithNewline = true;
      this.#lastSeq = seq;
      for (const e of stamped) this.#reducer.apply(e);
      this.write();
    }
    return { accepted: stamped.length, lastSeq: this.#lastSeq, events: stamped };
  }

  /** Rewrite every snapshot of this project and its entry in `home/projects`. */
  write() {
    const snap = this.snapshot();
    writeSnapshots(this.dir, snap, { cache: this.#cache });
    updateProjectsIndex(this.workspace, {
      folder: this.folder,
      title: this.title ?? snap.structure.title ?? this.folder,
      step: 4,
      phase: snap.state.phase,
      agents: snap.structure.roles.length + 1,
      runs: snap.state.run,
    });
  }
}
