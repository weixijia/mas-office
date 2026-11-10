import './keepalive.js';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createClaudeBackend, describeTool, findOnPath, firstSentence, shortenHome, toPermissionResult } from '../src/backends/claude.js';
import { createPushable } from '../src/backends/pushable.js';

const HOME = '/home/tester';
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async (n = 5) => {
  for (let i = 0; i < n; i += 1) await tick();
};

/**
 * A scripted stand-in for the Agent SDK `query()`: records options and every user
 * message pushed into the prompt iterable, and lets the test emit SDK messages.
 */
function fakeQuery() {
  const calls = [];
  const fn = (params) => {
    const out = createPushable();
    const q = {
      params,
      options: params.options,
      inputs: [],
      interrupts: 0,
      closed: false,
      onInput: null,
      emit: (msg) => out.push(msg),
      finish: () => out.end(),
      async interrupt() {
        q.interrupts += 1;
        q.onInterrupt?.();
      },
      close() {
        q.closed = true;
        out.end();
      },
      [Symbol.asyncIterator]: () => out[Symbol.asyncIterator](),
    };
    (async () => {
      for await (const m of params.prompt) {
        q.inputs.push(m);
        q.onInput?.(m);
      }
      out.end();
    })();
    calls.push(q);
    return q;
  };
  fn.calls = calls;
  return fn;
}

function recordingSink(ask = async () => ({ behavior: 'allow' })) {
  const events = [];
  const entries = [];
  const asks = [];
  return {
    events,
    entries,
    asks,
    types: () => events.map((e) => e.type),
    event: (type, data) => events.push({ type, data }),
    transcript: (entry) => entries.push(entry),
    ask: async (request) => {
      asks.push(request);
      return ask(request);
    },
  };
}

const spec = (extra = {}) => ({
  agentId: 'finder-a',
  cwd: `${HOME}/project`,
  systemPrompt: 'Role contract.',
  compiled: {
    claude: {
      tools: ['WebSearch', 'Read', 'Write'],
      disallowedTools: ['Bash'],
      mcpServers: {},
      permissionMode: 'default',
      settingSources: [],
    },
  },
  ...extra,
});

const init = (sessionId = 'sess-1') => ({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-test', tools: [] });
const result = (uuids, extra = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Done.',
  total_cost_usd: 0.01,
  modelUsage: { m: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2, cacheCreationInputTokens: 3 } },
  user_message_uuids: uuids,
  queued_turn_count: 0,
  ...extra,
});

async function startSession(sinkAsk, specExtra, backendExtra = {}) {
  const query = fakeQuery();
  const backend = createClaudeBackend({
    query,
    claudePath: '/usr/local/bin/claude',
    home: HOME,
    env: { PATH: '/usr/bin', HOME, LANG: 'en_GB.UTF-8', FAKE_SECRET_TOKEN: 'sk-should-not-leak', ANTHROPIC_API_KEY: 'sk-ant-nope', CLAUDECODE: '1' },
    closeTimeoutMs: 200,
    ...backendExtra,
  });
  const sink = recordingSink(sinkAsk);
  const session = await backend.start(spec(specExtra), sink);
  return { backend, sink, session, q: query.calls[0], query };
}

describe('pushable', () => {
  it('buffers, wakes waiting readers, drains on end, refuses pushes after end', async () => {
    const p = createPushable();
    p.push(1);
    const it = p[Symbol.asyncIterator]();
    assert.deepEqual(await it.next(), { value: 1, done: false });
    const waiting = it.next();
    p.push(2);
    assert.deepEqual(await waiting, { value: 2, done: false });
    p.push(3);
    p.end();
    assert.equal(p.push(4), false);
    assert.equal(p.ended, true);
    assert.deepEqual(await it.next(), { value: 3, done: false });
    assert.deepEqual(await it.next(), { value: undefined, done: true });
  });

  it('end() releases a reader that is already waiting, and return() ends the stream', async () => {
    const p = createPushable();
    const it = p[Symbol.asyncIterator]();
    const waiting = it.next();
    p.end();
    assert.deepEqual(await waiting, { value: undefined, done: true });
    const q = createPushable();
    const values = [];
    q.push('a');
    q.push('b');
    for await (const v of q) {
      values.push(v);
      break; // calls return()
    }
    assert.deepEqual(values, ['a']);
    assert.equal(q.ended, true);
  });
});

