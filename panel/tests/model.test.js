// Run: node panel/tests/model.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const M = require('../model.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message.split('\n').join('\n       ')); }
}
const EXAMPLES = path.join(__dirname, '..', '..', 'examples');
const S = M.DEMO_DATA.structure;
const TASK = { requirements: [{ id: 'R1', text: 'a' }, { id: 'R2', text: 'b' }, { id: 'R3', text: 'c' }, { id: 'R4', text: 'd' }] };

console.log('model.js');

test('the panel is passive: no writing helpers are exported', () => {
  ['structureToMarkdown', 'answersToMarkdown', 'appendRequest', 'addRole', 'deleteRole', 'uniqueId'].forEach((k) => assert.strictEqual(M[k], undefined, k));
});

test('say → screen activity keyword mapping', () => {
  const act = (say, state) => M.activityFor({ state: state || 'working', say });
  assert.strictEqual(act('Searching Currys…'), 'search');
  assert.strictEqual(act('Looking at eBay sellers'), 'search');
  assert.strictEqual(act('Browsing Amazon sellers…'), 'search');
  assert.strictEqual(act('Reading 3 offers…'), 'check');
  assert.strictEqual(act('Re-checking delivery times'), 'check');
  assert.strictEqual(act('Verifying shipping costs…'), 'check');
  assert.strictEqual(act('Currys: £279, free delivery'), 'sheet');
  assert.strictEqual(act('Adding up delivery costs'), 'sheet');
  assert.strictEqual(act('Calculating the total'), 'sheet');
  assert.strictEqual(act('Writing the shortlist'), 'write');
  assert.strictEqual(act('Drafting a summary'), 'write');
  assert.strictEqual(act('Combining both lists'), 'write');
  assert.strictEqual(act('Planning the run'), 'plan');
  assert.strictEqual(act('Scheduling day 2'), 'plan');
  assert.strictEqual(act('Saving 2 source cards'), 'type', 'fallback is typing');
  assert.strictEqual(act('Result ready'), 'type', '"ready" is not "read"');
  assert.strictEqual(act('搜索 Currys 黑五优惠'), 'search');
  assert.strictEqual(act('核验 HDMI 2.1'), 'check');
  assert.strictEqual(act('anything', 'waiting'), 'screensaver');
  assert.strictEqual(act('Finished', 'done'), 'done');
  assert.strictEqual(act('', 'idle'), 'off');
  assert.strictEqual(M.activityFor(null), 'off');
});

test('elapsed time formatting', () => {
  assert.deepStrictEqual([0, 999, 45000, 80000, 605000, 3725000].map(M.formatElapsed), ['0s', '0s', '45s', '1m 20s', '10m 05s', '1h 02m']);
  assert.strictEqual(M.formatElapsed(-5), '0s');
});

test('run clock formatting', () => {
  assert.deepStrictEqual([0, 7000, 84000, 723000, 3723000].map(M.formatClock), ['0:00', '0:07', '1:24', '12:03', '1:02:03']);
});

test('progress is clamped, missing progress is null', () => {
  assert.deepStrictEqual([50, 120, -3, '40', 33.6, undefined, null, 'x'].map(M.clampProgress), [50, 100, 0, 40, 34, null, null, null]);
});

test('team progress strip', () => {
  let t = M.teamProgress(S, { 'retail-finder': { state: 'working' }, 'marketplace-finder': { state: 'flagged' }, 'catch-checker': { state: 'waiting' } });
  assert.deepStrictEqual([t.done, t.total, t.text], [0, 3, 'Group A · 2 working in parallel']);
  t = M.teamProgress(S, { 'retail-finder': { state: 'done' }, 'marketplace-finder': { state: 'done' }, 'catch-checker': { state: 'working' } });
  assert.deepStrictEqual([t.done, t.text, Math.round(t.fraction * 100)], [2, 'Group B · 1 working', 67]);
  assert.strictEqual(M.teamProgress(S, { lead: { state: 'working' } }).text, 'Lead is working');
  assert.strictEqual(M.teamProgress(S, {}).text, 'Nobody is working right now');
  assert.strictEqual(M.teamProgress(null, {}).total, 0);
});

test('status line follows MAS_STATE.phase, else the files', () => {
  assert.strictEqual(M.phaseLine({ state: { phase: 'refine' } }), 'Your team design is ready. Refine it by chatting with your assistant.');
  assert.strictEqual(M.phaseLine({ state: { phase: 'running' } }), 'Your team is working.');
  assert.strictEqual(M.phaseLine({}), 'Waiting for your assistant. Say hi to it to start.');
  assert.strictEqual(M.phaseLine({ task: {}, structure: { locked: true } }), 'Team locked. Ready to run.');
  assert.strictEqual(M.phaseLine({ task: {}, structure: { locked: true }, result: {} }), 'Result ready.');
});

test('status changes are compared by content, not timestamps', () => {
  assert.strictEqual(M.statusKey({ state: 'working', say: 'a', t: '1' }), M.statusKey({ state: 'working', say: 'a', t: '2' }));
  assert.notStrictEqual(M.statusKey({ state: 'working', say: 'a' }), M.statusKey({ state: 'working', say: 'b' }));
});

test('cost text', () => {
  assert.strictEqual(M.costInfo(3).text, '4 agents ≈ 4× the tokens of one assistant');
  assert.strictEqual(M.costInfo(0).text, '1 agent ≈ 1× the tokens of one assistant');
  assert.deepStrictEqual([2, 4, 6].map((n) => M.costInfo(n).level), ['calm', 'warm', 'hot']);
});

