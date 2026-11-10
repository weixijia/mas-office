#!/usr/bin/env node
// Smoke test for the Codex backend against the user's installed, signed-in `codex`.
//
//   node packages/runtime/scripts/smoke-codex.mjs [--dir <empty work dir>] [--model <id>] [--steps abcde]
//
// Runs about five short turns in a fresh folder outside the repository (`--steps` picks a subset):
//   a) a write needs approval → allowed → out.txt exists
//   b) a write needs approval → declined → forbidden.txt absent
//   c) steer during a running turn, then steer with no running turn
//   d) a new backend resumes the thread and remembers out.txt
// It never logs in: when `probe()` says signed out, it stops.

import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createCodexBackend } from '../src/backends/codex.js';

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };

const notifications = new Set();
const serverRequests = new Set();
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

/** Real spawn, plus a read-only tap on stdout that records the method names Codex sends. */
function tappedSpawn(command, args, opts) {
  const child = nodeSpawn(command, args, opts);
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      try {
        const message = JSON.parse(line);
        if (typeof message.method === 'string') (message.id !== undefined ? serverRequests : notifications).add(message.method);
      } catch { /* not JSON */ }
    }
  });
  return child;
}

const events = [];
const asks = [];
let askPolicy = () => ({ behavior: 'cancel' });
const sink = {
  event(type, data) { events.push({ type, data, at: Date.now() }); },
  transcript(entry) {
    if (entry.kind === 'system') console.log(`  [${elapsed()}] system: ${entry.text}`);
  },
  async ask(request) {
    const answer = askPolicy(request);
    asks.push({ request, answer });
    console.log(`  [${elapsed()}] ask ${request.source.raw}: ${request.title} → ${answer.behavior}${answer.optionId ? `/${answer.optionId}` : ''}`);
    return answer;
  },
  resolvedElsewhere(toolCallId) { console.log(`  [${elapsed()}] resolved elsewhere: ${toolCallId}`); },
};

