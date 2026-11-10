// The request broker: every thing that waits on someone goes through here.
//
// One request, one answer. A request is opened in the log (`request.opened`), then exactly one
// of these closes it: a policy rule, the Lead (within its allow-list), the person at the panel
// (`command.respond`), the session going away, or a timeout. Whoever is second gets told so.
//
// The broker holds only what cannot be rebuilt from the log: the callbacks of the sessions that
// are waiting. After a restart those are gone, so `expireOrphans` closes what the log still shows
// as pending.

import { shortId } from './util.js';

const HUMAN_OUTCOMES = new Set(['selected', 'submitted', 'declined', 'cancelled']);

/**
 * @param {{emit: (events: object[]) => void, snapshot: () => object}} log the project's log
 */
export function createBroker(log) {
  /** @type {Map<string, {agentId: string, data: object, resolve: (r: object) => void, timer?: NodeJS.Timeout}>} */
  const waiting = new Map();

  function close(requestId, resolution) {
    const entry = waiting.get(requestId);
    if (!entry) return false;
    waiting.delete(requestId);
    clearTimeout(entry.timer);
    const { outcome, optionId, payload, note, by, cmdId } = resolution;
    log.emit([{
      type: 'request.resolved',
      agentId: entry.agentId,
      data: {
        requestId, outcome, by,
        ...(optionId !== undefined && { optionId }),
        ...(payload !== undefined && { payload }),
        ...(note !== undefined && { note }),
        ...(cmdId !== undefined && { cmdId }),
      },
    }]);
    entry.resolve({ requestId, ...resolution, option: entry.data.options?.find((o) => o.optionId === optionId) ?? null });
    return true;
  }

  return {
    /**
     * Open a request and wait for its answer.
     * @param {string} agentId who is asking
     * @param {object} data `request.opened` data without `requestId`
     * @param {{timeoutMs?: number, onTimeout?: object}} [options] `onTimeout` is the resolution to
     *   apply when nobody answers in time (default: outcome `expired`)
     * @returns {{requestId: string, answer: Promise<object>}}
     */
    open(agentId, data, { timeoutMs, onTimeout } = {}) {
      const requestId = shortId('req');
      let resolve;
      const answer = new Promise((r) => { resolve = r; });
      const entry = { agentId, data, resolve };
      waiting.set(requestId, entry);
      const expiresAt = timeoutMs ? new Date(Date.now() + timeoutMs).toISOString() : undefined;
      log.emit([{ type: 'request.opened', agentId, data: { ...data, requestId, ...(expiresAt && { expiresAt }) } }]);
      if (timeoutMs) {
        entry.timer = setTimeout(() => {
          close(requestId, { outcome: 'expired', by: { kind: 'system' }, ...onTimeout });
        }, timeoutMs);
        entry.timer.unref?.();
      }
      return { requestId, answer };
    },

    /** Close a request from code (a policy, the Lead, the session ending). False when it was not waiting. */
    close,

    /**
     * Pass a waiting request on to someone else (the Lead could not decide: now the person must).
     * The log shows the old request as superseded and a new one for the new addressee; whoever is
     * waiting for the answer keeps waiting, now on the new id. Returns the new id, or null.
     */
    reroute(requestId, patch, note) {
      const entry = waiting.get(requestId);
      if (!entry) return null;
      waiting.delete(requestId);
      const next = shortId('req');
      entry.data = { ...entry.data, ...patch };
      waiting.set(next, entry);
      log.emit([
        { type: 'request.resolved', agentId: entry.agentId, data: { requestId, outcome: 'superseded', by: { kind: 'agent', id: 'lead' }, ...(note && { note }) } },
        { type: 'request.opened', agentId: entry.agentId, data: { ...entry.data, requestId: next } },
      ]);
      return next;
    },

    has: (requestId) => waiting.has(requestId),
    /** How many requests an agent is waiting on right now. */
    countFor(agentId) {
      let n = 0;
      for (const entry of waiting.values()) if (entry.agentId === agentId) n += 1;
      return n;
    },
    get: (requestId) => waiting.get(requestId) ?? null,
    get size() { return waiting.size; },

    /**
     * Apply a person's `command.respond`. Returns the ack to write: `applied`, or `rejected`
     * with the reason.
     */
    respond(event) {
      const { requestId, outcome, optionId, payload, note, cmdId, origin } = event.data;
      const entry = waiting.get(requestId);
      if (!entry) return { status: 'rejected', reason: 'already_resolved' };
      if (!HUMAN_OUTCOMES.has(outcome)) return { status: 'rejected', reason: 'bad_outcome' };
      const kind = origin?.kind ?? 'agent';
      const resolver = entry.data.resolver ?? 'anyone';
      if (resolver === 'human_only' && kind !== 'human') return { status: 'rejected', reason: 'not_allowed' };
      if (resolver === 'not_creator' && kind === 'agent' && origin?.id === entry.agentId) {
        return { status: 'rejected', reason: 'not_allowed' };
      }
      if (outcome === 'selected' && !entry.data.options?.some((o) => o.optionId === optionId)) {
        return { status: 'rejected', reason: 'unknown_option' };
      }
      close(requestId, { outcome, optionId, payload, note, cmdId, by: kind === 'human' ? { kind: 'human' } : { kind, id: origin?.id } });
      return { status: 'applied' };
    },

    /** Cancel everything an agent is waiting on (its session ended or was stopped). */
    cancelAgent(agentId, by = { kind: 'system' }) {
      for (const [requestId, entry] of waiting) {
        if (entry.agentId === agentId) close(requestId, { outcome: 'cancelled', by });
      }
    },

    cancelAll(by = { kind: 'system' }) {
      for (const requestId of [...waiting.keys()]) close(requestId, { outcome: 'cancelled', by });
    },

    /**
     * After a restart: requests the log shows as pending have nobody waiting for them any more.
     * Mark them expired so nobody answers into the void.
     */
    expireOrphans() {
      const pending = log.snapshot().inbox?.pending ?? [];
      const orphans = pending.filter((r) => !waiting.has(r.requestId));
      if (!orphans.length) return 0;
      log.emit(orphans.map((r) => ({
        type: 'request.resolved',
        agentId: r.agentId,
        data: { requestId: r.requestId, outcome: 'expired', by: { kind: 'system' }, note: 'The session that asked is gone. Ask the agent again if it still matters.' },
      })));
      return orphans.length;
    },
  };
}