test('markdown renderer escapes HTML', () => {
  const html = M.renderMarkdown('Hi <script>alert(1)</script> **b** [x](javascript:alert(1)) <img src=x onerror=alert(1)>');
  assert.ok(!html.includes('<script') && !html.includes('<img') && !/href="javascript/i.test(html), html);
  assert.ok(html.includes('&lt;script&gt;') && html.includes('<strong>b</strong>'), html);
});

test('markdown renderer: table, headings, lists, links', () => {
  const md = '## Shortlist\n| Shop | Total |\n|---|---:|\n| Currys | **£279** |\n| eBay "X" | `£264` |\n\n- one *it*\n- [card](../sources/a.md)\n\n1. first\n2. second';
  const html = M.renderMarkdown(md, { resolveLink: (u) => 'ROOT/' + u });
  assert.ok(html.includes('<h2>Shortlist</h2>'));
  assert.ok(html.includes('<th style="text-align:right">Total</th>') && html.includes('<td style="text-align:right"><strong>£279</strong></td>'), html);
  assert.ok(html.includes('<td>eBay &quot;X&quot;</td>') && html.includes('<code>£264</code>'), html);
  assert.ok(html.includes('<li>one <em>it</em></li>') && html.includes('href="ROOT/../sources/a.md"'), html);
  assert.ok(html.includes('<ol><li>first</li><li>second</li></ol>'));
});

test('renders the example results', () => {
  ['price-compare', 'trip-planning'].forEach((ex) => {
    const f = path.join(EXAMPLES, ex, 'outputs', 'result.js');
    if (!fs.existsSync(f)) return;
    const r = M.evalDataFile(fs.readFileSync(f, 'utf8')).MAS_RESULT;
    assert.ok(M.renderMarkdown(r.markdown).length > 100, ex);
  });
});

test('requirement coverage', () => {
  const s = M.clone(S);
  s.roles[2].serves = [];
  const c = M.coverage(s, TASK);
  assert.deepStrictEqual(c.rolesWithoutReq, ['catch-checker']);
  assert.deepStrictEqual(c.unservedReqs, ['R2', 'R3']);
  assert.deepStrictEqual(M.coverage(S, TASK).servedBy.R1, ['retail-finder', 'marketplace-finder']);
});

test('progress steps', () => {
  assert.deepStrictEqual(M.deriveProgress({}), { step: 1, done: false, started: false });
  assert.strictEqual(M.deriveProgress({ task: {}, structure: { locked: false }, state: { step: 4 } }).step, 3);
  const p = M.deriveProgress({ task: {}, structure: { locked: true }, state: { step: 4, phase: 'done' } });
  assert.deepStrictEqual([p.step, p.done], [4, true]);
});

test('demo script: parallel at ~8 s with progress, flag at ~25 s, all done, loops', () => {
  const sc = M.buildDemoScript(S);
  const at = (t) => M.demoStatusesAt(sc, t);
  assert.ok(Object.values(at(0.5)).every((x) => x.state === 'idle'));
  assert.strictEqual(at(3).lead.say, 'Planning the run');
  assert.strictEqual(at(6)['catch-checker'].state, 'waiting');
  assert.strictEqual(at(8)['retail-finder'].state, 'working');
  assert.strictEqual(at(8)['marketplace-finder'].state, 'working');
  assert.ok(at(12)['retail-finder'].progress > at(8)['retail-finder'].progress, 'progress grows');
  assert.notStrictEqual(M.activityFor(at(8)['retail-finder']), 'type');
  assert.strictEqual(at(17)['retail-finder'].state, 'handoff');
  assert.strictEqual(at(17)['retail-finder'].to, 'catch-checker');
  assert.strictEqual(at(25)['catch-checker'].state, 'flagged');
  assert.strictEqual(at(25)['catch-checker'].flag, 'eBay seller X: refurbished');
  assert.strictEqual(at(37).lead.say, 'Writing the shortlist');
  assert.strictEqual(M.activityFor(at(37).lead), 'write');
  assert.ok(Object.values(at(44)).every((x) => x.state === 'done' && x.progress === 100));
  assert.ok(Object.values(at(60)).every((x) => x.state === 'done'), 'after-work tail before the loop');
  assert.ok(Object.values(at(74.5)).every((x) => x.state === 'idle'), 'loops');
});

test('demo work summaries cover every member, generic for unknown roles', () => {
  const s = { lead: { id: 'lead', name: 'Lead' }, groups: [{ id: 'A' }], roles: [{ id: 'x', name: 'X', job: 'Find flights', group: 'A', handsTo: 'lead' }] };
  const w = M.demoWork(s);
  assert.deepStrictEqual(w.map((e) => e.by), ['lead', 'x']);
  assert.ok(w[1].summary.includes('Find flights') && w[1].summary.includes('Lead'));
  assert.ok(M.demoWork(S).find((e) => e.by === 'catch-checker').summary.includes('refurbished'));
});

test('demo script works with three groups and two roles handing to lead', () => {
  const f = path.join(EXAMPLES, 'trip-planning', 'mas', 'structure.js');
  if (!fs.existsSync(f)) return;
  const s = M.evalDataFile(fs.readFileSync(f, 'utf8')).MAS_STRUCTURE;
  const sc = M.buildDemoScript(s);
  const states = (t) => M.demoStatusesAt(sc, t);
  assert.strictEqual(states(9)['sights-finder'].state, 'working');
  assert.strictEqual(states(9)['travel-finder'].state, 'working');
  assert.strictEqual(states(23)['day-planner'].state, 'handoff');
  assert.strictEqual(states(27)['day-planner'].state, 'done');
  assert.ok(['working', 'flagged'].includes(states(30)['budget-clash-checker'].state));
});

test('say history keeps the last 5 distinct messages', () => {
  const h = {};
  ['a', 'a', 'b', 'c', 'd', 'e', 'f'].forEach((say) => M.pushSay(h, 'x', { state: 'working', say }));
  assert.deepStrictEqual(h.x.map((e) => e.say), ['b', 'c', 'd', 'e', 'f']);
});

test('data files evaluate against a fresh object', () => {
  const f = path.join(EXAMPLES, 'price-compare', 'mas', 'status', 'catch-checker.js');
  if (fs.existsSync(f)) assert.ok(M.evalDataFile(fs.readFileSync(f, 'utf8')).MAS_STATUS['catch-checker'].state);
  assert.throws(() => M.evalDataFile('window.X = {'));
});

test('result.work accepts an array or an object map', () => {
  assert.deepStrictEqual(M.normalizeWork([{ by: 'a', summary: '- x' }, { nope: 1 }]), [{ by: 'a', summary: '- x' }]);
  assert.deepStrictEqual(M.normalizeWork({ a: '- x', b: { summary: '- y' } }), [{ by: 'a', summary: '- x' }, { by: 'b', summary: '- y' }]);
  assert.deepStrictEqual(M.normalizeWork(undefined), []);
  assert.deepStrictEqual(M.normalizeWork('text'), []);
});

test('headline: one status sentence per moment', () => {
  const d = { structure: S, task: TASK, state: { phase: 'running' } };
  const w = (say) => ({ state: 'working', say });
  assert.strictEqual(M.headline(d, { 'retail-finder': w('Searching Currys'), 'marketplace-finder': w('Searching eBay') }), 'Retail finder and Marketplace finder are searching at the same time.');
  assert.strictEqual(M.headline(d, { 'catch-checker': { state: 'flagged', flag: 'x' } }), 'Catch checker flagged a problem.');
  assert.strictEqual(M.headline(d, { 'catch-checker': { state: 'handoff', to: 'lead' } }), 'Catch checker is handing work to the Lead.');
  assert.strictEqual(M.headline(d, { lead: w('Writing the shortlist') }), 'The Lead is writing.');
  assert.strictEqual(M.headline(Object.assign({}, d, { result: {} }), { lead: { state: 'done' } }), 'The result is ready.');
  assert.strictEqual(M.headline({ structure: Object.assign({}, S, { locked: false }) }, {}), 'Your team is drafted. Refine it in the chat.');
  assert.strictEqual(M.headline({ task: TASK }, {}), 'Your task is on the board.');
  assert.strictEqual(M.headline({}, {}), 'Say hi to your assistant to begin.');
});

function teamOf(n, groups) {
  const gs = Array.from({ length: groups }, (_, i) => ({ id: String.fromCharCode(65 + i), label: 'G' + i, after: i ? String.fromCharCode(64 + i) : null }));
  return { lead: { id: 'lead', name: 'Lead' }, groups: gs, roles: Array.from({ length: n }, (_, i) => ({ id: 'r' + i, name: 'Role ' + i, group: gs[i % groups].id, handsTo: 'lead' })) };
}
test('plan: desks never overlap and stay inside their rooms (1–8 roles, 1–4 groups)', () => {
  for (let n = 1; n <= 8; n++) for (let g = 1; g <= Math.min(4, n); g++) {
    const plan = M.planOffice(teamOf(n, g));
    const boxes = Object.keys(plan.desks).map((id) => Object.assign({ id }, plan.desks[id].desk));
    boxes.forEach((a, i) => boxes.slice(i + 1).forEach((b) => assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.d <= b.y || b.y + b.d <= a.y, n + '/' + g + ' ' + a.id + '×' + b.id)));
    Object.keys(plan.desks).forEach((id) => {
      const d = plan.desks[id], room = plan.rooms.find((r) => r.id === d.room);
      assert.ok(d.desk.x >= room.x0 && d.desk.x + d.desk.w <= room.x1 && d.desk.y >= room.y0 && d.stand.y <= room.y1 + 0.01, n + '/' + g + ' ' + id);
    });
    assert.ok(plan.W <= 12.5, 'rooms wrap into rows');
  }
});

// Same projection and anchors as office.js: leaders start at the desk's front-left / back-right top corner.
function sheetFor(n, groups, U, width, height) {
  const C = Math.cos(Math.PI / 6), plan = M.planOffice(teamOf(n, groups));
  const O = [(width - (plan.W + plan.D) * C * U) / 2 + plan.D * C * U, 12 + 2.15 * U];
  const P = (x, y, z) => [O[0] + (x - y) * C * U, O[1] + (x + y) * 0.5 * U - z * U];
  const poly = M.convexHull([[0, 0], [plan.W, 0], [plan.W, plan.D], [0, plan.D]].flatMap(([x, y]) => [P(x, y, -0.3), P(x, y, 1.25)]));
  const items = Object.keys(plan.desks).map((id) => {
    const d = plan.desks[id].desk, c = P(d.x + d.w / 2, d.y + d.d / 2, d.h);
    return { id, ax: c[0], ay: c[1], left: P(d.x, d.y + d.d, d.h), right: P(d.x + d.w, d.y, d.h) };
  });
  return { plan, poly, items };
}
function fitLabels(n, groups, width, height) {
  for (let U = 70; U >= 20; U *= 0.94) {
    const sh = sheetFor(n, groups, U, width, height);
    const res = M.layoutLabels(sh.items, { width, height, poly: sh.poly, lw: 214, lh: 92 });
    if (res.ok) return Object.assign({ U }, sh, res);
  }
  return null;
}
test('labels: collision-free beside the drawing for 1–8 roles at 1440×900', () => {
  const width = 920, height = 640;
  for (let n = 1; n <= 8; n++) {
    const r = fitLabels(n, Math.min(3, n), width, height);
    assert.ok(r, 'a layout exists for n=' + n);
    const L = r.labels;
    assert.strictEqual(L.length, n + 1);
    L.forEach((a, i) => {
      assert.ok(a.x >= 0 && a.x + a.w <= width && a.y >= 0 && a.y + a.h <= height, 'inside the area');
      L.slice(i + 1).forEach((b) => assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, 'labels overlap at n=' + n));
      for (let y = a.y; y <= a.y + a.h; y += 4) { const q = M.polyXRange(r.poly, y); if (q) assert.ok(a.x + a.w <= q[0] || a.x >= q[1], 'label over the drawing at n=' + n); }
    });
    assert.ok(r.U >= 26 || n > 6, 'figures stay large for small teams (U=' + r.U.toFixed(1) + ', n=' + n + ')');
  }
});

