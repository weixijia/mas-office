// Where events go. Both transports share one rule: emitting must never break the agent,
// so failures are reported once with console.warn and the events are dropped.

import path from 'node:path';
import { ProjectLog } from './log.js';
import { writeDocument, GLOBALS } from './files.js';

function warner() {
  const seen = new Set();
  return (key, message) => {
    if (seen.has(key)) return;
    seen.add(key);
    console.warn(`[mas-office] ${message}`);
  };
}

/** Writes `<workspace>/<project>/mas/events.jsonl` and the snapshots, in this process. */
export class FileTransport {
  #logs = new Map();
  #warn = warner();

  constructor(workspace) {
    this.workspace = path.resolve(workspace);
  }

  open(folder, { title, task } = {}) {
    try {
      const log = new ProjectLog(this.workspace, folder, { title });
      this.#logs.set(folder, log);
      if (task) writeDocument(path.join(log.dir, 'me', 'task'), GLOBALS.task, { ...(title && { title }), ...task });
      log.write();
    } catch (err) {
      this.#warn(`open:${folder}`, `cannot open project "${folder}" (${err.message}); its events will be dropped.`);
    }
  }

  send(folder, event) {
    const log = this.#logs.get(folder);
    if (!log) return;
    try {
      log.append([event]);
    } catch (err) {
      this.#warn(`send:${folder}`, `cannot write events for "${folder}" (${err.message}); dropping them.`);
    }
  }

  /** The current reducer snapshot of a project (file transport only). */
  snapshot(folder) {
    return this.#logs.get(folder)?.snapshot();
  }

  async close() {}
}

/** The largest request body `mas-office serve` accepts (bytes). */
export const MAX_BATCH_BYTES = 1024 * 1024;
const MAX_BATCH_EVENTS = 500;

/**
 * Queues events and POSTs them in batches to `mas-office serve` (`/v0/events?project=`).
 * A batch is a JSON array that never exceeds `maxBatchBytes`; one event too big on its own is dropped.
 */
export class HttpTransport {
  #queue = [];
  #timer = null;
  #flushing = null;
  #warn = warner();

  constructor(url, { fetch = globalThis.fetch, batchDelay = 25, timeout = 10_000, maxBatchBytes = MAX_BATCH_BYTES } = {}) {
    if (typeof fetch !== 'function') throw new TypeError('The HTTP transport needs fetch (Node 18+).');
    this.url = String(url).replace(/\/+$/, '');
    this.fetch = fetch;
    this.batchDelay = batchDelay;
    this.timeout = timeout;
    this.maxBatchBytes = maxBatchBytes;
  }

  open() {}

  send(folder, event) {
    this.#queue.push([folder, event]);
    this.#schedule();
  }

  #schedule() {
    if (!this.#timer && !this.#flushing && this.#queue.length) this.#timer = setTimeout(() => this.#flush(), this.batchDelay);
  }

  #flush() {
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#flushing ??= this.#drain().finally(() => {
      this.#flushing = null;
      this.#schedule(); // events queued while the last request was finishing
    });
    return this.#flushing;
  }

  async #drain() {
    while (this.#queue.length) {
      const folder = this.#queue[0][0];
      const batch = [];
      let size = 2; // "[" and "]"
      while (this.#queue.length && this.#queue[0][0] === folder && batch.length < MAX_BATCH_EVENTS) {
        const json = JSON.stringify(this.#queue[0][1]);
        const bytes = Buffer.byteLength(json);
        if (bytes + 2 > this.maxBatchBytes) {
          const { type } = this.#queue.shift()[1];
          this.#warn('too-big', `dropping a "${type}" event of ${bytes} bytes: the server accepts at most ${this.maxBatchBytes} bytes per request.`);
          continue;
        }
        if (batch.length && size + 1 + bytes > this.maxBatchBytes) break;
        size += bytes + (batch.length ? 1 : 0);
        batch.push(json);
        this.#queue.shift();
      }
      if (!batch.length) continue;
      try {
        const res = await this.fetch(`${this.url}/v0/events?project=${encodeURIComponent(folder)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: `[${batch.join(',')}]`,
          signal: AbortSignal.timeout(this.timeout),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
      } catch (err) {
        this.#warn('post', `cannot send events to ${this.url} (${err.message}); dropping them.`);
      }
    }
  }

  /** Wait until every queued event has been sent (or dropped). */
  async close() {
    while (this.#queue.length || this.#flushing) await this.#flush();
  }
}

export { warner };