describe('helpers', () => {
  it('shortens home paths deeply and finds the first sentence', () => {
    assert.deepEqual(shortenHome({ a: `${HOME}/x`, b: [`see ${HOME}/y`], c: 3 }, HOME), { a: '~/x', b: ['see ~/y'], c: 3 });
    assert.equal(firstSentence('First one. Second one.'), 'First one.');
    assert.equal(firstSentence('line one\nline two'), 'line one');
    assert.equal(firstSentence('x'.repeat(300)).length, 120);
  });

  it('describes tools with human titles and subjects', () => {
    const cwd = `${HOME}/project`;
    const bash = describeTool('Bash', { command: 'npm test' }, { cwd, home: HOME });
    assert.equal(bash.title, 'Run `npm test`?');
    assert.deepEqual(bash.subject, { type: 'command', tool: 'Bash', command: 'npm test', input: { command: 'npm test' } });
    const write = describeTool('Write', { file_path: `${cwd}/outputs/work/finder-a.md`, content: 'x' }, { cwd, home: HOME });
    assert.equal(write.title, 'Write outputs/work/finder-a.md?');
    assert.equal(write.subject.type, 'file_change');
    assert.equal(write.subject.path, 'outputs/work/finder-a.md');
    const outside = describeTool('Edit', { file_path: `${HOME}/notes.md` }, { cwd, home: HOME });
    assert.equal(outside.subject.path, '~/notes.md');
    assert.equal(describeTool('WebSearch', { query: 'sony xm6 price' }, { cwd }).say, 'Searching: sony xm6 price');
    assert.equal(describeTool('WebSearch', { query: 'sony xm6 price' }, { cwd }).title, 'Search the web for “sony xm6 price”?');
    assert.equal(describeTool('WebFetch', { url: 'https://www.currys.co.uk/p/1' }, { cwd }).title, 'Open www.currys.co.uk in the browser?');
    assert.equal(describeTool('mcp__shop__lookup', {}, { cwd }).subject.mcpServer, 'shop');
  });

  it('finds an executable on PATH without a shell', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mas-claude-path-'));
    try {
      const bin = path.join(dir, 'claude');
      writeFileSync(bin, '#!/bin/sh\n');
      chmodSync(bin, 0o755);
      assert.equal(await findOnPath('claude', ['/nonexistent-dir', dir].join(path.delimiter), 'linux'), bin);
      assert.equal(await findOnPath('claude', '/nonexistent-dir', 'linux'), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('probe', () => {
  const fakeExec = (authStdout, { failAuth = false } = {}) => {
    const calls = [];
    const fn = async (file, args, opts) => {
      calls.push({ file, args, opts });
      if (args[0] === '--version') return { stdout: '2.1.322 (Claude Code)\n', stderr: '' };
      if (failAuth) {
        const err = new Error('exit 1');
        err.stdout = authStdout;
        throw err;
      }
      return { stdout: authStdout, stderr: '' };
    };
    fn.calls = calls;
    return fn;
  };

  it('reports version and login without leaking email or org ids', async () => {
    const execFile = fakeExec(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: 'someone@example.com', orgId: 'org-123', orgName: 'Acme' }));
    const backend = createClaudeBackend({ execFile, claudePath: '/usr/local/bin/claude', env: { PATH: '/usr/bin', SECRET_TOKEN: 'x' } });
    const res = await backend.probe();
    assert.deepEqual(res, { available: true, version: '2.1.322', loggedIn: true, detail: 'Signed in (claude.ai, max).' });
    assert.ok(!JSON.stringify(res).includes('example.com') && !JSON.stringify(res).includes('org-123') && !JSON.stringify(res).includes('Acme'));
    assert.deepEqual(execFile.calls.map((c) => c.args), [['--version'], ['auth', 'status', '--json']]);
    for (const c of execFile.calls) {
      assert.equal(c.file, '/usr/local/bin/claude');
      assert.ok(c.opts.timeout > 0);
      assert.equal(c.opts.env.SECRET_TOKEN, undefined);
    }
  });

  it('reads the JSON a signed-out CLI prints with a non-zero exit', async () => {
    const backend = createClaudeBackend({ execFile: fakeExec('{"loggedIn": false}', { failAuth: true }), claudePath: '/x/claude' });
    const res = await backend.probe();
    assert.equal(res.available, true);
    assert.equal(res.loggedIn, false);
    assert.match(res.detail, /claude auth login/);
  });

  it('reports a missing binary', async () => {
    const backend = createClaudeBackend({ execFile: fakeExec('{}'), env: { PATH: '/nonexistent-dir' } });
    const res = await backend.probe();
    assert.equal(res.available, false);
    assert.match(res.detail, /not installed/);
  });
});

describe('start options', () => {
  it('passes the compiled role, the user binary and a minimal environment', async () => {
    const { session, q } = await startSession();
    const o = q.options;
    assert.equal(o.pathToClaudeCodeExecutable, '/usr/local/bin/claude');
    assert.equal(o.cwd, `${HOME}/project`);
    assert.deepEqual(o.tools, ['WebSearch', 'Read', 'Write']);
    assert.deepEqual(o.disallowedTools, ['Bash']);
    assert.deepEqual(o.settingSources, []);
    assert.equal(o.permissionMode, 'default');
    assert.equal(o.strictMcpConfig, true);
    assert.equal(o.allowedTools, undefined, 'allowedTools would bypass canUseTool');
    assert.equal(o.mcpServers, undefined);
    assert.deepEqual(o.systemPrompt, { type: 'preset', preset: 'claude_code', append: 'Role contract.' });
    assert.equal(typeof o.canUseTool, 'function');
    assert.match(o.sessionId, /^[0-9a-f-]{36}$/);
    assert.equal(o.resume, undefined);
    assert.equal(session.id, o.sessionId);
    assert.equal(session.state, 'idle');
    // Minimal environment: allow-listed keys only, no secrets, no nesting markers.
    assert.equal(o.env.PATH, '/usr/bin');
    assert.equal(o.env.HOME, HOME);
    assert.equal(o.env.LANG, 'en_GB.UTF-8');
    assert.equal(o.env.FAKE_SECRET_TOKEN, undefined);
    assert.equal(o.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(o.env.CLAUDECODE, undefined);
    assert.ok(!Object.values(o.env).some((v) => String(v).startsWith('sk-')));
    assert.ok(!Object.keys(o.env).some((k) => /ENTRYPOINT|CLIENT_APP|USER_AGENT/.test(k)), 'no client identity overrides');
    await session.close();
  });

  it('resumes with the given session id and the model from the spec', async () => {
    const { session, q, sink } = await startSession(undefined, { resume: 'old-session', model: 'haiku' });
    assert.equal(q.options.resume, 'old-session');
    assert.equal(q.options.sessionId, undefined);
    assert.equal(q.options.model, 'haiku');
    assert.equal(session.id, 'old-session');
    q.emit(init('old-session'));
    await settle();
    assert.deepEqual(sink.entries.find((e) => e.kind === 'system').text, 'Session resumed');
    await session.close();
  });
});

describe('message mapping', () => {
  it('maps init, text, thinking, tools, results and rate limits to events and transcript', async () => {
    const { session, q, sink } = await startSession();
    q.onInput = (m) => {
      q.emit(init());
      q.emit({ type: 'system', subtype: 'session_state_changed', state: 'running' });
      q.emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'thinking', thinking: 'Let me think.' }] } });
      q.emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'tu1', name: 'WebSearch', input: { query: 'sony xm6 price' } }] } });
      q.emit({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: `5 results\n${'x'.repeat(5000)}` }] }] } });
      q.emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: `${HOME}/project/a.md` } }] } });
      q.emit({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: `ENOENT ${HOME}/project/a.md` }] } });
      q.emit({ type: 'assistant', parent_tool_use_id: 'tu9', message: { content: [{ type: 'text', text: 'Subagent says hi.' }] } });
      q.emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: `Found three offers in ${HOME}/project. More detail follows here.` }] } });
      q.emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: 1800000000, utilization: 0.8 } });
      q.emit({ type: 'brand_new_type', whatever: true });
      q.emit({ type: 'system', subtype: 'brand_new_subtype' });
      q.emit(null);
      q.emit(result([m.uuid]));
    };
    const res = await session.turn('Find offers.');
    assert.equal(res.ok, true);
    assert.equal(res.stopReason, 'end_turn');
    assert.equal(res.text, 'Done.');
    assert.deepEqual(res.usage, { inputTokens: 15, outputTokens: 5, turns: 1, costUsd: 0.01 });

    assert.deepEqual(sink.types(), [
      'agent.status', 'agent.registered', 'tool.started', 'tool.finished', 'tool.started', 'tool.failed',
      'message', 'usage', 'usage', 'agent.status',
    ]);
    const ev = (type, n = 0) => sink.events.filter((e) => e.type === type)[n].data;
    assert.deepEqual(ev('agent.status', 0), { state: 'working', say: 'Working' });
    assert.deepEqual(ev('agent.registered'), {
      backend: 'claude-code', model: 'claude-test', session: { backend: 'claude-code', id: 'sess-1', resumable: true },
      accepts: ['message', 'respond', 'interrupt', 'assign'],
    });
    assert.equal(session.id, 'sess-1');
    assert.deepEqual(ev('tool.started', 0), { name: 'WebSearch', callId: 'tu1', say: 'Searching: sony xm6 price' });
    assert.deepEqual(ev('tool.finished'), { name: 'WebSearch', callId: 'tu1' });
    assert.deepEqual(ev('tool.failed'), { name: 'Read', callId: 'tu2', error: 'ENOENT ~/project/a.md' });
    assert.deepEqual(ev('message'), { text: 'Found three offers in ~/project.' });
    assert.deepEqual(ev('usage', 0), { limit: { status: 'allowed_warning', kind: 'five_hour', resetsAt: new Date(1800000000 * 1000).toISOString(), utilization: 0.8 } });
    assert.deepEqual(ev('agent.status', 1), { state: 'idle', say: 'Turn finished', stopReason: 'end_turn' });

    const kinds = sink.entries.map((e) => e.kind);
    assert.deepEqual(kinds, ['user', 'system', 'thinking', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'assistant', 'assistant', 'result']);
    const tr = (kind, n = 0) => sink.entries.filter((e) => e.kind === kind)[n];
    assert.equal(tr('tool_call').summary, 'sony xm6 price');
    assert.equal(tr('tool_result').summary, '5 results');
    assert.equal(tr('tool_result').text.length, 4001);
    assert.deepEqual(tr('tool_call', 1).input, { file_path: '~/project/a.md' });
    assert.equal(tr('tool_result', 1).ok, false);
    assert.equal(tr('assistant', 0).parentCallId, 'tu9');
    assert.ok(sink.entries.every((e) => typeof e.ts === 'string'));
    assert.ok(!JSON.stringify(sink.entries).includes(HOME), 'home paths are shortened');
    assert.equal(session.state, 'idle');
    await session.close();
  });

  it('maps error results and interrupts to stop reasons, and emits agent.stopped only after the result', async () => {
    const { session, q, sink } = await startSession();
    q.onInput = (m) => q.emit(result([m.uuid], { subtype: 'error_max_turns', is_error: true, errors: ['too many turns'] }));
    const r1 = await session.turn('one');
    assert.equal(r1.ok, false);
    assert.equal(r1.stopReason, 'max_turns');
    assert.equal(r1.error, 'too many turns');

    let lastUuid;
    q.onInput = (m) => {
      lastUuid = m.uuid;
    };
    const pending = session.turn('two');
    await settle();
    assert.equal(session.state, 'running');
    await session.interrupt();
    assert.equal(q.interrupts, 1);
    assert.ok(!sink.types().includes('agent.stopped'), 'not stopped until the backend confirms');
    q.emit(result([lastUuid], { subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming' }));
    const r2 = await pending;
    assert.equal(r2.stopReason, 'cancelled');
    assert.deepEqual(sink.events.at(-1), { type: 'agent.stopped', data: { reason: 'Interrupted', scope: 'turn' } });
    assert.equal(session.state, 'idle');
    await session.close();
  });

  it('fails pending turns and emits agent.failed when the CLI stream dies', async () => {
    const { session, q, sink } = await startSession();
    q.onInput = () => q.finish();
    const res = await session.turn('hello');
    assert.equal(res.ok, false);
    assert.equal(res.stopReason, 'error');
    assert.ok(sink.types().includes('agent.failed'));
    assert.equal(session.state, 'closed');
  });
});

describe('canUseTool', () => {
  const callTool = (q, name, input, extra = {}) => {
    const controller = new AbortController();
    const promise = q.options.canUseTool(name, input, { signal: controller.signal, toolUseID: extra.toolUseID ?? 'tu1', requestId: 'r1', ...extra });
    return { promise, controller };
  };

  it('asks the sink and allows with the original input', async () => {
    const { session, q, sink } = await startSession(async () => ({ behavior: 'allow', optionId: 'allow-once' }));
    const input = { file_path: `${HOME}/project/outputs/work/finder-a.md`, content: 'x' };
    const res = await callTool(q, 'Write', input).promise;
    assert.deepEqual(res, { behavior: 'allow', updatedInput: input });
    const req = sink.asks[0];
    assert.equal(req.kind, 'approval');
    assert.equal(req.title, 'Write outputs/work/finder-a.md?');
    assert.deepEqual(req.subject, { type: 'file_change', tool: 'Write', path: 'outputs/work/finder-a.md', input: { file_path: '~/project/outputs/work/finder-a.md', content: 'x' } });
    assert.equal(req.toolCallId, 'tu1');
    assert.deepEqual(req.options.map((o) => o.optionId), ['allow-once', 'allow-always', 'reject']);
    assert.deepEqual(req.source, { backend: 'claude-code', raw: 'can_use_tool' });
    await session.close();
  });

  it('allows with an updated input; allow-always is offered without suggestions and never applies them', async () => {
    const { session, q, sink } = await startSession(async (req) =>
      req.toolCallId === 'tu1'
        ? { behavior: 'allow', updatedInput: { command: 'npm test -- --quiet' } }
        : { behavior: 'allow', optionId: 'allow-always', remember: true },
    );
    const r1 = await callTool(q, 'Bash', { command: 'npm test' }).promise;
    assert.deepEqual(r1, { behavior: 'allow', updatedInput: { command: 'npm test -- --quiet' } });
    const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm:*' }], behavior: 'allow', destination: 'localSettings' }];
    const r2 = await callTool(q, 'Bash', { command: 'npm test' }, { toolUseID: 'tu2', suggestions }).promise;
    assert.deepEqual(r2, { behavior: 'allow', updatedInput: { command: 'npm test' } }, 'no updatedPermissions');
    assert.deepEqual(sink.asks[0].options.map((o) => o.optionId), ['allow-once', 'allow-always', 'reject']);
    assert.equal(sink.asks[0].title, 'Run `npm test`?');
    await session.close();
  });

  it('denies with the message, and cancel becomes deny + interrupt', async () => {
    const answers = [{ behavior: 'deny', message: 'Not that file.' }, { behavior: 'cancel' }];
    const { session, q } = await startSession(async () => answers.shift());
    assert.deepEqual(await callTool(q, 'Write', { file_path: 'x' }).promise, { behavior: 'deny', message: 'Not that file.' });
    const cancelled = await callTool(q, 'Write', { file_path: 'y' }, { toolUseID: 'tu2' }).promise;
    assert.equal(cancelled.behavior, 'deny');
    assert.equal(cancelled.interrupt, true);
    await session.close();
  });

  it('is idempotent per tool-use id', async () => {
    let release;
    const { session, q, sink } = await startSession(() => new Promise((resolve) => {
      release = resolve;
    }));
    const a = callTool(q, 'Write', { file_path: 'x' });
    const b = callTool(q, 'Write', { file_path: 'x' });
    await settle();
    assert.equal(sink.asks.length, 1, 're-delivery does not open a second request');
    assert.equal(session.state, 'requires_action');
    release({ behavior: 'allow' });
    const [ra, rb] = await Promise.all([a.promise, b.promise]);
    assert.deepEqual(ra, rb);
    // A re-delivery after the answer gets the same answer without asking again.
    assert.deepEqual(await callTool(q, 'Write', { file_path: 'x' }).promise, ra);
    assert.equal(sink.asks.length, 1);
    assert.equal(session.state, 'idle');
    await session.close();
  });

  it('resolves (deny) when the signal aborts or the session closes', async () => {
    const { session, q } = await startSession(() => new Promise(() => {}));
    const aborted = callTool(q, 'Write', { file_path: 'x' });
    aborted.controller.abort();
    assert.deepEqual(await aborted.promise, { behavior: 'deny', message: 'The request was cancelled.', interrupt: true });
    const open = callTool(q, 'Write', { file_path: 'y' }, { toolUseID: 'tu2' });
    await settle();
    await session.close();
    const res = await open.promise;
    assert.equal(res.behavior, 'deny');
    assert.equal(res.interrupt, true);
    // After close, new requests are denied at once.
    assert.equal((await callTool(q, 'Write', { file_path: 'z' }, { toolUseID: 'tu3' }).promise).behavior, 'deny');
  });

  it('maps AskUserQuestion to a question and passes the answers back', async () => {
    const questions = [{ question: 'Which region?', header: 'Region', options: [{ label: 'UK' }, { label: 'US' }], multiSelect: false }];
    const { session, q, sink } = await startSession(async () => ({ behavior: 'allow', answers: { 'Which region?': 'UK' } }));
    const res = await callTool(q, 'AskUserQuestion', { questions }).promise;
    assert.deepEqual(res, { behavior: 'allow', updatedInput: { questions, answers: { 'Which region?': 'UK' } } });
    const req = sink.asks[0];
    assert.equal(req.kind, 'question');
    assert.equal(req.title, 'Which region?');
    assert.deepEqual(req.questions, questions);
    assert.equal(req.subject.type, 'question');
    assert.deepEqual(req.options, []);
    await session.close();
  });

  it('toPermissionResult maps a free-text question reply and a declined question', () => {
    const input = { questions: [{ question: 'Q?' }] };
    assert.deepEqual(toPermissionResult({ behavior: 'allow', message: 'Use your judgement' }, { toolName: 'AskUserQuestion', input }), {
      behavior: 'allow', updatedInput: { questions: input.questions, response: 'Use your judgement' },
    });
    assert.deepEqual(toPermissionResult({ behavior: 'deny' }, { toolName: 'AskUserQuestion', input }), { behavior: 'deny', message: 'The user declined to answer.' });
    assert.equal(toPermissionResult(undefined, { toolName: 'Write', input: {} }).behavior, 'deny');
  });
});

describe('send and turn', () => {
  it('maps deliveries to priorities and reports what happened', async () => {
    const { session, q } = await startSession();
    const turn = session.turn('long task');
    await settle();
    assert.equal(q.inputs[0].priority, undefined, 'a turn on an idle session has no priority');
    const steer = await session.send('steer me', 'steer');
    const queue = await session.send('queue me', 'queue');
    await settle();
    assert.equal(q.inputs[1].priority, 'next');
    assert.equal(q.inputs[2].priority, 'later');
    assert.equal(steer.status, 'applied');
    assert.match(steer.reason, /running turn/);
    assert.match(queue.reason, /after the current turn/);
    for (const m of q.inputs) {
      assert.equal(m.type, 'user');
      assert.equal(m.parent_tool_use_id, null);
      assert.match(m.uuid, /^[0-9a-f-]{36}$/);
    }
    // The running turn's result also consumed the steer (folded in); the queued one runs next.
    q.emit(result([q.inputs[0].uuid, q.inputs[1].uuid], { queued_turn_count: 1 }));
    const r = await turn;
    assert.equal(r.ok, true);
    assert.equal(session.state, 'running', 'the queued message is still outstanding');
    q.emit(result([q.inputs[2].uuid]));
    await settle();
    assert.equal(session.state, 'idle');

    // interrupt delivery: interrupt first, then push without priority.
    const t2 = session.turn('another');
    await settle();
    const ack = await session.send('stop and do this', 'interrupt');
    assert.equal(q.interrupts, 1);
    assert.match(ack.reason, /Interrupted/);
    await settle();
    assert.equal(q.inputs.at(-1).priority, undefined);
    q.emit(result([q.inputs.at(-2).uuid], { subtype: 'error_during_execution', is_error: true }));
    assert.equal((await t2).stopReason, 'cancelled');
    await session.close();
  });

  it('downgrades steer to queue while an approval is pending, and says so', async () => {
    const { session, q } = await startSession(() => new Promise(() => {}));
    session.turn('task');
    await settle();
    q.options.canUseTool('Write', { file_path: 'x' }, { signal: new AbortController().signal, toolUseID: 'tu1', requestId: 'r1' });
    await settle();
    assert.equal(session.state, 'requires_action');
    const ack = await session.send('change course', 'steer');
    await settle();
    assert.equal(ack.status, 'applied');
    assert.match(ack.reason, /approval is pending/);
    assert.equal(q.inputs.at(-1).priority, 'later');
    await session.close();
  });

  it('serialises concurrent turns and resolves each at its own result', async () => {
    const { session, q } = await startSession();
    const t1 = session.turn('first');
    const t2 = session.turn('second');
    await settle();
    assert.equal(q.inputs.length, 1, 'the second turn waits for the first');
    q.emit(result([q.inputs[0].uuid], { result: 'one' }));
    assert.equal((await t1).text, 'one');
    await settle();
    assert.equal(q.inputs.length, 2);
    assert.equal(q.inputs[1].message.content, 'second');
    q.emit(result([q.inputs[1].uuid], { result: 'two' }));
    assert.equal((await t2).text, 'two');
    await session.close();
  });

  it('falls back to push order when results do not echo uuids', async () => {
    const { session, q } = await startSession();
    const t1 = session.turn('first');
    await settle();
    q.emit(result(undefined, { result: 'one' }));
    assert.equal((await t1).text, 'one');
    assert.equal(session.state, 'idle');
    await session.close();
  });

  it('rejects sends after close, settles pending turns, and backend.close closes every session', async () => {
    const { backend, session } = await startSession();
    const pending = session.turn('never answered');
    await settle();
    await backend.close();
    const res = await pending;
    assert.equal(res.ok, false);
    assert.equal(res.stopReason, 'cancelled');
    assert.equal(session.state, 'closed');
    assert.equal((await session.send('hi', 'steer')).status, 'rejected');
    assert.equal((await session.turn('again')).stopReason, 'cancelled');
    assert.equal((await session.send('x', 'bogus')).status, 'rejected');
  });
});

describe('PreToolUse precheck', () => {
  const hookOf = (q) => {
    const matchers = q.options.hooks?.PreToolUse;
    assert.equal(matchers.length, 1);
    assert.equal(matchers[0].matcher, undefined, 'runs for every tool');
    return matchers[0].hooks[0];
  };
  const hookInput = (extra = {}) => ({
    hook_event_name: 'PreToolUse',
    session_id: 's',
    transcript_path: '/t',
    cwd: `${HOME}/project`,
    tool_name: 'Read',
    tool_input: { file_path: `${HOME}/project/secrets/notes.md` },
    tool_use_id: 'tu1',
    ...extra,
  });

  it('blocks a denied call with the reason and the same subject as canUseTool', async () => {
    const { session, q, sink } = await startSession();
    const seen = [];
    sink.precheck = (subject) => {
      seen.push(subject);
      return { effect: 'deny', reason: 'secrets/ is not readable' };
    };
    const out = await hookOf(q)(hookInput(), 'tu1', { signal: new AbortController().signal });
    assert.deepEqual(out, {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Not allowed for your role: secrets/ is not readable',
      },
    });
    assert.deepEqual(seen, [describeTool('Read', { file_path: `${HOME}/project/secrets/notes.md` }, { cwd: `${HOME}/project`, home: HOME }).subject]);
    assert.equal(seen[0].path, 'secrets/notes.md');
    await session.close();
  });

  it('returns no decision for allow, undefined, or no precheck', async () => {
    const { session, q, sink } = await startSession();
    const hook = hookOf(q);
    const opts = { signal: new AbortController().signal };
    assert.deepEqual(await hook(hookInput(), 'tu1', opts), {}, 'no precheck on the sink');
    const verdicts = [
      () => ({ effect: 'allow' }),
      () => undefined,
      async () => ({ effect: 'allow' }),
      () => ({ effect: 'something-else' }),
    ];
    for (const verdict of verdicts) {
      sink.precheck = verdict;
      assert.deepEqual(await hook(hookInput(), 'tu1', opts), {});
    }
    assert.equal(sink.asks.length, 0, 'no approval is opened unless the role check says ask');
    await session.close();
  });

  it('fails closed when the role check throws or rejects', async () => {
    const { session, q, sink } = await startSession();
    const hook = hookOf(q);
    for (const verdict of [() => { throw new Error('boom'); }, async () => { throw new Error('async boom'); }]) {
      sink.precheck = verdict;
      const out = await hook(hookInput(), 'tu1', { signal: new AbortController().signal });
      assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
      assert.equal(out.hookSpecificOutput.permissionDecisionReason, 'Not allowed for your role: the role check failed.');
    }
    await session.close();
  });

  it('enforces ask through the shared registry: one question, reused by canUseTool', async () => {
    let release;
    const { session, q, sink } = await startSession(() => new Promise((resolve) => {
      release = resolve;
    }));
    sink.precheck = () => ({ effect: 'ask', reason: 'reads of secrets/ need a person' });
    const hooked = hookOf(q)(hookInput(), 'tu1', { signal: new AbortController().signal });
    await settle();
    assert.equal(sink.asks.length, 1);
    const req = sink.asks[0];
    assert.equal(req.kind, 'approval');
    assert.equal(req.title, 'Read secrets/notes.md?');
    assert.equal(req.toolCallId, 'tu1');
    assert.equal(req.description, 'reads of secrets/ need a person');
    assert.deepEqual(req.source, { backend: 'claude-code', raw: 'pre_tool_use' });
    assert.equal(session.state, 'requires_action');
    // canUseTool for the same tool use joins the pending question.
    const viaCallback = q.options.canUseTool('Read', { file_path: `${HOME}/project/secrets/notes.md` }, { signal: new AbortController().signal, toolUseID: 'tu1', requestId: 'r1' });
    await settle();
    assert.equal(sink.asks.length, 1, 'the person is asked once');
    release({ behavior: 'allow', optionId: 'allow-once' });
    const out = await hooked;
    assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Approved.' } });
    assert.equal((await viaCallback).behavior, 'allow');
    // A later canUseTool delivery for the same id reuses the answer.
    assert.equal((await q.options.canUseTool('Read', {}, { signal: new AbortController().signal, toolUseID: 'tu1', requestId: 'r2' })).behavior, 'allow');
    assert.equal(sink.asks.length, 1);
    await session.close();
  });

  it('maps an ask answered deny, or with an edited input, to the hook decision', async () => {
    const answers = [{ behavior: 'deny', message: 'Not that folder.' }, { behavior: 'allow', updatedInput: { command: 'ls -la' } }];
    const { session, q, sink } = await startSession(async () => answers.shift());
    sink.precheck = () => ({ effect: 'ask' });
    const hook = hookOf(q);
    const opts = { signal: new AbortController().signal };
    const denied = await hook(hookInput({ tool_use_id: 'tuA' }), 'tuA', opts);
    assert.deepEqual(denied.hookSpecificOutput, { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Not that folder.' });
    const edited = await hook(hookInput({ tool_use_id: 'tuB', tool_name: 'Bash', tool_input: { command: 'ls' } }), 'tuB', opts);
    assert.equal(edited.hookSpecificOutput.permissionDecision, 'allow');
    assert.deepEqual(edited.hookSpecificOutput.updatedInput, { command: 'ls -la' });
    await session.close();
  });

  it('denies a pending ask when the hook is aborted or the session closes', async () => {
    const { session, q, sink } = await startSession(() => new Promise(() => {}));
    sink.precheck = () => ({ effect: 'ask' });
    const controller = new AbortController();
    const aborted = hookOf(q)(hookInput({ tool_use_id: 'tuX' }), 'tuX', { signal: controller.signal });
    await settle();
    controller.abort();
    assert.equal((await aborted).hookSpecificOutput.permissionDecision, 'deny');
    const open = hookOf(q)(hookInput({ tool_use_id: 'tuY' }), 'tuY', { signal: new AbortController().signal });
    await settle();
    await session.close();
    assert.equal((await open).hookSpecificOutput.permissionDecision, 'deny');
  });

  it('registers the hook with a long timeout and fail-closed onFailure', async () => {
    const { session, q } = await startSession();
    const [matcher] = q.options.hooks.PreToolUse;
    assert.ok(matcher.timeout >= 3600, 'hours, for human waits');
    assert.equal(matcher.onFailure, 'block');
    await session.close();
  });

  it('covers subagent tool calls and async denials', async () => {
    const { session, q, sink } = await startSession();
    const seen = [];
    sink.precheck = async (subject) => {
      seen.push(subject);
      return { effect: 'deny' };
    };
    const out = await hookOf(q)(hookInput({ agent_id: 'sub-1', agent_type: 'general-purpose', tool_name: 'Bash', tool_input: { command: 'ls' } }), 'tu2', { signal: new AbortController().signal });
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /^Not allowed for your role: /);
    assert.deepEqual(seen[0], { type: 'command', tool: 'Bash', command: 'ls', input: { command: 'ls' } });
    await session.close();
  });

  it('passes allowedTools and strictMcpConfig through from the compiled role', async () => {
    const compiled = { claude: { ...spec().compiled.claude, allowedTools: ['Read'], strictMcpConfig: false } };
    const { session, q } = await startSession(undefined, { compiled });
    assert.deepEqual(q.options.allowedTools, ['Read']);
    assert.equal(q.options.strictMcpConfig, false);
    await session.close();
  });
});