test('leaders: one elbow each, from the desk, and no two leaders cross (1–8 roles)', () => {
  for (let n = 1; n <= 8; n++) for (let g = 1; g <= Math.min(3, n); g++) {
    const r = fitLabels(n, g, 920, 640);
    assert.ok(r, 'layout for n=' + n + '/' + g);
    r.labels.forEach((l) => {
      const it = r.items.find((x) => x.id === l.id);
      assert.deepStrictEqual(l.path[0], it[l.side], 'anchored at the desk corner on its side');
      assert.strictEqual(l.path.length, 3, 'anchor → elbow → label');
      assert.strictEqual(l.path[1][1], l.path[2][1], 'last leg is horizontal');
      assert.ok(l.side === 'left' ? l.x + l.w < l.path[0][0] : l.x > l.path[0][0], 'label sits outside its own anchor, so the leader never strikes through it');
      assert.strictEqual(l.side === 'left' ? it.ax < Math.max(...r.poly.map((p) => p[0])) : true, true);
    });
    for (let i = 0; i < r.labels.length; i++) for (let j = i + 1; j < r.labels.length; j++)
      assert.ok(!M.pathsCross(r.labels[i].path, r.labels[j].path), 'leaders cross at n=' + n + '/' + g + ': ' + r.labels[i].id + ' × ' + r.labels[j].id);
  }
});

test('leaders steer around other roles: crossings never increase vs. the plain layout (1–8 roles)', () => {
  const width = 920, height = 640, lines = [];
  let before = 0, after = 0;
  for (let n = 1; n <= 8; n++) for (let g = 1; g <= Math.min(3, n); g++) {
    for (let U = 70; U >= 20; U *= 0.94) {
      const sh = sheetFor(n, g, U, width, height);
      const ids = sh.items.map((it) => it.id);
      const P = (() => { const C = Math.cos(Math.PI / 6), O = [(width - (sh.plan.W + sh.plan.D) * C * U) / 2 + sh.plan.D * C * U, 12 + 2.15 * U]; return (x, y, z) => [O[0] + (x - y) * C * U, O[1] + (x + y) * 0.5 * U - z * U]; })();
      const boxes = M.roleBoxes(sh.plan, ids, P, U);
      const opt = { width, height, poly: sh.poly, lw: 214, lh: 92, boxes };
      const plain = M.layoutLabels(sh.items, Object.assign({ avoid: false }, opt));
      const smart = M.layoutLabels(sh.items, opt);
      if (!plain.ok || !smart.ok) continue;
      const a = M.leaderCrossings(plain.labels, boxes), b = M.leaderCrossings(smart.labels, boxes);
      assert.ok(b <= a, 'more crossings at n=' + n + '/' + g + ': ' + a + ' → ' + b);
      for (let i = 0; i < smart.labels.length; i++) for (let j = i + 1; j < smart.labels.length; j++) assert.ok(!M.pathsCross(smart.labels[i].path, smart.labels[j].path), 'leaders cross');
      before += a; after += b; lines.push(n + '/' + g + ':' + a + '→' + b);
      break;
    }
  }
  console.log('       desk/figure crossings, plain → steered: ' + before + ' → ' + after + '  (' + lines.join(' ') + ')');
});

test('real run (pi-deals: 2 roles in A/B + lead) at a 650px drawing: both margins, clear of room names', () => {
  const s = { lead: { id: 'lead', name: 'Lead' }, groups: [{ id: 'A', label: 'Find offers', after: null }, { id: 'B', label: 'Check prices', after: 'A' }],
    roles: [{ id: 'reseller-finder', name: 'Reseller finder', group: 'A', handsTo: 'price-checker', serves: ['R1'] }, { id: 'price-checker', name: 'Price checker', group: 'B', handsTo: 'lead', serves: ['R3'] }] };
  const C = Math.cos(Math.PI / 6), width = 650, height = 640, plan = M.planOffice(s);
  let r = null;
  for (let U = 70; U >= 20 && !r; U *= 0.94) {
    const O = [(width - (plan.W + plan.D) * C * U) / 2 + plan.D * C * U, 12 + 2.15 * U];
    const P = (x, y, z) => [O[0] + (x - y) * C * U, O[1] + (x + y) * 0.5 * U - z * U];
    const poly = M.convexHull([[0, 0], [plan.W, 0], [plan.W, plan.D], [0, plan.D]].flatMap(([x, y]) => [P(x, y, -0.3), P(x, y, 1.25)]));
    const items = Object.keys(plan.desks).map((id) => { const d = plan.desks[id].desk, c = P(d.x + d.w / 2, d.y + d.d / 2, d.h); return { id, ax: c[0], ay: c[1], left: P(d.x, d.y + d.d, d.h), right: P(d.x + d.w, d.y, d.h) }; });
    const rooms = M.letterRooms(plan, P, U);
    const res = M.layoutLabels(items, { width, height, poly, lw: 190, lh: 92, boxes: M.roleBoxes(plan, Object.keys(plan.desks), P, U), obstacles: rooms.map((x) => x.poly) });
    if (res.ok) r = Object.assign({ rooms }, res);
  }
  assert.ok(r, 'a layout exists');
  assert.ok(r.labels.some((l) => l.side === 'left') && r.labels.some((l) => l.side === 'right'), 'both margins are used: ' + r.labels.map((l) => l.id + ':' + l.side).join(' '));
  r.labels.forEach((l) => r.rooms.forEach((q) => assert.ok(!M.polysOverlap([[l.x, l.y], [l.x + l.w, l.y], [l.x + l.w, l.y + l.h], [l.x, l.y + l.h]], q.poly), l.id + ' covers ' + q.text)));
  for (let i = 0; i < r.labels.length; i++) for (let j = i + 1; j < r.labels.length; j++) assert.ok(!M.pathsCross(r.labels[i].path, r.labels[j].path));
});

test('grid routes walk along the plan axes only', () => {
  const plan = M.planOffice(S);
  const a = plan.desks['retail-finder'].stand, b = plan.desks.lead.visit;
  let prev = a;
  M.gridRoute(plan, a, b).forEach((p) => { assert.ok(Math.abs(p.x - prev.x) < 1e-9 || Math.abs(p.y - prev.y) < 1e-9, 'axis-aligned leg'); prev = p; });
  assert.deepStrictEqual(prev, { x: b.x, y: b.y });
});

test('home/projects.js: several MAS in one folder', () => {
  assert.strictEqual(M.normalizeHome(undefined), null, 'no home file → legacy single-project layout');
  const h = M.normalizeHome({
    current: 'headphone-deals',
    projects: [
      { folder: 'headphone-deals', title: 'Headphone deal finder', step: 4, phase: 'done', agents: 4, runs: 1 },
      { folder: 'lisbon-trip' },
      { folder: 'headphone-deals', title: 'Duplicate — ignored' },
      { folder: '../escape' }, { folder: 'Upper-Case' }, { folder: '-dash-first' }, { folder: 'a'.repeat(65) }, { title: 'no folder' }, null,
      { folder: 'odd-fields', step: 9, agents: -2, runs: 'x', title: '  ' }
    ]
  });
  assert.deepStrictEqual(h.projects.map((p) => p.folder), ['headphone-deals', 'lisbon-trip', 'odd-fields']);
  assert.strictEqual(h.projects[0].title, 'Headphone deal finder', 'first entry for a folder wins');
  assert.deepStrictEqual(h.projects[1], { folder: 'lisbon-trip', title: 'lisbon-trip', step: null, phase: null, agents: null, runs: null });
  assert.deepStrictEqual([h.projects[2].step, h.projects[2].agents, h.projects[2].runs, h.projects[2].title], [null, null, null, 'odd-fields']);
  assert.strictEqual(h.current, 'headphone-deals');
  assert.strictEqual(M.normalizeHome({ current: 'not-listed-yet', projects: [] }).current, 'not-listed-yet', 'a valid current is kept before its entry exists');
  assert.strictEqual(M.normalizeHome({ current: '../etc', projects: [] }).current, null, 'an invalid current means "choosing"');
  assert.strictEqual(M.normalizeHome({ current: null }).current, null);
  assert.deepStrictEqual(M.normalizeHome({}).projects, []);
});