const rows = [];
const record = (name, pass, detail) => { rows.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}: ${detail}`); };

const waitFor = async (predicate, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

async function main() {
  const dir = flag('--dir') ?? path.join(os.tmpdir(), `smoke-codex-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  if (readdirSync(dir).length) throw new Error(`${dir} is not empty`);
  nodeSpawn('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 300));
  console.log(`work dir: ${dir}`);

  let backend = createCodexBackend({ spawn: tappedSpawn, interruptTimeoutMs: 60_000 });
  const tProbe = Date.now();
  const probe = await backend.probe();
  console.log(`probe (${Date.now() - tProbe} ms): ${JSON.stringify(probe)}`);
  if (!probe.available || !probe.loggedIn) {
    console.log('Codex is not available or not signed in; stopping (run `codex login` yourself).');
    await backend.close();
    process.exitCode = 2;
    return;
  }

  let model = flag('--model');
  if (!model) {
    try {
      const list = await backend.server.peer.request('model/list', {});
      const ids = (list?.data ?? []).map((m) => m.id);
      model = ids.find((id) => /luna/.test(id)) ?? ids.find((id) => /mini/.test(id));
    } catch { /* use the default model */ }
  }
  console.log(`model: ${model ?? '(default)'}`);

  const spec = {
    agentId: 'smoke',
    cwd: dir,
    systemPrompt: 'You are a terse test agent. Do exactly what the user asks and nothing more. Keep answers to one line.',
    compiled: { codex: { approvalPolicy: 'on-request', sandbox: 'read-only', networkAccess: false, writableRoots: [] } },
    ...(model ? { model } : {}),
  };
  const tStart = Date.now();
  let session = await backend.start(spec, sink);
  console.log(`thread ${session.id} started in ${Date.now() - tStart} ms`);
  const threadId = session.id;

  const steps = flag('--steps') ?? 'abcde';
  let result;
  let mark;

  // (a) allowed write
  if (steps.includes('a')) {
    askPolicy = (request) => (request.kind === 'approval' ? { behavior: 'allow', optionId: request.options.find((o) => o.kind === 'allow_once')?.optionId } : { behavior: 'cancel' });
    mark = asks.length;
    result = await session.turn('Create a file named out.txt in the current folder containing the single word OK. Then reply DONE.');
    const outOk = existsSync(path.join(dir, 'out.txt')) && readFileSync(path.join(dir, 'out.txt'), 'utf8').trim() === 'OK';
    record('a) approval asked, allowed, out.txt written', asks.length > mark && outOk,
      `asks=${asks.slice(mark).map((a) => a.request.source.raw).join(',') || 'none'} file=${outOk} stop=${result.stopReason} text=${JSON.stringify(result.text.slice(0, 80))}`);
  }

  // (b) declined write
  if (steps.includes('b')) {
    askPolicy = (request) => (request.kind === 'approval' ? { behavior: 'deny', optionId: 'decline' } : { behavior: 'cancel' });
    mark = asks.length;
    const toolMark = events.length;
    result = await session.turn('Create a file named forbidden.txt in the current folder containing the single word NO. Then reply DONE.');
    const forbidden = existsSync(path.join(dir, 'forbidden.txt'));
    const failed = events.slice(toolMark).filter((e) => e.type === 'tool.failed').map((e) => e.data.error);
    record('b) approval asked, declined, forbidden.txt absent', asks.length > mark && !forbidden,
      `asks=${asks.slice(mark).map((a) => a.request.source.raw).join(',') || 'none'} file=${forbidden} toolFailed=${JSON.stringify(failed)} stop=${result.stopReason} text=${JSON.stringify(result.text.slice(0, 80))}`);
  }

  if (!steps.includes('c')) { /* skip steering */ } else {
  // (c1) steer while a turn runs
  askPolicy = () => ({ behavior: 'deny', optionId: 'decline' });
  const workingMark = events.length;
  const running = session.turn('Think about the number 7 and write a four-line poem about it. Do not use any tools.');
  await waitFor(() => events.slice(workingMark).some((e) => e.type === 'agent.status' && e.data?.state === 'working'), 30_000);
  const steer = await session.send('Also end your reply with the exact word STEERED.', 'steer');
  result = await running;
  record('c1) steer during a running turn', steer.status === 'applied',
    `ack=${steer.status} reason="${steer.reason}" stateAfter=${session.state} replyHasSTEERED=${/STEERED/.test(result.text)}`);

  // (c2) steer with no running turn → falls back to turn/start
  const idleMark = events.length;
  const idleSteer = await session.send('Reply with the single word PONG.', 'steer');
  await waitFor(() => events.slice(idleMark).some((e) => (e.type === 'agent.status' && e.data?.state === 'idle') || e.type === 'agent.stopped'), 120_000);
  const pong = events.slice(idleMark).filter((e) => e.type === 'message').map((e) => e.data.text).join(' ');
  record('c2) steer with no running turn starts a new turn', idleSteer.status === 'applied' && /no active turn/.test(idleSteer.reason ?? ''),
    `ack=${idleSteer.status} reason="${idleSteer.reason}" reply=${JSON.stringify(pong.slice(0, 40))}`);
  }

  // (e) the compiled role shape (packages/node/src/team/compile.js codexOptions): an allowed
  // apply_patch file change must be written under the read-only sandbox; MCP servers from the
  // user's Codex config must be off for the thread.
  if (steps.includes('e')) {
    const entries = [];
    const roleSink = { ...sink, transcript(entry) { entries.push(entry); sink.transcript(entry); } };
    const compiled = {
      codex: {
        approvalPolicy: 'on-request', sandbox: 'read-only', networkAccess: false, writableRoots: [],
        sandboxPolicy: { type: 'readOnly', networkAccess: false, access: { type: 'restricted', includePlatformDefaults: true, readableRoots: [dir] } },
        config: { web_search: 'disabled', mcp_servers: {} },
      },
    };
    const tRole = Date.now();
    const role = await backend.start({ ...spec, compiled }, roleSink);
    const roleStartMs = Date.now() - tRole;
    askPolicy = (request) => (request.kind === 'approval' ? { behavior: 'allow', optionId: 'accept' } : { behavior: 'cancel' });
    mark = asks.length;
    result = await role.turn('Use the apply_patch tool (not a shell command) to create notes.md containing the single line HELLO. Then reply DONE.');
    const notes = existsSync(path.join(dir, 'notes.md')) ? readFileSync(path.join(dir, 'notes.md'), 'utf8').trim() : null;
    const kinds = asks.slice(mark).map((a) => a.request.source.raw);
    record('e) compiled role: allowed file change is written under read-only', kinds.includes('item/fileChange/requestApproval') && notes === 'HELLO',
      `asks=${kinds.join(',') || 'none'} notes.md=${JSON.stringify(notes)} startMs=${roleStartMs} stop=${result.stopReason}`);
    const listed = await backend.server.peer.request('mcpServerStatus/list', { detail: 'toolsAndAuthOnly', threadId: role.id });
    const live = (listed.data ?? []).filter((s) => s.runtimeStatus !== 'disabled').map((s) => `${s.name}:${s.runtimeStatus}`);
    record('e) MCP servers from the user config are off for the role', live.length === 0, `still loaded: ${live.join(' ') || 'none'}`);
    for (const entry of entries.filter((e) => e.kind === 'system')) console.log(`  role note: ${entry.text}`);
  }

  // (d) resume in a fresh backend
  await backend.close();
  if (steps.includes('d')) {
    backend = createCodexBackend({ spawn: tappedSpawn });
    const tResume = Date.now();
    session = await backend.start({ ...spec, resume: threadId }, sink);
    const resumeMs = Date.now() - tResume;
    result = await session.turn('Which file did you create first in this conversation? Answer with just the file name.');
    record('d) resume keeps context', session.id === threadId && /out\.txt/.test(result.text),
      `sameThread=${session.id === threadId} resumeMs=${resumeMs} text=${JSON.stringify(result.text.slice(0, 80))}`);
    await backend.close();
  }

  const usage = events.filter((e) => e.type === 'usage').reduce((acc, e) => ({ ...acc, ...e.data }), {});
  console.log('\n| Check | Result | Detail |\n|---|---|---|');
  for (const row of rows) console.log(`| ${row.name} | ${row.pass ? 'PASS' : 'FAIL'} | ${row.detail.replace(/\|/g, '/')} |`);
  console.log(`\nnotifications seen: ${[...notifications].sort().join(', ')}`);
  console.log(`server requests seen: ${[...serverRequests].sort().join(', ') || 'none'}`);
  console.log(`event types emitted: ${[...new Set(events.map((e) => e.type))].join(', ')}`);
  console.log(`usage (merged): ${JSON.stringify(usage)}`);
  console.log(`total ${elapsed()}`);
  if (rows.some((r) => !r.pass)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`smoke test error: ${error.stack ?? error}`);
  console.log(`notifications seen: ${[...notifications].sort().join(', ')}`);
  console.log(`server requests seen: ${[...serverRequests].sort().join(', ') || 'none'}`);
  process.exitCode = 1;
});
