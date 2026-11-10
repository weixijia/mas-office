import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createCodexBackend, unwrapShell, limitFromSnapshot } from '../src/backends/codex.js';
import { CHILD_ENV_KEYS } from '../src/backends/types.js';

// ---------------------------------------------------------------------------------------------
// A scripted fake `codex app-server`: in-process streams, JSON lines, per-method handlers.

class FakeServer {
  constructor(child, handlers) {
    this.child = child;
    this.handlers = handlers;
    this.calls = []; // client requests {method, params, id}
    this.clientNotifications = [];
    this.responses = new Map(); // id of our server request → response message
    this.waiters = new Map();
    this.nextRequestId = 1;
    this.threads = 0;
    this.turns = 0;
    let buffer = '';
    child.stdin.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        this.onLine(JSON.parse(line));
      }
    });
  }

  async onLine(message) {
    if (typeof message.method === 'string' && message.id !== undefined) {
      this.calls.push(message);
      const handler = this.handlers[message.method] ?? DEFAULT_HANDLERS[message.method];
      if (!handler) return this.write({ id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
      try {
        const result = await handler(message.params, this, message);
        if (result !== SILENT) this.write({ id: message.id, result: result ?? {} });
      } catch (error) {
        this.write({ id: message.id, error: { code: error.code ?? -32603, message: error.message } });
      }
      return;
    }
    if (typeof message.method === 'string') { this.clientNotifications.push(message); return; }
    this.responses.set(message.id, message);
    this.waiters.get(message.id)?.(message);
  }

  write(message) { if (!this.child.dead) this.child.stdout.write(`${JSON.stringify(message)}\n`); }
  notify(method, params) { this.write({ method, params }); }

  /** Send a server request; resolve with the client's response message. */
  request(method, params) {
    const id = this.nextRequestId++;
    const response = new Promise((resolve) => this.waiters.set(id, resolve));
    this.write({ id, method, params });
    return { id, response };
  }

  callsOf(method) { return this.calls.filter((c) => c.method === method); }

  startTurn(threadId, turnId) { this.notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress', items: [] } }); }

  complete(threadId, turnId, { text = 'done', status = 'completed', error = null } = {}) {
    if (text) this.notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: `msg_${turnId}`, text, phase: 'final_answer' } });
    this.notify('turn/completed', { threadId, turn: { id: turnId, status, items: [], error } });
  }

  crash(code = 1) {
    this.child.dead = true;
    this.child.exitCode = code;
    this.child.stdout.end();
    this.child.emit('exit', code, null);
  }
}

const SILENT = Symbol('silent');

const DEFAULT_HANDLERS = {
  initialize: () => ({ userAgent: 'fake/1', codexHome: '/fake', platformFamily: 'unix', platformOs: 'macos' }),
  'account/read': () => ({ account: { type: 'chatgpt', email: 'person@example.com', planType: 'plus', workspaceName: 'Secret Co' }, requiresOpenaiAuth: true }),
  'account/rateLimits/read': () => ({ rateLimits: { limitId: 'codex', primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_800_000_000 }, secondary: null, planType: 'plus', rateLimitReachedType: null }, accountId: 'acct_secret' }),
  'thread/start': (params, srv) => ({ thread: { id: `thr_${++srv.threads}` }, model: params.model ?? 'fake-model' }),
  'thread/resume': (params) => ({ thread: { id: params.threadId }, model: 'fake-model' }),
  'thread/unsubscribe': () => ({ status: 'unsubscribed' }),
  'mcpServerStatus/list': () => ({ data: [], nextCursor: null }),
  'turn/start': (params, srv) => {
    const turnId = `turn_${++srv.turns}`;
    setImmediate(() => srv.startTurn(params.threadId, turnId));
    return { turn: { id: turnId, status: 'inProgress', items: [], error: null } };
  },
  'turn/steer': (params) => ({ turnId: params.expectedTurnId }),
  'turn/interrupt': (params, srv) => {
    setImmediate(() => srv.complete(params.threadId, params.turnId, { text: '', status: 'interrupted' }));
    return {};
  },
};

function fakeCodex(handlers = {}, backendOptions = {}) {
  const spawns = [];
  const spawn = (command, args, opts) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.kill = () => true;
    child.stdin.on('finish', () => setImmediate(() => { if (child.exitCode === null) { child.exitCode = 0; child.dead = true; child.emit('exit', 0, null); } }));
    const srv = new FakeServer(child, handlers);
    spawns.push({ command, args, opts, child, srv });
    return child;
  };
  const execFile = (file, args, opts, callback) => {
    if (backendOptions.versionError) return callback(backendOptions.versionError);
    callback(null, 'codex-cli 0.167.0\n', '');
  };
  const backend = createCodexBackend({ spawn, execFile, interruptTimeoutMs: 1000, ...backendOptions });
  return { backend, spawns, get srv() { return spawns.at(-1)?.srv; } };
}