test('fixture: mock-home is a valid multi-MAS folder', () => {
  const base = path.join(__dirname, 'fixtures', 'mock-home');
  if (!fs.existsSync(base)) return;
  const h = M.normalizeHome(M.evalDataFile(fs.readFileSync(path.join(base, 'home', 'projects.js'), 'utf8')).MAS_HOME);
  assert.ok(h.projects.length >= 2);
  h.projects.forEach((p) => assert.ok(fs.existsSync(path.join(base, p.folder, 'me', 'task.js')), p.folder + ' has a task'));
  assert.ok(M.evalDataFile(fs.readFileSync(path.join(base, 'home', 'env.js'), 'utf8')).MAS_ENV.subagents);
});

test('after-work: lounge spots fit, never touch furniture, and no two figures overlap on screen (1–8 roles)', () => {
  const pose = (st) => (st.kind === 'sofa' ? 'sit' : st.kind === 'chat' ? 'chat-' + st.side : 'stand');
  for (let n = 1; n <= 8; n++) for (let g = 1; g <= Math.min(3, n); g++) {
    const plan = M.planOffice(teamOf(n, g)), need = n + 1, L = M.loungeLayout(plan, need);
    const all = L.stations.concat(L.party.ring, L.overflow);
    all.forEach((p) => {
      assert.ok(p.x > plan.lounge.x0 && p.x < plan.lounge.x1 && p.y > 0 && p.y < M.PLAN.BACK, 'inside the lounge');
      L.furniture.forEach((f) => assert.ok(!(p.x > f.x - 0.12 && p.x < f.x + f.w + 0.12 && p.y > f.y - 0.12 && p.y < f.y + f.d + 0.12), 'clear of ' + f.kind));
    });
    // after-work: every station and every overflow spot can be occupied at once
    const work = L.stations.map((st) => [st.id, M.figBox(st, pose(st))]).concat(L.overflow.map((p, i) => ['over-' + i, M.figBox(p, 'stand')]));
    // the party: everyone on the ring at once
    const party = L.party.ring.map((p, i) => ['ring-' + i, M.figBox(p, 'stand')]);
    [work, party].forEach((set) => set.forEach(([ia, a], i) => set.slice(i + 1).forEach(([ib, b]) => assert.ok(!M.boxesOverlap(a, b, 0), 'figures overlap at n=' + n + '/' + g + ': ' + ia + ' × ' + ib))));
    assert.ok(L.party.ring.length >= need, 'everyone fits round the party table at n=' + n);
    assert.ok(L.stations.length + L.overflow.length >= Math.min(need, 6), 'after-work room for the team at n=' + n);
    L.stations.filter((st) => st.pair).forEach((st) => assert.ok(L.stations.some((o) => o.id === st.pair), 'pairs are kept whole'));
    const cof = L.stations.filter((st) => st.kind === 'coffee');
    if (cof.length === 2) assert.ok(Math.hypot(cof[0].x - cof[1].x, cof[0].y - cof[1].y) >= 1.2 - 1e-9, 'coffee queue spaced along the counter');
  }
});

test('after-work scheduler: never double-books, only done figures, quiet while the team works', () => {
  const lounge = M.loungeLayout(M.planOffice(teamOf(8, 3)));
  for (let n = 1; n <= 8; n++) {
    const rng = M.seededRandom('sim-' + n), figs = Array.from({ length: n }, (_, i) => ({ id: 'f' + i, state: 'done', at: null }));
    for (let step = 0; step < 300; step++) {
      const f = figs[Math.floor(rng() * n)];
      const occupied = {};
      figs.forEach((x) => { if (x.at) occupied[x.at] = x.id; });
      const teamBusy = step < 60;
      const s = M.pickStation(lounge, occupied, f, { teamBusy, current: f.at, rng });
      if (s) {
        assert.ok(!occupied[s.id] || occupied[s.id] === f.id, 'double-booked ' + s.id);
        if (teamBusy) assert.ok(['coffee', 'sofa'].includes(s.kind), 'early finishers stay quiet: ' + s.kind);
        f.at = s.id;
      }
      const seen = figs.filter((x) => x.at).map((x) => x.at);
      assert.strictEqual(new Set(seen).size, seen.length, 'one figure per station');
    }
  }
  ['working', 'waiting', 'flagged', 'handoff', 'idle'].forEach((state) => assert.strictEqual(M.pickStation(lounge, {}, { id: 'x', state }, {}), null, state + ' never plays'));
  assert.strictEqual(M.pickStation(lounge, {}, { id: 'x', state: 'done' }, { teamBusy: true }).kind, 'coffee', 'an early finisher goes for coffee first');
  const disperse = (k) => { const occ = {}, out = []; for (let i = 0; i < k; i++) { const s = M.pickStation(lounge, occ, { id: 'p' + i, state: 'done' }, { ordered: true, doneCount: k, remaining: k - i }); if (s) { occ[s.id] = 'p' + i; out.push(s.kind); } } return out; };
  assert.deepStrictEqual(disperse(2), ['tt', 'tt'], 'two people: a game of table tennis');
  assert.deepStrictEqual(disperse(4), ['tt', 'tt', 'sofa', 'sofa'], 'three or more: the sofa fills before standing spots');
  assert.deepStrictEqual(disperse(3), ['tt', 'tt', 'sofa']);
  assert.ok(!disperse(5).slice(4).includes('chat') || disperse(5).filter((k) => k === 'chat').length !== 1, 'a pair is never opened for one person');
  const seat = M.pickStation(lounge, {}, { id: 'q', state: 'done' }, { doneCount: 3, rng: () => 0.99 });
  assert.strictEqual(seat.kind, 'sofa', 'the scheduler prefers a free seat once three are done');
  assert.strictEqual(M.pickStation(lounge, {}, { id: 'q', state: 'done' }, { doneCount: 3, current: 'sofa-0' }), null, 'a seated figure stays seated');
  const a = M.seededRandom('fig-a:run-1'), b = M.seededRandom('fig-a:run-1');
  assert.strictEqual(a(), b(), 'seeded per figure: stable across re-renders');
});

test('wrap party: once per run, only when the finish is seen live', () => {
  assert.strictEqual(M.partyDue(null, 'run-1', true, true), true);
  assert.strictEqual(M.partyDue('run-1', 'run-1', true, true), false, 'not again for the same run (re-render, poll, resize)');
  assert.strictEqual(M.partyDue('run-1', 'run-2', true, true), true, 'a new run (or a demo replay) parties again');
  assert.strictEqual(M.partyDue(null, 'run-1', false, true), false, 'not while anyone still works');
  assert.strictEqual(M.partyDue(null, 'run-1', true, false), false, 'not when the page opens on an already finished run');
  assert.strictEqual(M.partyDue(null, null, true, true), false, 'needs a result');
});

/* ---------- MAS Office: failed state, sdk mode, dynamic agents, desk cap, flag kinds ---------- */
test('failed is a state, and a terminal one', () => {
  assert.ok(M.STATES.includes('failed'));
  assert.deepStrictEqual(M.FINISHED, ['done', 'failed']);
  assert.strictEqual(M.activityFor({ state: 'failed', say: 'Searching' }), 'failed', 'a failed desk never looks busy');
  assert.strictEqual(M.phaseLine({ state: { phase: 'failed' } }), 'The run failed.');
});

