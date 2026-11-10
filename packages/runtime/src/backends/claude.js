// Claude Code session adapter: one streaming-input Agent SDK `query()` per agent,
// run on the user's own installed `claude` binary. The contract is
// docs/design/runtime.md §4; the events are spec/rfcs/0001-protocol-0.2.md §2.
//
// Compliance (root CLAUDE.md §3): the SDK drives the unmodified `claude` found on
// PATH; login state comes from `claude auth status` only; no credential file or
// keychain is ever read; the child gets a minimal environment (`childEnv`).

import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, constants } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { createPushable } from './pushable.js';
import { childEnv } from './types.js';

/** @typedef {import('./types.js').AgentBackend} AgentBackend */
/** @typedef {import('./types.js').AgentSession} AgentSession */
/** @typedef {import('./types.js').SessionSpec} SessionSpec */
/** @typedef {import('./types.js').SessionSink} SessionSink */
/** @typedef {import('./types.js').AskRequest} AskRequest */
/** @typedef {import('./types.js').AskAnswer} AskAnswer */
/** @typedef {import('./types.js').TurnResult} TurnResult */

const BACKEND = 'claude-code';
const TOOL_RESULT_MAX = 4000;
const MESSAGE_MAX = 120;
const PROBE_TIMEOUT_MS = 15000;
const PRECHECK_TIMEOUT_S = 24 * 60 * 60;
const ACCEPTS = ['message', 'respond', 'interrupt', 'assign'];
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// ---------------------------------------------------------------------------
// Small text helpers

/** Replace the home directory with `~` in every string inside `value`. */
export function shortenHome(value, home = os.homedir()) {
  if (!home || home === '/') return value;
  if (typeof value === 'string') return value.split(home).join('~');
  if (Array.isArray(value)) return value.map((item) => shortenHome(item, home));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = shortenHome(item, home);
    return out;
  }
  return value;
}

function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The first sentence (or line) of `text`, at most `max` characters. */
export function firstSentence(text, max = MESSAGE_MAX) {
  const line = String(text ?? '').trim().split(/\n/)[0].trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(line);
  return clip(sentence ? sentence[1] : line, max);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n');
}

function displayPath(file, cwd, home) {
  if (typeof file !== 'string' || !file) return '(unknown file)';
  if (cwd && path.isAbsolute(file)) {
    const rel = path.relative(cwd, file);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  }
  return shortenHome(file, home);
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname || String(url);
  } catch {
    return clip(url, 60);
  }
}

/**
 * Human wording for one tool call: the approval title, the status-line `say`,
 * the transcript `summary` and the request `subject`.
 */
