// End-to-end check of the panel against the real server and engine, driven through the UI in headless Chrome.
//
//   node packages/runtime/scripts/panel-check.mjs [--out <dir>] [--width 1440|390] [--keep]
//
// No real sessions are started: the backends are scripted fakes (test/helpers.js), so nothing uses a subscription.
// The workspace is a temp folder outside the repo. Screenshots go to --out (default: <tmp>/mas-panel-check).
// Needs Google Chrome; Node ≥ 22 (global WebSocket).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from 'mas-office/server';
import { createRuntime } from '../src/index.js';
import { TEAM, workspaceWith, fakeBackends, write, card, json, sleep } from '../test/helpers.js';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const OUT = path.resolve(opt('--out', path.join(os.tmpdir(), 'mas-panel-check')));
const WIDTHS = opt('--width') ? [Number(opt('--width'))] : [1440, 390];
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PANEL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'panel');
fs.mkdirSync(OUT, { recursive: true });
if (!fs.existsSync(CHROME)) { console.error('Google Chrome not found at ' + CHROME + ' (set CHROME=…)'); process.exit(2); }

/* ---------- the team and its scripted sessions ---------- */
const team = structuredClone(TEAM);
team.gates = [{ id: 'g1', after: 'A', kind: 'stage', title: 'Look at the offers before checking' }, { id: 'g2', kind: 'final', title: 'Approve the answer' }];
const ANSWER = '## Shortlist\n\n| Shop | Total |\n|---|---|\n| Currys | <claim id="c1" src="currys-xm6">£279, new, free delivery</claim> |\n| eBay | <claim id="c2" src="ebay-xm6">£249 + £15 postage, sealed</claim> |\n\nWe suggest the Currys offer.';
const ANSWER2 = '## Open-box units\n\n<claim id="c3" src="ebay-openbox">An open-box XM6 on eBay costs £219.</claim> It is not new, so it fails your "new only" rule.';
const pause = () => sleep(1000 + Math.random() * 2000); // 1–3 s per turn, so the office can be watched

