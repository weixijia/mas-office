/* MAS Office — pure supervision logic: the "needs you" inbox, wait clocks, command receipts, keyboard rules,
   notification admission, transcript grouping and edge pointers.
   Loaded by the browser (window.MASInbox) and by Node tests (module.exports). No DOM, no clock: callers pass `now`.
   Everything read here comes from snapshot files written by agents, so every field is checked before use. */
(function () {
  'use strict';

  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const str = (v) => (typeof v === 'string' ? v : null);
  const arr = (v) => (Array.isArray(v) ? v : []);
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

  /* ---------- request kinds and words ---------- */
  // Tones map onto the sheet palette: verm = needs you, cobalt = a question, ochre = a warning.
  const KINDS = {
    approval: { word: 'Approval', tone: 'verm' },
    question: { word: 'Question', tone: 'cobalt' },
    decision: { word: 'Decision', tone: 'verm' },
    flag: { word: 'Flag', tone: 'ochre' },
    gate: { word: 'Gate', tone: 'verm' }
  };
  // Unknown kinds are kept as given and treated like a question (RFC 0001 §2.1).
  const kindInfo = (k) => Object.assign({ kind: KINDS[k] ? k : 'question' }, KINDS[k] || KINDS.question);
  const URGENCY = { high: 0, normal: 1, low: 2 };
  const OUTCOMES = ['selected', 'submitted', 'declined', 'cancelled', 'expired', 'superseded', 'stale'];
  const FINAL = ['applied', 'rejected', 'unsupported', 'expired', 'conflict', 'failed'];
  const RANK = { sending: 0, sent: 1, accepted: 2, applied: 3, rejected: 3, unsupported: 3, expired: 3, conflict: 3, failed: 3 };

  /* ---------- snapshot normalisation ---------- */
  function normalizeOption(o) {
    if (!isObj(o) || typeof o.optionId !== 'string' || !o.optionId) return null;
    return { optionId: o.optionId, name: str(o.name) || o.optionId, kind: str(o.kind) || 'choice' };
  }
  function normalizeRequest(r) {
    if (!isObj(r) || typeof r.requestId !== 'string' || !r.requestId) return null;
    return {
      requestId: r.requestId, agentId: str(r.agentId), kind: str(r.kind) || 'question', title: str(r.title) || 'Untitled request',
      description: str(r.description), subject: isObj(r.subject) ? r.subject : null, toolCallId: str(r.toolCallId),
      options: arr(r.options).map(normalizeOption).filter(Boolean), responseSchema: isObj(r.responseSchema) ? r.responseSchema : null,
      blocking: r.blocking !== false, routeTo: str(r.routeTo) || 'human', resolver: str(r.resolver) || 'anyone',
      urgency: Object.prototype.hasOwnProperty.call(URGENCY, r.urgency) ? r.urgency : 'normal',
      expiresAt: str(r.expiresAt), onExpire: str(r.onExpire), openedAt: str(r.openedAt), seq: num(r.seq), run: num(r.run),
      outcome: OUTCOMES.includes(r.outcome) ? r.outcome : null, optionId: str(r.optionId), payload: r.payload === undefined ? null : r.payload,
      note: str(r.note), by: isObj(r.by) ? { kind: str(r.by.kind) || 'system', id: str(r.by.id), rule: str(r.by.rule) } : null,
      cmdId: str(r.cmdId), resolvedAt: str(r.resolvedAt)
    };
  }
  function normalizeCommand(c) {
    if (!isObj(c) || typeof c.cmdId !== 'string' || !c.cmdId) return null;
    return {
      cmdId: c.cmdId, type: str(c.type), agentId: str(c.agentId), origin: isObj(c.origin) ? { kind: str(c.origin.kind) || 'agent', id: str(c.origin.id) } : { kind: 'agent', id: 'lead' },
      text: str(c.text), delivery: str(c.delivery), requestId: str(c.requestId), status: RANK[c.status] != null ? c.status : 'sent',
      reason: str(c.reason), sentAt: str(c.sentAt), ackAt: str(c.ackAt), seq: num(c.seq)
    };
  }
  // MAS_INBOX → {pending, recent, commands} with only well-formed entries, or null when there is no inbox.
  function normalizeInbox(raw) {
    if (!isObj(raw)) return null;
    return {
      pending: arr(raw.pending).map(normalizeRequest).filter(Boolean),
      recent: arr(raw.recent).map(normalizeRequest).filter(Boolean),
      commands: arr(raw.commands).map(normalizeCommand).filter(Boolean)
    };
  }

  /* ---------- wait clocks ---------- */
  // Adapted from AgentSystemLabs/agent-office@852e2ab28c4f3f31bffdf4b20353bd119c9d3270 src/client/features/needsyou/logic.ts (MIT)
  // Copyright (c) 2026 AgentSystemLabs
  // How long it has waited: nothing for the first minute, then "4 min", "1 h 05 min".
  function waited(since, now) {
    const min = since == null || !isFinite(since) ? 0 : Math.floor((now - since) / 60000);
    if (min < 1) return '';
    return min < 60 ? min + ' min' : Math.floor(min / 60) + ' h ' + String(min % 60).padStart(2, '0') + ' min';
  }
  // One wait of an agent's: asking again later is another episode.
  const waitKey = (id, since) => id + '@' + since;
  // When a request started waiting: its own timestamp, unless that is missing or in the future (a skewed clock),
  // then the moment the panel first saw it.
  function sinceOf(req, firstSeen, now) {
    const t = req && req.openedAt ? Date.parse(req.openedAt) : NaN;
    if (isFinite(t) && (now == null || t <= now + 60000)) return t;
    return firstSeen != null ? firstSeen : now != null ? now : null;
  }
  // A duration for people, used by the HCI timings: "<1 s", "12 s", "1 min 40 s", "1 h 05 min".
  function durationText(ms) {
    if (ms == null || !isFinite(ms) || ms < 0) return '';
    const s = Math.floor(ms / 1000);
    if (s < 1) return '<1 s';
    if (s < 60) return s + ' s';
    if (s < 3600) return Math.floor(s / 60) + ' min' + (s % 60 ? ' ' + (s % 60) + ' s' : '');
    return Math.floor(s / 3600) + ' h ' + String(Math.floor(s / 60) % 60).padStart(2, '0') + ' min';
  }

  /* ---------- what a request holds up ---------- */
  // Groups that run after `gid`, directly or through others (the `after` chain).
  function laterGroups(groups, gid) {
    const list = arr(groups).filter((g) => isObj(g) && typeof g.id === 'string');
    const out = new Set();
    let frontier = [gid];
    for (let i = 0; i < 50 && frontier.length; i++) {
      const next = list.filter((g) => frontier.includes(g.after) && !out.has(g.id) && g.id !== gid).map((g) => g.id);
      next.forEach((id) => out.add(id));
      frontier = next;
    }
    return out;
  }
  // The agents a blocking request holds up besides the asker: everyone down its handsTo chain, everyone in a later
  // stage (or, for a gate on a stage, the stages after it), the Lead last. Agents already done or failed are not held.
  function holdsUp(req, s, statuses) {
    if (!req || !isObj(s)) return [];
    const roles = arr(s.roles).filter((r) => isObj(r) && typeof r.id === 'string');
    const id = req.agentId, seen = new Set([id]), out = [];
    const add = (x) => { if (typeof x === 'string' && !seen.has(x)) { seen.add(x); out.push(x); } };
    let cur = id;
    for (let i = 0; i < 50 && cur && cur !== 'lead'; i++) {
      const r = roles.find((x) => x.id === cur);
      if (!r) break;
      const next = typeof r.handsTo === 'string' && r.handsTo ? r.handsTo : 'lead';
      if (seen.has(next)) break;
      add(next); cur = next;
    }
    const subj = req.subject || {};
    const me = roles.find((x) => x.id === id);
    const gid = req.kind === 'gate' && typeof (subj.after || subj.stage) === 'string' ? subj.after || subj.stage : me && me.group;
    if (gid) { const later = laterGroups(s.groups, gid); roles.filter((r) => later.has(r.group)).forEach((r) => add(r.id)); }
    if (req.kind === 'gate' && gid && id !== 'lead') add('lead');
    const st = statuses || {};
    const live = out.filter((x) => !(st[x] && (st[x].state === 'done' || st[x].state === 'failed')));
    const i = live.indexOf('lead');
    if (i >= 0 && i !== live.length - 1) { live.splice(i, 1); live.push('lead'); }
    return live;
  }
  // "Catch checker and Lead", "A, B and C", "A, B and 3 others".
  function namesText(names) {
    const n = names.length;
    if (!n) return '';
    if (n === 1) return names[0];
    if (n <= 3) return names.slice(0, -1).join(', ') + ' and ' + names[n - 1];
    return names.slice(0, 2).join(', ') + ' and ' + (n - 2) + ' others';
  }
  const holdsUpText = (names) => (names.length ? 'Holds up ' + namesText(names) : '');

  /* ---------- sorting ---------- */
  // Adapted from paperclipai/paperclip@b8e02fc2b418a9104612fa731f7afde7afcce6b5 ui/src/lib/blockedInbox.ts compareBlockedAttention (MIT)
  // Copyright (c) 2025 Paperclip AI
  // Urgency first, then requests that block more (blocking before non-blocking, then more agents held up), then oldest.
  function compareRequests(a, b) {
    const u = (URGENCY[a.req.urgency] ?? 1) - (URGENCY[b.req.urgency] ?? 1);
    if (u) return u;
    const bl = (b.req.blocking ? 1 : 0) - (a.req.blocking ? 1 : 0);
    if (bl) return bl;
    const h = (b.holds ? b.holds.length : 0) - (a.holds ? a.holds.length : 0);
    if (h) return h;
    const as = a.since != null && isFinite(a.since) ? a.since : Infinity, bs = b.since != null && isFinite(b.since) ? b.since : Infinity;
    const d = as - bs;
    if (isFinite(d) && d) return d;
    return (a.req.seq || 0) - (b.req.seq || 0) || (a.req.requestId < b.req.requestId ? -1 : a.req.requestId > b.req.requestId ? 1 : 0);
  }
  // The inbox as the panel shows it: `human` (needs you, sorted), `withLead` (routed to the Lead or another agent first:
  // shown dimmed until escalated or resolved) and `recent` (newest first). Each pending item: {req, since, holds}.
  function arrangeInbox(inbox, s, statuses, firstSeen, now) {
    const box = inbox || { pending: [], recent: [] };
    const seen = firstSeen || {};
    const item = (req) => ({ req, since: sinceOf(req, seen[req.requestId], now), holds: req.blocking ? holdsUp(req, s, statuses) : [] });
    const items = arr(box.pending).map(item);
    const human = items.filter((x) => x.req.routeTo === 'human').sort(compareRequests);
    const withLead = items.filter((x) => x.req.routeTo !== 'human').sort(compareRequests);
    return { human, withLead, recent: arr(box.recent).slice() };
  }

  /* ---------- who waits on you, in order (the N key) ---------- */
  // Agents with a blocking request that needs you: most urgent first, then whoever has waited longest.
  function waitingAgents(human) {
    const by = new Map();
    arr(human).forEach((x) => {
      if (!x.req.blocking || !x.req.agentId) return;
      const w = by.get(x.req.agentId) || { id: x.req.agentId, since: Infinity, urgency: 2, count: 0, requestIds: [] };
      w.since = Math.min(w.since, x.since != null ? x.since : Infinity);
      w.urgency = Math.min(w.urgency, URGENCY[x.req.urgency] ?? 1);
      w.count++; w.requestIds.push(x.req.requestId);
      by.set(w.id, w);
    });
    return Array.from(by.values()).sort((a, b) => a.urgency - b.urgency || a.since - b.since || (a.id < b.id ? -1 : 1));
  }
  // Adapted from AgentSystemLabs/agent-office@852e2ab28c4f3f31bffdf4b20353bd119c9d3270 src/client/nextup.ts NextUp (MIT)
  // Copyright (c) 2026 AgentSystemLabs
  // One press after another: the first in line not visited this round; once all are visited, the first again.
  // An agent that starts a new wait after its visit is new to this round. `here` comes up only when it is the only one.
  function NextUp() { this.visited = new Map(); }
  NextUp.prototype.next = function (waiting, here) {
    const list = arr(waiting);
    for (const [id, at] of this.visited) if (!list.some((w) => w.id === id && w.since === at)) this.visited.delete(id);
    const others = list.filter((w) => w.id !== here);
    let pick = others.find((w) => !this.visited.has(w.id));
    if (!pick) { this.visited.clear(); pick = others[0] || list[0]; }
    if (pick) this.visited.set(pick.id, pick.since);
    return pick || null;
  };
  // Agents free for more work (idle, or done with this run), in team order; `since` is their status so a change is new.
  function idleAgents(s, statuses) {
    if (!isObj(s)) return [];
    const st = statuses || {};
    return ['lead'].concat(arr(s.roles).filter((r) => isObj(r) && typeof r.id === 'string').map((r) => r.id))
      .filter((id) => !st[id] || st[id].state === 'idle' || st[id].state === 'done')
      .map((id) => ({ id, since: st[id] ? st[id].state + '|' + (st[id].say || '') : 'none' }));
  }

  /* ---------- answering ---------- */
  const isAllow = (o) => /^allow/.test(o.kind), isReject = (o) => /^reject/.test(o.kind);
  // The A / D keys: only when the request offers exactly one allow-kind and one reject-kind option, and neither is an
  // "always" (a standing rule is never picked by a key press).
  function quickPair(req) {
    if (!req || !Array.isArray(req.options)) return null;
    const allow = req.options.filter(isAllow), reject = req.options.filter(isReject);
    if (allow.length !== 1 || reject.length !== 1) return null;
    if (allow[0].kind !== 'allow_once' || reject[0].kind !== 'reject_once') return null;
    return { allow: allow[0], reject: reject[0] };
  }
  // Buttons for a request. A gate without options gets accept / revise (with text) / stop; a revise option needs text.
  function answerOptions(req) {
    if (!req) return [];
    let opts = req.options.slice();
    if (!opts.length && req.kind === 'gate') {
      opts = [{ optionId: 'accept', name: 'Accept', kind: 'allow_once' }, { optionId: 'revise', name: 'Revise', kind: 'choice' }, { optionId: 'stop', name: 'Stop', kind: 'reject_once' }];
    }
    return opts.map((o) => Object.assign({}, o, { needsText: req.kind === 'gate' && /revis/i.test(o.optionId + ' ' + o.name), tone: isAllow(o) ? 'allow' : isReject(o) ? 'reject' : 'choice', always: /_always$/.test(o.kind) }));
  }
  // The command.respond data for a button or a typed reply (outcome `submitted`, payload {text}).
  function respondData(req, opt, text) {
    const t = typeof text === 'string' ? text.trim() : '';
    if (opt) {
      const d = { requestId: req.requestId, outcome: 'selected', optionId: opt.optionId };
      if (t) d.payload = { text: t };
      return d;
    }
    return t ? { requestId: req.requestId, outcome: 'submitted', payload: { text: t } } : null;
  }

  /* ---------- what an approval is about (shown in full, folded when long) ---------- */
  function pretty(v) {
    try { return typeof v === 'string' ? v : JSON.stringify(v, null, 2); } catch (e) { return String(v); }
  }
  function subjectView(subject) {
    if (!isObj(subject)) return null;
    const type = str(subject.type) || 'other';
    const rest = Object.assign({}, subject); delete rest.type;
    let label = '', text = '';
    if (type === 'tool_call') {
      label = 'Tool' + (str(subject.tool) ? ': ' + subject.tool : '');
      text = subject.input !== undefined ? pretty(subject.input) : str(subject.command) || pretty(rest);
    } else if (type === 'command') {
      label = 'Command'; text = str(subject.command) || pretty(rest);
    } else if (type === 'file_change') {
      label = 'File' + (str(subject.path) ? ': ' + subject.path : '');
      text = str(subject.diff) || str(subject.patch) || str(subject.content) || (Array.isArray(subject.paths) ? subject.paths.join('\n') : '') || (str(subject.path) ? '' : pretty(rest));
    } else if (type === 'plan') {
      label = 'Plan';
      const steps = arr(subject.steps).length ? subject.steps : arr(subject.plan);
      text = steps.length ? steps.map((x, i) => (i + 1) + '. ' + (typeof x === 'string' ? x : pretty(x))).join('\n') : pretty(rest);
    } else if (type === 'claim') {
      label = 'Claim' + (str(subject.claimId) ? ' ' + subject.claimId : '');
      text = str(subject.text) || pretty(rest);
    } else if (type === 'stage') {
      label = 'Stage' + (str(subject.label) ? ': ' + subject.label : str(subject.after) ? ' after ' + subject.after : '');
      text = str(subject.summary) || (Array.isArray(subject.files) ? subject.files.filter((f) => typeof f === 'string').join('\n') : '');
    } else { label = type; text = pretty(rest); }
    const lines = text ? text.split('\n').length : 0;
    return { type, label, text, lines, long: lines > 8 || text.length > 600 };
  }

  /* ---------- who decided, and what ---------- */
  // Who decided, as it reads after the outcome: "by you", "by Lead", "by policy rule "web search"", "in the terminal".
  function byText(by, nameOf) {
    const b = by || { kind: 'system' };
    const name = (id) => (nameOf ? nameOf(id) : id);
    if (b.kind === 'human') return 'by you';
    if (b.kind === 'agent') return 'by ' + (b.id ? name(b.id) : 'an agent');
    if (b.kind === 'policy') return 'by policy rule' + (b.rule ? ' "' + b.rule + '"' : '');
    if (b.kind === 'terminal') return 'in the terminal';
    return 'by the system';
  }
  function outcomeText(req) {
    if (!req) return '';
    const opt = req.options.find((o) => o.optionId === req.optionId);
    const text = req.payload && typeof req.payload.text === 'string' ? req.payload.text : '';
    switch (req.outcome) {
      case 'selected': return (opt ? opt.name : req.optionId || 'Answered') + (text ? ': "' + text + '"' : '');
      case 'submitted': return text ? 'Replied: "' + text + '"' : 'Replied';
      case 'declined': return 'Declined';
      case 'cancelled': return 'Cancelled';
      case 'expired': return 'Expired';
      case 'superseded': return 'Answered elsewhere';
      case 'stale': return 'No longer relevant';
      default: return 'Resolved';
    }
  }

  /* ---------- command receipts: sent → accepted → applied / rejected ---------- */
  // `local` is what this page knows ({state: sending | sent | conflict | failed, error}), `cmd` the server's record in
  // MAS_INBOX.commands. A receipt never moves backwards (an older snapshot does not undo an ack), and a final state stays.
  function receipt(local, cmd) {
    let state = local && RANK[local.state] != null ? local.state : 'sent', reason = (local && local.error) || null;
    if (cmd && !FINAL.includes(state) && RANK[cmd.status] != null && RANK[cmd.status] >= RANK[state]) { state = cmd.status; reason = cmd.reason || null; }
    return { state, reason, final: FINAL.includes(state), ok: state === 'applied' || state === 'accepted', text: receiptText(state, reason) };
  }
  function receiptText(state, reason) {
    const why = reason ? ': ' + String(reason).replace(/_/g, ' ') : '';
    switch (state) {
      case 'sending': return 'Sending…';
      case 'sent': return 'Sent…';
      case 'accepted': return 'Accepted' + (reason ? ' · ' + String(reason).replace(/_/g, ' ') : '');
      case 'applied': return 'Applied' + (reason ? ' · ' + String(reason).replace(/_/g, ' ') : '');
      case 'rejected': return 'Rejected' + why;
      case 'unsupported': return 'This agent cannot take that' + why;
      case 'expired': return 'Expired before it was delivered';
      case 'conflict': return 'Already answered';
      case 'failed': return 'Not sent' + why;
      default: return '';
    }
  }
  // A Stop is "requested" until the agent's status really changes (accepted is not stopped).
  // stop: {state, error, key} where key is the agent's status key when Stop was pressed; keyNow is the current one.
  function stopState(stop, cmd, keyNow, stopReason) {
    if (!stop) return null;
    const r = receipt(stop, cmd);
    if (r.final && !r.ok) return { state: 'refused', text: 'Stop not done: ' + r.text };
    if (stopReason === 'cancelled' || (keyNow != null && keyNow !== stop.key)) return { state: 'stopped', text: 'Stopped' };
    return { state: 'requested', text: 'Stop requested' + (r.state === 'applied' || r.state === 'accepted' ? ' · waiting for the agent to stop' : '') };
  }

  /* ---------- notifications (negotiated interruption) ---------- */
  // Adapted from KbWen/agent-virtual-office@48e0e23da55cdf7b083afdee468d21f16cdd02b9 src/inference/desktopNotifier.js (MIT)
  // Copyright (c) 2026 KbWen
  // A system notification only for a blocking request that needs you, has waited at least 30 s, while the tab is
  // hidden, with notifications switched on and allowed, and once per wait episode.
  const NOTIFY_AFTER = 30000;
  function shouldNotify(o) {
    return !!(o && o.enabled && o.permission === 'granted' && o.hidden && o.blocking && o.routeTo === 'human' &&
      typeof o.waitedMs === 'number' && o.waitedMs >= NOTIFY_AFTER && !o.notified);
  }

  /* ---------- transcript ---------- */
  // Parse the complete lines of a growing JSONL text after `consumed` characters. Returns the new entries and how far
  // it got (a half-written last line waits for the next read). If the text no longer starts as before, start over.
  function jsonlAppend(state, text) {
    const t = typeof text === 'string' ? text : '';
    const st = state && state.consumed <= t.length && t.slice(0, state.head.length) === state.head ? state : { consumed: 0, head: '' };
    const end = t.lastIndexOf('\n') + 1;
    const chunk = end > st.consumed ? t.slice(st.consumed, end) : '';
    const entries = [];
    chunk.split('\n').forEach((line) => {
      if (!line.trim()) return;
      try { const v = JSON.parse(line); if (isObj(v) && typeof v.kind === 'string') entries.push(v); } catch (e) { /* a broken line is skipped */ }
    });
    const consumed = Math.max(st.consumed, end);
    return { reset: st !== state, entries, state: { consumed, head: t.slice(0, Math.min(consumed, 256)) } };
  }
  const toolName = (e) => (e && typeof e.tool === 'string' && e.tool) || 'tool';
  // Transcript entries → rows. A tool call and its result (same callId) form one step; consecutive steps of the same
  // tool collapse into one row with a count; a failed result marks its row. Other entries pass through.
  function groupTranscript(entries) {
    const out = [], open = new Map();
    arr(entries).forEach((e) => {
      if (!isObj(e)) return;
      if (e.kind === 'tool_call') {
        const step = { call: e, result: null };
        if (typeof e.callId === 'string') open.set(e.callId, step);
        const prev = out[out.length - 1];
        if (prev && prev.kind === 'tools' && prev.tool === toolName(e) && prev.steps[0].call) prev.steps.push(step);
        else out.push({ kind: 'tools', tool: toolName(e), steps: [step], ts: str(e.ts) });
        return;
      }
      if (e.kind === 'tool_result') {
        const step = typeof e.callId === 'string' ? open.get(e.callId) : null;
        if (step && !step.result) { step.result = e; open.delete(e.callId); return; }
        out.push({ kind: 'tools', tool: toolName(e), steps: [{ call: null, result: e }], ts: str(e.ts) });
        return;
      }
      out.push({ kind: 'entry', entry: e });
    });
    out.forEach((g) => {
      if (g.kind !== 'tools') return;
      g.count = g.steps.length;
      g.failed = g.steps.filter((x) => x.result && x.result.ok === false).length;
      g.running = g.steps.filter((x) => x.call && !x.result).length;
    });
    return out;
  }
  // The tool an agent is using right now: the last call without a result.
  function currentTool(entries) {
    const list = arr(entries), done = new Set();
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (!isObj(e)) continue;
      if (e.kind === 'tool_result' && typeof e.callId === 'string') done.add(e.callId);
      if (e.kind === 'tool_call') return done.has(e.callId) ? null : { tool: toolName(e), summary: str(e.summary) };
      if (e.kind === 'result' || e.kind === 'assistant') return null;
    }
    return null;
  }

  /* ---------- edge pointers ---------- */
  // Adapted from AgentSystemLabs/agent-office@852e2ab28c4f3f31bffdf4b20353bd119c9d3270 src/client/ui/compass.ts Compass.update (MIT)
  // Copyright (c) 2026 AgentSystemLabs
  // Points (screen x, y) outside `box` get a mark on the box edge, on the line from the box centre towards them;
  // marks on one edge are spread apart (`spacing`) and backed up when pushed off the end. Points inside get none.
  function edgeMarks(points, box, spacing) {
    const sp = Object.assign({ side: 56, across: 120 }, spacing);
    const cx = (box.left + box.right) / 2, cy = (box.top + box.bottom) / 2;
    const placed = [];
    arr(points).forEach((p) => {
      if (p.x >= box.left && p.x <= box.right && p.y >= box.top && p.y <= box.bottom) return;
      const dx = p.x - cx, dy = p.y - cy;
      let s = Infinity;
      if (dx > 0) s = (box.right - cx) / dx; else if (dx < 0) s = (box.left - cx) / dx;
      if (dy > 0) s = Math.min(s, (box.bottom - cy) / dy); else if (dy < 0) s = Math.min(s, (box.top - cy) / dy);
      if (!isFinite(s)) return;
      const x = cx + dx * s, y = cy + dy * s;
      const edge = x <= box.left + 1 ? 'left' : x >= box.right - 1 ? 'right' : y <= box.top + 1 ? 'top' : 'bottom';
      placed.push({ id: p.id, x, y, angle: Math.atan2(dy, dx), edge });
    });
    ['left', 'right', 'top', 'bottom'].forEach((edge) => {
      const side = edge === 'left' || edge === 'right', axis = side ? 'y' : 'x', gap = side ? sp.side : sp.across;
      const row = placed.filter((p) => p.edge === edge).sort((a, b) => a[axis] - b[axis]);
      for (let i = 1; i < row.length; i++) row[i][axis] = Math.max(row[i][axis], row[i - 1][axis] + gap);
      const over = row.length ? row[row.length - 1][axis] - (side ? box.bottom : box.right) : 0;
      if (over > 0) row.forEach((p) => { p[axis] = Math.max(side ? box.top : box.left, p[axis] - over); });
    });
    return placed;
  }

  const api = {
    KINDS, URGENCY, NOTIFY_AFTER, kindInfo, normalizeInbox, normalizeRequest, waited, waitKey, sinceOf, durationText,
    holdsUp, namesText, holdsUpText, compareRequests, arrangeInbox, waitingAgents, NextUp, idleAgents,
    quickPair, answerOptions, respondData, subjectView, byText, outcomeText, receipt, receiptText, stopState, shouldNotify,
    jsonlAppend, groupTranscript, currentTool, edgeMarks
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.MASInbox = api;
})();
