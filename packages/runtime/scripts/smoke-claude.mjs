#!/usr/bin/env node
// Real smoke test for the Claude Code backend (S0 exit criterion).
//
// Runs against the user's installed and signed-in `claude`, in a fresh temporary
// folder outside any repository so no project CLAUDE.md is loaded. Four short turns
// on the cheapest model alias:
//   a) write out.txt         -> a Write approval is asked and allowed
//   b) write forbidden.txt   -> the approval is denied, the file must not exist
//   c) steer during a turn   -> the ack reason is reported, STEERED lands in out.txt
//   d) close, resume         -> the resumed session remembers out.txt
//
// Usage: node packages/runtime/scripts/smoke-claude.mjs [--dir <parent>] [--model <alias>]

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createClaudeBackend } from '../src/backends/claude.js';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};
const parent = flag('--dir', process.env.MAS_SMOKE_DIR || os.tmpdir());
const model = flag('--model', 'haiku');
const dir = path.join(parent, `smoke-claude-${randomBytes(4).toString('hex')}`);
mkdirSync(dir, { recursive: true });

const rows = [];
const check = (name, pass, note = '') => rows.push({ name, pass: Boolean(pass), note });
const eventTypes = new Map();
const events = [];
const asks = [];
const t0 = Date.now();
let registeredAt = null;
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

const sink = {
  event(type, data) {
    if (type === 'agent.registered' && registeredAt === null) registeredAt = Date.now();
    eventTypes.set(type, (eventTypes.get(type) ?? 0) + 1);
    events.push({ type, data });
    if (process.env.MAS_SMOKE_VERBOSE) console.log(elapsed(), 'event', type, JSON.stringify(data));
  },
  transcript(entry) {
    if (process.env.MAS_SMOKE_VERBOSE) console.log(elapsed(), 'transcript', entry.kind, JSON.stringify(entry).slice(0, 200));
  },
  async ask(request) {
    const deny = String(request.subject?.path ?? '').includes('forbidden');
    asks.push({ title: request.title, tool: request.subject?.tool, path: request.subject?.path, decision: deny ? 'deny' : 'allow' });
    console.log(elapsed(), `ask: ${request.title} -> ${deny ? 'deny' : 'allow'}`);
    return deny
      ? { behavior: 'deny', message: 'The supervisor refused this file.' }
      : { behavior: 'allow', optionId: 'allow-once' };
  },
};

const spec = {
  agentId: 'smoke',
  cwd: dir,
  systemPrompt:
    'You are a terse test agent. Do exactly what is asked and nothing else. Use relative file paths. ' +
    'If a tool call is refused, say so in one sentence and do not retry.',
  compiled: {
    claude: { tools: ['Write', 'Read'], disallowedTools: [], mcpServers: {}, permissionMode: 'default', settingSources: [] },
  },
  model,
};

const read = (file) => (existsSync(path.join(dir, file)) ? readFileSync(path.join(dir, file), 'utf8') : null);
const waitIdle = async (session, ms) => {
  const until = Date.now() + ms;
  while (session.state !== 'idle' && session.state !== 'closed' && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 250));
  }
  return session.state;
};