function script() {
  let writeups = 0;
  return async ({ agentId, text, sink, spec, turnNo }) => {
    const say = (s) => sink.event('agent.status', { state: 'working', say: s });
    const tool = (callId, name, summary, input, result, ok = true) => {
      sink.transcript({ kind: 'tool_call', callId, tool: name, summary, input });
      sink.transcript({ kind: 'tool_result', callId, ok, summary: result });
    };
    if (agentId === 'lead') {
      await sleep(800);
      if (text.includes('Write one brief per role')) return `Plan.${json({ plan: ['Finders search in parallel', 'You look at the offers', 'Checker verifies', 'Lead writes the shortlist'], briefs: { 'finder-a': 'Search Currys and Argos.', 'finder-b': 'Search eBay.', checker: 'Check each offer.' } })}`;
      if (text.includes('asks a follow-up')) return json({ dispatch: ['finder-b'], briefs: { 'finder-b': 'Look for open-box units.' }, reason: 'Needs a new search' });
      writeups += 1;
      write(spec.cwd, 'outputs/result.md', writeups === 1 ? ANSWER : ANSWER2);
      return `Written.${json({ title: 'Headphone shortlist', satisfied: true, next: 'Buy from Currys.', open: [] })}`;
    }
    if (agentId === 'checker') {
      await pause();
      if (text.includes('Check its claims one by one')) {
        const claims = /- c3 \[/.test(text)
          ? [{ claimId: 'c3', status: 'supported', sourceId: 'ebay-openbox', relationship: 'supports', note: 'Listing shows £219, open box.' }]
          : [{ claimId: 'c1', status: 'supported', sourceId: 'currys-xm6', relationship: 'supports', note: 'Price and delivery on the product page.' },
             { claimId: 'c2', status: 'partial', sourceId: 'ebay-xm6', relationship: 'supports', note: 'Price matches; "sealed" is not stated.' }];
        return json({ reviews: [], claims });
      }
      write(spec.cwd, 'outputs/work/checker.md', '# Checked\n\nBoth offers hold up.');
      const targets = [...text.matchAll(/outputs\/work\/(finder-[ab])(?:-round\d+)?\.md/g)].map((m) => m[1]);
      return json({ reviews: [...new Set(targets)].map((target) => ({ target, verdict: 'accept' })), claims: [] });
    }
    const round2 = /round2/.test(text);
    const slug = agentId === 'finder-a' ? 'currys-xm6' : round2 ? 'ebay-openbox' : 'ebay-xm6';
    const file = /Write your work to (\S+)\./.exec(text)[1];
    say(agentId === 'finder-a' ? 'Searching Currys…' : 'Searching eBay…');
    tool(`${agentId}-${turnNo}-1`, 'WebSearch', agentId === 'finder-a' ? 'currys sony xm6' : 'ebay sony xm6', { query: 'sony xm6' }, '8 results');
    if (agentId === 'finder-b' && turnNo === 1 && !round2) {
      const allowed = await sink.ask({
        kind: 'approval', title: 'Search the web for "sony xm6 ebay"?', subject: { type: 'tool_call', tool: 'WebSearch', input: { query: 'sony xm6 ebay' } },
        toolCallId: 'tool_1', options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
        source: { backend: 'codex', raw: 'item/commandExecution/requestApproval' },
      });
      if (allowed.behavior !== 'allow') return { ok: false, text: '', stopReason: 'error', error: 'search refused' };
      await sink.ask({
        kind: 'question', title: 'Question', subject: { type: 'question', tool: 'AskUserQuestion' }, options: [],
        questions: [{ question: 'New or refurbished?', header: 'Condition', options: [{ label: 'New only', description: 'Sealed units' }, { label: 'Either' }] }],
        source: { backend: 'claude-code', raw: 'can_use_tool' },
      });
    }
    if (agentId === 'finder-a' && turnNo === 1) {
      say('Reading the Currys product page…');
      return new Promise(() => {}); // keeps working until someone stops it
    }
    await pause();
    tool(`${agentId}-${turnNo}-2`, 'WebFetch', slug + ' page', { url: `https://example.com/${slug}` }, 'Page read');
    write(spec.cwd, file, `# ${agentId}\n\n| Offer | Price | Source |\n|---|---|---|\n| ${slug} | ${slug === 'currys-xm6' ? '£279' : slug === 'ebay-openbox' ? '£219' : '£249 + £15'} | [${slug}] |\n`);
    write(spec.cwd, `sources/${slug}.md`, card({ title: slug, url: `https://example.com/${slug}`, by: agentId }));
    return `Looked around.\nDONE: Found one offer at ${slug}`;
  };
}

/* ---------- Chrome over CDP ---------- */
const logs = [];
let ws, seq = 0, sessionId;
const pending = new Map();
const send = (method, params = {}, sid) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) })); });
const call = (m, p) => send(m, p, sessionId);
async function ev(expr) {
  const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result.value;
}
async function openChrome() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const url = await new Promise((resolve, reject) => { let t = ''; chrome.stderr.on('data', (d) => { t += d; const m = t.match(/DevTools listening on (ws:\/\/\S+)/); if (m) resolve(m[1]); }); chrome.once('error', reject); });
  ws = new WebSocket(url);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (e) => {
    const v = JSON.parse(e.data);
    if (v.id && pending.has(v.id)) { const p = pending.get(v.id); pending.delete(v.id); v.error ? p.reject(new Error(JSON.stringify(v.error))) : p.resolve(v.result); return; }
    if (v.method === 'Runtime.exceptionThrown') logs.push('exception: ' + (v.params.exceptionDetails.exception?.description ?? v.params.exceptionDetails.text));
    if (v.method === 'Runtime.consoleAPICalled' && v.params.type === 'error') logs.push('console.error: ' + JSON.stringify(v.params.args.map((a) => a.value ?? a.description)));
    if (v.method === 'Log.entryAdded' && v.params.entry.level === 'error' && !/Failed to load resource/.test(v.params.entry.text)) logs.push('log: ' + v.params.entry.text);
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }));
  await call('Page.enable'); await call('Runtime.enable'); await call('Log.enable');
  return { close: () => { try { ws.close(); } catch { /* closed */ } chrome.kill('SIGKILL'); fs.rmSync(profile, { recursive: true, force: true }); } };
}
const shot = async (name) => { const s = await call('Page.captureScreenshot', { format: 'png' }); const f = path.join(OUT, name + '.png'); fs.writeFileSync(f, Buffer.from(s.data, 'base64')); return f; };
async function key(k, { shift = false } = {}) {
  const special = { Enter: [13, '\r'], Escape: [27, ''] };
  const [vk, text] = special[k] ?? [k.toUpperCase().charCodeAt(0), k];
  const base = { key: k, code: special[k] ? k : 'Key' + k.toUpperCase(), windowsVirtualKeyCode: vk, modifiers: shift ? 8 : 0 };
  await call('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(text && { text, unmodifiedText: text }) });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}
// Click the middle of the element's first line box (a wrapped inline span's middle may fall between its lines).
async function click(sel) {
  const at = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getClientRects()[0] || e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()`);
  assert.ok(at, 'missing ' + sel);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await call('Input.dispatchMouseEvent', { type, x: at[0], y: at[1], button: 'left', clickCount: 1 });
}
const type = (text) => call('Input.insertText', { text });
async function until(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out: ' + what);
    await sleep(120);
  }
}
const dom = (expr, what, ms) => until(() => ev(expr), what, ms);

/* ---------- one full loop at one width ---------- */
const results = [];
async function step(label, fn) {
  const t0 = Date.now();
  try { const note = await fn(); results.push({ label, ok: true }); console.log(`  ok   ${label}${note ? ' — ' + note : ''} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); return true; }
  catch (err) { results.push({ label, ok: false }); console.log(`  FAIL ${label} — ${err.message.split('\n').slice(0, 12).join(' ').replace(/\s+/g, ' ').slice(0, 900)}`); return false; }
}