test('team progress counts failed roles as finished, not done', () => {
  let t = M.teamProgress(S, { 'retail-finder': { state: 'done' }, 'marketplace-finder': { state: 'failed' }, 'catch-checker': { state: 'done' } });
  assert.deepStrictEqual([t.done, t.failed, t.finished, t.total, t.text, t.fraction], [2, 1, 3, 3, 'All roles finished · 1 failed', 1]);
  t = M.teamProgress(S, { 'retail-finder': { state: 'failed' }, 'marketplace-finder': { state: 'done' }, 'catch-checker': { state: 'working' } });
  assert.deepStrictEqual([t.finished, t.text], [2, 'Group B · 1 working']);
  assert.strictEqual(M.teamProgress(S, { 'retail-finder': { state: 'done' }, 'marketplace-finder': { state: 'done' }, 'catch-checker': { state: 'done' } }).text, 'All roles done', 'unchanged without failures');
});

test('wrap-up: a party only when everyone is done; a failure ends the run quietly', () => {
  assert.strictEqual(M.wrapUp(['done', 'done', 'done']), 'party');
  assert.strictEqual(M.wrapUp(['done', 'failed', 'done']), 'quiet');
  assert.strictEqual(M.wrapUp(['failed']), 'quiet');
  assert.strictEqual(M.wrapUp(['done', 'working']), null, 'someone still works');
  assert.strictEqual(M.wrapUp(['done', 'flagged']), null, 'a flag is not an ending');
  assert.strictEqual(M.wrapUp(['done', 'idle']), null);
  assert.strictEqual(M.wrapUp([]), null);
  assert.strictEqual(M.wrapUp([{ state: 'done' }, { state: 'failed' }]), 'quiet', 'accepts status objects');
  // the office only throws the party for 'party'; a quiet ending keeps finishers on coffee and the sofa
  const lounge = M.loungeLayout(M.planOffice(teamOf(4, 2)));
  const s = M.pickStation(lounge, {}, { id: 'x', state: 'done' }, { teamBusy: true, current: 'coffee-0', rng: () => 0.99 });
  assert.ok(!s || ['coffee', 'sofa'].includes(s.kind), 'quiet stations only');
  assert.strictEqual(M.pickStation(lounge, {}, { id: 'x', state: 'failed' }, {}), null, 'a failed agent stays at its desk');
});

test('flag kinds: "needs you" vs a found problem vs a failure', () => {
  assert.deepStrictEqual(['concern', 'needs_input', 'needs_approval', undefined, 'bogus', 'error'].map((k) => M.stateLabel({ state: 'flagged', flagKind: k })),
    ['flagged', 'needs you', 'needs you', 'flagged', 'flagged', 'flagged']);
  assert.strictEqual(M.flagInfo({ state: 'flagged', flagKind: 'needs_input' }).title, 'Needs your input');
  assert.strictEqual(M.flagInfo({ state: 'flagged', flagKind: 'needs_approval' }).title, 'Needs your approval');
  assert.strictEqual(M.flagInfo({ state: 'flagged' }).title, 'Found a problem');
  assert.strictEqual(M.flagInfo({ state: 'failed', flagKind: 'error' }).icon, 'fail');
  assert.strictEqual(M.stateLabel({ state: 'failed' }), 'failed');
  assert.strictEqual(M.stateLabel({ state: 'working' }), 'working');
  assert.strictEqual(M.flagInfo({ state: 'working', flagKind: 'needs_input' }), null, 'flagKind only counts while flagged');
  assert.ok(M.needsYou({ state: 'flagged', flagKind: 'needs_input' }) && !M.needsYou({ state: 'flagged', flagKind: 'concern' }));
  assert.notStrictEqual(M.statusKey({ state: 'flagged', flag: 'x', flagKind: 'concern' }), M.statusKey({ state: 'flagged', flag: 'x', flagKind: 'needs_input' }), 'a new kind is a change');
  assert.strictEqual(M.statusKey({ state: 'working', say: 'a' }), 'working|a||', 'unchanged key without a kind');
});

test('headline: needs you, failures and a failed run', () => {
  const d = { structure: S, task: TASK, state: { phase: 'running' } };
  assert.strictEqual(M.headline(d, { 'catch-checker': { state: 'flagged', flag: 'OK to buy?', flagKind: 'needs_approval' }, 'retail-finder': { state: 'flagged', flag: 'x' } }), 'Catch checker needs you.');
  assert.strictEqual(M.headline(d, { 'retail-finder': { state: 'failed' }, 'catch-checker': { state: 'working', say: 'Checking' } }), 'Retail finder failed.');
  assert.strictEqual(M.headline(d, { 'retail-finder': { state: 'failed' }, 'catch-checker': { state: 'failed' } }), '2 agents failed.');
  assert.strictEqual(M.headline(Object.assign({}, d, { result: {} }), { lead: { state: 'done' }, 'retail-finder': { state: 'failed' } }), 'The result is ready, but Retail finder failed.');
  assert.strictEqual(M.headline({ structure: S, state: { phase: 'failed' } }, { lead: { state: 'failed', flag: 'Worker 1 failed' } }), 'The run failed.');
  assert.strictEqual(M.headline({ structure: S, state: { phase: 'running' } }, { lead: { state: 'failed' } }), 'The run failed.');
});

test('sdk mode: no task needed, no four-step journey', () => {
  const sdk = (extra) => Object.assign({ state: { mode: 'sdk', phase: 'running' }, structure: { locked: true, roles: [] } }, extra);
  assert.ok(M.isSdk(sdk()) && !M.isSdk({ state: { mode: 'kit' } }) && !M.isSdk({ state: {} }) && !M.isSdk({}));
  assert.deepStrictEqual(M.deriveProgress(sdk()), { step: 4, done: false, started: true, sdk: true }, 'a missing me/task is fine');
  assert.strictEqual(M.deriveProgress(sdk({ state: { mode: 'sdk', phase: 'done' } })).done, true);
  // kit mode (no mode, or mode: "kit") is unchanged: a missing task is step 1
  assert.strictEqual(M.deriveProgress({ state: { step: 4 }, structure: { locked: true } }).step, 1);
  assert.strictEqual(M.deriveProgress({ state: { mode: 'kit', step: 4 }, structure: { locked: true } }).step, 1);
  assert.strictEqual(M.deriveProgress({ state: { mode: 'kit' }, task: {}, structure: { locked: true } }).sdk, undefined);
  assert.strictEqual(M.headline({ state: { mode: 'sdk', phase: 'locked' } }, {}), 'Waiting for the first run.');
  assert.strictEqual(M.headline({ state: { mode: 'sdk', phase: 'locked' }, structure: { locked: true, roles: [] } }, { lead: { state: 'idle' } }), 'The team is ready.');
  assert.strictEqual(M.headline({ state: { phase: 'locked' }, structure: { locked: true, roles: [] } }, { lead: { state: 'idle' } }), 'Your team is locked and ready to run.', 'kit wording unchanged');
  assert.strictEqual(M.headline({ state: { mode: 'sdk', phase: 'running' }, structure: { title: 'X', locked: true, roles: [] } }, { lead: { state: 'working', say: 'Planning the run' } }), 'The Lead is planning.');
});

test('dynamic agents get the "Spawned at runtime" group', () => {
  const s = { title: 'T', locked: true, lead: { id: 'lead' }, groups: [{ id: 'A', label: 'Search', after: null }],
    roles: [{ id: 'a', group: 'A' }, { id: 'x', dynamic: true, parent: 'a' }, { id: 'y', group: 'dyn', dynamic: true }] };
  const n = M.withDynamicGroup(s);
  assert.deepStrictEqual(n.groups, [{ id: 'A', label: 'Search', after: null }, { id: 'dyn', label: 'Spawned at runtime', after: 'A' }]);
  assert.deepStrictEqual(n.roles.map((r) => r.group), ['A', 'dyn', 'dyn']);
  assert.strictEqual(s.groups.length, 1, 'the input is not changed');
  assert.strictEqual(M.withDynamicGroup(n), n, 'already normalised: returned as is');
  assert.strictEqual(M.withDynamicGroup(S), S, 'kit structures pass through untouched');
  assert.strictEqual(M.withDynamicGroup(null), null);
  assert.strictEqual(M.zoneCaption(n.groups[1], 2), 'Spawned at runtime');
  assert.strictEqual(M.groupCaption(n.groups[1], 1), 'Spawned at runtime');
  const plan = M.planOffice(n);
  assert.deepStrictEqual(plan.rooms.filter((r) => r.kind === 'group').map((r) => r.id), ['A', 'dyn'], 'a room of its own, not "No group yet"');
});