// Tap the SDK stream (read-only) to report raw message types and whether results echo
// the uuids of the user messages the adapter sent.
const { query: sdkQuery } = await import('@anthropic-ai/claude-agent-sdk');
const rawTypes = new Map();
const sentUuids = new Set();
let echoedResults = 0;
let results = 0;
const tappedQuery = (params) => {
  const prompt = params.prompt;
  const tappedPrompt = {
    async *[Symbol.asyncIterator]() {
      for await (const m of prompt) {
        if (m?.uuid) sentUuids.add(m.uuid);
        yield m;
      }
    },
  };
  const q = sdkQuery({ ...params, prompt: tappedPrompt });
  const note = (m) => {
    const key = m.subtype ? `${m.type}/${m.subtype}` : m.type;
    rawTypes.set(key, (rawTypes.get(key) ?? 0) + 1);
    if (m.type === 'result') {
      results += 1;
      const echoed = (m.user_message_uuids ?? [m.user_message_uuid]).filter((u) => sentUuids.has(u));
      if (echoed.length) echoedResults += 1;
      if (process.env.MAS_SMOKE_VERBOSE) {
        console.log(elapsed(), 'raw result', JSON.stringify({ subtype: m.subtype, is_error: m.is_error, stop_reason: m.stop_reason, terminal_reason: m.terminal_reason, queued_turn_count: m.queued_turn_count, echoed: echoed.length, uuids: m.user_message_uuids?.length }));
      }
    }
  };
  return new Proxy(q, {
    get(target, prop) {
      if (prop === Symbol.asyncIterator) {
        return () => {
          const it = target[Symbol.asyncIterator]();
          return {
            async next() {
              const r = await it.next();
              if (!r.done && r.value) note(r.value);
              return r;
            },
            return: (v) => (it.return ? it.return(v) : Promise.resolve({ value: v, done: true })),
          };
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
};

const backend = createClaudeBackend({ query: tappedQuery });
let session;
let exitCode = 0;
try {
  const probe = await backend.probe();
  console.log('probe:', JSON.stringify(probe));
  check('probe: installed and signed in', probe.available && probe.loggedIn, `${probe.version ?? '?'}; ${probe.detail ?? ''}`);
  if (!probe.available || !probe.loggedIn) throw new Error('Claude Code is not available or not signed in.');
  console.log('workdir:', dir);

  // a) allowed write
  const startAt = Date.now();
  session = await backend.start(spec, sink);
  const r1 = await session.turn('Write the single word OK to the file out.txt');
  const turn1At = Date.now();
  check('session id known', typeof session.id === 'string' && session.id.length > 0, session.id);
  check('startup: agent.registered latency', registeredAt !== null, registeredAt ? `${((registeredAt - startAt) / 1000).toFixed(1)}s to init, ${((turn1At - startAt) / 1000).toFixed(1)}s to first result` : 'no init');
  const writeAsk = asks.find((a) => a.tool === 'Write' && String(a.path).includes('out.txt'));
  check('a) canUseTool fired for Write out.txt', writeAsk, writeAsk?.title ?? `asks: ${JSON.stringify(asks)}`);
  check('a) turn ok and out.txt written', r1.ok && /OK/.test(read('out.txt') ?? ''), `stop=${r1.stopReason} file=${JSON.stringify(read('out.txt'))}`);

  // b) denied write
  const r2 = await session.turn('Now write the word NO to the file forbidden.txt');
  const denyAsk = asks.find((a) => String(a.path).includes('forbidden'));
  check('b) canUseTool fired for forbidden.txt and was denied', denyAsk?.decision === 'deny', denyAsk?.title ?? 'no ask');
  check('b) forbidden.txt does not exist', read('forbidden.txt') === null);
  check('b) model reports it could not', /(could ?n.?t|cannot|can't|unable|denied|refused|not (allowed|permitted|able))/i.test(r2.text), JSON.stringify(r2.text.slice(0, 160)));

  // c) steer during a running turn
  const turn3 = session.turn('Read out.txt, then write a three-line haiku about the word OK to the file haiku.txt.');
  await new Promise((r) => setTimeout(r, 1500));
  const stateAtSteer = session.state;
  const ack = await session.send('Also rewrite out.txt so it contains exactly: OK STEERED', 'steer');
  console.log(elapsed(), 'steer ack:', JSON.stringify(ack), 'state at steer:', stateAtSteer);
  const r3 = await turn3;
  const finalState = await waitIdle(session, 90000);
  check('c) steer acked applied', ack.status === 'applied', `${ack.reason} (state at send: ${stateAtSteer})`);
  check('c) STEERED reached out.txt', /STEERED/.test(read('out.txt') ?? ''), `turn3 stop=${r3.stopReason}; final state=${finalState}; out.txt=${JSON.stringify(read('out.txt'))}`);
  const writeAsks = asks.filter((a) => a.tool === 'Write').length;
  check('canUseTool fired for every Write', writeAsks >= 3, `${writeAsks} Write asks: ${asks.map((a) => a.path).join(', ')}`);

  // d) close and resume
  const firstId = session.id;
  await session.close();
  check('close: state closed', session.state === 'closed');
  session = await backend.start({ ...spec, resume: firstId }, sink);
  const r4 = await session.turn('What was the first file you wrote in this conversation? Answer with just the file name.');
  check('d) resume kept context', /out\.txt/.test(r4.text), JSON.stringify(r4.text.slice(0, 120)));
  check('d) resumed session id', session.id === firstId, session.id);
} catch (err) {
  check('run completed without exception', false, String(err?.stack ?? err).slice(0, 400));
} finally {
  await backend.close();
}

const width = Math.max(...rows.map((r) => r.name.length));
console.log('\nRESULT  CHECK'.padEnd(width + 10) + 'NOTE');
for (const r of rows) {
  if (!r.pass) exitCode = 1;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}    ${r.name.padEnd(width)}  ${r.note}`);
}
console.log('\nevent types seen:', [...eventTypes].map(([t, n]) => `${t}×${n}`).join(', '));
console.log('raw SDK message types:', [...rawTypes].map(([t, n]) => `${t}×${n}`).join(', '));
console.log(`results echoing a sent uuid: ${echoedResults}/${results}`);
console.log('asks:', JSON.stringify(asks));
console.log('total time:', elapsed());
process.exit(exitCode);
