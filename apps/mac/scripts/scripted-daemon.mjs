#!/usr/bin/env node
// A MAS Office daemon for checks and UI work: the REAL server and runtime with SCRIPTED fake backends, so no
// real Claude Code or Codex session starts and no subscription is used. Prints the same one-line handshake as
// `mas-office up --json` on stdout and exits when its stdin closes.
//
//   node scripted-daemon.mjs                     a fresh workspace with a locked team ("deals"), runtime attached
//   node scripted-daemon.mjs --fixture <dir>     serve a copy of a workspace (e.g. the panel's mock-supervise
//                                                fixture) without a runtime, for renders
//
// The scripted run: the Lead plans; finder-a searches; finder-b asks to use web search (a pending approval)
// and, once allowed, waits for a steering message before it writes its work; the checker accepts both and
// verifies the claims; the Lead writes an answer with two <claim> tags. No network: URL checks are off.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from 'mas-office/server';
import { updateProjectsIndex } from 'mas-office';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..', '..');
const { createRuntime } = await import(path.join(repo, 'packages/runtime/src/index.js'));
const { TEAM, workspaceWith, fakeBackends, write, card, json, OPTIONS, sleep } = await import(path.join(repo, 'packages/runtime/test/helpers.js'));

const args = process.argv.slice(2);
const fixture = args.includes('--fixture') ? path.resolve(args[args.indexOf('--fixture') + 1]) : null;
const say = (line) => process.stderr.write(`${line}\n`);

const ANSWER = `## Shortlist

<claim id="c1" src="currys-xm6">Currys sells the XM6 new for £279.</claim>
<claim id="c2" src="ebay-xm6">eBay has a refurbished unit for £199.</claim>

We suggest the Currys offer.`;

let server;
let runtime = null;
if (fixture) {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mas-fixture-')));
  fs.cpSync(fixture, ws, { recursive: true });
  server = await startServer({ workspace: ws, port: 0 });
  say(`Serving a copy of ${fixture} at ${server.url} (no runtime)`);
} else {
  const { ws, project } = workspaceWith(TEAM);
  updateProjectsIndex(ws, { folder: project, title: TEAM.title, step: 4, phase: 'locked' });
  let fakes;
  const steered = () => fakes.record.sent.some((m) => m.agentId === 'finder-b');
  const script = async ({ agentId, text, sink, spec }) => {
    sink.transcript?.({ ts: new Date().toISOString(), kind: 'assistant', text: `${agentId} is on it.` });
    if (agentId === 'lead') {
      if (text.includes('Write one brief per role')) {
        return `Plan.${json({ plan: ['Search', 'Check'], briefs: { 'finder-a': 'Search Currys and Argos.', 'finder-b': 'Search eBay.', checker: 'Check each offer.' } })}`;
      }
      if (text.includes('asks a follow-up')) return json({ answerFromFiles: 'Currys is still the best offer.' });
      write(spec.cwd, 'outputs/result.md', ANSWER);
      return `Written.${json({ title: 'Headphone shortlist', satisfied: true, next: 'Buy from Currys.', open: [] })}`;
    }
    if (agentId === 'checker') {
      if (text.includes('Check its claims one by one')) {
        return json({ reviews: [], claims: [
          { claimId: 'c1', status: 'supported', sourceId: 'currys-xm6', relationship: 'supports' },
          { claimId: 'c2', status: 'supported', sourceId: 'ebay-xm6', relationship: 'supports' },
        ] });
      }
      write(spec.cwd, 'outputs/work/checker.md', '# Checked\nBoth offers are real.');
      const targets = [...text.matchAll(/outputs\/work\/(finder-[ab])\.md/g)].map((m) => m[1]);
      return json({ reviews: [...new Set(targets)].map((target) => ({ target, verdict: 'accept' })), claims: [] });
    }
    if (agentId === 'finder-b') {
      sink.transcript?.({ ts: new Date().toISOString(), kind: 'tool_call', callId: 'call_1', tool: 'WebSearch', summary: 'sony xm6 ebay', input: { query: 'sony xm6 ebay' } });
      const res = await sink.ask({
        kind: 'approval', title: 'Search the web for "sony xm6 ebay"?', subject: { type: 'tool_call', tool: 'WebSearch', input: { query: 'sony xm6 ebay' } },
        toolCallId: 'call_1', options: OPTIONS, source: { backend: 'claude-code', raw: 'can_use_tool' },
      });
      sink.transcript?.({ ts: new Date().toISOString(), kind: 'tool_result', callId: 'call_1', ok: res.behavior === 'allow', summary: res.behavior });
      // Wait (bounded) for the person's steering message before writing the work.
      for (let i = 0; i < 600 && !steered(); i++) await sleep(50);
    }
    const slug = agentId === 'finder-a' ? 'currys-xm6' : 'ebay-xm6';
    const file = /Write your work to (\S+)\./.exec(text)?.[1] ?? `outputs/work/${agentId}.md`;
    write(spec.cwd, file, `# ${agentId}\nFound an offer [${slug}].`);
    write(spec.cwd, `sources/${slug}.md`, card({ title: slug, url: `https://example.com/${slug}`, by: agentId }));
    return `Looked around.\nDONE: Found one offer at ${slug}`;
  };
  fakes = fakeBackends(script);
  server = await startServer({ workspace: ws, port: 0 });
  runtime = createRuntime({ workspace: ws, server, backends: fakes.backends, probes: { 'claude-code': { available: true, loggedIn: true, version: 'scripted' }, codex: { available: true, loggedIn: true, version: 'scripted' } }, options: { maxParallel: 2, verifyNetwork: false, tickMs: 20 } });
  server.attach(runtime);
  say(`Scripted daemon for ${ws} at ${server.url} (fake backends, no real sessions)`);
}

process.stdout.write(`${JSON.stringify({
  url: server.url, port: server.port, token: server.token,
  backends: runtime ? runtime.info().backends : {}, maxParallel: runtime ? runtime.info().maxParallel : 3,
})}\n`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await runtime?.close().catch(() => {});
  await server.close();
  say('stdin closed: stopped');
  process.exit(0);
};
process.stdin.on('end', stop);
process.stdin.on('close', stop);
process.on('SIGTERM', stop);
process.stdin.resume();