test('topology dynamic: no declared groups, before and after agents appear', () => {
  const empty = { title: 'Untitled MAS', version: 1, locked: true, topology: 'dynamic', lead: { id: 'lead', name: 'Lead' }, groups: [], roles: [] };
  const p0 = M.planOffice(empty);
  assert.ok(p0.lounge && p0.desks.lead && p0.rooms.length === 2, 'lead and lounge only');
  const grown = M.withDynamicGroup(Object.assign({}, empty, { roles: [1, 2, 3].map((i) => ({ id: 'w' + i, dynamic: true, parent: 'lead' })) }));
  const p1 = M.planOffice(grown);
  assert.deepStrictEqual(Object.keys(p1.desks).sort(), ['lead', 'w1', 'w2', 'w3']);
  assert.deepStrictEqual(p1.desks.lead, p0.desks.lead, 'the lead keeps its desk while the team grows');
});

test('desk cap: at most 12 roles get a desk, the rest are counted; stable as agents are added', () => {
  const big = (n) => M.withDynamicGroup({ lead: { id: 'lead' }, groups: [{ id: 'A', after: null }],
    roles: [{ id: 'a1', group: 'A' }].concat(Array.from({ length: n - 1 }, (_, i) => ({ id: 'd' + i, dynamic: true }))) });
  assert.strictEqual(M.MAX_DESKS, 12);
  const c20 = M.capRoles(big(20));
  assert.strictEqual(c20.structure.roles.length, 12);
  assert.deepStrictEqual(c20.hidden, Array.from({ length: 8 }, (_, i) => 'd' + (i + 11)));
  assert.strictEqual(c20.structure.roles[0].id, 'a1', 'declared groups first');
  assert.deepStrictEqual(M.capRoles(big(21)).structure.roles.map((r) => r.id), c20.structure.roles.map((r) => r.id), 'a new agent never takes a drawn desk');
  const c5 = M.capRoles(big(5));
  assert.strictEqual(c5.hidden.length, 0, 'under the cap: nothing hidden');
  assert.strictEqual(M.capRoles(S).structure, S, 'under the cap: the same structure');
  assert.deepStrictEqual(M.capRoles(big(4), 2).hidden, ['d1', 'd2']);
  assert.deepStrictEqual(M.capRoles(null).hidden, []);
  // a group listed later in the array but earlier in run order keeps its desks first
  const s = { groups: [{ id: 'B', after: 'A' }, { id: 'A', after: null }], roles: [{ id: 'b', group: 'B' }, { id: 'a', group: 'A' }] };
  assert.deepStrictEqual(M.capRoles(s, 1).structure.roles.map((r) => r.id), ['a']);
});

test('plan: 9–12 roles in one room, or spread over groups, still fit without overlaps', () => {
  for (let n = 9; n <= 12; n++) for (let g = 1; g <= 4; g++) {
    const plan = M.planOffice(teamOf(n, g));
    const boxes = Object.keys(plan.desks).map((id) => Object.assign({ id }, plan.desks[id].desk));
    boxes.forEach((a, i) => boxes.slice(i + 1).forEach((b) => assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.d <= b.y || b.y + b.d <= a.y, n + '/' + g + ' ' + a.id + '×' + b.id)));
    Object.keys(plan.desks).forEach((id) => {
      const d = plan.desks[id], room = plan.rooms.find((r) => r.id === d.room);
      assert.ok(d.desk.x >= room.x0 && d.desk.x + d.desk.w <= room.x1 && d.desk.y >= room.y0 && d.stand.y <= room.y1 + 0.01, n + '/' + g + ' ' + id);
    });
    assert.ok(plan.W <= 12.5, 'rooms wrap into rows at n=' + n + '/' + g);
    const L = M.loungeLayout(plan, n + 1);
    assert.ok(L.party.ring.length >= Math.min(n + 1, 9), 'the lounge still has a ring at n=' + n);
  }
  // one room of 12: four columns, so the office stays wider than deep
  const one = M.planOffice(teamOf(12, 1));
  assert.ok(one.D < one.W + 3, 'not a corridor: ' + one.W.toFixed(1) + '×' + one.D.toFixed(1));
});

test('fixture: mock-sdk is an sdk-mode workspace with a dynamic, a failed and a needs-you agent', () => {
  const base = path.join(__dirname, 'fixtures', 'mock-sdk');
  const read = (rel) => M.evalDataFile(fs.readFileSync(path.join(base, rel), 'utf8'));
  const h = M.normalizeHome(read('home/projects.js').MAS_HOME), dir = h.current + '/';
  const state = read(dir + 'mas/state.js').MAS_STATE, s = M.withDynamicGroup(read(dir + 'mas/structure.js').MAS_STRUCTURE);
  assert.strictEqual(state.mode, 'sdk');
  assert.ok(!fs.existsSync(path.join(base, dir, 'me', 'task.js')), 'no task file: sdk mode does not need one');
  const st = {};
  ['lead'].concat(s.roles.map((r) => r.id)).forEach((id) => Object.assign(st, read(dir + 'mas/status/' + id + '.js').MAS_STATUS));
  Object.values(st).forEach((x) => assert.ok(M.STATES.includes(x.state), x.state));
  assert.ok(s.roles.every((r) => r.dynamic && r.group === 'dyn'));
  assert.ok(Object.values(st).some((x) => x.state === 'failed') && Object.values(st).some((x) => M.needsYou(x)));
  const d = { state, structure: s };
  assert.deepStrictEqual(M.deriveProgress(d), { step: 4, done: false, started: true, sdk: true });
  assert.strictEqual(M.headline(d, st), 'Approver needs you.');
  assert.strictEqual(M.teamProgress(s, st).failed, 1);
  assert.strictEqual(M.wrapUp(Object.values(st)), null, 'still running');
});

