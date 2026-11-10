// Codex session adapter. One shared `codex app-server` child (the user's installed, unmodified
// binary) over stdio JSON-RPC; one Codex thread per agent. The contract is docs/design/runtime.md §4.
//
// Wire shapes follow the generated types of codex-cli 0.167.0 (`codex app-server generate-ts`), stable
// surface only (`experimentalApi: false`). The app-server protocol is experimental upstream, so every
// field read here is optional-chained and unknown notifications are ignored.
//
// Compliance (root CLAUDE.md §3): login state comes only from `account/read`; no credential file is
// read; `account/chatgptAuthTokens/refresh` is refused; the child gets `childEnv()`, never our env.

import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JsonRpcPeer, JsonRpcError, ErrorCodes, NO_RESPONSE } from './jsonrpc.js';
import { childEnv } from './types.js';

/** @typedef {import('./types.js').SessionSpec} SessionSpec */
/** @typedef {import('./types.js').SessionSink} SessionSink */
/** @typedef {import('./types.js').AskRequest} AskRequest */
/** @typedef {import('./types.js').AskAnswer} AskAnswer */
/** @typedef {import('./types.js').TurnResult} TurnResult */
/** @typedef {import('./types.js').AgentBackend} AgentBackend */
/** @typedef {import('./types.js').Delivery} Delivery */

const PACKAGE_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
})();

/** Streaming deltas we never read: `item/completed` carries the authoritative item. */
export const OPT_OUT_NOTIFICATIONS = [
  'item/agentMessage/delta',
  'item/plan/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
  'item/commandExecution/outputDelta',
  'item/commandExecution/terminalInteraction',
  'item/fileChange/outputDelta',
  'item/fileChange/patchUpdated',
  'item/mcpToolCall/progress',
  'command/exec/outputDelta',
  'process/outputDelta',
  'turn/diff/updated',
  'rawResponseItem/completed',
  'rawResponse/completed',
];

const TRANSCRIPT_LIMIT = 4000;
const RESTART_LIMIT = 3;
const RESTART_WINDOW_MS = 60_000;

// No session-wide option: `acceptForSession` would widen what Codex runs without asking past the
// role policy. "Allow always" from the engine is sent as a plain `accept`; the engine remembers
// exact subjects itself.
const APPROVAL_OPTIONS = [
  { optionId: 'accept', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'decline', name: 'Decline', kind: 'reject_once' },
  { optionId: 'cancel', name: 'Decline and stop the turn', kind: 'reject_once' },
];

// ---------------------------------------------------------------------------------------------
// Small helpers

/** @param {unknown} error */
const messageOf = (error) => String(/** @type {any} */ (error)?.message ?? error);

/** @param {string | null | undefined} text @param {number} [max] */
function truncate(text, max = TRANSCRIPT_LIMIT) {
  if (typeof text !== 'string') return '';
  return text.length > max ? `${text.slice(0, max)}…(truncated)` : text;
}