export function describeTool(name, input, { cwd, home = os.homedir() } = {}) {
  const args = input && typeof input === 'object' ? input : {};
  const safeInput = shortenHome(args, home);
  const base = { type: 'tool_call', tool: name, input: safeInput };

  if (name === 'Bash') {
    const command = shortenHome(String(args.command ?? ''), home);
    return {
      title: `Run \`${clip(command, 80)}\`?`,
      say: `Running: ${clip(command, 60)}`,
      summary: clip(command, 120),
      subject: { type: 'command', tool: name, command, input: safeInput },
    };
  }
  if (FILE_TOOLS.has(name)) {
    const file = displayPath(args.file_path ?? args.notebook_path, cwd, home);
    const verb = name === 'Write' ? 'Write' : 'Edit';
    return {
      title: `${verb} ${file}?`,
      say: `${verb === 'Write' ? 'Writing' : 'Editing'} ${clip(file, 60)}`,
      summary: file,
      subject: { type: 'file_change', tool: name, path: file, input: safeInput },
    };
  }
  if (name === 'Read') {
    const file = displayPath(args.file_path, cwd, home);
    return { title: `Read ${file}?`, say: `Reading ${clip(file, 60)}`, summary: file, subject: { ...base, path: file } };
  }
  if (name === 'WebSearch') {
    const q = clip(args.query, 80);
    return { title: `Search the web for “${q}”?`, say: `Searching: ${clip(q, 60)}`, summary: q, subject: base };
  }
  if (name === 'WebFetch') {
    const host = hostOf(args.url);
    return { title: `Open ${host} in the browser?`, say: `Opening ${host}`, summary: clip(args.url, 120), subject: base };
  }
  if (name === 'Glob' || name === 'Grep') {
    const pattern = clip(args.pattern, 60);
    return { title: `Search files for \`${pattern}\`?`, say: `Searching files: ${pattern}`, summary: pattern, subject: base };
  }
  if (name === 'Agent' || name === 'Task') {
    const what = clip(args.description ?? args.subagent_type ?? 'a subtask', 60);
    return { title: `Start a helper for “${what}”?`, say: `Delegating: ${what}`, summary: what, subject: base };
  }
  if (name === 'TodoWrite') {
    return { title: 'Update the to-do list?', say: 'Updating the plan', summary: 'to-do list', subject: base };
  }
  if (name === 'AskUserQuestion') {
    const questions = Array.isArray(args.questions) ? args.questions : [];
    const first = clip(questions[0]?.question ?? 'A question', 100);
    return { title: first, say: 'Asking a question', summary: first, subject: { ...base, type: 'question' } };
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) {
    return {
      title: `Use ${mcp[2]} from ${mcp[1]}?`,
      say: `Using ${mcp[1]}: ${mcp[2]}`,
      summary: `${mcp[1]}: ${mcp[2]}`,
      subject: { ...base, mcpServer: mcp[1] },
    };
  }
  return { title: `Use ${name}?`, say: `Using ${name}`, summary: name, subject: base };
}

// ---------------------------------------------------------------------------
// Binary lookup and probe

/** `which`-style lookup without a shell. */
export async function findOnPath(name, envPath = process.env.PATH ?? '', platform = process.platform) {
  const names = platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    for (const candidate of names) {
      const full = path.join(dir, candidate);
      try {
        await access(full, platform === 'win32' ? constants.F_OK : constants.X_OK);
        return full;
      } catch {
        // not here; keep looking
      }
    }
  }
  return null;
}