async function loop(W) {
  const H = W <= 390 ? 844 : 900, tag = String(W);
  const { ws: workspace, project } = workspaceWith(team);
  // What `mas-office init` leaves: the workspace's project list, with this project current.
  fs.writeFileSync(path.join(workspace, 'home', 'projects.json'), JSON.stringify({ current: project, projects: [{ folder: project, title: team.title }] }));
  const { backends } = fakeBackends(script());
  const server = await startServer({ workspace, port: 0, panel: PANEL });
  const runtime = createRuntime({ workspace, server, backends, options: { verifyNetwork: false } });
  server.attach(runtime);
  const snap = () => server.log(project).snapshot();
  const pendingWhere = (fn) => (snap().inbox?.pending ?? []).find(fn);
  const recentOf = (id) => (snap().inbox?.recent ?? []).find((r) => r.requestId === id);
  console.log(`\n[${tag}] workspace ${workspace}`);
  logs.length = 0;
  await call('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W <= 390 });
  await call('Page.navigate', { url: `${server.url}/office/?token=${server.token}` });
  const all = [];
  const go = async (label, fn) => { all.push(await step(`[${tag}] ${label}`, fn)); return all[all.length - 1]; };
  const blur = () => ev('document.activeElement && document.activeElement.blur()');
  // Esc closes an open claim card first, then the drawer.
  const closeDrawer = async () => { for (let i = 0; i < 3 && await ev(`document.querySelector('#drawer').classList.contains('open')`); i++) { await blur(); await key('Escape'); await sleep(250); } };
  // Phones: the inbox and the run box are further down the page; the drawer is a full-screen sheet.

  await go('task typed into "Give the team a task" starts the run', async () => {
    await dom(`!!document.querySelector('#c-run form[data-run="task"]')`, 'the task box (token + runtime + locked team)');
    assert.ok(!(await ev('location.href')).includes('token'), 'token left the address bar');
    await ev(`document.querySelector('#run-text').focus()`);
    await type('Find the best UK price for Sony WH-1000XM6 headphones, new only.');
    await click('#c-run button[type=submit]');
    await until(() => snap().state?.phase === 'running', 'server: phase running');
    await dom(`/Started/.test(document.querySelector('#c-run').textContent) || document.body.classList.contains('sdk')`, 'run receipt');
    return 'run ' + snap().state.run;
  });

  let approval;
  await go('the approval reaches the inbox with its wait clock; approved from the inbox', async () => {
    approval = await until(() => pendingWhere((r) => r.kind === 'approval' && r.agentId === 'finder-b'), 'server: approval pending');
    await dom(`!!document.querySelector('#c-inbox [data-req="${approval.requestId}"]')`, 'inbox card');
    await dom(`/^\\d+:\\d\\d$/.test((document.querySelector('.fig.waits[data-id="finder-b"] .wait text') || {}).textContent || '')`, 'office wait clock on the raised hand');
    const card = await ev(`(() => { const e = document.querySelector('#c-inbox [data-req="${approval.requestId}"]'); return { wait: !!e.querySelector('.ib-wait'), text: e.textContent }; })()`);
    assert.ok(card.wait); assert.match(card.text, /Market finder/); assert.match(card.text, /Tool: WebSearch/); assert.match(card.text, /Holds up Catch checker and Lead/);
    await ev(`document.querySelector('#c-inbox').scrollIntoView()`);
    await shot(`${tag}-1-inbox-pending`);
    await click(`#c-inbox [data-req="${approval.requestId}"] [data-opt="allow"]`);
    await until(() => recentOf(approval.requestId), 'server: approval resolved');
    const r = recentOf(approval.requestId);
    assert.deepEqual([r.outcome, r.optionId, r.by.kind], ['selected', 'allow', 'human']);
    await dom(`!document.querySelector('#c-inbox [data-req="${approval.requestId}"]')`, 'card leaves the list');
  });

  await go('the question is answered by its choice button', async () => {
    const q = await until(() => pendingWhere((r) => r.kind === 'question'), 'server: question pending');
    assert.deepEqual(q.options.map((o) => o.name), ['New only', 'Either']);
    await dom(`!!document.querySelector('#c-inbox [data-req="${q.requestId}"] [data-opt="choice-0"]')`, 'choice buttons');
    await click(`#c-inbox [data-req="${q.requestId}"] [data-opt="choice-0"]`);
    await until(() => recentOf(q.requestId), 'server: question resolved');
    assert.equal(recentOf(q.requestId).optionId, 'choice-0');
  });

  await go('a steer message to the running finder shows the adapter\'s receipt', async () => {
    await until(() => snap().statuses['finder-a']?.state === 'working', 'finder-a working');
    await ev(`document.querySelector('#c-team [data-select="finder-a"]').click()`);
    await dom(`document.querySelector('#drawer').dataset.mode === 'agent' && /Retail finder/.test(document.querySelector('.ag-name').textContent)`, 'agent drawer');
    await dom(`document.querySelectorAll('.tx-row').length >= 2`, 'transcript rows');
    await blur(); await key('Enter'); // Enter: write to the agent
    await dom(`document.activeElement && document.activeElement.id === 'cf-text'`, 'chat focused');
    await type('Prefer shops with free delivery.');
    await key('Enter');
    const cmd = await until(() => (snap().inbox?.commands ?? []).find((c) => c.type === 'command.message' && c.agentId === 'finder-a' && c.status === 'applied'), 'server: message applied');
    assert.equal(cmd.reason, 'delivered at the next break');
    const line = await dom(`(() => { const l = [...document.querySelectorAll('#cf-log li')].pop(); return l && /Applied · delivered at the next break/.test(l.textContent) && l.textContent; })()`, 'receipt in the chat log');
    await dom(`[...document.querySelectorAll('.tx-cmd')].some((r) => /Prefer shops/.test(r.textContent))`, 'message in the transcript');
    await shot(`${tag}-2-agent-drawer-chat`);
    return line;
  });

  let decision;
  await go('Stop: "Stop requested" until the status changes, then the engine asks "What now?"', async () => {
    await click('#cf-stop');
    const seen = await until(() => ev(`document.querySelector('#cf-stopstate').textContent`), 'stop state text', 3000);
    assert.match(seen, /Stop requested|Stopped/);
    decision = await until(() => pendingWhere((r) => r.kind === 'decision'), 'server: decision pending');
    assert.match(decision.title, /You stopped Retail finder\. What now\?/);
    assert.ok(snap().statuses['finder-a'].stopReason === 'cancelled' || snap().statuses['finder-a'].state !== 'working');
    await dom(`/^Stopped$/.test(document.querySelector('#cf-stopstate').textContent)`, '"Stopped" once the status changed');
    await dom(`!!document.querySelector('#dr-body .ag-wait [data-req="${decision.requestId}"]')`, 'decision card in the drawer');
    return 'first state seen: ' + seen;
  });

  await go('"Try again" from the drawer restarts the finder', async () => {
    await click(`#dr-body [data-req="${decision.requestId}"] [data-opt="retry"]`);
    await until(() => recentOf(decision.requestId), 'server: decision resolved');
    assert.equal(recentOf(decision.requestId).optionId, 'retry');
    await until(() => snap().board.tasks.some((t) => t.agentId === 'finder-a' && t.attempt >= 2), 'server: attempt 2');
    await closeDrawer();
  });

  await go('the stage gate: a note sends the stage back, then accept', async () => {
    const gate = await until(() => pendingWhere((r) => r.kind === 'gate'), 'server: stage gate', 30000);
    assert.equal(gate.title, 'Look at the offers before checking');
    await dom(`!!document.querySelector('#c-inbox [data-req="${gate.requestId}"]')`, 'gate card');
    await ev(`document.querySelector('#c-inbox [data-req="${gate.requestId}"]').scrollIntoView({ block: 'center' })`);
    const card = await ev(`document.querySelector('#c-inbox [data-req="${gate.requestId}"]').textContent`);
    assert.match(card, /Looks good, continue/); assert.match(card, /Holds up Catch checker/); assert.match(card, /Send back/);
    await shot(`${tag}-3-gate-card`);
    await ev(`document.querySelector('#c-inbox [data-req="${gate.requestId}"] form[data-reply] input').focus()`);
    await type('Also check Argos.');
    await key('Enter');
    await until(() => recentOf(gate.requestId), 'server: gate answered with a note');
    assert.deepEqual([recentOf(gate.requestId).outcome, recentOf(gate.requestId).payload], ['submitted', { text: 'Also check Argos.' }]);
    const again = await until(() => pendingWhere((r) => r.kind === 'gate' && r.requestId !== gate.requestId), 'server: the gate again after the redo', 30000);
    await dom(`!!document.querySelector('#c-inbox [data-req="${again.requestId}"] [data-opt="accept"]')`, 'second gate card');
    await click(`#c-inbox [data-req="${again.requestId}"] [data-opt="accept"]`);
    await until(() => recentOf(again.requestId), 'server: gate accepted');
    return 'redo turns: ' + snap().board.tasks.filter((t) => t.agentId.startsWith('finder') && t.attempt >= 2).length;
  });

  await go('the final gate is approved', async () => {
    const fin = await until(() => pendingWhere((r) => r.kind === 'gate' && r.title === 'Approve the answer'), 'server: final gate', 40000);
    assert.ok(snap().result, 'the result is there while the final gate waits');
    await dom(`!!document.querySelector('#c-inbox [data-req="${fin.requestId}"] [data-opt="accept"]')`, 'final gate card');
    await click(`#c-inbox [data-req="${fin.requestId}"] [data-opt="accept"]`);
    await until(() => snap().state?.phase === 'done', 'server: run done');
  });

  await go('the result drawer opens with the credibility line and claim highlights; the claim card works', async () => {
    await dom(`document.querySelector('#drawer').classList.contains('open') && document.querySelector('#drawer').dataset.mode === 'result'`, 'result drawer slides out', 10000);
    await sleep(700); // let it finish sliding before aiming at a claim
    const s = snap();
    const want = M_cred(s.verification.summary);
    const v = await ev(`({ cred: (document.querySelector('.cred-t') || {}).textContent, claims: [...document.querySelectorAll('#dr-body .claim')].map((c) => c.dataset.claim + ':' + c.dataset.status) })`);
    assert.equal(v.cred, want);
    assert.deepEqual(v.claims, ['c1:supported', 'c2:partial']);
    if (W > 390) {
      const at = await ev(`(() => { const c = document.querySelector('#dr-body .claim[data-claim="c2"]'); c.scrollIntoView({ block: 'center' }); const b = c.getClientRects()[0]; return [b.left + 6, b.top + b.height / 2]; })()`);
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at[0], y: at[1] });
    } else await click('#dr-body .claim[data-claim="c2"]');
    const cardText = await dom(`!document.querySelector('#claim-card').hidden && document.querySelector('#claim-card').textContent`, 'claim card');
    assert.match(cardText, /partial/); assert.match(cardText, /Catch checker/); assert.match(cardText, /ebay-xm6/);
    await shot(`${tag}-4-result-claim-card`);
    return v.cred;
  });

  await go('"Ask a follow-up": round 2 arrives and the drawer re-opens on it', async () => {
    if (W <= 390) await click('#dr-body .cred'); // a tap elsewhere closes a pinned card
    await closeDrawer();
    await dom(`!!document.querySelector('#c-run form[data-run="followUp"]')`, 'follow-up box');
    await ev(`document.querySelector('#run-text').focus()`);
    await type('Any open-box units?');
    await click('#c-run button[type=submit]');
    await until(() => snap().state?.phase === 'running', 'server: round 2 running');
    // the final gate is asked again for the new answer
    const fin2 = await until(() => pendingWhere((r) => r.kind === 'gate' && r.title === 'Approve the answer'), 'server: final gate of round 2', 40000);
    assert.equal(snap().result?.round, 2, 'round 2 is written before its gate');
    await dom(`!!document.querySelector('#c-inbox [data-req="${fin2.requestId}"] [data-opt="accept"]')`, 'round 2 gate card');
    await click(`#c-inbox [data-req="${fin2.requestId}"] [data-opt="accept"]`);
    await until(() => snap().state?.phase === 'done' && snap().result?.round === 2, 'server: round 2 done', 40000);
    await dom(`document.querySelector('#drawer').classList.contains('open') && document.querySelectorAll('#dr-rounds button').length === 2`, 'drawer re-opens with two rounds', 10000);
    const t = await ev(`document.querySelector('#dr-body').textContent`);
    assert.match(t, /You asked.*Any open-box units\?/s); assert.match(t, /open-box XM6 on eBay costs £219/);
    await sleep(700); // let it finish sliding
    await shot(`${tag}-5-round2`);
  });

  await go('no exceptions, console errors or CSP violations', async () => { assert.deepEqual(logs, []); });
  await runtime.close();
  await server.close();
  if (!args.includes('--keep')) fs.rmSync(workspace, { recursive: true, force: true });
  return all.every(Boolean);
}
// The panel's credibility line, computed the same way from the server's summary (panel/model.js credibility()).
function M_cred(summary) {
  const words = { supported: 'supported', partial: 'partial', contradicted: 'contradicted', unknown: 'unknown', unchecked: 'unchecked' };
  const parts = [summary.claims + (summary.claims === 1 ? ' claim' : ' claims')].concat(Object.keys(words).filter((k) => summary[k]).map((k) => summary[k] + ' ' + words[k]));
  const links = [['live', 'live'], ['stale', 'stale'], ['hallucinated', 'dead'], ['blocked', 'blocked']].filter(([k]) => summary[k]).map(([k, w]) => summary[k] + ' ' + w);
  return parts.join(' · ') + (links.length ? ' · links: ' + links.join(', ') : '');
}

const chrome = await openChrome();
let ok = true;
try {
  for (const W of WIDTHS) ok = (await loop(W)) && ok;
} finally {
  chrome.close();
  console.log(`\n${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed · screenshots in ${OUT}`);
}
process.exit(ok ? 0 : 1);