test('agent-written text stays text: names, flags and emoji are escaped', () => {
  const nasty = '<img src=x onerror=alert(1)> "q" & \'s\' 🤖';
  const e = M.esc(nasty);
  assert.ok(!/[<>"']/.test(e) && e.includes('&lt;img') && e.includes('🤖'), e);
  assert.strictEqual(M.headline({ structure: { locked: true, lead: {}, roles: [{ id: 'x', name: nasty }] }, state: {} }, { x: { state: 'failed' } }), nasty + ' failed.', 'the headline is set with textContent, never as HTML');
});

test('?root= accepts only relative folders inside the workspace', () => {
  assert.strictEqual(M.safeRoot('../examples/price-compare/'), '../examples/price-compare/');
  assert.strictEqual(M.safeRoot('../examples/price-compare'), '../examples/price-compare/');
  assert.strictEqual(M.safeRoot('../'), '../');
  assert.strictEqual(M.safeRoot('tests/fixtures/mock-sdk/research-sprint/'), 'tests/fixtures/mock-sdk/research-sprint/');
  assert.strictEqual(M.safeRoot('../a/../b/./c'), '../a/../b/./c/');
  ['https://evil.example/', 'HTTP://evil.example/', '//evil.example/', '/abs/path/', 'javascript:alert(1)', 'data:text/javascript,1',
    '..\\..\\x', '../\\evil.example/', '../../', '../../../etc/', '../a/../../b/', '%2e%2e/%2e%2e/', '..%2f..%2f', '../x?y=1', '../x#y',
    '../ex amples/', 'blob:https://x/1', '', null, undefined, 5].forEach((v) => assert.strictEqual(M.safeRoot(v), null, String(v)));
});

test('agent ids named like Object.prototype members work everywhere ids are keys', () => {
  const ids = ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__'];
  const s = { title: 'P', locked: true, lead: { id: 'lead', name: 'Lead' }, groups: [{ id: 'A', label: 'A', after: null }],
    roles: ids.map((id) => ({ id, name: id, group: 'A', handsTo: 'lead', serves: ['constructor'] })) };
  const plan = M.planOffice(s);
  ids.forEach((id) => assert.ok(plan.desks[id] && plan.desks[id].seat, id));
  assert.strictEqual(plan.desks.watch, undefined);
  assert.strictEqual(Object.getPrototypeOf(plan.desks), null);
  const history = M.dict();
  ids.forEach((id) => assert.strictEqual(M.pushSay(history, id, { state: 'working', say: 'hi ' + id }), true, id));
  assert.deepStrictEqual(Object.keys(history), ids);
  const st = M.dict(Object.fromEntries(ids.map((id) => [id, { state: 'done' }])));
  assert.strictEqual(st.__proto__.state, 'done'); // eslint-disable-line no-proto
  assert.strictEqual(M.teamProgress(s, st).done, ids.length);
  assert.strictEqual(M.teamProgress(s, M.dict()).done, 0, 'missing statuses are not found on the prototype');
  assert.deepStrictEqual(M.coverage(s, { requirements: [{ id: 'R1', text: 'x' }] }).unknownRefs.length, ids.length);
  const script = M.buildDemoScript(s);
  assert.ok(ids.every((id) => M.demoStatusesAt(script, 41.5)[id].state === 'done'));
});

// Exercise the real startup and live-probe code with a recording browser boundary.
function startup(search) {
  const vm = require('vm');
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const staticDeclaration = source.match(/  const STATIC = [^\n]+/)[0];
  const liveCode = source.slice(source.indexOf('  async function startLive()'), source.indexOf('  /* ---------- start ---------- */'));
  const startupCode = source.slice(source.indexOf("  $('#replay').hidden"), source.lastIndexOf('})();'));
  const calls = { polls: 0, fetches: 0, intervals: [] };
  const context = {
    params: new URLSearchParams(search), location: { protocol: 'https:' },
    window: { EventSource: function () {}, fetch: true },
    fetch: () => { calls.fetches++; return new Promise(() => {}); },
    setInterval: (fn, delay) => calls.intervals.push({ fn, delay }),
    setTimeout: () => 1, clearTimeout: () => {},
    $: () => ({}), ICON: { panel: '' }, S: { sidebar: false, demo: new URLSearchParams(search).get('demo') === '1' },
    LIVE: { on: false }, Date, performance: { now: () => 0 },
    setSidebar() {}, renderTop() {}, renderSidebar() {}, renderOffice() {}, startSupervision() {},
    poll: () => { calls.polls++; }, demoTick() {}, demoStart: 0, lastPoll: 0
  };
  vm.runInNewContext(staticDeclaration + '\n' + liveCode + '\n' + startupCode, context);
  return calls;
}

test('static embedding loads snapshots once without a server probe or repeated polling', () => {
  const calls = startup('?static=1');
  assert.strictEqual(calls.polls, 1, 'the complete initial poll still runs');
  assert.strictEqual(calls.fetches, 0, 'no health probe on a static host');
  assert.deepStrictEqual(calls.intervals.map((x) => x.delay), [1000], 'only the drawing refresh remains');
  calls.intervals.forEach((x) => x.fn());
  assert.strictEqual(calls.polls, 1);
});

test('normal panel startup keeps live probing and fallback snapshot polling', () => {
  const calls = startup('');
  assert.strictEqual(calls.fetches, 1);
  assert.strictEqual(calls.polls, 1);
  const polling = calls.intervals.find((x) => x.delay === 2000);
  assert.ok(polling);
  polling.fn();
  assert.strictEqual(calls.polls, 2);
  assert.strictEqual(startup('?static=0').fetches, 1, 'only explicit static=1 opts out');
});

test('static embedding preserves the demo timeline', () => {
  const calls = startup('?static=1&demo=1');
  assert.strictEqual(calls.fetches, 0);
  assert.deepStrictEqual(calls.intervals.map((x) => x.delay), [1000, 250]);
});

test('status updates and ready results cannot resize the office viewport', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const statusRules = Array.from(css.matchAll(/(?:^|\n)\s*\.status\s*\{([^}]+)\}/g), (m) => m[1]);
  assert.ok(statusRules.length >= 2, 'desktop and narrow status bands are explicit');
  statusRules.forEach((rule) => assert.match(rule, /(?:^|;)\s*height\s*:/, 'status text gets a fixed, responsive band'));
  assert.match(statusRules[0], /overflow-y:\s*auto/, 'long custom names remain accessible');
  assert.doesNotMatch(css, /body\.wide-side/, 'results keep the same sidebar width');
  assert.doesNotMatch(app, /classList\.toggle\('wide-side'/, 'a ready result does not resize the drawing');
});

test('result rounds: a run answer, then follow-ups, oldest first', () => {
  assert.deepStrictEqual(M.resultRounds(null), []);
  const one = M.resultRounds({ title: 'T', run: 1, markdown: 'A' });
  assert.deepStrictEqual(one.map((x) => [x.round, x.question, x.latest]), [[1, '', true]], 'a plain result is round 1');
  const r = { title: 'T', run: 2, round: 3, question: 'And Argos?', markdown: 'C',
    previous: [{ round: 1, title: 'T', markdown: 'A' }, { round: 2, question: 'Warranty?', markdown: 'B' }, null, { round: 9 }, 'x'] };
  const rounds = M.resultRounds(r);
  assert.deepStrictEqual(rounds.map((x) => [x.round, x.question, x.markdown, x.latest]),
    [[1, '', 'A', false], [2, 'Warranty?', 'B', false], [3, 'And Argos?', 'C', true]], 'broken entries are skipped');
  assert.strictEqual(M.resultRounds({ markdown: 'B', previous: [{ markdown: 'A' }] })[1].round, 2, 'missing round numbers count on');
  assert.strictEqual(M.resultRounds({ markdown: 'B', round: 1, previous: [{ round: 4, markdown: 'A' }] })[1].round, 5, 'the latest round is never behind an earlier one');
  assert.strictEqual(M.resultRounds({ markdown: 'B', round: '2', question: 7 })[0].question, '', 'wrong types are ignored');
  assert.deepStrictEqual(M.resultRounds({ markdown: 'C', previous: [{ markdown: 'A' }, { round: 1, markdown: 'B' }] }).map((x) => x.round), [1, 2, 3], 'duplicate numbers never share an anchor');
});

test('result drawer: slides out once per new result or round, never on opening a finished run', () => {
  assert.strictEqual(M.drawerDue(undefined, '1#1'), false, 'opened on a finished run: card only');
  assert.strictEqual(M.drawerDue(null, '1#1'), true, 'arrived while watching');
  assert.strictEqual(M.drawerDue('1#1', '1#1'), false, 'once per result');
  assert.strictEqual(M.drawerDue('1#1', '1#2'), true, 'a follow-up round is new');
  assert.strictEqual(M.drawerDue(null, null), false);
});

test('the result drawer is an overlay: it never resizes the office', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const drawer = css.match(/(?:^|\n)\.drawer\s*\{([^}]+)\}/);
  assert.ok(drawer, 'the drawer has a rule');
  assert.match(drawer[1], /position:\s*absolute/, 'out of the sheet grid flow');
  assert.match(css, /\.sheet\s*\{\s*position:\s*relative;\s*overflow-x:\s*clip;/, 'anchored to the sheet, clipped while closed');
  assert.doesNotMatch(css, /drawer-open[^{]*\.(sheet|stage|drawing-host)\b/, 'opening it does not restyle the drawing');
  assert.match(html, /id="drawer"[^>]*aria-hidden="true"[^>]*inert/, 'closed and out of the tab order at start');
  assert.doesNotMatch(app, /setDrawer\(true[^)]*\);[^\n]*setSidebar\(/, 'opening the drawer does not also resize the title block');
});

/* ---------- protocol 0.2: claim tags, verification, board ---------- */
const SUP = path.join(__dirname, 'fixtures', 'mock-supervise', 'deals');
const supLoad = (rel) => M.evalDataFile(fs.readFileSync(path.join(SUP, rel), 'utf8'));

test('claim tags: stripped, wrapped with the checker status, markdown inside still works', () => {
  const html = M.renderMarkdown('A <claim id="c1" src="a,b">**new** at £279</claim> deal.', { claims: { c1: 'supported' } });
  assert.strictEqual(html, '<p>A <span class="claim" data-claim="c1" data-status="supported" tabindex="0"><strong>new</strong> at £279</span> deal.</p>');
  assert.match(M.renderMarkdown('<claim id=c9>x</claim>'), /data-status="unchecked">x<\/span>/, 'no verification: unchecked, not focusable');
  assert.doesNotMatch(M.renderMarkdown('<claim id=c9>x</claim>'), /tabindex/);
  assert.match(M.renderMarkdown('<claim id="c1">x</claim>', { claims: { c1: 'evil"><script>' } }), /data-status="unchecked"/, 'statuses are a fixed list');
  assert.match(M.renderMarkdown('| a | b |\n|---|---|\n| <claim id="c2">cell</claim> | y |', { claims: { c2: 'partial' } }), /<td><span class="claim" data-claim="c2" data-status="partial" tabindex="0">cell<\/span><\/td>/);
  assert.match(M.renderMarkdown('<CLAIM ID="c3">upper</CLAIM>', { claims: { c3: 'contradicted' } }), /data-status="contradicted"/);
  assert.deepStrictEqual(M.claimSegments('a <claim id="k" src="s1, bad id ,s2">b</claim> c'), [{ text: 'a ' }, { claim: { id: 'k', src: ['s1', 's2'] }, text: 'b' }, { text: ' c' }]);
});

test('claim tags: hostile input renders as text and never injects markup', () => {
  const cases = [
    ['<claim id=\'x" onmouseover="alert(1)\'>t</claim>', '<p>&lt;claim id=&#39;x&quot; onmouseover=&quot;alert(1)&#39;&gt;t&lt;/claim&gt;</p>'],
    ['<claim id=x><script>alert(1)</script>', '<p>&lt;claim id=x&gt;&lt;script&gt;alert(1)&lt;/script&gt;</p>'],
    ['<claim id=a>outer <claim id=b>inner</claim> tail</claim>', '<p>&lt;claim id=a&gt;outer <span class="claim" data-claim="b" data-status="unchecked">inner</span> tail&lt;/claim&gt;</p>'],
    ['</claim> stray', '<p>&lt;/claim&gt; stray</p>'],
    ['<claim>no id</claim>', '<p>&lt;claim&gt;no id&lt;/claim&gt;</p>'],
    ['<claim id="ok" onclick="x()">t</claim>', '<p><span class="claim" data-claim="ok" data-status="unchecked">t</span></p>'],
    ['<claim id="a<b">t</claim>', '<p>&lt;claim id=&quot;a&lt;b&quot;&gt;t&lt;/claim&gt;</p>'],
    ['<claimx id=a>t</claim>', '<p>&lt;claimx id=a&gt;t&lt;/claim&gt;</p>']
  ];
  cases.forEach(([src, want]) => assert.strictEqual(M.renderMarkdown(src), want, src));
  const r = supLoad('outputs/result.js').MAS_RESULT;
  const html = M.renderMarkdown(r.markdown, { claims: { c1: 'supported' } });
  assert.doesNotMatch(html, /<img|<script|\son[a-z]+="/i);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('claim tags: linear time on 500 KB of hostile input', () => {
  const inputs = ['<claim '.repeat(75000), '<claim id=a>'.repeat(45000), ('<claim id="c1">x</claim> ').repeat(20000), '<'.repeat(500000), ('<claim id="' + 'a'.repeat(280)).repeat(1700)];
  inputs.forEach((s) => {
    const t = Date.now();
    M.renderMarkdown(s, { claims: { c1: 'supported' } });
    assert.ok(Date.now() - t < 1500, 'took ' + (Date.now() - t) + ' ms for ' + s.slice(0, 20));
  });
});

test('verification: normalised, summarised, and what the checkers caught', () => {
  const ver = M.normalizeVerification(supLoad('outputs/verification.js').MAS_VERIFICATION);
  assert.deepStrictEqual(ver.claims.map((c) => c.status), ['supported', 'partial', 'contradicted', 'unknown', 'unchecked', 'not-checkworthy']);
  assert.strictEqual(ver.evidence['best-deals'].urlHealth, 'hallucinated');
  assert.strictEqual(M.HEALTH[ver.evidence['best-deals'].urlHealth], 'dead');
  const c = M.credibility(ver.summary);
  assert.strictEqual(c.text, '6 claims · 1 supported · 1 partial · 1 contradicted · 1 unknown · 1 unchecked · links: 3 live, 1 dead, 1 blocked');
  assert.deepStrictEqual(c.segments.map((x) => x.status), ['supported', 'partial', 'contradicted', 'unknown', 'unchecked']);
  const board = M.normalizeBoard(supLoad('mas/board.js').MAS_BOARD);
  const caught = M.checkersCaught(ver, board);
  assert.deepStrictEqual(caught.claims.map((x) => x.claimId), ['c3', 'c4']);
  assert.deepStrictEqual(caught.reviews.map((x) => x.target), ['marketplace-finder']);
  assert.deepStrictEqual(Object.keys(M.claimStatusMap(ver)), ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
  assert.strictEqual(M.normalizeVerification(null), null);
  const bad = M.normalizeVerification({ claims: [{ claimId: 'z', status: 'weird', verdicts: [null, { status: 'x' }] }], evidence: [{ sourceId: 's', urlHealth: 'boom', grade: 'Z' }], summary: { claims: -3 } });
  assert.deepStrictEqual([bad.claims[0].status, bad.claims[0].verdicts.length, bad.evidence.s.urlHealth, bad.evidence.s.grade, bad.summary.claims], ['unchecked', 1, null, null, 0]);
});

test('board: reviewer pairs with their last verdict, the ledger line, usage', () => {
  const s = supLoad('mas/structure.js').MAS_STRUCTURE, board = M.normalizeBoard(supLoad('mas/board.js').MAS_BOARD);
  assert.deepStrictEqual(M.reviewPairs(s, board).map((p) => [p.from, p.to, p.verdict, p.bad]), [['catch-checker', 'retail-finder', 'accept', false], ['catch-checker', 'marketplace-finder', 'revise', true]]);
  assert.deepStrictEqual(M.reviewPairs(s, null).map((p) => p.to), ['retail-finder', 'marketplace-finder'], 'from the team design alone');
  assert.deepStrictEqual(M.reviewPairs({ roles: [{ id: 'x', reviewerOf: ['x'] }] }, null), [], 'nobody reviews themselves');
  assert.strictEqual(M.ledgerLine(board.ledger, (id) => (id === 'catch-checker' ? 'Catch checker' : id)), 'Progressing · next: Catch checker');
  assert.strictEqual(M.ledgerLine({ looping: true, stalls: 2 }), 'Looping · 2 stalls');
  assert.strictEqual(M.ledgerLine(null), '');
  const u = M.usageInfo(board.usage['marketplace-finder']);
  assert.strictEqual(u.text, '64k in · 6.2k out · 7 turns');
  assert.strictEqual(u.warn, 'Usage limit: allowed warning · resets 14:00');
  assert.strictEqual(M.usageInfo(board.usage.lead).text, '41k in · 5.3k out · $0.62 · 4 turns');
  assert.strictEqual(M.usageTotal(board.usage).text, '226k tokens · $0.62 across 4 agents');
  assert.strictEqual(M.backendLabel('claude-code'), 'Claude Code');
  assert.strictEqual(M.backendLabel('codex'), 'Codex');
  assert.strictEqual(M.backendLabel('other'), 'other');
  assert.strictEqual(M.normalizeBoard('x'), null);
});

test('tool entries: strings or {name, effect}; ask and deny are said in words', () => {
  assert.deepStrictEqual(M.toolInfo('web search'), { name: 'web search', effect: 'allow', text: 'web search' });
  assert.strictEqual(M.toolInfo({ name: 'browse the web', effect: 'ask' }).text, 'browse the web (asks first)');
  assert.strictEqual(M.toolInfo({ name: 'run commands', effect: 'deny' }).text, 'run commands (not allowed)');
  assert.strictEqual(M.toolInfo({ name: 'x', effect: 'weird' }).effect, 'allow');
  assert.deepStrictEqual([M.toolInfo({}), M.toolInfo(null), M.toolInfo(5), M.toolInfo('')], [null, null, null, null]);
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.doesNotMatch(app, /\(m\.tools \|\| \[\]\)\.join/, 'never prints [object Object]');
});

test('the panel loads the 0.2 modules with plain script tags, and reads 0.2 snapshots only for SDK projects', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const order = ['model.js', 'inbox.js', 'office.js', 'app.js'].map((f) => html.indexOf('<script src="' + f + '"></script>'));
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), 'model, inbox, office, app in order');
  assert.doesNotMatch(html, /\son[a-z]+=/i, 'no inline event handlers (CSP script-src self)');
  assert.match(app, /if \(M\.isSdk\(next\)\) await Promise\.all\(Object\.keys\(EXTRA\)/);
  assert.doesNotMatch(app, /console\.(log|debug)\(/);
  assert.doesNotMatch(app, /token\(\)[^;\n]*(innerHTML|textContent|href|src)/, 'the token never reaches the page');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