/** First non-empty line, whitespace collapsed, cut to `max` chars. */
function oneLine(text, max = 140) {
  if (typeof text !== 'string') return '';
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const flat = line.replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** `/bin/zsh -lc 'ls -la'` → `ls -la`; anything else unchanged. */
export function unwrapShell(command) {
  if (typeof command !== 'string') return '';
  const match = command.match(/^(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/);
  return match ? match[2] : command;
}

function deferred() {
  /** @type {(value?: any) => void} */
  let resolve = () => {};
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const delay = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });

/** @param {string} p @param {string} cwd */
function relativeTo(p, cwd) {
  if (typeof p !== 'string') return '';
  if (!cwd || !path.isAbsolute(p)) return p;
  const rel = path.relative(cwd, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : p;
}

/** Map a Codex rate-limit snapshot to the protocol's `usage.limit` object (no account ids). */
export function limitFromSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const window = (w) => (w && typeof w === 'object'
    ? {
      usedPercent: w.usedPercent ?? null,
      windowMins: w.windowDurationMins ?? null,
      resetsAt: typeof w.resetsAt === 'number' ? new Date(w.resetsAt * 1000).toISOString() : null,
    }
    : null);
  const primary = window(snapshot.primary);
  const secondary = window(snapshot.secondary);
  const used = Math.max(primary?.usedPercent ?? 0, secondary?.usedPercent ?? 0);
  const status = snapshot.rateLimitReachedType ? 'rejected' : used >= 80 ? 'allowed_warning' : 'allowed';
  return {
    source: 'codex',
    status,
    kind: snapshot.limitId ?? 'codex',
    resetsAt: primary?.resetsAt ?? null,
    primary,
    secondary,
    planType: snapshot.planType ?? null,
    reached: snapshot.rateLimitReachedType ?? null,
  };
}

/** Merge a sparse rate-limit update over the last full snapshot (null fields keep the old value). */
function mergeSnapshot(previous, update) {
  if (!previous) return update;
  if (!update) return previous;
  const merged = { ...previous };
  for (const [key, value] of Object.entries(update)) if (value !== null && value !== undefined) merged[key] = value;
  return merged;
}

/** Plain-text sign-in description for `probe().detail`: never an email, workspace or account id. */
function describeAccount(account) {
  switch (account?.type) {
    case 'chatgpt': return `Signed in with ChatGPT${account.planType ? ` (${account.planType} plan)` : ''}`;
    case 'apiKey': return 'Signed in with an API key';
    case 'amazonBedrock': return 'Using Amazon Bedrock';
    case 'gcp': return 'Using Google Cloud';
    default: return `Signed in (${account?.type ?? 'unknown'})`;
  }
}

// ---------------------------------------------------------------------------------------------
// Thread configuration

/** `SandboxPolicy` fields per type in codex-cli 0.167.0 (generated types, stable and experimental alike). */
const SANDBOX_POLICY_FIELDS = {
  readOnly: ['type', 'networkAccess'],
  workspaceWrite: ['type', 'writableRoots', 'networkAccess', 'excludeTmpdirEnvVar', 'excludeSlashTmp'],
  externalSandbox: ['type', 'networkAccess'],
  dangerFullAccess: ['type'],
};

/**
 * The `sandboxPolicy` sent with every `turn/start`: the compiled one when given, reduced to the
 * fields the installed protocol knows; otherwise built from `sandbox`, `networkAccess`, `writableRoots`.
 * @returns {{policy: object | null, dropped: string[]}}
 */
export function turnSandboxPolicy(codex, sandbox, cwd) {
  const networkAccess = Boolean(codex.networkAccess);
  const given = codex.sandboxPolicy && typeof codex.sandboxPolicy === 'object' ? codex.sandboxPolicy : null;
  if (given) {
    const known = SANDBOX_POLICY_FIELDS[given.type];
    if (!known) return { policy: null, dropped: [`type "${given.type}" (the thread keeps its sandbox mode)`] };
    const policy = {};
    const dropped = [];
    for (const [key, value] of Object.entries(given)) {
      if (known.includes(key)) policy[key] = value;
      else dropped.push(key);
    }
    if (Array.isArray(policy.writableRoots)) policy.writableRoots = policy.writableRoots.map((root) => path.resolve(cwd, root));
    return { policy, dropped };
  }
  if (sandbox === 'workspace-write') {
    return {
      policy: {
        type: 'workspaceWrite',
        writableRoots: (codex.writableRoots ?? []).map((root) => path.resolve(cwd, root)),
        networkAccess,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      dropped: [],
    };
  }
  if (sandbox === 'read-only') return { policy: { type: 'readOnly', networkAccess }, dropped: [] };
  return { policy: null, dropped: [] };
}

/**
 * Thread config overrides that leave a role only the MCP servers it was given. Codex merges
 * `config` over the user's own config layers, so every other server the app-server reports is
 * switched off: plain servers with `mcp_servers.<name>.enabled = false`, plugin servers with
 * `plugins.<pluginId>.enabled = false`, and ChatGPT apps with `features.apps = false`.
 * @param {object} config the compiled `codex.config`
 * @param {{name: string, pluginId: string | null}[]} inventory from `mcpServerStatus/list`
 * @param {Set<string>} [skip] servers Codex refused to disable before
 * @returns {{config: object, added: Set<string>}}
 */
export function isolationConfig(config, inventory, skip = new Set()) {
  const granted = new Set(Object.keys(config.mcp_servers ?? {}));
  const mcpServers = { ...(config.mcp_servers ?? {}) };
  const plugins = { ...(config.plugins ?? {}) };
  const added = new Set();
  for (const server of inventory) {
    if (granted.has(server.name) || skip.has(server.name)) continue;
    if (server.pluginId) {
      if (!(server.pluginId in plugins)) plugins[server.pluginId] = { enabled: false };
    } else {
      mcpServers[server.name] = { enabled: false };
      added.add(server.name);
    }
  }
  const features = { ...(config.features ?? {}) };
  if (!('apps' in features)) features.apps = false;
  return {
    config: { ...config, mcp_servers: mcpServers, ...(Object.keys(plugins).length ? { plugins } : {}), features },
    added,
  };
}

// ---------------------------------------------------------------------------------------------
// Server requests → AskRequest, and AskAnswer → the exact response shape for each method.

/**
 * @param {AskAnswer} answer
 * @returns {'accept' | 'decline' | 'cancel'} never `acceptForSession`
 */
function approvalDecision(answer) {
  if (answer?.behavior === 'allow') return 'accept';
  if (answer?.behavior === 'deny') return answer.optionId === 'cancel' ? 'cancel' : 'decline';
  return 'cancel';
}

/** v2 decision → legacy `ReviewDecision` (for `execCommandApproval` / `applyPatchApproval`). */
function legacyDecision(decision, answer) {
  switch (decision) {
    case 'accept': return 'approved';
    case 'decline': return { denied: { rejection: answer?.message || 'Declined in MAS Office' } };
    default: return 'abort';
  }
}

function commandAsk(params, session, { legacy = false } = {}) {
  const rawCommand = legacy ? (params.command ?? []).join(' ') : (params.command ?? '');
  const command = unwrapShell(rawCommand);
  const network = params.networkApprovalContext ?? null;
  const approvalKind = params.kind ?? 'command';
  const itemId = legacy ? params.callId : params.itemId;
  let title;
  if (network) title = `Allow network access to ${network.host}?`;
  else if (approvalKind === 'writeStdin') title = `Send input to \`${oneLine(command, 80)}\`?`;
  else title = `Run \`${oneLine(command, 80)}\`?`;
  const humanOnly = approvalKind === 'humanCommand';
  /** @type {AskRequest} */
  const request = {
    kind: 'approval',
    title,
    ...(params.reason ? { description: params.reason } : {}),
    subject: {
      type: 'command',
      command,
      cwd: params.cwd ?? session.cwd,
      ...(rawCommand !== command ? { rawCommand } : {}),
      ...(network ? { network } : {}),
      ...(approvalKind !== 'command' ? { approvalKind } : {}),
      ...(humanOnly ? { humanOnly: true } : {}),
    },
    toolCallId: params.approvalId ? `${itemId}:${params.approvalId}` : itemId,
    options: APPROVAL_OPTIONS,
    source: { backend: 'codex', raw: legacy ? 'execCommandApproval' : 'item/commandExecution/requestApproval' },
  };
  const respond = (answer) => {
    const decision = approvalDecision(answer);
    return { decision: legacy ? legacyDecision(decision, answer) : decision };
  };
  // A network grant widens the sandbox past the role design: declined without asking anyone.
  const immediate = network
    ? { response: respond({ behavior: 'deny' }), note: `Declined network access to ${network.host} without asking: network grants are not part of the team design.` }
    : null;
  return { request, respond, immediate };
}

function fileChangeAsk(params, session, { legacy = false } = {}) {
  const itemId = legacy ? params.callId : params.itemId;
  const changes = legacy
    ? Object.entries(params.fileChanges ?? {}).map(([p, change]) => ({ path: p, kind: change?.type ?? null, moveTo: change?.move_path ?? null, diff: change?.unified_diff ?? change?.content ?? '' }))
    : (session.fileChanges.get(itemId) ?? []).map((c) => ({ path: c.path, kind: c.kind?.type ?? c.kind ?? null, moveTo: c.kind?.move_path ?? c.move_path ?? null, diff: c.diff ?? '' }));
  // A rename writes at its destination too: both ends go to the policy.
  const paths = changes.flatMap((c) => [c.path, c.moveTo]).filter((p) => typeof p === 'string' && p);
  const shown = paths.map((p) => relativeTo(p, session.cwd));
  const title = shown.length === 1 ? `Change \`${shown[0]}\`?` : shown.length > 1 ? `Change ${shown.length} files?` : 'Allow file changes?';
  /** @type {AskRequest} */
  const request = {
    kind: 'approval',
    title,
    ...(params.reason ? { description: params.reason } : {}),
    subject: {
      type: 'file_change',
      ...(paths.length ? { path: paths[0] } : {}),
      paths,
      ...(params.grantRoot ? { grantRoot: params.grantRoot } : {}),
      input: { changes: changes.map((c) => ({ path: c.path, kind: c.kind, diff: truncate(c.diff) })) },
    },
    toolCallId: itemId,
    options: APPROVAL_OPTIONS,
    source: { backend: 'codex', raw: legacy ? 'applyPatchApproval' : 'item/fileChange/requestApproval' },
  };
  const respond = (answer) => {
    const decision = approvalDecision(answer);
    return { decision: legacy ? legacyDecision(decision, answer) : decision };
  };
  // A grant root asks for session-wide writes under a folder: declined without asking anyone.
  const immediate = params.grantRoot
    ? { response: respond({ behavior: 'deny' }), note: `Declined a file change asking for write access under ${relativeTo(params.grantRoot, session.cwd)} without asking: folder-wide write grants are not part of the team design.` }
    : null;
  return { request, respond, immediate };
}

function permissionsAsk(params, session) {
  const requested = params.permissions ?? {};
  const fs = requested.fileSystem ?? null;
  const parts = [];
  if (requested.network?.enabled) parts.push('network access');
  const writes = [...(fs?.write ?? []), ...(fs?.entries ?? []).filter((e) => e?.access === 'write').map((e) => e?.path?.path ?? e?.path)]
    .filter((p) => typeof p === 'string');
  const reads = (fs?.read ?? []).filter((p) => typeof p === 'string');
  if (writes.length) parts.push(`write access to ${writes.map((p) => relativeTo(p, session.cwd)).join(', ')}`);
  if (reads.length) parts.push(`read access to ${reads.map((p) => relativeTo(p, session.cwd)).join(', ')}`);
  /** @type {AskRequest} */
  const request = {
    kind: 'approval',
    title: `Grant ${parts.length ? parts.join(' and ') : 'extra permissions'}?`,
    ...(params.reason ? { description: params.reason } : {}),
    subject: { type: 'permissions', cwd: params.cwd ?? session.cwd, input: requested },
    toolCallId: params.itemId,
    options: [
      { optionId: 'allowTurn', name: 'Allow for this turn', kind: 'allow_once' },
      { optionId: 'decline', name: 'Decline', kind: 'reject_once' },
    ],
    source: { backend: 'codex', raw: 'item/permissions/requestApproval' },
  };
  const none = { permissions: {}, scope: 'turn' };
  // Write and network grants widen the sandbox past the role design: declined without asking.
  // Read grants may be asked about, and are never given for the whole session.
  const immediate = requested.network?.enabled || writes.length
    ? { response: none, note: `Declined a request for ${parts.join(' and ')} without asking: write and network grants are not part of the team design.` }
    : null;
  return {
    request,
    immediate,
    respond(answer) {
      if (answer?.behavior !== 'allow') return none;
      return { permissions: requested.fileSystem ? { fileSystem: requested.fileSystem } : {}, scope: 'turn' };
    },
  };
}

function userInputAsk(params) {
  const questions = (params.questions ?? []).map((q) => ({
    id: q.id,
    header: q.header ?? '',
    question: q.question ?? '',
    options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description ?? '' })),
    multiSelect: false,
    isOther: Boolean(q.isOther),
    isSecret: Boolean(q.isSecret),
  }));
  const single = questions.length === 1 ? questions[0] : null;
  /** @type {AskRequest} */
  const request = {
    kind: 'question',
    title: single ? oneLine(single.question, 120) || single.header : `${questions.length} questions`,
    subject: { type: 'question' },
    toolCallId: params.itemId,
    options: single ? single.options.map((o) => ({ optionId: o.label, name: o.label, kind: 'choice' })) : [],
    questions,
    source: { backend: 'codex', raw: 'item/tool/requestUserInput' },
  };
  return {
    request,
    respond(answer) {
      if (answer?.behavior !== 'allow') return { answers: {} };
      const given = answer.answers && typeof answer.answers === 'object' ? answer.answers : {};
      const answers = {};
      for (const q of questions) {
        let value = given[q.id] ?? given[q.question];
        if (value === undefined && single) value = answer.optionId ?? answer.message;
        if (value === undefined || value === null) continue;
        const list = (Array.isArray(value) ? value : [value]).map(String);
        answers[q.id] = { answers: list };
      }
      return { answers };
    },
  };
}