function parseAuthStatus(stdout) {
  try {
    const json = JSON.parse(String(stdout));
    return json && typeof json === 'object' ? json : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Permission answers

/** Translate an AskAnswer into the SDK's PermissionResult. */
export function toPermissionResult(answer, { toolName, input }) {
  const a = answer && typeof answer === 'object' ? answer : { behavior: 'cancel' };
  if (a.behavior === 'allow') {
    if (toolName === 'AskUserQuestion') {
      const updatedInput = { ...input, questions: input?.questions ?? [] };
      const answers = a.answers ?? a.updatedInput?.answers;
      if (answers && typeof answers === 'object') updatedInput.answers = answers;
      else if (a.message) updatedInput.response = a.message;
      else updatedInput.answers = {};
      return { behavior: 'allow', updatedInput };
    }
    // "Allow always" is a plain allow here: the engine remembers exact subjects.
    // Claude's own permission suggestions (broad rules, mode changes) are never applied.
    return { behavior: 'allow', updatedInput: a.updatedInput ?? input };
  }
  if (a.behavior === 'deny') {
    const fallback = toolName === 'AskUserQuestion' ? 'The user declined to answer.' : 'The user denied this action.';
    return { behavior: 'deny', message: a.message || fallback };
  }
  return { behavior: 'deny', message: a.message || 'The request was cancelled.', interrupt: true };
}

// ---------------------------------------------------------------------------
// The backend

/**
 * @param {object} [options]
 * @param {Function} [options.query] the Agent SDK `query` (injected by tests)
 * @param {(file: string, args: string[], opts: object) => Promise<{stdout: string, stderr?: string}>} [options.execFile]
 * @param {string} [options.claudePath] path to `claude`; default: looked up on PATH
 * @param {Record<string, string | undefined>} [options.env] source environment for `childEnv` (default `process.env`)
 * @param {string} [options.home] home directory for `~` shortening
 * @param {number} [options.closeTimeoutMs] how long close() waits for the CLI to exit
 * @returns {AgentBackend}
 */
export function createClaudeBackend(options = {}) {
  const envSource = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const execFile = options.execFile ?? promisify(execFileCallback);
  const closeTimeoutMs = options.closeTimeoutMs ?? 10000;
  /** @type {Set<AgentSession>} */
  const sessions = new Set();
  let claudePath = options.claudePath ?? null;
  let queryFn = options.query ?? null;

  async function resolveClaude() {
    if (!claudePath) claudePath = await findOnPath('claude', envSource.PATH ?? '');
    return claudePath;
  }

  async function loadQuery() {
    if (!queryFn) queryFn = (await import('@anthropic-ai/claude-agent-sdk')).query;
    return queryFn;
  }

  async function probe() {
    const bin = await resolveClaude();
    if (!bin) return { available: false, detail: 'Claude Code is not installed (no `claude` on PATH).' };
    const run = async (args) => {
      try {
        return await execFile(bin, args, { timeout: PROBE_TIMEOUT_MS, env: childEnv({}, envSource), windowsHide: true });
      } catch (err) {
        // `claude auth status` exits non-zero when signed out but still prints JSON.
        if (err && typeof err.stdout === 'string' && err.stdout.trim()) return { stdout: err.stdout, stderr: err.stderr };
        throw err;
      }
    };
    let version;
    try {
      const { stdout } = await run(['--version']);
      version = /\d+\.\d+\.\d+\S*/.exec(String(stdout))?.[0] ?? (String(stdout).trim() || undefined);
    } catch (err) {
      return { available: false, detail: `\`claude --version\` failed: ${clip(err?.message, 200)}` };
    }
    let status = null;
    try {
      status = parseAuthStatus((await run(['auth', 'status', '--json'])).stdout);
    } catch (err) {
      return { available: true, version, loggedIn: false, detail: `\`claude auth status\` failed: ${clip(err?.message, 200)}` };
    }
    if (!status) return { available: true, version, loggedIn: false, detail: 'Could not read `claude auth status`.' };
    // Only the boolean and the auth-method / plan labels are used; email and org ids are ignored.
    const loggedIn = status.loggedIn === true;
    const labels = [status.authMethod, status.subscriptionType].filter((v) => typeof v === 'string' && v);
    const detail = loggedIn
      ? `Signed in${labels.length ? ` (${labels.join(', ')})` : ''}.`
      : 'Not signed in. Run `claude auth login` in a terminal.';
    return { available: true, version, loggedIn, detail };
  }

  /**
   * @param {SessionSpec} spec
   * @param {SessionSink} sink
   * @returns {Promise<AgentSession>}
   */
  async function start(spec, sink) {
    const query = await loadQuery();
    const bin = await resolveClaude();
    if (!bin) throw new Error('Claude Code is not installed (no `claude` on PATH).');

    const compiled = (spec.compiled && spec.compiled.claude) || {};
    const cwd = spec.cwd;
    const input = createPushable();
    const abortController = new AbortController();
    const now = () => new Date().toISOString();

    let id = spec.resume || randomUUID();
    let closing = false;
    let closed = false;
    let running = false;
    let registered = false;
    let interruptPending = false;
    let lastAssistantText = '';
    let stderrTail = '';
    let resultCount = 0;
    const totals = { inputTokens: 0, outputTokens: 0 };
    /** @type {string[]} uuids pushed but not yet consumed by a `result` */
    const outstanding = [];
    /** @type {Map<string, (r: TurnResult) => void>} */
    const turnWaiters = new Map();
    /** @type {Map<string, {promise: Promise<object>, settle: (r: object) => void}>} */
    const asks = new Map();
    /** @type {Map<string, object>} answered permission results, for re-delivered requests */
    const answered = new Map();
    /** @type {Map<string, string>} tool_use id → tool name */
    const toolNames = new Map();
    let turnChain = Promise.resolve();

    const emit = (type, data) => {
      try {
        sink.event(type, data);
      } catch {
        // a sink failure must not break the session loop
      }
    };
    const record = (entry) => {
      try {
        sink.transcript({ ts: now(), ...entry });
      } catch {
        // same as above
      }
    };

    const currentState = () => {
      if (closed) return 'closed';
      if (asks.size) return 'requires_action';
      return running ? 'running' : 'idle';
    };

    // ---- permission callback -------------------------------------------------

    // One decision per tool-use id, shared by canUseTool and the PreToolUse hook:
    // a re-delivered request, or the same call reaching both paths, gets the one
    // answer and the person is asked once.
    function requestDecision(key, toolName, toolInput, opts = {}) {
      const pending = asks.get(key);
      if (pending) return pending.promise;
      if (answered.has(key)) return Promise.resolve(answered.get(key));
      if (closing || closed) return Promise.resolve({ behavior: 'deny', message: 'The session is closing.', interrupt: true });

      let resolvePromise;
      const promise = new Promise((resolve) => {
        resolvePromise = resolve;
      });
      let done = false;
      const entry = {
        promise,
        settle(result, remember = false) {
          if (done) return;
          done = true;
          asks.delete(key);
          if (remember) answered.set(key, result);
          resolvePromise(result);
        },
      };
      asks.set(key, entry);

      const signal = opts.signal;
      if (signal) {
        const onAbort = () => entry.settle({ behavior: 'deny', message: 'The request was cancelled.', interrupt: true });
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      const described = describeTool(toolName, toolInput, { cwd, home });
      const isQuestion = toolName === 'AskUserQuestion';
      /** @type {AskRequest} */
      const request = {
        kind: isQuestion ? 'question' : 'approval',
        title: described.title,
        subject: described.subject,
        toolCallId: opts.toolUseID,
        options: isQuestion
          ? []
          : [
              { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
              { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
            ],
        source: { backend: BACKEND, raw: opts.raw || 'can_use_tool' },
      };
      if (opts.description) request.description = shortenHome(String(opts.description), home);
      if (isQuestion) request.questions = Array.isArray(toolInput?.questions) ? toolInput.questions : [];

      Promise.resolve()
        .then(() => sink.ask(request))
        .then(
          (answer) => {
            const result = toPermissionResult(answer, { toolName, input: toolInput });
            entry.settle(result, answer?.behavior === 'allow' || answer?.behavior === 'deny');
          },
          (err) => entry.settle({ behavior: 'deny', message: `No answer could be obtained: ${clip(err?.message, 200)}` }),
        );
      return promise;
    }

    async function canUseTool(toolName, toolInput, opts = {}) {
      const key = opts.toolUseID || opts.requestId || randomUUID();
      return requestDecision(key, toolName, toolInput, {
        signal: opts.signal,
        toolUseID: opts.toolUseID,
        description: opts.description || opts.decisionReason,
      });
    }

    // PreToolUse hook: runs for every tool call, including those Claude Code allows
    // without asking (reads inside cwd, read-only Bash) and those made by subagents.
    // `deny` blocks; `ask` gets its answer through requestDecision (the same registry
    // as canUseTool); `allow` / no verdict returns `{}` ("no decision"), so the hook
    // never approves anything the role check did not send to a person.
    async function preToolUse(hookInput, toolUseID, hookOptions = {}) {
      if (typeof sink.precheck !== 'function' || !hookInput || hookInput.hook_event_name !== 'PreToolUse') return {};
      const decide = (permissionDecision, reason, extra = {}) => ({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason: reason, ...extra },
      });
      const toolName = String(hookInput.tool_name ?? 'tool');
      const toolInput = hookInput.tool_input && typeof hookInput.tool_input === 'object' ? hookInput.tool_input : {};
      let verdict;
      try {
        verdict = await sink.precheck(describeTool(toolName, toolInput, { cwd, home }).subject);
      } catch {
        return decide('deny', 'Not allowed for your role: the role check failed.');
      }
      if (verdict?.effect === 'deny') {
        return decide('deny', `Not allowed for your role: ${verdict.reason || 'this tool call is outside the role design.'}`);
      }
      if (verdict?.effect !== 'ask') return {};
      const key = hookInput.tool_use_id || toolUseID || randomUUID();
      const result = await requestDecision(key, toolName, toolInput, {
        signal: hookOptions?.signal,
        toolUseID: key,
        description: verdict.reason,
        raw: 'pre_tool_use',
      });
      if (result.behavior === 'allow') {
        const changed = result.updatedInput && result.updatedInput !== toolInput;
        return decide('allow', 'Approved.', changed ? { updatedInput: result.updatedInput } : {});
      }
      return decide('deny', result.message || 'The user denied this action.');
    }

    // ---- message mapping -----------------------------------------------------

    function markWorking() {
      if (running) return;
      running = true;
      emit('agent.status', { state: 'working', say: 'Working' });
    }

    function onSystem(msg) {
      if (msg.subtype === 'init') {
        if (typeof msg.session_id === 'string' && msg.session_id) id = msg.session_id;
        if (registered) return;
        registered = true;
        const model = typeof msg.model === 'string' ? msg.model : undefined;
        emit('agent.registered', {
          backend: BACKEND,
          ...(model ? { model } : {}),
          session: { backend: BACKEND, id, resumable: true },
          accepts: ACCEPTS,
        });
        record({ kind: 'system', text: spec.resume ? 'Session resumed' : `Session started${model ? ` (${model})` : ''}` });
      }
      // Other subtypes (session_state_changed, status, hooks, tasks, …) carry nothing we map.
    }

    function onAssistant(msg) {
      const blocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
      const fromSubagent = typeof msg.parent_tool_use_id === 'string' && msg.parent_tool_use_id !== '';
      const parent = fromSubagent ? { parentCallId: msg.parent_tool_use_id } : {};
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          const text = shortenHome(block.text.trim(), home);
          record({ kind: 'assistant', text, ...parent });
          if (!fromSubagent) {
            lastAssistantText = text;
            emit('message', { text: firstSentence(text) });
          }
        } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
          record({ kind: 'thinking', text: shortenHome(block.thinking.trim(), home), ...parent });
        } else if ((block.type === 'tool_use' || block.type === 'server_tool_use') && typeof block.id === 'string') {
          const name = String(block.name ?? 'tool');
          toolNames.set(block.id, name);
          const d = describeTool(name, block.input, { cwd, home });
          emit('tool.started', { name, callId: block.id, say: d.say });
          record({ kind: 'tool_call', callId: block.id, tool: name, summary: d.summary, input: d.subject.input, ...parent });
        }
      }
      if (msg.error && !fromSubagent) record({ kind: 'system', text: `Model error: ${msg.error}` });
    }

    function onUser(msg) {
      if (msg.isReplay) return;
      const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
      const parent = msg.parent_tool_use_id ? { parentCallId: msg.parent_tool_use_id } : {};
      for (const block of content) {
        if (!block || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const callId = block.tool_use_id;
        const name = toolNames.get(callId);
        const text = shortenHome(textOf(block.content), home);
        const ok = block.is_error !== true;
        const detached = msg.tool_use_result && typeof msg.tool_use_result === 'object' && msg.tool_use_result.detachedToolCall;
        if (ok) emit('tool.finished', { ...(name ? { name } : {}), callId });
        else emit('tool.failed', { ...(name ? { name } : {}), callId, error: firstSentence(text, 200) || 'Tool failed' });
        record({
          kind: 'tool_result',
          callId,
          ok,
          summary: detached ? 'Moved to the background' : firstSentence(text, 80),
          text: text.length > TOOL_RESULT_MAX ? `${text.slice(0, TOOL_RESULT_MAX)}…` : text,
          ...parent,
        });
      }
    }

    function onRateLimit(msg) {
      const info = msg.rate_limit_info;
      if (!info || typeof info !== 'object') return;
      const limit = {};
      if (info.status) limit.status = info.status;
      if (info.rateLimitType) limit.kind = info.rateLimitType;
      if (typeof info.resetsAt === 'number') {
        limit.resetsAt = new Date(info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt).toISOString();
      }
      if (typeof info.utilization === 'number') limit.utilization = info.utilization;
      emit('usage', { limit });
    }

    function onResult(msg) {
      resultCount += 1;
      const modelUsage = msg.modelUsage && typeof msg.modelUsage === 'object' ? Object.values(msg.modelUsage) : [];
      if (modelUsage.length) {
        // modelUsage is cumulative for this query(), so it replaces the totals.
        totals.inputTokens = 0;
        totals.outputTokens = 0;
        for (const u of modelUsage) {
          totals.inputTokens += (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
          totals.outputTokens += u.outputTokens ?? 0;
        }
      } else if (msg.usage && typeof msg.usage === 'object') {
        totals.inputTokens += (msg.usage.input_tokens ?? 0) + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0);
        totals.outputTokens += msg.usage.output_tokens ?? 0;
      }
      const usage = { inputTokens: totals.inputTokens, outputTokens: totals.outputTokens, turns: resultCount };
      if (typeof msg.total_cost_usd === 'number') usage.costUsd = msg.total_cost_usd;
      emit('usage', usage);

      const aborted = msg.terminal_reason === 'aborted_streaming' || msg.terminal_reason === 'aborted_tools';
      /** @type {TurnResult['stopReason']} */
      let stopReason;
      if (interruptPending || aborted) stopReason = 'cancelled';
      else if (msg.subtype === 'success' && !msg.is_error) stopReason = 'end_turn';
      else if (msg.subtype === 'error_max_turns') stopReason = 'max_turns';
      else stopReason = 'error';
      const ok = stopReason === 'end_turn';
      const text = shortenHome(typeof msg.result === 'string' && msg.result ? msg.result : lastAssistantText, home);
      lastAssistantText = '';
      /** @type {TurnResult} */
      const turnResult = { ok, text, stopReason, usage };
      if (!ok) {
        const errors = Array.isArray(msg.errors) ? msg.errors.filter(Boolean).join('; ') : '';
        turnResult.error = shortenHome(errors || (msg.is_error && msg.result) || stopReason, home);
      }
      record({ kind: 'result', ok, text, usage, ...(turnResult.error ? { error: turnResult.error } : {}) });

      // Which pushed messages did this result consume? The CLI echoes our uuids in
      // user_message_uuids; without an echo, results arrive in push order.
      const reported = Array.isArray(msg.user_message_uuids)
        ? msg.user_message_uuids
        : typeof msg.user_message_uuid === 'string'
          ? [msg.user_message_uuid]
          : [];
      let consumed = reported.filter((u) => outstanding.includes(u));
      if (!consumed.length && outstanding.length) consumed = [outstanding[0]];
      for (const uuid of consumed) {
        const at = outstanding.indexOf(uuid);
        if (at >= 0) outstanding.splice(at, 1);
      }
      // Without an echo, queued_turn_count 0 means no further result follows: whatever
      // is outstanding was folded into this turn.
      if (!reported.length && msg.queued_turn_count === 0) consumed = consumed.concat(outstanding.splice(0));
      for (const uuid of consumed) {
        const waiter = turnWaiters.get(uuid);
        if (waiter) {
          turnWaiters.delete(uuid);
          waiter(turnResult);
        }
      }

      if (interruptPending) {
        interruptPending = false;
        running = false;
        emit('agent.stopped', { reason: 'Interrupted', scope: 'turn' });
        if (outstanding.length) markWorking();
        return;
      }
      if (!outstanding.length) {
        running = false;
        emit('agent.status', { state: 'idle', say: ok ? 'Turn finished' : `Turn ended (${stopReason})`, stopReason });
      }
    }

    function handle(msg) {
      if (!msg || typeof msg !== 'object') return;
      try {
        switch (msg.type) {
          case 'system':
            onSystem(msg);
            break;
          case 'assistant':
            onAssistant(msg);
            break;
          case 'user':
            onUser(msg);
            break;
          case 'result':
            onResult(msg);
            break;
          case 'rate_limit_event':
            onRateLimit(msg);
            break;
          default:
            break; // unknown types are skipped
        }
      } catch {
        // a malformed message is skipped, never fatal
      }
    }

    // ---- lifecycle -----------------------------------------------------------

    function finish(stopReason, error) {
      if (closed) return;
      closed = true;
      running = false;
      input.end();
      for (const entry of asks.values()) entry.settle({ behavior: 'deny', message: 'The session was closed.', interrupt: true });
      const result = { ok: false, text: '', stopReason, error: error || 'The session was closed.' };
      for (const waiter of turnWaiters.values()) waiter(result);
      turnWaiters.clear();
      outstanding.length = 0;
      sessions.delete(session);
    }

    function pushUser(text, priority) {
      const uuid = randomUUID();
      /** @type {Record<string, unknown>} */
      const message = {
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        session_id: id,
        uuid,
      };
      if (priority) message.priority = priority;
      outstanding.push(uuid);
      markWorking();
      input.push(message);
      return uuid;
    }

    /** @type {Record<string, unknown>} */
    const sdkOptions = {
      cwd,
      pathToClaudeCodeExecutable: bin,
      env: childEnv({ CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' }, envSource),
      settingSources: Array.isArray(compiled.settingSources) ? compiled.settingSources : [],
      permissionMode: compiled.permissionMode || 'default',
      strictMcpConfig: typeof compiled.strictMcpConfig === 'boolean' ? compiled.strictMcpConfig : true,
      systemPrompt: spec.systemPrompt
        ? { type: 'preset', preset: 'claude_code', append: spec.systemPrompt }
        : { type: 'preset', preset: 'claude_code' },
      canUseTool,
      // timeout: a person may take hours to answer an `ask`; onFailure 'block' keeps a
      // failed or timed-out hook from letting the call through.
      hooks: { PreToolUse: [{ hooks: [preToolUse], timeout: PRECHECK_TIMEOUT_S, onFailure: 'block' }] },
      abortController,
      stderr: (data) => {
        stderrTail = `${stderrTail}${data}`.slice(-2000);
      },
    };
    if (Array.isArray(compiled.tools)) sdkOptions.tools = compiled.tools;
    // Names listed here skip canUseTool (no approval), but the PreToolUse precheck still runs.
    if (Array.isArray(compiled.allowedTools) && compiled.allowedTools.length) sdkOptions.allowedTools = compiled.allowedTools;
    if (Array.isArray(compiled.disallowedTools) && compiled.disallowedTools.length) sdkOptions.disallowedTools = compiled.disallowedTools;
    if (compiled.mcpServers && typeof compiled.mcpServers === 'object' && Object.keys(compiled.mcpServers).length) {
      sdkOptions.mcpServers = compiled.mcpServers;
    }
    const model = spec.model || spec.compiled?.model;
    if (model) sdkOptions.model = model;
    if (spec.resume) sdkOptions.resume = spec.resume;
    else sdkOptions.sessionId = id;

    const q = query({ prompt: input, options: sdkOptions });

    const loop = (async () => {
      try {
        for await (const msg of q) handle(msg);
        if (!closing) {
          const reason = `The Claude Code session ended unexpectedly.${stderrTail ? ` ${clip(shortenHome(stderrTail, home), 300)}` : ''}`;
          record({ kind: 'system', text: reason });
          emit('agent.failed', { reason });
          finish('error', reason);
        }
      } catch (err) {
        if (!closing) {
          const reason = `Claude Code session failed: ${clip(shortenHome(String(err?.message ?? err), home), 300)}`;
          record({ kind: 'system', text: reason });
          emit('agent.failed', { reason });
          finish('error', reason);
        }
      } finally {
        finish('cancelled');
      }
    })();

    const withTimeout = (promise, ms) =>
      Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref?.())]);

    /** @type {AgentSession} */
    const session = {
      get id() {
        return id;
      },
      get state() {
        return currentState();
      },

      turn(text) {
        const run = turnChain.then(
          () =>
            new Promise((resolve) => {
              if (closing || closed) {
                resolve({ ok: false, text: '', stopReason: 'cancelled', error: 'The session was closed.' });
                return;
              }
              record({ kind: 'user', text: shortenHome(String(text), home), origin: 'system' });
              const uuid = pushUser(String(text), running ? 'later' : undefined);
              turnWaiters.set(uuid, resolve);
            }),
        );
        turnChain = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },

      async send(text, delivery) {
        if (closing || closed) return { status: 'rejected', reason: 'no_session: the session is closed' };
        const body = String(text);
        const wasRunning = running;
        if (delivery === 'interrupt') {
          if (wasRunning) {
            try {
              await session.interrupt();
            } catch (err) {
              return { status: 'rejected', reason: `The interrupt failed: ${clip(err?.message, 200)}` };
            }
            pushUser(body);
            return { status: 'applied', reason: 'Interrupted the running turn, then sent the message as a new turn.' };
          }
          pushUser(body);
          return { status: 'applied', reason: 'No turn was running; the message started a new turn.' };
        }
        if (delivery === 'queue') {
          pushUser(body, 'later');
          return {
            status: 'applied',
            reason: wasRunning
              ? 'Queued: it runs as a new turn after the current turn ends.'
              : 'No turn was running; the message started a new turn.',
          };
        }
        if (delivery === 'steer') {
          if (asks.size) {
            pushUser(body, 'later');
            return {
              status: 'applied',
              reason: 'An approval is pending, so the message was queued (delivered as a new turn after this one) instead of steering.',
            };
          }
          pushUser(body, 'next');
          return {
            status: 'applied',
            reason: wasRunning
              ? 'Delivered into the running turn at its next break point (after the current tool calls finish).'
              : 'No turn was running; the message started a new turn.',
          };
        }
        return { status: 'rejected', reason: `Unknown delivery: ${delivery}` };
      },

      async interrupt() {
        if (closing || closed || !running) return;
        interruptPending = true;
        try {
          await q.interrupt();
        } catch (err) {
          interruptPending = false;
          throw err;
        }
      },

      async close() {
        if (closing) return loop.then(() => undefined);
        closing = true;
        for (const entry of asks.values()) entry.settle({ behavior: 'deny', message: 'The session was closed.', interrupt: true });
        if (running) {
          try {
            await withTimeout(Promise.resolve(q.interrupt()), 3000);
          } catch {
            // the process may already be gone
          }
        }
        input.end();
        try {
          await withTimeout(loop, closeTimeoutMs);
        } catch {
          try {
            if (typeof q.close === 'function') q.close();
          } catch {
            // ignore
          }
          abortController.abort();
          await withTimeout(loop, 2000).catch(() => undefined);
        }
        finish('cancelled');
      },
    };

    sessions.add(session);
    return session;
  }

  async function close() {
    await Promise.all([...sessions].map((s) => s.close().catch(() => undefined)));
  }

  return { name: BACKEND, probe, start, close };
}