function recordingSink(answer = () => ({ behavior: 'allow' })) {
  const sink = {
    events: [],
    entries: [],
    asks: [],
    elsewhere: [],
    answer,
    event(type, data) { sink.events.push({ type, data }); },
    transcript(entry) { sink.entries.push(entry); },
    ask(request) { sink.asks.push(request); return Promise.resolve(sink.answer(request)); },
    resolvedElsewhere(toolCallId, info) { sink.elsewhere.push({ toolCallId, info }); },
    ofType(type) { return sink.events.filter((e) => e.type === type).map((e) => e.data); },
  };
  return sink;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate, label = 'condition') {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${label}`);
}

const SPEC = {
  agentId: 'finder',
  cwd: '/work/project',
  systemPrompt: 'You are the finder.',
  compiled: { model: null, codex: { approvalPolicy: 'on-request', sandbox: 'workspace-write', networkAccess: true, writableRoots: ['outputs/work'] } },
};

// ---------------------------------------------------------------------------------------------

test('helpers: unwrapShell and limitFromSnapshot', () => {
  assert.equal(unwrapShell("/bin/zsh -lc 'ls -la'"), 'ls -la');
  assert.equal(unwrapShell('bash -c "echo hi"'), 'echo hi');
  assert.equal(unwrapShell('git status'), 'git status');
  const limit = limitFromSnapshot({ limitId: 'codex', primary: { usedPercent: 85, windowDurationMins: 300, resetsAt: 0 }, secondary: null, rateLimitReachedType: null });
  assert.equal(limit.status, 'allowed_warning');
  assert.equal(limit.primary.resetsAt, new Date(0).toISOString());
  assert.equal(limitFromSnapshot({ rateLimitReachedType: 'primary' }).status, 'rejected');
  assert.equal(limitFromSnapshot(null), null);
});

test('initialize handshake: client info, stable API, delta opt-out, then "initialized"; minimal env, no shell', async () => {
  process.env.MAS_OFFICE_TEST_SECRET = 'do-not-leak';
  try {
    const f = fakeCodex();
    await f.backend.start(SPEC, recordingSink());
    const { command, args, opts, srv } = f.spawns[0];
    assert.equal(command, 'codex');
    assert.deepEqual(args, ['app-server']);
    assert.notEqual(opts.shell, true);
    assert.ok(!('MAS_OFFICE_TEST_SECRET' in opts.env));
    for (const key of Object.keys(opts.env)) assert.ok(CHILD_ENV_KEYS.includes(key), `unexpected env key ${key}`);
    assert.equal(opts.env.PATH, process.env.PATH);
    const init = srv.calls[0];
    assert.equal(init.method, 'initialize');
    assert.equal(init.params.clientInfo.name, 'mas_office');
    assert.equal(init.params.clientInfo.title, 'MAS Office');
    assert.match(init.params.clientInfo.version, /^\d+\.\d+\.\d+/);
    assert.equal(init.params.capabilities.experimentalApi, false);
    assert.ok(init.params.capabilities.optOutNotificationMethods.includes('item/agentMessage/delta'));
    assert.deepEqual(srv.clientNotifications.map((n) => n.method), ['initialized']);
    assert.ok(!('jsonrpc' in init));
    await f.backend.close();
  } finally {
    delete process.env.MAS_OFFICE_TEST_SECRET;
  }
});

test('probe: version and login from account/read, never an email or workspace name', async () => {
  const f = fakeCodex();
  const result = await f.backend.probe();
  assert.deepEqual(result, { available: true, version: '0.167.0', loggedIn: true, detail: 'Signed in with ChatGPT (plus plan)' });
  assert.doesNotMatch(JSON.stringify(result), /example\.com|Secret Co/);
  assert.equal(f.srv.callsOf('account/read')[0].params.refreshToken, false);
  await f.backend.close();

  const signedOut = fakeCodex({ 'account/read': () => ({ account: null, requiresOpenaiAuth: true }) });
  const out = await signedOut.backend.probe();
  assert.equal(out.loggedIn, false);
  assert.match(out.detail, /codex login/);
  await signedOut.backend.close();

  const missing = fakeCodex({}, { versionError: Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }) });
  const none = await missing.backend.probe();
  assert.equal(none.available, false);
  assert.match(none.detail, /not on PATH/);
  assert.equal(missing.spawns.length, 0);
});

test('start: thread/start params from the spec, agent.registered, sandbox policy on every turn', async () => {
  const f = fakeCodex();
  const sink = recordingSink();
  const session = await f.backend.start({ ...SPEC, model: 'gpt-x' }, sink);
  assert.equal(session.id, 'thr_1');
  assert.equal(session.state, 'idle');
  const params = f.srv.callsOf('thread/start')[0].params;
  assert.deepEqual(params, {
    cwd: '/work/project', approvalPolicy: 'on-request', sandbox: 'workspace-write', developerInstructions: 'You are the finder.', model: 'gpt-x',
    config: { mcp_servers: {}, features: { apps: false } },
  });
  assert.deepEqual(sink.ofType('agent.registered')[0], {
    backend: 'codex', model: 'gpt-x', session: { backend: 'codex', id: 'thr_1', resumable: true }, accepts: ['message', 'respond', 'interrupt'],
  });
  const done = session.turn('hello');
  await until(() => f.srv.callsOf('turn/start').length === 1, 'turn/start');
  const turnStart = f.srv.callsOf('turn/start')[0].params;
  assert.deepEqual(turnStart.input, [{ type: 'text', text: 'hello', text_elements: [] }]);
  assert.deepEqual(turnStart.sandboxPolicy, { type: 'workspaceWrite', writableRoots: ['/work/project/outputs/work'], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false });
  f.srv.complete('thr_1', 'turn_1');
  await done;
  await f.backend.close();
});

test('compiled codex config and sandboxPolicy pass through; fields the installed version lacks are dropped with a note', async () => {
  const f = fakeCodex();
  const sink = recordingSink();
  const compiled = {
    model: null,
    codex: {
      approvalPolicy: 'on-request', sandbox: 'read-only', networkAccess: false, writableRoots: [],
      sandboxPolicy: { type: 'readOnly', networkAccess: false, access: { type: 'restricted', includePlatformDefaults: true, readableRoots: ['/work/project'] } },
      config: { web_search: 'disabled', mcp_servers: { shop: { command: 'shop-mcp', default_tools_approval_mode: 'prompt' } } },
    },
  };
  const session = await f.backend.start({ ...SPEC, compiled }, sink);
  const params = f.srv.callsOf('thread/start')[0].params;
  assert.equal(params.sandbox, 'read-only');
  assert.equal(params.config.web_search, 'disabled');
  assert.deepEqual(params.config.mcp_servers.shop, { command: 'shop-mcp', default_tools_approval_mode: 'prompt' });
  assert.equal(params.config.features.apps, false);
  const note = sink.entries.find((e) => e.kind === 'system' && /sandboxPolicy/.test(e.text));
  assert.match(note.text, /does not know sandboxPolicy field access; sent without it \(reads are not limited to the readable roots\)/);
  const turn = session.turn('x');
  await until(() => f.srv.callsOf('turn/start').length === 1);
  assert.deepEqual(f.srv.callsOf('turn/start')[0].params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  f.srv.complete(session.id, 'turn_1');
  await turn;
  await f.backend.close();
});

test('MCP isolation: servers the role was not given are switched off per thread; built-ins that refuse are retried without', async () => {
  const inventory = [
    { name: 'shop', pluginId: null }, { name: 'google-workspace', pluginId: null },
    { name: 'codex_apps', pluginId: null }, { name: 'cua_repl', pluginId: 'unified-computer-use@openai-bundled' },
  ];
  const f = fakeCodex({
    'mcpServerStatus/list': (params) => (params.threadId
      ? { data: [{ name: 'shop', runtimeStatus: 'connected' }, { name: 'google-workspace', runtimeStatus: 'disabled' }, { name: 'stray', runtimeStatus: 'connected' }], nextCursor: null }
      : { data: inventory, nextCursor: null }),
    'thread/start': (params, srv) => {
      if (params.config?.mcp_servers?.codex_apps) throw new Error('failed to load configuration: invalid transport\nin `mcp_servers.codex_apps`');
      return { thread: { id: `thr_${++srv.threads}` }, model: 'fake' };
    },
  });
  const sink = recordingSink();
  const compiled = { codex: { approvalPolicy: 'on-request', sandbox: 'read-only', config: { mcp_servers: { shop: { command: 'shop-mcp' } } } } };
  await f.backend.start({ ...SPEC, compiled }, sink);
  const starts = f.srv.callsOf('thread/start');
  assert.equal(starts.length, 2);
  const config = starts[1].params.config;
  assert.deepEqual(config.mcp_servers, { shop: { command: 'shop-mcp' }, 'google-workspace': { enabled: false } });
  assert.deepEqual(config.plugins, { 'unified-computer-use@openai-bundled': { enabled: false } });
  assert.equal(config.features.apps, false);
  await until(() => sink.entries.some((e) => /still loads/.test(e.text ?? '')), 'isolation note');
  assert.match(sink.entries.find((e) => /still loads/.test(e.text)).text, /not given: stray\./);
  // the refusal is remembered: the next thread starts in one call
  await f.backend.start({ ...SPEC, compiled }, recordingSink());
  assert.equal(f.srv.callsOf('thread/start').length, 3);
  assert.equal(f.srv.callsOf('mcpServerStatus/list').filter((c) => !c.params.threadId).length, 1, 'inventory cached');
  await f.backend.close();

  const off = fakeCodex({ 'mcpServerStatus/list': () => ({ data: inventory, nextCursor: null }) }, { isolateMcp: false });
  await off.backend.start({ ...SPEC, compiled }, recordingSink());
  assert.deepEqual(off.srv.callsOf('thread/start')[0].params.config, { mcp_servers: { shop: { command: 'shop-mcp' } } });
  await off.backend.close();
});

test('resume: thread/resume when it works; fresh thread plus a system note when it fails', async () => {
  const f = fakeCodex();
  const sink = recordingSink();
  const session = await f.backend.start({ ...SPEC, resume: 'thr_old' }, sink);
  assert.equal(session.id, 'thr_old');
  assert.equal(f.srv.callsOf('thread/resume')[0].params.threadId, 'thr_old');
  assert.equal(f.srv.callsOf('thread/start').length, 0);
  assert.ok(sink.entries.some((e) => e.kind === 'system' && e.text === 'Session resumed'));
  await f.backend.close();

  const g = fakeCodex({ 'thread/resume': () => { throw Object.assign(new Error('no rollout found for thread id thr_gone'), { code: -32600 }); } });
  const sink2 = recordingSink();
  const fresh = await g.backend.start({ ...SPEC, resume: 'thr_gone' }, sink2);
  assert.equal(fresh.id, 'thr_1');
  assert.equal(g.srv.callsOf('thread/start').length, 1);
  const note = sink2.entries.find((e) => e.kind === 'system');
  assert.match(note.text, /Could not resume Codex thread thr_gone \(no rollout found.*\); started a fresh thread/);
  assert.equal(sink2.ofType('agent.registered')[0].session.id, 'thr_1');
  await g.backend.close();
});

test('event mapping for one turn: status, tools, reasoning, messages, usage, limits, result', async () => {
  const f = fakeCodex();
  const sink = recordingSink();
  const session = await f.backend.start(SPEC, sink);
  const pending = session.turn('go');
  await until(() => sink.ofType('agent.status').some((s) => s.state === 'working'), 'working');
  assert.equal(session.state, 'running');
  const srv = f.srv;
  const longOutput = 'x'.repeat(5000);
  srv.notify('item/started', { threadId: 'thr_1', turnId: 'turn_1', item: { type: 'commandExecution', id: 'cmd1', command: "/bin/zsh -lc 'ls -la'", cwd: '/work/project', status: 'inProgress' } });
  srv.notify('item/completed', { threadId: 'thr_1', turnId: 'turn_1', item: { type: 'commandExecution', id: 'cmd1', command: "/bin/zsh -lc 'ls -la'", cwd: '/work/project', status: 'completed', exitCode: 0, aggregatedOutput: longOutput } });
  srv.notify('item/started', { threadId: 'thr_1', turnId: 'turn_1', item: { type: 'commandExecution', id: 'cmd2', command: 'false', cwd: '/work/project', status: 'inProgress' } });
  srv.notify('item/completed', { threadId: 'thr_1', turnId: 'turn_1', item: { type: 'commandExecution', id: 'cmd2', command: 'false', status: 'failed', exitCode: 1, aggregatedOutput: '' } });
  srv.notify('item/completed', { threadId: 'thr_1', turnId: 'turn_1', item: { type: 'webSearch', id: 'ws1', query: 'sony xm6 price', action: null, results: null } });
  srv.notify('item/completed', { threadId: 'thr_1', turnId: 'turn_1', item: { type: 'reasoning', id: 'r1', summary: ['Check the price'], content: [] } });
  srv.notify('item/completed', { threadId: 'thr_1', turnId: 'turn_1', item: { type: 'agentMessage', id: 'm1', text: 'Looking now.\nMore detail.', phase: 'commentary' } });
  srv.notify('thread/tokenUsage/updated', { threadId: 'thr_1', turnId: 'turn_1', tokenUsage: { total: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }, last: {} } });
  srv.notify('some/futureNotification', { threadId: 'thr_1' });
  srv.complete('thr_1', 'turn_1', { text: 'Final answer.' });
  const result = await pending;

  assert.deepEqual(result, { ok: true, text: 'Final answer.', stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 } });
  assert.deepEqual(sink.ofType('tool.started'), [
    { name: 'command', callId: 'cmd1', say: 'Running ls -la' },
    { name: 'command', callId: 'cmd2', say: 'Running false' },
    { name: 'web search', callId: 'ws1', say: 'Searching the web: sony xm6 price' },
  ]);
  assert.deepEqual(sink.ofType('tool.finished'), [{ name: 'command', callId: 'cmd1' }, { name: 'web search', callId: 'ws1' }]);
  assert.deepEqual(sink.ofType('tool.failed'), [{ name: 'command', callId: 'cmd2', error: 'exit code 1 (failed)' }]);
  assert.deepEqual(sink.ofType('message'), [{ text: 'Looking now.' }, { text: 'Final answer.' }]);
  assert.deepEqual(sink.ofType('agent.status').at(-1), { state: 'idle', stopReason: 'end_turn', say: 'Final answer.' });
  const kinds = sink.entries.map((e) => e.kind);
  assert.deepEqual(kinds, ['tool_call', 'tool_result', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'thinking', 'assistant', 'assistant', 'result']);
  const toolResult = sink.entries.find((e) => e.kind === 'tool_result' && e.callId === 'cmd1');
  assert.ok(toolResult.text.length < 4100 && toolResult.text.startsWith('xxxx'));
  assert.equal(sink.entries.find((e) => e.kind === 'tool_call').input.command, 'ls -la');
  assert.ok(sink.entries.every((e) => typeof e.ts === 'string'));
  await until(() => sink.ofType('usage').some((u) => u.limit), 'rate limit usage');
  const { limit } = sink.ofType('usage').find((u) => u.limit);
  assert.equal(limit.primary.usedPercent, 12);
  assert.doesNotMatch(JSON.stringify(limit), /acct_secret/);
  assert.equal(session.state, 'idle');
  await f.backend.close();
});

test('failed turns and error notifications', async () => {
  const f = fakeCodex();
  const sink = recordingSink();
  const session = await f.backend.start(SPEC, sink);
  const pending = session.turn('go');
  await until(() => f.srv.turns === 1 && sink.ofType('agent.status').length);
  f.srv.notify('error', { threadId: 'thr_1', turnId: 'turn_1', willRetry: true, error: { message: 'stream disconnected' } });
  f.srv.notify('error', { threadId: 'thr_1', turnId: 'turn_1', willRetry: false, error: { message: 'usage limit reached' } });
  f.srv.complete('thr_1', 'turn_1', { text: '', status: 'failed', error: null });
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.stopReason, 'error');
  assert.equal(result.error, 'usage limit reached');
  assert.ok(sink.entries.some((e) => e.kind === 'system' && /stream disconnected — retrying/.test(e.text)));
  assert.equal(sink.ofType('agent.status').at(-1).stopReason, 'error');
  await f.backend.close();
});

/** Start a session with a running turn; returns helpers. */
async function runningTurn(answer, handlers) {
  const f = fakeCodex(handlers);
  const sink = recordingSink(answer);
  const session = await f.backend.start(SPEC, sink);
  const turn = session.turn('work');
  await until(() => sink.ofType('agent.status').some((s) => s.state === 'working'), 'working');
  return { f, sink, session, turn, srv: f.srv };
}

test('command approval round trip for every decision', async () => {
  const cases = [
    [{ behavior: 'allow' }, 'accept'],
    [{ behavior: 'allow', optionId: 'accept' }, 'accept'],
    [{ behavior: 'allow', optionId: 'acceptForSession' }, 'accept'], // never session-wide
    [{ behavior: 'allow', remember: true }, 'accept'], // "allow always" is remembered by the engine
    [{ behavior: 'deny' }, 'decline'],
    [{ behavior: 'deny', optionId: 'cancel' }, 'cancel'],
    [{ behavior: 'cancel' }, 'cancel'],
  ];
  let answer;
  const { f, sink, session, srv, turn } = await runningTurn(() => answer);
  for (const [given, expected] of cases) {
    answer = given;
    const { response } = srv.request('item/commandExecution/requestApproval', {
      kind: 'command', threadId: 'thr_1', turnId: 'turn_1', itemId: 'cmd9', startedAtMs: 0, environmentId: null,
      command: "/bin/zsh -lc 'rm -rf build'", cwd: '/work/project', reason: 'cleanup',
    });
    assert.deepEqual((await response).result, { decision: expected }, JSON.stringify(given));
  }
  const ask = sink.asks[0];
  assert.equal(ask.kind, 'approval');
  assert.equal(ask.title, 'Run `rm -rf build`?');
  assert.equal(ask.description, 'cleanup');
  assert.deepEqual(ask.subject, { type: 'command', command: 'rm -rf build', cwd: '/work/project', rawCommand: "/bin/zsh -lc 'rm -rf build'" });
  assert.equal(ask.toolCallId, 'cmd9');
  assert.deepEqual(ask.options.map((o) => [o.optionId, o.kind]), [['accept', 'allow_once'], ['decline', 'reject_once'], ['cancel', 'reject_once']]);
  assert.deepEqual(ask.source, { backend: 'codex', raw: 'item/commandExecution/requestApproval' });
  srv.complete('thr_1', 'turn_1');
  await turn;
  await f.backend.close();
  void session;
});

test('session state is requires_action while an ask is pending', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { f, session, srv, turn } = await runningTurn(() => gate);
  const { response } = srv.request('item/commandExecution/requestApproval', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'c', command: 'ls' });
  await until(() => session.state === 'requires_action', 'requires_action');
  release({ behavior: 'allow' });
  assert.deepEqual((await response).result, { decision: 'accept' });
  assert.equal(session.state, 'running');
  srv.complete('thr_1', 'turn_1');
  await turn;
  await f.backend.close();
});

test('file change approval uses the paths from item/started', async () => {
  let answer = { behavior: 'allow' };
  const { f, sink, srv, turn } = await runningTurn(() => answer);
  srv.notify('item/started', { threadId: 'thr_1', turnId: 'turn_1', item: { type: 'fileChange', id: 'fc1', status: 'inProgress', changes: [{ path: '/work/project/out.txt', kind: { type: 'add' }, diff: '+OK' }] } });
  let r = srv.request('item/fileChange/requestApproval', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'fc1', startedAtMs: 0, reason: null, grantRoot: null });
  assert.deepEqual((await r.response).result, { decision: 'accept' });
  const ask = sink.asks[0];
  assert.equal(ask.title, 'Change `out.txt`?');
  assert.equal(ask.subject.type, 'file_change');
  assert.equal(ask.subject.path, '/work/project/out.txt');
  assert.deepEqual(ask.subject.paths, ['/work/project/out.txt']);
  assert.deepEqual(ask.subject.input.changes, [{ path: '/work/project/out.txt', kind: 'add', diff: '+OK' }]);
  answer = { behavior: 'deny' };
  r = srv.request('item/fileChange/requestApproval', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'fc1' });
  assert.deepEqual((await r.response).result, { decision: 'decline' });
  srv.notify('item/completed', { threadId: 'thr_1', turnId: 'turn_1', item: { type: 'fileChange', id: 'fc1', status: 'declined', changes: [{ path: '/work/project/out.txt', kind: { type: 'add' }, diff: '+OK' }] } });
  await until(() => sink.ofType('tool.failed').length === 1);
  assert.deepEqual(sink.ofType('tool.failed')[0], { name: 'file change', callId: 'fc1', error: 'declined' });
  srv.complete('thr_1', 'turn_1');
  await turn;
  await f.backend.close();
});

test('permissions request: network and write grants are declined without asking; read grants are asked, turn-scoped only', async () => {
  let answer;
  const { f, sink, srv, turn } = await runningTurn(() => answer);
  const base = { threadId: 'thr_1', turnId: 'turn_1', itemId: 'p1', environmentId: null, startedAtMs: 0, cwd: '/work/project', reason: 'need it' };
  answer = { behavior: 'allow', remember: true };
  const network = { ...base, permissions: { network: { enabled: true }, fileSystem: null } };
  assert.deepEqual((await srv.request('item/permissions/requestApproval', network).response).result, { permissions: {}, scope: 'turn' });
  const write = { ...base, permissions: { network: null, fileSystem: { read: null, write: ['/work/project'] } } };
  assert.deepEqual((await srv.request('item/permissions/requestApproval', write).response).result, { permissions: {}, scope: 'turn' });
  assert.equal(sink.asks.length, 0, 'nobody was asked');
  const notes = sink.entries.filter((e) => e.kind === 'system').map((e) => e.text);
  assert.match(notes[0], /Declined a request for network access without asking/);
  assert.match(notes[1], /Declined a request for write access to \/work\/project without asking/);

  const read = { ...base, permissions: { network: null, fileSystem: { read: ['/data/shared'], write: null } } };
  assert.deepEqual((await srv.request('item/permissions/requestApproval', read).response).result, { permissions: { fileSystem: { read: ['/data/shared'], write: null } }, scope: 'turn' });
  answer = { behavior: 'deny' };
  assert.deepEqual((await srv.request('item/permissions/requestApproval', read).response).result, { permissions: {}, scope: 'turn' });
  assert.equal(sink.asks[0].title, 'Grant read access to /data/shared?');
  assert.deepEqual(sink.asks[0].options.map((o) => o.kind), ['allow_once', 'reject_once']);
  srv.complete('thr_1', 'turn_1');
  await turn;
  await f.backend.close();
});

test('command approvals for network access and file changes with a grant root are declined without asking', async () => {
  const { f, sink, srv, turn } = await runningTurn(() => ({ behavior: 'allow', remember: true }));
  let r = srv.request('item/commandExecution/requestApproval', {
    threadId: 'thr_1', turnId: 'turn_1', itemId: 'n1', command: 'curl https://example.com', networkApprovalContext: { host: 'example.com', protocol: 'https' },
  });
  assert.deepEqual((await r.response).result, { decision: 'decline' });
  srv.notify('item/started', { threadId: 'thr_1', turnId: 'turn_1', item: { type: 'fileChange', id: 'g1', status: 'inProgress', changes: [{ path: '/work/project/outputs/work/finder.md', kind: { type: 'add' }, diff: '+x' }] } });
  r = srv.request('item/fileChange/requestApproval', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'g1', grantRoot: '/work/project' });
  assert.deepEqual((await r.response).result, { decision: 'decline' });
  assert.equal(sink.asks.length, 0);
  const notes = sink.entries.filter((e) => e.kind === 'system').map((e) => e.text);
  assert.match(notes[0], /Declined network access to example\.com without asking/);
  assert.match(notes[1], /write access under \/work\/project without asking/);
  srv.complete('thr_1', 'turn_1');
  await turn;
  await f.backend.close();
});

test('file change approval checks both ends of a rename (move_path)', async () => {
  const { f, sink, srv, turn } = await runningTurn(() => ({ behavior: 'deny' }));
  srv.notify('item/started', { threadId: 'thr_1', turnId: 'turn_1', item: { type: 'fileChange', id: 'mv1', status: 'inProgress', changes: [{ path: '/work/project/outputs/work/finder.md', kind: { type: 'update', move_path: '/work/project/CLAUDE.md' }, diff: '' }] } });
  const r = srv.request('item/fileChange/requestApproval', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'mv1' });
  assert.deepEqual((await r.response).result, { decision: 'decline' });
  assert.deepEqual(sink.asks[0].subject.paths, ['/work/project/outputs/work/finder.md', '/work/project/CLAUDE.md']);
  assert.equal(sink.asks[0].title, 'Change 2 files?');
  srv.complete('thr_1', 'turn_1');
  await turn;
  await f.backend.close();
});

test('precheck: a refused call Codex runs without asking stops the turn, and the work continues in a new turn', async () => {
  const checked = [];
  const { f, sink, session, srv, turn } = await runningTurn();
  sink.precheck = (subject) => {
    checked.push(subject);
    return /\.env/.test(subject.command ?? '') ? { effect: 'deny', reason: 'Commands never touch credential files' } : { effect: 'allow' };
  };
  srv.notify('item/started', { threadId: 'thr_1', turnId: 'turn_1', item: { type: 'commandExecution', id: 'ok1', command: "/bin/zsh -lc 'ls'", cwd: '/work/project', status: 'inProgress' } });
  srv.notify('item/started', { threadId: 'thr_1', turnId: 'turn_1', item: { type: 'commandExecution', id: 'bad1', command: "/bin/zsh -lc 'cat .env'", cwd: '/work/project', status: 'inProgress' } });
  await until(() => srv.callsOf('turn/interrupt').length === 1, 'turn/interrupt');
  assert.deepEqual(srv.callsOf('turn/interrupt')[0].params, { threadId: 'thr_1', turnId: 'turn_1' });
  assert.deepEqual(checked[1], { type: 'command', command: 'cat .env', cwd: '/work/project', sandboxed: true });
  assert.deepEqual(sink.ofType('tool.failed'), [{ name: 'command', callId: 'bad1', error: 'Refused by the team design: Commands never touch credential files' }]);
  srv.notify('item/completed', { threadId: 'thr_1', turnId: 'turn_1', item: { type: 'commandExecution', id: 'bad1', command: 'cat .env', status: 'completed', exitCode: 0, aggregatedOutput: 'SECRET=1' } });
  // the default turn/interrupt handler completes turn_1 as interrupted → continuation turn_2
  await until(() => srv.callsOf('turn/start').length === 2, 'continuation turn/start');
  assert.equal(srv.callsOf('turn/start')[1].params.input[0].text, 'That command is not allowed for your role: Commands never touch credential files. Continue without it.');
  assert.equal(sink.ofType('agent.stopped').length, 0, 'not a user interrupt');
  assert.equal(sink.ofType('tool.failed').length, 1, 'no second tool event for the refused item');
  await until(() => sink.ofType('agent.status').filter((s) => s.state === 'working').length === 2);
  srv.complete('thr_1', 'turn_2', { text: 'Done without it.' });
  const result = await turn;
  assert.deepEqual(result, { ok: true, text: 'Done without it.', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } });
  assert.equal(session.state, 'idle');
  await f.backend.close();
});

test('precheck: MCP calls and page opens are checked; allow and ask leave the turn alone; no precheck, no check', async () => {
  const checked = [];
  const { f, sink, srv, turn } = await runningTurn();
  sink.precheck = (subject) => { checked.push(subject); return { effect: subject.tool === 'WebFetch' ? 'ask' : 'allow' }; };
  srv.notify('item/started', { threadId: 'thr_1', turnId: 'turn_1', item: { type: 'mcpToolCall', id: 'm1', server: 'shop', tool: 'search', arguments: { q: 'xm6' }, status: 'inProgress' } });
  srv.notify('item/started', { threadId: 'thr_1', turnId: 'turn_1', item: { type: 'webSearch', id: 'w1', query: '', action: { type: 'openPage', url: 'https://example.com/a' } } });
  srv.notify('item/started', { threadId: 'thr_1', turnId: 'turn_1', item: { type: 'webSearch', id: 'w2', query: 'xm6', action: { type: 'search', query: 'xm6' } } });
  await until(() => checked.length === 2);
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(checked, [
    { type: 'tool_call', tool: 'mcp__shop__search', input: { q: 'xm6' } },
    { type: 'tool_call', tool: 'WebFetch', input: { url: 'https://example.com/a' } },
  ]);
  assert.equal(srv.callsOf('turn/interrupt').length, 0);
  srv.complete('thr_1', 'turn_1');
  assert.equal((await turn).ok, true);
  await f.backend.close();
});

test('precheck: a user interrupt during a refusal does not continue', async () => {
  const { f, sink, session, srv, turn } = await runningTurn(undefined, {
    'turn/interrupt': () => ({}), // confirmed by hand below
  });
  sink.precheck = () => ({ effect: 'deny', reason: 'no' });
  srv.notify('item/started', { threadId: 'thr_1', turnId: 'turn_1', item: { type: 'commandExecution', id: 'b', command: 'cat raw/bank.pdf', cwd: '/work/project', status: 'inProgress' } });
  await until(() => srv.callsOf('turn/interrupt').length === 1);
  const stopping = session.interrupt();
  await tick();
  srv.complete('thr_1', 'turn_1', { text: '', status: 'interrupted' });
  await stopping;
  assert.equal((await turn).stopReason, 'cancelled');
  assert.equal(srv.callsOf('turn/start').length, 1);
  await f.backend.close();
});

test('user input questions: answers by id, by question text, or one option; declines send no answers', async () => {
  let answer;
  const { f, sink, srv, turn } = await runningTurn(() => answer);
  const questions = [
    { id: 'q1', header: 'Budget', question: 'What is the budget?', isOther: true, isSecret: false, options: [{ label: '£200', description: '' }, { label: '£300', description: 'more' }] },
    { id: 'q2', header: 'Region', question: 'Which region?', isOther: false, isSecret: false, options: null },
  ];
  answer = { behavior: 'allow', answers: { q1: '£200', 'Which region?': ['UK', 'EU'] } };
  let r = srv.request('item/tool/requestUserInput', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'u1', questions, isBlocking: true, autoResolutionMs: null });
  assert.deepEqual((await r.response).result, { answers: { q1: { answers: ['£200'] }, q2: { answers: ['UK', 'EU'] } } });
  const ask = sink.asks[0];
  assert.equal(ask.kind, 'question');
  assert.equal(ask.title, '2 questions');
  assert.equal(ask.questions[0].options[1].label, '£300');

  answer = { behavior: 'allow', optionId: '£300' };
  r = srv.request('item/tool/requestUserInput', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'u2', questions: [questions[0]], isBlocking: true, autoResolutionMs: null });
  assert.deepEqual((await r.response).result, { answers: { q1: { answers: ['£300'] } } });
  assert.deepEqual(sink.asks[1].options.map((o) => o.kind), ['choice', 'choice']);

  answer = { behavior: 'cancel' };
  r = srv.request('item/tool/requestUserInput', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'u3', questions, isBlocking: true, autoResolutionMs: null });
  assert.deepEqual((await r.response).result, { answers: {} });
  srv.complete('thr_1', 'turn_1');
  await turn;
  await f.backend.close();
});

test('MCP elicitation: accept with content, decline, cancel', async () => {
  let answer;
  const { f, sink, srv, turn } = await runningTurn(() => answer);
  const params = { threadId: 'thr_1', turnId: 'turn_1', serverName: 'shop', mode: 'form', _meta: null, message: 'Pick a size', requestedSchema: { type: 'object', properties: { size: { type: 'string' } } } };
  answer = { behavior: 'allow', answers: { size: 'M' } };
  assert.deepEqual((await srv.request('mcpServer/elicitation/request', params).response).result, { action: 'accept', content: { size: 'M' }, _meta: null });
  answer = { behavior: 'deny' };
  assert.deepEqual((await srv.request('mcpServer/elicitation/request', params).response).result, { action: 'decline', content: null, _meta: null });
  answer = { behavior: 'cancel' };
  assert.deepEqual((await srv.request('mcpServer/elicitation/request', params).response).result, { action: 'cancel', content: null, _meta: null });
  assert.equal(sink.asks[0].title, 'Pick a size');
  assert.equal(sink.asks[0].subject.type, 'mcp_elicitation');
  assert.equal(sink.asks[0].subject.server, 'shop');
  srv.complete('thr_1', 'turn_1');
  await turn;
  await f.backend.close();
});

test('legacy execCommandApproval / applyPatchApproval map to ReviewDecision', async () => {
  let answer;
  const { f, sink, srv, turn } = await runningTurn(() => answer);
  answer = { behavior: 'allow' };
  let r = srv.request('execCommandApproval', { conversationId: 'thr_1', callId: 'c1', approvalId: null, command: ['ls', '-la'], cwd: '/work/project', reason: null, parsedCmd: [] });
  assert.deepEqual((await r.response).result, { decision: 'approved' });
  assert.equal(sink.asks[0].subject.command, 'ls -la');
  answer = { behavior: 'deny', message: 'not now' };
  r = srv.request('applyPatchApproval', { conversationId: 'thr_1', callId: 'p1', fileChanges: { '/work/project/a.md': { type: 'add', content: 'x' } }, reason: null, grantRoot: null });
  assert.deepEqual((await r.response).result, { decision: { denied: { rejection: 'not now' } } });
  assert.equal(sink.asks[1].title, 'Change `a.md`?');
  answer = { behavior: 'cancel' };
  r = srv.request('execCommandApproval', { conversationId: 'thr_1', callId: 'c2', command: ['ls'], cwd: '/', parsedCmd: [] });
  assert.deepEqual((await r.response).result, { decision: 'abort' });
  srv.complete('thr_1', 'turn_1');
  await turn;
  await f.backend.close();
});

test('unknown and refused server requests get an explicit error and a transcript note; unknown threads are declined', async () => {
  const { f, sink, srv, turn } = await runningTurn(() => ({ behavior: 'allow' }));
  let r = srv.request('item/brandNew/request', { threadId: 'thr_1' });
  let response = await r.response;
  assert.equal(response.error.code, -32601);
  assert.ok(sink.entries.some((e) => e.kind === 'system' && /item\/brandNew\/request/.test(e.text)));
  r = srv.request('account/chatgptAuthTokens/refresh', { reason: 'unauthorized' });
  response = await r.response;
  assert.equal(response.error.code, -32601);
  assert.match(response.error.message, /never handles credentials/);
  r = srv.request('item/commandExecution/requestApproval', { threadId: 'thr_other', turnId: 't', itemId: 'x', command: 'ls' });
  assert.deepEqual((await r.response).result, { decision: 'cancel' });
  assert.equal(sink.asks.length, 0);
  srv.complete('thr_1', 'turn_1');
  await turn;
  await f.backend.close();
});

test('serverRequest/resolved while still asking: resolvedElsewhere hook, and no late response', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { f, sink, session, srv, turn } = await runningTurn(() => gate);
  const { id } = srv.request('item/commandExecution/requestApproval', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'cmd5', command: 'ls' });
  await until(() => sink.asks.length === 1, 'ask');
  srv.notify('serverRequest/resolved', { threadId: 'thr_1', requestId: id });
  await until(() => sink.elsewhere.length === 1, 'resolvedElsewhere');
  assert.deepEqual(sink.elsewhere[0], { toolCallId: 'cmd5', info: { requestId: id } });
  assert.equal(session.state, 'running');
  release({ behavior: 'allow' });
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(srv.responses.has(id), false);
  srv.complete('thr_1', 'turn_1');
  await turn;
  await f.backend.close();
});

test('steer with a running turn uses turn/steer with expectedTurnId', async () => {
  const { f, session, srv, turn } = await runningTurn();
  const ack = await session.send('focus on price', 'steer');
  assert.deepEqual(ack, { status: 'applied', reason: 'steered into the running turn' });
  assert.deepEqual(srv.callsOf('turn/steer')[0].params, { threadId: 'thr_1', input: [{ type: 'text', text: 'focus on price', text_elements: [] }], expectedTurnId: 'turn_1' });
  assert.equal(srv.callsOf('turn/start').length, 1);
  srv.complete('thr_1', 'turn_1');
  await turn;
  await f.backend.close();
});

test('steer with no running turn starts a new turn', async () => {
  const f = fakeCodex();
  const sink = recordingSink();
  const session = await f.backend.start(SPEC, sink);
  const ack = await session.send('hello', 'steer');
  assert.deepEqual(ack, { status: 'applied', reason: 'no active turn; started a new turn' });
  assert.equal(f.srv.callsOf('turn/steer').length, 0);
  assert.equal(f.srv.callsOf('turn/start')[0].params.input[0].text, 'hello');
  f.srv.complete('thr_1', 'turn_1');
  await until(() => session.state === 'idle');
  await f.backend.close();
});

test('steer that loses the race with turn end falls back to turn/start', async () => {
  const { f, session, srv, turn } = await runningTurn(undefined, {
    'turn/steer': (params, server) => {
      server.complete(params.threadId, params.expectedTurnId); // the turn ends first
      throw Object.assign(new Error('no active turn to steer'), { code: -32600 });
    },
  });
  const ack = await session.send('late thought', 'steer');
  assert.deepEqual(ack, { status: 'applied', reason: 'no active turn; started a new turn' });
  assert.equal((await turn).ok, true);
  assert.equal(srv.callsOf('turn/start').at(-1).params.input[0].text, 'late thought');
  srv.complete('thr_1', 'turn_2');
  await until(() => session.state === 'idle');
  await f.backend.close();
});

test('steer refused for another reason is reported as rejected', async () => {
  const { f, session, srv, turn } = await runningTurn(undefined, {
    'turn/steer': () => { throw Object.assign(new Error('cannot steer a review turn'), { code: -32600 }); },
  });
  assert.deepEqual(await session.send('x', 'steer'), { status: 'rejected', reason: 'cannot steer a review turn' });
  srv.complete('thr_1', 'turn_1');
  await turn;
  await f.backend.close();
});

test('queue holds the message until the running turn ends', async () => {
  const { f, session, srv, turn } = await runningTurn();
  let acked = null;
  const ackPromise = session.send('next please', 'queue').then((a) => { acked = a; });
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(srv.callsOf('turn/start').length, 1);
  assert.equal(acked, null);
  srv.complete('thr_1', 'turn_1');
  await turn;
  await ackPromise;
  assert.deepEqual(acked, { status: 'applied', reason: 'held until the running turn ended, then started a new turn' });
  assert.equal(srv.callsOf('turn/start')[1].params.input[0].text, 'next please');
  srv.complete('thr_1', 'turn_2');
  await until(() => session.state === 'idle');
  await f.backend.close();
});

test('interrupt delivery stops the turn (confirmed by Codex), then starts a new one', async () => {
  const { f, sink, session, srv, turn } = await runningTurn();
  const ack = await session.send('change of plan', 'interrupt');
  assert.deepEqual(ack, { status: 'applied', reason: 'interrupted the running turn, then started a new turn' });
  assert.deepEqual(srv.callsOf('turn/interrupt')[0].params, { threadId: 'thr_1', turnId: 'turn_1' });
  const first = await turn;
  assert.equal(first.stopReason, 'cancelled');
  assert.equal(first.ok, false);
  assert.deepEqual(sink.ofType('agent.stopped'), [{ reason: 'Interrupted', scope: 'turn' }]);
  assert.equal(srv.callsOf('turn/start')[1].params.input[0].text, 'change of plan');
  srv.complete('thr_1', 'turn_2');
  await until(() => session.state === 'idle');
  await f.backend.close();
});

test('interrupt() only reports a stop once Codex confirms', async () => {
  let confirm;
  const { f, sink, session, srv, turn } = await runningTurn(undefined, {
    'turn/interrupt': (params, server) => { confirm = () => server.complete(params.threadId, params.turnId, { text: '', status: 'interrupted' }); return {}; },
  });
  const stopping = session.interrupt();
  await until(() => typeof confirm === 'function', 'turn/interrupt');
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(sink.ofType('agent.stopped').length, 0);
  confirm();
  await stopping;
  assert.equal((await turn).stopReason, 'cancelled');
  assert.equal(sink.ofType('agent.stopped').length, 1);
  await f.backend.close();
  void srv;
});

test('turns are serialised: the second turn/start waits for the first turn to complete', async () => {
  const f = fakeCodex();
  const sink = recordingSink();
  const session = await f.backend.start(SPEC, sink);
  const one = session.turn('one');
  const two = session.turn('two');
  await until(() => f.srv.callsOf('turn/start').length === 1);
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(f.srv.callsOf('turn/start').length, 1);
  f.srv.complete('thr_1', 'turn_1', { text: 'first' });
  assert.equal((await one).text, 'first');
  await until(() => f.srv.callsOf('turn/start').length === 2);
  assert.equal(f.srv.callsOf('turn/start')[1].params.input[0].text, 'two');
  await until(() => sink.ofType('agent.status').filter((s) => s.state === 'working').length === 2);
  f.srv.complete('thr_1', 'turn_2', { text: 'second' });
  assert.equal((await two).text, 'second');
  await f.backend.close();
});

test('a failed turn/start resolves the turn with an error and lets the next one run', async () => {
  let fail = true;
  const f = fakeCodex({
    'turn/start': (params, srv) => {
      if (fail) { fail = false; throw new Error('model not available'); }
      return DEFAULT_HANDLERS['turn/start'](params, srv);
    },
  });
  const sink = recordingSink();
  const session = await f.backend.start(SPEC, sink);
  const bad = await session.turn('one');
  assert.deepEqual(bad, { ok: false, text: '', stopReason: 'error', error: 'model not available' });
  const good = session.turn('two');
  await until(() => sink.ofType('agent.status').some((s) => s.state === 'working'));
  f.srv.complete('thr_1', 'turn_1');
  assert.equal((await good).ok, true);
  await f.backend.close();
});

test('routing: notifications and requests reach only the session that owns the thread', async () => {
  const f = fakeCodex();
  const a = recordingSink();
  const b = recordingSink();
  const sa = await f.backend.start({ ...SPEC, agentId: 'a' }, a);
  const sb = await f.backend.start({ ...SPEC, agentId: 'b' }, b);
  assert.equal(f.spawns.length, 1, 'one shared app-server');
  const tb = sb.turn('for b');
  await until(() => b.ofType('agent.status').some((s) => s.state === 'working'));
  f.srv.notify('item/completed', { threadId: sb.id, turnId: 'turn_1', item: { type: 'agentMessage', id: 'm', text: 'only b', phase: null } });
  const r = f.srv.request('item/commandExecution/requestApproval', { threadId: sb.id, turnId: 'turn_1', itemId: 'x', command: 'ls' });
  await r.response;
  f.srv.complete(sb.id, 'turn_1');
  await tb;
  assert.equal(a.ofType('message').length, 0);
  assert.equal(a.ofType('agent.status').length, 0);
  assert.equal(a.asks.length, 0);
  assert.equal(b.asks.length, 1);
  assert.deepEqual(b.ofType('message').map((m) => m.text), ['only b', 'done']);
  assert.equal(sa.state, 'idle');
  await f.backend.close();
});

test('crash mid-turn: turn errors, asks settle, agent.failed; lazy restart with a crash-loop guard', async () => {
  let clock = 0;
  const f = fakeCodex({}, { now: () => clock });
  const sink = recordingSink(() => new Promise(() => {})); // an ask nobody answers
  const session = await f.backend.start(SPEC, sink);
  const turn = session.turn('work');
  await until(() => sink.ofType('agent.status').some((s) => s.state === 'working'));
  f.srv.request('item/commandExecution/requestApproval', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'x', command: 'ls' });
  await until(() => sink.asks.length === 1);
  f.srv.child.stderr.write('thread panicked at codex-core\n');
  f.srv.crash(101);
  const result = await turn;
  assert.equal(result.ok, false);
  assert.equal(result.stopReason, 'error');
  assert.match(result.error, /codex app-server exited \(code 101\): thread panicked/);
  assert.equal(sink.ofType('agent.failed').length, 1);
  assert.match(sink.ofType('agent.failed')[0].reason, /code 101/);
  assert.equal(session.state, 'closed');
  assert.deepEqual(await session.turn('again'), { ok: false, text: '', stopReason: 'error', error: 'session closed' });
  assert.deepEqual(await session.send('x', 'steer'), { status: 'rejected', reason: 'session closed' });

  // lazy restart on the next start(); at most 3 restarts per minute
  for (let i = 1; i <= 3; i++) {
    const again = await f.backend.start(SPEC, recordingSink());
    assert.equal(f.spawns.length, 1 + i);
    assert.equal(again.state, 'idle');
    f.srv.crash(1);
    clock += 1000;
  }
  await assert.rejects(f.backend.start(SPEC, recordingSink()), /crashed 3 times within a minute/);
  clock += 61_000;
  const recovered = await f.backend.start({ ...SPEC, resume: 'thr_1' }, recordingSink());
  assert.equal(recovered.id, 'thr_1');
  await f.backend.close();
});

test('a server that never initialises fails start() with its stderr, and is not counted as a crash', async () => {
  const f = fakeCodex({ initialize: (params, srv) => { srv.child.stderr.write('error: unknown subcommand app-server\n'); setImmediate(() => srv.crash(2)); return SILENT; } });
  for (let i = 0; i < 5; i++) {
    await assert.rejects(f.backend.start(SPEC, recordingSink()), /codex app-server did not start: .*before initialize answered/);
  }
  assert.equal(f.spawns.length, 5, 'no crash-loop refusal for failed starts');
});

test('close settles queued turns and stops the server; a closed backend can start again', async () => {
  const { f, session, turn } = await runningTurn();
  const queued = session.turn('later');
  await f.backend.close();
  assert.equal((await turn).stopReason, 'cancelled');
  assert.deepEqual(await queued, { ok: false, text: '', stopReason: 'cancelled', error: 'session closed' });
  assert.equal(session.state, 'closed');
  assert.equal(f.spawns[0].child.exitCode, 0);
  const again = await f.backend.start(SPEC, recordingSink());
  assert.equal(f.spawns.length, 2);
  await again.close();
  await f.backend.close();
});