function elicitationAsk(params, session, id) {
  const mode = params.mode ?? 'form';
  /** @type {AskRequest} */
  const request = {
    kind: 'question',
    title: oneLine(params.message, 120) || `${params.serverName} asks for input`,
    ...(params.message && oneLine(params.message, 120) !== params.message ? { description: params.message } : {}),
    subject: {
      type: 'mcp_elicitation',
      server: params.serverName,
      mode,
      ...(params.url ? { url: params.url } : {}),
      ...(params.requestedSchema ? { input: params.requestedSchema } : {}),
    },
    toolCallId: `elicitation:${params.serverName}:${id}`,
    options: [
      { optionId: 'accept', name: 'Accept', kind: 'allow_once' },
      { optionId: 'decline', name: 'Decline', kind: 'reject_once' },
      { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
    ],
    source: { backend: 'codex', raw: 'mcpServer/elicitation/request' },
  };
  return {
    request,
    respond(answer) {
      if (answer?.behavior === 'allow') {
        const content = mode === 'url' ? null : (answer.answers ?? answer.updatedInput ?? {});
        return { action: 'accept', content, _meta: null };
      }
      return { action: answer?.behavior === 'deny' ? 'decline' : 'cancel', content: null, _meta: null };
    },
  };
}

/**
 * Every server request this version can send. `build` turns it into an ask; `refuse` is the answer
 * when no live session owns the thread. Methods not listed here get an explicit JSON-RPC error.
 */
const SERVER_REQUESTS = {
  'item/commandExecution/requestApproval': { build: (p, s) => commandAsk(p, s), refuse: () => ({ decision: 'cancel' }) },
  'item/fileChange/requestApproval': { build: (p, s) => fileChangeAsk(p, s), refuse: () => ({ decision: 'cancel' }) },
  'item/permissions/requestApproval': { build: (p, s) => permissionsAsk(p, s), refuse: () => ({ permissions: {}, scope: 'turn' }) },
  'item/tool/requestUserInput': { build: (p) => userInputAsk(p), refuse: () => ({ answers: {} }) },
  'mcpServer/elicitation/request': { build: (p, s, id) => elicitationAsk(p, s, id), refuse: () => ({ action: 'cancel', content: null, _meta: null }) },
  execCommandApproval: { build: (p, s) => commandAsk(p, s, { legacy: true }), refuse: () => ({ decision: 'abort' }) },
  applyPatchApproval: { build: (p, s) => fileChangeAsk(p, s, { legacy: true }), refuse: () => ({ decision: 'abort' }) },
};

/** Requests we refuse on purpose, with the reason sent back to Codex. */
const REFUSED_REQUESTS = {
  'account/chatgptAuthTokens/refresh': 'MAS Office never handles credentials; sign in with `codex login`.',
  'attestation/generate': 'MAS Office does not provide client attestation.',
  'item/tool/call': 'MAS Office registers no dynamic tools.',
};

// ---------------------------------------------------------------------------------------------
// Thread items → protocol events and transcript entries

/** @returns {{name: string, say: string, summary: string, input: object} | null} */
function toolStart(item, cwd) {
  switch (item?.type) {
    case 'commandExecution': {
      const command = unwrapShell(item.command);
      return { name: 'command', say: `Running ${oneLine(command, 60)}`, summary: oneLine(command, 200), input: { command, cwd: item.cwd } };
    }
    case 'fileChange': {
      const paths = (item.changes ?? []).map((c) => relativeTo(c.path, cwd));
      const shown = paths.length === 1 ? paths[0] : `${paths.length} files`;
      return { name: 'file change', say: `Editing ${shown}`, summary: paths.join(', '), input: { changes: (item.changes ?? []).map((c) => ({ path: c.path, kind: c.kind?.type ?? c.kind })) } };
    }
    case 'mcpToolCall':
      return { name: `mcp:${item.server}/${item.tool}`, say: `Using ${item.server} ${item.tool}`, summary: `${item.server}.${item.tool}`, input: { arguments: item.arguments ?? null } };
    case 'dynamicToolCall':
      return { name: item.tool, say: `Using ${item.tool}`, summary: item.tool, input: { arguments: item.arguments ?? null } };
    case 'webSearch': {
      const query = item.query || item.action?.query || item.action?.url || '';
      return { name: 'web search', say: `Searching the web: ${oneLine(query, 60)}`, summary: oneLine(query, 200), input: { query, action: item.action ?? null } };
    }
    case 'imageView':
      return { name: 'image view', say: `Viewing ${relativeTo(item.path, cwd)}`, summary: item.path, input: { path: item.path } };
    default:
      return null;
  }
}

/** @returns {{ok: boolean, error?: string, summary: string, text: string}} */
function toolEnd(item) {
  switch (item?.type) {
    case 'commandExecution': {
      const ok = item.status === 'completed' && (item.exitCode === 0 || item.exitCode === null || item.exitCode === undefined);
      const error = item.status === 'declined' ? 'declined' : !ok ? `exit code ${item.exitCode ?? 'unknown'} (${item.status})` : undefined;
      return { ok, error, summary: item.status === 'declined' ? 'declined' : `exit ${item.exitCode ?? '?'}`, text: item.aggregatedOutput ?? '' };
    }
    case 'fileChange': {
      const ok = item.status === 'completed';
      const n = (item.changes ?? []).length;
      return { ok, error: ok ? undefined : item.status, summary: `${n} file${n === 1 ? '' : 's'} ${item.status}`, text: (item.changes ?? []).map((c) => c.diff ?? '').join('\n') };
    }
    case 'mcpToolCall': {
      const ok = item.status === 'completed' && !item.error;
      return { ok, error: ok ? undefined : item.error?.message ?? item.status, summary: item.status, text: ok ? JSON.stringify(item.result?.content ?? null) : item.error?.message ?? '' };
    }
    case 'dynamicToolCall': {
      const ok = item.status === 'completed' && item.success !== false;
      return { ok, error: ok ? undefined : item.status, summary: item.status, text: JSON.stringify(item.contentItems ?? null) };
    }
    case 'webSearch':
      return { ok: true, summary: `${(item.results ?? []).length} results`, text: item.results ? JSON.stringify(item.results) : '' };
    default:
      return { ok: true, summary: 'done', text: '' };
  }
}

// ---------------------------------------------------------------------------------------------
// Session

const STOP_REASONS = { completed: 'end_turn', interrupted: 'cancelled', failed: 'error' };
const MAX_REFUSAL_CONTINUATIONS = 3;

/** The policy subject for a call Codex may run without asking, or null when there is nothing to check. */
export function precheckSubject(item) {
  switch (item?.type) {
    case 'commandExecution':
      // `sandboxed`: Codex ran it inside its read-only sandbox without asking (anything that
      // writes or needs the network arrives as an approval request instead).
      return { type: 'command', command: unwrapShell(item.command), cwd: item.cwd, sandboxed: true };
    case 'mcpToolCall':
      return { type: 'tool_call', tool: `mcp__${item.server}__${item.tool}`, input: item.arguments && typeof item.arguments === 'object' ? item.arguments : {} };
    case 'webSearch': {
      const url = item.action?.url;
      return typeof url === 'string' && url ? { type: 'tool_call', tool: 'WebFetch', input: { url } } : null;
    }
    default:
      return null;
  }
}

class CodexSession {
  /**
   * @param {object} init
   * @param {any} init.server the shared server record
   * @param {SessionSpec} init.spec
   * @param {SessionSink} init.sink
   * @param {string} init.threadId
   * @param {object} init.threadParams params reused for `thread/resume`
   * @param {object | null} init.sandboxPolicy sent with every `turn/start`
   * @param {(server: any, session: CodexSession) => void} init.refreshLimits
   * @param {number} init.interruptTimeoutMs
   */
  constructor(init) {
    this.server = init.server;
    this.spec = init.spec;
    this.sink = init.sink;
    this.threadId = init.threadId;
    this.threadParams = init.threadParams;
    this.sandboxPolicy = init.sandboxPolicy;
    this.refreshLimits = init.refreshLimits;
    this.interruptTimeoutMs = init.interruptTimeoutMs;
    this.cwd = init.spec.cwd;
    /** @type {'running' | 'requires_action' | 'idle' | 'closed'} */
    this.state = 'idle';
    this.closed = false;
    this.needsResume = false;
    /** @type {{text: string, onResult?: (r: TurnResult) => void, onStarted?: (r: {status: 'applied' | 'rejected', reason?: string}) => void}[]} */
    this.queue = [];
    /** @type {any} */
    this.active = null;
    /** @type {Map<string, {toolCallId?: string, resolvedElsewhere: boolean}>} */
    this.pendingAsks = new Map();
    /** @type {Map<string, any[]>} file changes by item id, for approval titles */
    this.fileChanges = new Map();
    /** @type {Set<string>} item ids that emitted tool.started */
    this.toolsStarted = new Set();
    /** @type {Set<string>} item ids refused by the role precheck */
    this.refused = new Set();
    // Thread totals from `thread/tokenUsage/updated` (they survive a resume). No `turns` total: a
    // resumed thread does not report how many turns it already had, so the engine counts turns.
    this.usage = { inputTokens: 0, outputTokens: 0 };
    this.closeSignal = deferred();
  }

  get id() { return this.threadId; }

  /** @param {object} entry */
  tx(entry) {
    try { this.sink.transcript({ ts: new Date().toISOString(), ...entry }); } catch { /* a sink must not break the adapter */ }
  }

  /** @param {string} type @param {object} [data] */
  emit(type, data) {
    try { this.sink.event(type, data); } catch { /* a sink must not break the adapter */ }
  }

  /** @param {string} text */
  note(text) { this.tx({ kind: 'system', text }); }

  updateState() {
    if (this.closed) this.state = 'closed';
    else if (this.pendingAsks.size) this.state = 'requires_action';
    else if (this.active) this.state = 'running';
    else this.state = 'idle';
  }

  request(method, params, options) { return this.server.peer.request(method, params, options); }

  // -- turns ---------------------------------------------------------------------------------

  /** @param {string} text @returns {Promise<TurnResult>} */
  turn(text) {
    if (this.closed) return Promise.resolve({ ok: false, text: '', stopReason: 'error', error: 'session closed' });
    return new Promise((resolve) => {
      this.queue.push({ text, onResult: resolve });
      this.pump();
    });
  }

  /** Queue a turn nobody awaits; resolve when Codex accepted `turn/start` (or refused it). */
  startDetached(text, front = false) {
    if (this.closed) return Promise.resolve({ status: 'rejected', reason: 'session closed' });
    return new Promise((resolve) => {
      const job = { text, onStarted: resolve };
      if (front) this.queue.unshift(job); else this.queue.push(job);
      this.pump();
    });
  }

  pump() {
    if (this.active || this.closed || !this.queue.length) return;
    this.runTurn(this.queue.shift());
  }

  async runTurn(job) {
    const active = { turnId: null, job, messages: [], error: null, refusals: [], userInterrupt: false, started: deferred(), done: deferred() };
    this.active = active;
    this.updateState();
    try {
      if (this.needsResume) {
        await this.request('thread/resume', { threadId: this.threadId, ...this.threadParams, excludeTurns: true });
        this.needsResume = false;
        this.note('Session resumed');
      }
      const params = {
        threadId: this.threadId,
        input: [{ type: 'text', text: job.text, text_elements: [] }],
        ...(this.sandboxPolicy ? { sandboxPolicy: this.sandboxPolicy } : {}),
      };
      const response = await this.request('turn/start', params);
      if (this.active !== active) return; // finished (or failed) while the response was in flight
      if (!active.turnId) active.turnId = response?.turn?.id ?? null;
      active.started.resolve();
      job.onStarted?.({ status: 'applied' });
    } catch (error) {
      if (this.active !== active) return;
      const reason = messageOf(error);
      this.active = null;
      this.updateState();
      active.started.resolve();
      active.done.resolve();
      this.note(`Could not start a Codex turn: ${reason}`);
      job.onResult?.({ ok: false, text: '', stopReason: 'error', error: reason });
      job.onStarted?.({ status: 'rejected', reason });
      this.pump();
    }
  }

  /** Settle the active turn from `turn/completed`. */
  finishTurn(turn) {
    const active = this.active;
    if (!active) return;
    if (active.turnId && turn?.id && turn.id !== active.turnId) return;
    const status = turn?.status ?? 'failed';
    // A call the role design refuses stopped this turn: carry on in a new turn that tells the
    // model why. The caller's turn() resolves with the continuation's result.
    const job = active.job;
    if (active.refusals.length && status !== 'failed' && !active.userInterrupt && (job.continuations ?? 0) < MAX_REFUSAL_CONTINUATIONS) {
      const reasons = [...new Set(active.refusals)].join('; ');
      this.active = null;
      active.started.resolve();
      active.done.resolve({ ok: false, text: '', stopReason: 'cancelled', error: `refused: ${reasons}` });
      job.onStarted?.({ status: 'applied' });
      this.queue.unshift({
        text: `That command is not allowed for your role: ${reasons}. Continue without it.`,
        onResult: job.onResult,
        continuations: (job.continuations ?? 0) + 1,
      });
      this.updateState();
      this.pump();
      return;
    }
    const stopReason = STOP_REASONS[status] ?? 'error';
    const final = active.messages.filter((m) => m.phase === 'final_answer').at(-1) ?? active.messages.at(-1);
    const text = final?.text ?? '';
    const error = status === 'completed' ? undefined : turn?.error?.message ?? active.error ?? (status === 'interrupted' ? 'interrupted' : 'turn failed');
    if (status === 'interrupted') {
      this.emit('agent.stopped', { reason: 'Interrupted', scope: 'turn' });
    } else {
      this.emit('agent.status', {
        state: 'idle',
        stopReason,
        say: status === 'completed' ? (oneLine(text, 120) || 'Turn finished') : oneLine(`Failed: ${error}`, 120),
      });
    }
    /** @type {TurnResult} */
    const result = { ok: status === 'completed', text, stopReason, usage: { ...this.usage } };
    if (error) result.error = error;
    this.tx({ kind: 'result', ok: result.ok, text: truncate(text), usage: result.usage, ...(error ? { error } : {}) });
    this.active = null;
    this.updateState();
    active.started.resolve();
    active.done.resolve(result);
    active.job.onStarted?.({ status: 'applied' }); // no-op when turn/start already answered
    active.job.onResult?.(result);
    this.refreshLimits(this.server, this);
    this.pump();
  }

  /**
   * @param {string} text
   * @param {Delivery} delivery
   * @returns {Promise<{status: 'applied' | 'rejected', reason?: string}>}
   */
  async send(text, delivery) {
    if (this.closed) return { status: 'rejected', reason: 'session closed' };
    if (delivery === 'queue') {
      const busy = Boolean(this.active || this.queue.length);
      const result = await this.startDetached(text, false);
      return result.status === 'applied'
        ? { status: 'applied', reason: busy ? 'held until the running turn ended, then started a new turn' : 'no active turn; started a new turn' }
        : result;
    }
    if (delivery === 'interrupt') {
      const busy = Boolean(this.active);
      await this.interrupt();
      const result = await this.startDetached(text, true);
      return result.status === 'applied'
        ? { status: 'applied', reason: busy ? 'interrupted the running turn, then started a new turn' : 'no active turn; started a new turn' }
        : result;
    }
    if (delivery !== 'steer') return { status: 'rejected', reason: `unknown delivery ${delivery}` };
    const active = this.active;
    if (active) {
      await active.started.promise;
      if (this.active === active && active.turnId) {
        try {
          await this.request('turn/steer', {
            threadId: this.threadId,
            input: [{ type: 'text', text, text_elements: [] }],
            expectedTurnId: active.turnId,
          });
          return { status: 'applied', reason: 'steered into the running turn' };
        } catch (error) {
          const reason = messageOf(error);
          if (!/no active turn|expected active turn id/i.test(reason)) return { status: 'rejected', reason };
          // The turn ended between our check and Codex's: fall through and start a new one.
        }
      }
    }
    const result = await this.startDetached(text, true);
    return result.status === 'applied' ? { status: 'applied', reason: 'no active turn; started a new turn' } : result;
  }

  async interrupt() {
    const active = this.active;
    if (!active || this.closed) return;
    active.userInterrupt = true;
    await active.started.promise;
    if (this.active !== active) return;
    await this.requestInterrupt(active);
    // Codex confirms with `turn/completed {status: interrupted}`; do not report a stop before that.
    await Promise.race([active.done.promise, delay(this.interruptTimeoutMs)]);
  }

  async requestInterrupt(active) {
    if (!active.turnId) return;
    try {
      await this.request('turn/interrupt', { threadId: this.threadId, turnId: active.turnId });
    } catch (error) {
      const reason = messageOf(error);
      if (!/no active turn/i.test(reason)) this.note(`Interrupt failed: ${reason}`);
    }
  }

  // -- role precheck for calls Codex runs without asking --------------------------------------

  /**
   * Codex runs some calls without an approval request (read-only commands in the sandbox, MCP tools
   * that do not prompt, page opens). Each is checked against the role design as it starts; a
   * `deny` stops the turn at once and the work continues in a new turn (see finishTurn). Only
   * `deny` is acted on: an `ask` cannot be honoured for a call that is already running.
   */
  async precheckItem(item) {
    if (typeof this.sink.precheck !== 'function') return;
    const subject = precheckSubject(item);
    if (!subject) return;
    const active = this.active;
    let verdict;
    try {
      verdict = await this.sink.precheck(subject);
    } catch (error) {
      verdict = { effect: 'deny', reason: `the role check failed (${messageOf(error)})` };
    }
    if (verdict?.effect !== 'deny' || !active || this.active !== active || this.closed) return;
    const reason = verdict.reason || 'this is outside the role design';
    this.refused.add(item.id);
    const tool = toolStart(item, this.cwd);
    this.emit('tool.failed', { name: tool?.name ?? item.type, callId: item.id, error: `Refused by the team design: ${reason}` });
    active.refusals.push(reason);
    if (active.refusals.length > 1) return; // the interrupt is already on its way
    await active.started.promise;
    if (this.active === active) await this.requestInterrupt(active);
  }

  async close() {
    if (this.closed) return;
    if (this.active && !this.server.dead) await this.interrupt();
    this.shutdown('cancelled', 'session closed');
    if (!this.server.dead) {
      this.request('thread/unsubscribe', { threadId: this.threadId }, { timeoutMs: 5000 }).catch(() => {});
    }
  }

  /** Settle everything this session owes. */
  shutdown(stopReason, reason) {
    if (this.closed) return;
    this.closed = true;
    this.server.sessions.delete(this.threadId);
    const active = this.active;
    this.active = null;
    const result = { ok: false, text: '', stopReason, error: reason };
    if (active) {
      active.started.resolve();
      active.done.resolve(result);
      active.job.onResult?.(result);
      active.job.onStarted?.({ status: 'rejected', reason });
    }
    for (const job of this.queue.splice(0)) {
      job.onResult?.(result);
      job.onStarted?.({ status: 'rejected', reason });
    }
    this.pendingAsks.clear();
    this.closeSignal.resolve({ behavior: 'cancel' });
    this.updateState();
  }

  /** The app-server died under this session. */
  fail(reason) {
    if (this.closed) return;
    this.shutdown('error', reason);
    this.note(reason);
    this.emit('agent.failed', { reason });
  }

  // -- server requests -----------------------------------------------------------------------

  async ask(method, handler, params, id) {
    let built;
    try {
      built = handler.build(params, this, id);
    } catch (error) {
      this.note(`Could not read Codex request \`${method}\` (${messageOf(error)}); declined it.`);
      return handler.refuse(params);
    }
    if (built.immediate) {
      this.note(built.immediate.note);
      return built.immediate.response;
    }
    const key = String(id);
    const entry = { toolCallId: built.request.toolCallId, resolvedElsewhere: false };
    this.pendingAsks.set(key, entry);
    this.updateState();
    /** @type {AskAnswer} */
    let answer;
    try {
      answer = await Promise.race([Promise.resolve().then(() => this.sink.ask(built.request)), this.closeSignal.promise]);
    } catch (error) {
      this.note(`Asking about \`${method}\` failed (${messageOf(error)}); cancelled it.`);
      answer = { behavior: 'cancel' };
    }
    if (this.pendingAsks.get(key) === entry) this.pendingAsks.delete(key);
    this.updateState();
    if (entry.resolvedElsewhere) return NO_RESPONSE;
    if (this.closed) answer = { behavior: 'cancel' };
    return built.respond(answer ?? { behavior: 'cancel' });
  }

  /** `serverRequest/resolved`: Codex cleared a request (answered elsewhere, or the turn ended). */
  resolved(requestId) {
    const key = String(requestId);
    const entry = this.pendingAsks.get(key);
    if (!entry) return;
    entry.resolvedElsewhere = true;
    this.pendingAsks.delete(key);
    this.updateState();
    try {
      this.sink.resolvedElsewhere?.(entry.toolCallId, { requestId });
    } catch { /* optional hook */ }
  }

  // -- notifications -------------------------------------------------------------------------

  /** @param {string} method @param {any} params */
  onNotification(method, params) {
    switch (method) {
      case 'turn/started': {
        const active = this.active;
        if (active && (!active.turnId || active.turnId === params.turn?.id)) {
          active.turnId = params.turn?.id ?? active.turnId;
          active.started.resolve();
        }
        this.emit('agent.status', { state: 'working', say: 'Working' });
        break;
      }
      case 'turn/completed':
        this.finishTurn(params.turn);
        break;
      case 'item/started':
        this.itemStarted(params.item);
        break;
      case 'item/completed':
        this.itemCompleted(params.item);
        break;
      case 'thread/tokenUsage/updated': {
        const total = params.tokenUsage?.total;
        if (!total) break;
        this.usage.inputTokens = total.inputTokens ?? this.usage.inputTokens;
        this.usage.outputTokens = total.outputTokens ?? this.usage.outputTokens;
        this.emit('usage', { inputTokens: this.usage.inputTokens, outputTokens: this.usage.outputTokens });
        break;
      }
      case 'error': {
        const text = params.error?.message ?? 'unknown error';
        const details = params.error?.additionalDetails ? ` (${params.error.additionalDetails})` : '';
        this.note(`Codex error: ${text}${details}${params.willRetry ? ' — retrying' : ''}`);
        if (!params.willRetry && this.active) this.active.error = text;
        break;
      }
      case 'serverRequest/resolved':
        this.resolved(params.requestId);
        break;
      case 'thread/closed':
        this.needsResume = true;
        break;
      case 'thread/status/changed':
        if (params.status?.type === 'systemError') this.note('Codex reported a system error on this thread.');
        break;
      case 'model/rerouted':
        this.note(`Codex rerouted the model from ${params.fromModel} to ${params.toModel}.`);
        break;
      case 'warning':
        if (params.message) this.note(`Codex warning: ${params.message}`);
        break;
      default:
        break; // unknown or uninteresting: ignore
    }
  }

  itemStarted(item) {
    if (!item || typeof item !== 'object') return;
    if (item.type === 'fileChange') this.fileChanges.set(item.id, item.changes ?? []);
    this.startTool(item);
    if (this.active) this.precheckItem(item);
  }

  startTool(item) {
    if (this.toolsStarted.has(item.id)) return;
    const tool = toolStart(item, this.cwd);
    if (!tool) return;
    this.toolsStarted.add(item.id);
    this.emit('tool.started', { name: tool.name, callId: item.id, say: tool.say });
    this.tx({ kind: 'tool_call', callId: item.id, tool: tool.name, summary: tool.summary, input: tool.input });
  }

  itemCompleted(item) {
    if (!item || typeof item !== 'object') return;
    switch (item.type) {
      case 'agentMessage': {
        if (typeof item.text !== 'string' || !item.text) return;
        this.active?.messages.push({ text: item.text, phase: item.phase ?? null });
        this.tx({ kind: 'assistant', text: item.text });
        this.emit('message', { text: oneLine(item.text) });
        return;
      }
      case 'reasoning': {
        const text = [...(item.summary ?? []), ...(item.summary?.length ? [] : item.content ?? [])].join('\n').trim();
        if (text) this.tx({ kind: 'thinking', text });
        return;
      }
      case 'contextCompaction':
        this.note('Codex compacted the conversation.');
        return;
      default:
        break;
    }
    if (!toolStart(item, this.cwd)) return;
    this.startTool(item); // some items (web search) may only arrive completed
    this.toolsStarted.delete(item.id);
    if (item.type === 'fileChange') this.fileChanges.delete(item.id);
    const { name } = toolStart(item, this.cwd);
    const end = toolEnd(item);
    if (this.refused.delete(item.id)) {
      // tool.failed went out when it was refused; keep only the transcript record
      this.tx({ kind: 'tool_result', callId: item.id, ok: false, summary: 'refused by the team design', text: truncate(end.text) });
      return;
    }
    if (end.ok) this.emit('tool.finished', { name, callId: item.id });
    else this.emit('tool.failed', { name, callId: item.id, error: end.error ?? 'failed' });
    this.tx({ kind: 'tool_result', callId: item.id, ok: end.ok, summary: end.summary, text: truncate(end.text) });
  }
}

// ---------------------------------------------------------------------------------------------
// Backend

/**
 * @param {object} [options]
 * @param {string} [options.command] the Codex binary (default `codex`, resolved on PATH without a shell)
 * @param {string[]} [options.args] app-server arguments (default `['app-server']`)
 * @param {typeof nodeSpawn} [options.spawn] injectable for tests
 * @param {typeof nodeExecFile} [options.execFile] injectable for tests
 * @param {Record<string, string>} [options.env] child environment (default `childEnv()`)
 * @param {number} [options.requestTimeoutMs] per-request timeout (default 120000)
 * @param {number} [options.interruptTimeoutMs] how long to wait for Codex to confirm an interrupt (default 30000)
 * @param {() => number} [options.now] clock for the crash-loop guard
 * @param {(line: string) => void} [options.log] debug log
 * @param {boolean} [options.isolateMcp] switch off, per thread, every MCP server the role was not given (default true)
 * @returns {AgentBackend & {readonly server: any}}
 */
export function createCodexBackend(options = {}) {
  const command = options.command ?? 'codex';
  const args = options.args ?? ['app-server'];
  const spawn = options.spawn ?? nodeSpawn;
  const execFile = options.execFile ?? nodeExecFile;
  const env = options.env ?? childEnv();
  const requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
  const interruptTimeoutMs = options.interruptTimeoutMs ?? 30_000;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const isolateMcp = options.isolateMcp ?? true;

  /** @type {any} */
  let server = null;
  /** @type {Promise<any> | null} */
  let starting = null;
  let crashed = false;
  /** @type {number[]} */
  const restarts = [];

  function onServerGone(record, reason) {
    if (record.dead) return;
    record.dead = true;
    record.peer?.close(reason);
    if (record.intentional) return;
    try { record.child.kill?.('SIGTERM'); } catch { /* already gone */ }
    if (!record.ready) return; // never initialised: launch() reports it; not a crash
    crashed = true;
    const tail = record.stderrTail.trim().split('\n').slice(-3).join(' | ');
    const detail = `codex app-server exited (${reason})${tail ? `: ${oneLine(tail, 300)}` : ''}`;
    log(detail);
    for (const session of [...record.sessions.values()]) session.fail(detail);
  }

  function onServerRequest(record, method, params, id) {
    const threadId = params?.threadId ?? params?.conversationId;
    const session = threadId ? record.sessions.get(threadId) : undefined;
    const handler = SERVER_REQUESTS[method];
    if (!handler) {
      const reason = REFUSED_REQUESTS[method] ?? `MAS Office does not handle ${method}.`;
      session?.note(`Codex sent \`${method}\`; refused: ${reason}`);
      log(`refused server request ${method}`);
      throw new JsonRpcError(ErrorCodes.methodNotFound, reason);
    }
    if (!session || session.closed) {
      log(`no live session for ${method} on thread ${threadId}; declined`);
      return handler.refuse(params);
    }
    return session.ask(method, handler, params, id);
  }

  function onServerNotification(record, method, params) {
    if (method === 'account/rateLimits/updated') {
      record.rateLimits = mergeSnapshot(record.rateLimits, params?.rateLimits);
      const limit = limitFromSnapshot(record.rateLimits);
      if (limit) for (const session of record.sessions.values()) if (session.active) session.emit('usage', { limit });
      return;
    }
    const threadId = params?.threadId;
    if (!threadId) return;
    record.sessions.get(threadId)?.onNotification(method, params);
  }

  function refreshLimits(record, session) {
    if (record.dead) return;
    record.peer.request('account/rateLimits/read', {}, { timeoutMs: 15_000 }).then((response) => {
      record.rateLimits = mergeSnapshot(record.rateLimits, response?.rateLimits);
      const limit = limitFromSnapshot(record.rateLimits);
      if (limit && !session.closed) session.emit('usage', { limit });
    }, () => { /* not every account has rate limits (API keys); ignore */ });
  }

  /** Every MCP server the app-server knows (names and plugin ids only; cached per server process). */
  async function mcpInventory(record) {
    if (record.mcpInventory) return record.mcpInventory;
    const servers = [];
    let cursor = null;
    for (let page = 0; page < 20; page++) {
      const response = await record.peer.request('mcpServerStatus/list', { detail: 'toolsAndAuthOnly', ...(cursor ? { cursor } : {}) }, { timeoutMs: 30_000 });
      for (const server of response?.data ?? []) {
        if (typeof server?.name === 'string') servers.push({ name: server.name, pluginId: server.pluginId ?? null });
      }
      cursor = response?.nextCursor ?? null;
      if (!cursor) break;
    }
    record.mcpInventory = servers;
    return servers;
  }

  /**
   * `thread/start` or `thread/resume`. A built-in server that cannot be switched off by name makes
   * Codex reject the config ("invalid transport in `mcp_servers.<name>`"): drop only that override,
   * remember it, and try again.
   */
  async function openThread(record, method, params, extra, isolated) {
    let current = params;
    const attempts = isolated.size + 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return { response: await record.peer.request(method, { ...extra, ...current }), params: current };
      } catch (error) {
        const name = /invalid transport\s+in `mcp_servers\.([^`]+)`/.exec(messageOf(error))?.[1];
        if (!name || !isolated.has(name) || !current.config?.mcp_servers?.[name]) throw error;
        isolated.delete(name);
        record.mcpUndisableable.add(name);
        const mcpServers = { ...current.config.mcp_servers };
        delete mcpServers[name];
        current = { ...current, config: { ...current.config, mcp_servers: mcpServers } };
      }
    }
    throw new Error(`${method} kept rejecting the MCP overrides`);
  }

  /** After start: say in the transcript which servers this role was not given still load. */
  function verifyIsolation(record, session, granted) {
    record.peer.request('mcpServerStatus/list', { detail: 'toolsAndAuthOnly', threadId: session.threadId }, { timeoutMs: 60_000 })
      .then((response) => {
        const loaded = (response?.data ?? [])
          .filter((s) => typeof s?.name === 'string' && !granted.includes(s.name) && s.runtimeStatus !== 'disabled')
          .map((s) => s.name);
        if (loaded.length && !session.closed) {
          session.note(`Codex still loads MCP servers this role was not given: ${loaded.join(', ')}. Their tools follow your Codex config, not this role's rules.`);
        }
      }, () => { /* verification is best effort */ });
  }

  async function launch() {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const record = { child, peer: null, dead: false, intentional: false, stderrTail: '', sessions: new Map(), rateLimits: null, ready: false, mcpInventory: null, mcpUndisableable: new Set() };
    child.stderr?.on('data', (chunk) => { record.stderrTail = (record.stderrTail + chunk).slice(-4000); });
    child.once('error', (error) => onServerGone(record, `spawn error: ${error.message}`));
    child.once('exit', (code, signal) => onServerGone(record, signal ? `signal ${signal}` : `code ${code}`));
    record.peer = new JsonRpcPeer({
      input: child.stdout,
      output: child.stdin,
      requestTimeoutMs,
      onNotification: (method, params) => onServerNotification(record, method, params),
      onRequest: (method, params, id) => onServerRequest(record, method, params, id),
      onProtocolError: (problem, line) => log(`${problem}${line ? `: ${line.slice(0, 200)}` : ''}`),
      onClose: (reason) => onServerGone(record, reason),
    });
    server = record;
    try {
      const init = await record.peer.request('initialize', {
        clientInfo: { name: 'mas_office', title: 'MAS Office', version: PACKAGE_VERSION },
        capabilities: { experimentalApi: false, requestAttestation: false, optOutNotificationMethods: OPT_OUT_NOTIFICATIONS },
      }, { timeoutMs: 30_000 });
      record.peer.notify('initialized');
      record.userAgent = init?.userAgent ?? null;
      record.ready = true;
      return record;
    } catch (error) {
      const tail = oneLine(record.stderrTail.trim().split('\n').slice(-1)[0] ?? '', 200);
      record.intentional = true; // a failed start is reported here, not as a crash
      onServerGone(record, 'initialize failed');
      try { child.kill?.('SIGTERM'); } catch { /* gone */ }
      throw new Error(`codex app-server did not start: ${messageOf(error)}${tail ? ` (${tail})` : ''}`);
    }
  }

  async function ensureServer() {
    if (server && !server.dead) return server.ready ? server : starting;
    if (starting) return starting;
    if (crashed) {
      const since = now() - RESTART_WINDOW_MS;
      while (restarts.length && restarts[0] <= since) restarts.shift();
      if (restarts.length >= RESTART_LIMIT) {
        throw new Error(`codex app-server crashed ${RESTART_LIMIT} times within a minute; not restarting it now`);
      }
      restarts.push(now());
    }
    starting = launch().finally(() => { starting = null; });
    return starting;
  }

  /** @returns {Promise<{stdout: string}>} */
  function execFileP(file, argv, opts) {
    return new Promise((resolve, reject) => {
      execFile(file, argv, opts, (error, stdout) => (error ? reject(error) : resolve({ stdout: String(stdout ?? '') })));
    });
  }

  return {
    name: 'codex',

    get server() { return server; },

    async probe() {
      let version;
      try {
        const { stdout } = await execFileP(command, ['--version'], { env, timeout: 15_000, windowsHide: true });
        version = stdout.trim().replace(/^codex(-cli)?\s+/i, '') || undefined;
      } catch (error) {
        const code = /** @type {any} */ (error)?.code;
        return {
          available: false,
          detail: code === 'ENOENT' ? '`codex` is not on PATH. Install the Codex CLI, then run `codex login`.' : `\`codex --version\` failed: ${oneLine(messageOf(error), 200)}`,
        };
      }
      try {
        const record = await ensureServer();
        const response = await record.peer.request('account/read', { refreshToken: false }, { timeoutMs: 30_000 });
        const account = response?.account ?? null;
        const loggedIn = Boolean(account) || response?.requiresOpenaiAuth === false;
        const detail = account
          ? describeAccount(account)
          : loggedIn ? 'No sign-in needed for the configured model provider' : 'Not signed in. Run `codex login`.';
        return { available: true, version, loggedIn, detail };
      } catch (error) {
        return { available: true, version, detail: `Could not check sign-in: ${oneLine(messageOf(error), 200)}` };
      }
    },

    /**
     * @param {SessionSpec} spec
     * @param {SessionSink} sink
     */
    async start(spec, sink) {
      const record = await ensureServer();
      const codex = /** @type {any} */ (spec.compiled)?.codex ?? {};
      const model = spec.model ?? /** @type {any} */ (spec.compiled)?.model ?? null;
      const sandbox = codex.sandbox ?? 'read-only';
      const notes = [];
      let config = codex.config && typeof codex.config === 'object' ? structuredClone(codex.config) : null;
      let isolated = new Set();
      if (isolateMcp) {
        try {
          ({ config, added: isolated } = isolationConfig(config ?? {}, await mcpInventory(record), record.mcpUndisableable));
        } catch (error) {
          notes.push(`Could not list Codex MCP servers (${oneLine(messageOf(error), 200)}); servers from your Codex config stay enabled for this role.`);
        }
      }
      let threadParams = {
        cwd: spec.cwd,
        approvalPolicy: codex.approvalPolicy ?? 'on-request',
        sandbox,
        ...(spec.systemPrompt ? { developerInstructions: spec.systemPrompt } : {}),
        ...(model ? { model } : {}),
        ...(config && Object.keys(config).length ? { config } : {}),
      };
      const { policy: sandboxPolicy, dropped } = turnSandboxPolicy(codex, sandbox, spec.cwd);
      if (dropped.length) {
        notes.push(`The installed Codex does not know sandboxPolicy field${dropped.length === 1 ? '' : 's'} ${dropped.join(', ')}; sent without ${dropped.length === 1 ? 'it' : 'them'}${dropped.includes('access') ? ' (reads are not limited to the readable roots)' : ''}.`);
      }

      let response = null;
      let note = null;
      if (spec.resume) {
        try {
          ({ response, params: threadParams } = await openThread(record, 'thread/resume', threadParams, { threadId: spec.resume, excludeTurns: true }, isolated));
          note = 'Session resumed';
        } catch (error) {
          note = `Could not resume Codex thread ${spec.resume} (${oneLine(messageOf(error), 200)}); started a fresh thread.`;
        }
      }
      if (!response) ({ response, params: threadParams } = await openThread(record, 'thread/start', threadParams, {}, isolated));
      const threadId = response?.thread?.id;
      if (typeof threadId !== 'string') throw new Error('codex app-server returned no thread id');

      const session = new CodexSession({
        server: record, spec, sink, threadId, threadParams, sandboxPolicy, refreshLimits, interruptTimeoutMs,
      });
      record.sessions.set(threadId, session);
      session.emit('agent.registered', {
        backend: 'codex',
        model: response.model ?? model ?? null,
        session: { backend: 'codex', id: threadId, resumable: true },
        accepts: ['message', 'respond', 'interrupt'],
      });
      if (note) session.note(note);
      for (const text of notes) session.note(text);
      if (isolateMcp) verifyIsolation(record, session, Object.keys(codex.config?.mcp_servers ?? {}));

      return {
        get id() { return session.id; },
        get state() { return session.state; },
        send: (text, delivery) => session.send(text, delivery),
        turn: (text) => session.turn(text),
        interrupt: () => session.interrupt(),
        close: () => session.close(),
      };
    },

    async close() {
      const record = server;
      if (!record || record.dead) return;
      await Promise.all([...record.sessions.values()].map((session) => session.close().catch(() => {})));
      record.intentional = true;
      const exited = new Promise((resolve) => {
        if (record.child.exitCode !== null && record.child.exitCode !== undefined) resolve(undefined);
        else record.child.once('exit', () => resolve(undefined));
      });
      record.peer.close('backend closed');
      record.dead = true;
      try { record.child.stdin?.end(); } catch { /* gone */ }
      const killTimer = setTimeout(() => { try { record.child.kill?.('SIGTERM'); } catch { /* gone */ } }, 2000);
      killTimer.unref?.();
      await Promise.race([exited, delay(5000)]);
      clearTimeout(killTimer);
      if (server === record) server = null;
    },
  };
}
