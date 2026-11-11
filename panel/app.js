/* MAS Office · live panel — a drawing sheet of a multi-agent team.
   The team is run elsewhere (an AI assistant following AGENTS.md, or a program using an SDK); this page reads the
   project's snapshot files. Over http(s) from `mas-office serve` it also listens to the event stream, and with the
   server's access token it can answer the team: the "needs you" inbox, messages to an agent, Stop, new runs.
   Without a token (file://, a website, a plain static server) the same views are shown read-only. */
(function () {
  'use strict';
  const M = window.MASModel;
  const I = window.MASInbox;
  const esc = M.esc;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const params = new URLSearchParams(location.search);
  // The access token arrives once as ?token=: keep it in this tab's sessionStorage and take it out of the address bar
  // (and so out of history, bookmarks and screenshots). It is never written into the page, a link or a log.
  const TOKEN_KEY = 'mas-office-token';
  let memToken = null;
  if (params.has('token')) {
    memToken = params.get('token') || null;
    try { if (memToken) sessionStorage.setItem(TOKEN_KEY, memToken); } catch (e) { /* storage blocked: keep it in memory */ }
    params.delete('token');
    const q = params.toString();
    try { history.replaceState(history.state, '', location.pathname + (q ? '?' + q : '') + location.hash); } catch (e) { /* not allowed here */ }
  }
  const token = () => { if (memToken) return memToken; try { return sessionStorage.getItem(TOKEN_KEY); } catch (e) { return null; } };
  // ?root= (examples) and ?demo=1 show one fixed project; otherwise home/projects.js says which MAS to follow.
  // Only a relative folder inside the workspace is accepted (scripts load from it); anything else means normal mode.
  const FIXED_ROOT = params.get('root') === null ? null : M.safeRoot(params.get('root'));
  let ROOT = FIXED_ROOT || '../';
  const FIXED = !!FIXED_ROOT || params.get('demo') === '1';
  // Published examples are immutable: load once, without live-server probing or snapshot polling.
  const STATIC = params.get('static') === '1';
  // ?view=office: embed mode for a host app (the Mac app's WKWebView, an iframe). Only the office drawing is shown,
  // filling the view; the host draws the inbox, drawers and controls itself and talks to the drawing through
  // window.MASEmbed (select, highlightStage) and the messages embedPost sends. Keys and the result drawer are off.
  const EMBED = M.embedOptions(location.search);
  if (EMBED) document.body.classList.add('embed');
  if (EMBED && EMBED.clear) document.body.classList.add('embed-clear');

  const FILES = { env: 'mas/env.js', state: 'mas/state.js', task: 'me/task.js', structure: 'mas/structure.js', result: 'outputs/result.js' };
  const GLOBALS = { env: 'MAS_ENV', state: 'MAS_STATE', task: 'MAS_TASK', structure: 'MAS_STRUCTURE', result: 'MAS_RESULT' };
  // Protocol 0.2 snapshots. Only programs (state.mode "sdk") write them, so they are read only for those projects:
  // a kit project or an example never asks for files it cannot have.
  const EXTRA = { inbox: 'mas/inbox.js', board: 'mas/board.js', verification: 'outputs/verification.js' };
  const EXTRA_GLOBALS = { inbox: 'MAS_INBOX', board: 'MAS_BOARD', verification: 'MAS_VERIFICATION' };
  const DOCS = Object.keys(FILES).concat(Object.keys(EXTRA));
  const BUSY = ['working', 'flagged', 'handoff'];
  const ENDED = M.FINISHED; // done or failed
  const STEPS = ['Describe', 'Design', 'Refine & lock', 'Run'];
  const GROUP = ['#E04E2A', '#2B57B5', '#D89A12', '#5E8C57', '#8E4C8A', '#1F8A84'];
  const ICON = {
    warn: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2 14.6 13.6H1.4Z" fill="#D89A12" stroke="#1B1F23" stroke-width="1.2" stroke-linejoin="round"/><path d="M8 6.4v3.4M8 11.4v.4" stroke="#1B1F23" stroke-width="1.4" stroke-linecap="round"/></svg>',
    tick: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="1.5" width="13" height="13" fill="#5E8C57" stroke="#1B1F23" stroke-width="1.2"/><path d="M4.6 8.2 7 10.6l4.4-5" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="square"/></svg>',
    back: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8H3.5M7.5 3.5 3 8l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    panel: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 2.75h12.5v10.5H1.75zM10.25 2.75v10.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    expand: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.25h4.25V6.5M6.5 13.75H2.25V9.5M13.75 2.25 9 7M2.25 13.75 7 9" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    shrink: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.75 6.5H9.5V2.25M2.25 9.5H6.5v4.25M9.5 6.5l4.25-4.25M6.5 9.5l-4.25 4.25" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    close: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    browser: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.75" y="2.75" width="12.5" height="10.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M1.75 5.75h12.5" stroke="currentColor" stroke-width="1.5"/><circle cx="3.9" cy="4.25" r=".6" fill="currentColor"/></svg>',
    globe: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M1.8 8h12.4M8 1.8c-3 3.4-3 9 0 12.4M8 1.8c3 3.4 3 9 0 12.4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    folder: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 3.25h4.5l1.5 1.5h6.5v8H1.75z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    ask: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.6" fill="#BDCBEA" stroke="#1B1F23" stroke-width="1.2"/><path d="M6 6.3a2 2 0 1 1 2.6 1.9c-.5.2-.6.5-.6 1v.5M8 11.3v.5" fill="none" stroke="#1B1F23" stroke-width="1.4" stroke-linecap="round"/></svg>',
    fail: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="1.5" width="13" height="13" fill="#F4C2B1" stroke="#1B1F23" stroke-width="1.2"/><path d="M5.2 5.2l5.6 5.6M10.8 5.2l-5.6 5.6" stroke="#1B1F23" stroke-width="1.6" stroke-linecap="square"/></svg>'
  };
  // The icon for a status that carries a flag (a found problem, a question for you, a failure), else ''.
  const flagIcon = (st) => { const f = M.flagInfo(st); return f ? ICON[f.icon] : ''; };
  const narrow = () => window.innerWidth <= 1100;
  const DRAWER_DELAY = 2500; // ms between a result arriving and the drawer sliding out
  const S = {
    demo: params.get('demo') === '1', data: {}, statuses: M.dict(), history: M.dict(), feed: [], timing: M.dict(), run: { start: 0, end: 0 },
    sigs: {}, lastChange: 0, loadedOnce: false, warnings: {}, selected: null, phase: undefined,
    sidebar: params.get('sidebar') ? params.get('sidebar') === 'open' : !narrow(), userSidebar: !!params.get('sidebar'), autoRun: undefined, seenKeys: new Set(), drawer: false, drawerFull: false,
    home: null, current: undefined, index: false,
    // supervision: the drawer's mode (result | agent | stage), the agent or stage it shows, its tab
    drawerMode: 'result', drawerAgent: null, stage: null, agentTab: 'transcript', v: null,
    // the inbox: when this page first saw each request, what it answered (requestId → {cmdId, label}), local command
    // records (cmdId → {state, error, …}), expanded folds, hints, HCI timings (requestId → {since, seen})
    firstSeen: M.dict(), answers: M.dict(), local: M.dict(), expand: new Set(), hint: M.dict(), tele: M.dict(), announced: null,
    tx: M.dict(), out: M.dict(), stops: M.dict(), notify: false, notifyNote: '', notified: new Set(), osNotes: M.dict(), runPost: null, claim: null
  };
  // A different MAS is now followed: everything per project starts over, as if the page had just opened.
  function resetProject() {
    Object.assign(S, { data: {}, statuses: M.dict(), history: M.dict(), feed: [], timing: M.dict(), run: { start: 0, end: 0 }, sigs: {}, selected: null,
      phase: undefined, warnings: {}, loadedOnce: false, autoRun: undefined, seenKeys: new Set(),
      stage: null, v: null, firstSeen: M.dict(), answers: M.dict(), hint: M.dict(), tele: M.dict(), announced: null, tx: M.dict(), out: M.dict(), stops: M.dict(), runPost: null });
    document.body.classList.remove('isolate');
    clearTimeout(S.drawerTimer);
    setDrawer(false);
    S.drawerMode = 'result';
    office.reset();
  }

  /* ---------- reading data files (script tags work on file://) ---------- */
  function loadScript(path, url) {
    return new Promise((resolve) => {
      $$('script[data-mas="' + path + '"]').forEach((s) => s.remove());
      const s = document.createElement('script');
      s.dataset.mas = path;
      s.src = (url || ROOT + path) + '?t=' + Date.now();
      let done = false;
      const fin = (st) => { if (!done) { done = true; clearTimeout(timer); resolve(st); } };
      const timer = setTimeout(() => fin('missing'), 4000);
      s.onload = () => fin('ok');
      s.onerror = () => fin('missing');
      document.head.appendChild(s);
    });
  }
  async function readData(path, globalName, statusId, url) {
    if (!statusId) window[globalName] = undefined;
    const st = await loadScript(path, url);
    const all = window.MAS_STATUS;
    const value = statusId ? (all && Object.prototype.hasOwnProperty.call(all, statusId) ? all[statusId] : undefined) : window[globalName];
    // Loaded but assigned nothing → a typo while the assistant was writing: keep the last good version.
    return { st: st === 'ok' && value === undefined ? 'broken' : st, value };
  }
  let loading = false, pollAgain = false, lastPoll = 0;
  // `soon`: a change was announced on the event stream; if a read is under way, read again right after it.
  async function poll(soon) {
    if (loading) { if (soon) pollAgain = true; return; }
    loading = true; lastPoll = Date.now();
    try {
      if (!FIXED && !(await followHome())) return; // index sheet: no project to read
      const next = {}, warnings = {};
      await Promise.all(Object.keys(FILES).map(async (k) => {
        if (k === 'env' && S.home) { // shared tool test in home/, falling back to the MAS's own copy
          const h = await readData('home/env.js', 'MAS_ENV', null, '../home/env.js');
          if (h.st === 'ok') { next.env = M.clone(h.value); return; }
        }
        const r = await readData(FILES[k], GLOBALS[k]);
        if (r.st === 'broken') { warnings[FILES[k]] = true; next[k] = S.data[k]; } else next[k] = M.clone(r.value);
      }));
      if (M.isSdk(next)) await Promise.all(Object.keys(EXTRA).map(async (k) => {
        const r = await readData(EXTRA[k], EXTRA_GLOBALS[k]);
        if (r.st === 'broken') { warnings[EXTRA[k]] = true; next[k] = S.data[k]; } else next[k] = M.clone(r.value);
      }));
      if (next.structure) next.structure = M.withDynamicGroup(next.structure); // agents spawned at runtime get their own room
      let statuses = S.statuses;
      if (!S.demo) {
        statuses = M.dict();
        const s = next.structure;
        if (s && s.locked) {
          window.MAS_STATUS = M.dict();
          const ids = ['lead'].concat((s.roles || []).map((r) => r.id));
          await Promise.all(ids.map(async (id) => {
            const path = 'mas/status/' + encodeURIComponent(id) + '.js'; // ids come from the files: never let one leave the folder
            const r = await readData(path, 'MAS_STATUS', id);
            if (r.st === 'broken') { warnings[path] = true; if (S.statuses[id]) statuses[id] = S.statuses[id]; } else if (r.value) statuses[id] = M.clone(r.value);
          }));
        }
      }
      S.warnings = warnings;
      apply(next, statuses);
    } finally {
      loading = false;
      if (pollAgain) { pollAgain = false; setTimeout(() => poll(true), 0); }
    }
  }
  // Read home/projects.js; returns true when a project should be read (current set, or legacy single-project folder).
  async function followHome() {
    window.MAS_HOME = undefined;
    const st = await loadScript('home/projects.js', '../home/projects.js');
    const home = st === 'ok' && window.MAS_HOME === undefined ? S.home : st === 'ok' ? M.normalizeHome(window.MAS_HOME) : null;
    const homeSig = sigOf(home);
    const embedProject = EMBED && EMBED.project; // the host chose the project: home/projects only lists them
    const cur = embedProject || (home ? home.current : '');
    if (cur !== S.current) { if (S.current !== undefined) resetProject(); S.current = cur; }
    const homeChanged = homeSig !== S.sigs.home;
    S.home = home; S.sigs.home = homeSig;
    ROOT = embedProject ? '../' + embedProject + '/' : !home ? '../' : '../' + home.current + '/';
    S.index = !embedProject && !!home && !home.current;
    if (!S.index) return true;
    const env = await readData('home/env.js', 'MAS_ENV', null, '../home/env.js');
    const envSig = sigOf(env.value);
    if (homeChanged || envSig !== S.sigs.env || !S.loadedOnce) {
      S.data = { env: M.clone(env.value) }; S.sigs.env = envSig; S.loadedOnce = true; S.lastChange = Date.now();
      render();
    }
    return false;
  }
  const sigOf = (v) => JSON.stringify(v);
  const statusSig = (st) => sigOf(Object.keys(st).sort().map((id) => [id, M.statusKey(st[id]), st[id].progress]));
  function apply(next, statuses) {
    let changed = false;
    DOCS.forEach((k) => { const sg = sigOf(next[k]); if (sg !== S.sigs[k]) { changed = true; S.sigs[k] = sg; } });
    S.data = next;
    if (!S.demo) {
      const ss = statusSig(statuses);
      if (ss !== S.sigs.statuses) { changed = true; S.sigs.statuses = ss; trackStatuses(statuses); }
    }
    const phase = next.state && next.state.phase;
    if (phase !== S.phase) {
      if (S.phase !== undefined && phase) S.feed.unshift({ id: null, state: 'phase', say: M.phaseLine(next), at: Date.now() });
      S.phase = phase;
    }
    if (changed || !S.loadedOnce) {
      if (S.loadedOnce || Object.values(next).some(Boolean)) S.lastChange = Date.now();
      S.loadedOnce = true;
      render();
    }
  }
  // Feed, message history and the panel's own clocks (agents' timestamps are not trusted).
  function trackStatuses(next) {
    const now = Date.now();
    Object.keys(next).forEach((id) => {
      const cur = next[id], prev = S.statuses[id];
      if (M.statusKey(cur) === M.statusKey(prev)) return;
      const t = S.timing[id] || (S.timing[id] = {});
      if (BUSY.includes(cur.state) && (!t.start || t.end)) { t.start = now; t.end = 0; }
      if (ENDED.includes(cur.state) && t.start && !t.end) t.end = now;
      if (cur.state === 'idle') delete S.timing[id];
      if (cur.say || cur.flag) S.feed.unshift({ id, state: cur.state, say: cur.say, flag: cur.flag, flagKind: cur.flagKind, to: cur.to, at: now });
      M.pushSay(S.history, id, cur);
    });
    S.feed.length = Math.min(S.feed.length, 30);
    const vals = Object.values(next);
    if (!vals.length || vals.every((v) => v.state === 'idle')) S.run = { start: 0, end: 0 };
    else if (vals.some((v) => v.state !== 'idle' && !ENDED.includes(v.state)) && (!S.run.start || S.run.end) && !(next.lead && ENDED.includes(next.lead.state))) S.run = { start: now, end: 0 };
    if (S.run.start && !S.run.end && next.lead && ENDED.includes(next.lead.state)) S.run.end = now;
    S.statuses = next;
  }

  /* ---------- effective data ---------- */
  function data() {
    if (!S.demo) return S.data;
    const base = S.data.structure ? S.data : M.DEMO_DATA;
    const leadDone = S.statuses.lead && S.statuses.lead.state === 'done';
    const result = base.result || null;
    return Object.assign({}, base, {
      state: { step: 4, phase: leadDone ? 'done' : 'running', next: 'A replay of an example run.', locked: true },
      result: result ? Object.assign({}, result, { work: M.normalizeWork(result.work).length ? result.work : M.demoWork(base.structure) }) : null
    });
  }
  const struct = () => data().structure || null;
  function resultInfo() {
    const d = data(), r = d.result;
    if (!r) return null;
    const leadDone = S.statuses.lead && S.statuses.lead.state === 'done';
    const phase = d.state && d.state.phase;
    const busy = Object.values(S.statuses).some((x) => !ENDED.includes(x.state) && x.state !== 'idle');
    const ready = S.demo ? leadDone : phase === 'done' || phase === 'failed' || leadDone || (!phase && !busy);
    return ready ? resultKeys(r) : null;
  }
  // A follow-up round is a new result, not a new run: the drawer keys on run + round, the office on the run only.
  function resultKeys(r) {
    const runKey = S.demo ? 'demo-' + demoLoop + '-' + (S.replays || 0) : String(r.run != null ? r.run : r.title); // a demo replay is a new run
    const rounds = M.resultRounds(r);
    return { r, rounds, runKey, key: runKey + '#' + rounds[rounds.length - 1].round };
  }
  function modeInfo() {
    const env = data().env, m = env && env.subagents;
    if (m === 'parallel') return { key: 'parallel', short: 'Real agents', long: 'real agents, each with its own context', tip: 'Each role runs as its own agent with its own context; roles in the same group work at the same time.' };
    if (m === 'sequential') return { key: 'sequential', short: 'Role-play', long: 'role-play, one assistant plays each role in turn', tip: 'The drawing still shows each role at its own desk, but they are not separate agents: one assistant plays every role, one after another.' };
    return null;
  }

  /* ---------- helpers ---------- */
  const cache = new WeakMap();
  function setHTML(node, html) { if (cache.get(node) !== html) { cache.set(node, html); node.innerHTML = html; } }
  const num = (t) => '<span class="num">' + esc(t) + '</span>';
  const rid = (id, task) => {
    const r = ((task && task.requirements) || []).find((x) => x.id === id);
    return '<span class="rid" data-req="' + esc(id) + '" title="' + esc(r ? r.text : 'Not in your task') + '">' + esc(id) + '</span>';
  };
  const resolveLink = (u) => ROOT + 'outputs/' + u.replace(/^\.\//, ''); // relative to outputs/ (formats.md)
  const md = (text) => M.renderMarkdown(text || '', { resolveLink });
  // The result in the drawer: claim spans carry their checker status.
  const mdClaims = (text) => M.renderMarkdown(text || '', { resolveLink, claims: V().claimMap });
  const nameOf = (s, id) => { if (!id) return 'Update'; const m = s && M.member(s, id); return m ? m.name : id === 'lead' ? 'Lead' : id; };
  const groupColor = (s, gid) => { const i = M.orderGroups(s).findIndex((g) => g.id === gid); return GROUP[(i < 0 ? 0 : i) % GROUP.length]; };
  const clock = M.formatClock;
  const stamp = (at) => (S.run.start && at >= S.run.start ? clock(at - S.run.start) : new Date(at).toTimeString().slice(0, 5));

  /* ---------- top rule + status sentence ---------- */
  // Step of a listed MAS: "04 Run", or "done" once its result is in.
  const stepOf = (p) => (p.phase === 'done' || p.phase === 'failed' ? esc(p.phase) : p.step ? num('0' + p.step) + ' ' + esc(STEPS[p.step - 1]) : '—');
  // While the student chooses a MAS in the chat, the sheet shows the folder's index instead of an office.
  function renderIndexTop() {
    const n = S.home.projects.length, mode = modeInfo();
    $('#proj').textContent = n ? n + ' MAS in this folder' : 'No MAS yet';
    setHTML($('#steps'), STEPS.map((name, i) => '<li>' + num('0' + (i + 1)) + '<span class="lbl">' + esc(name) + '</span></li>').join(''));
    setHTML($('#steps-short'), '');
    const mn = $('#mode-note');
    mn.hidden = !mode;
    if (mode) { mn.textContent = mode.short; mn.title = mode.tip; }
    $('#headline').textContent = n ? 'Choose a MAS in the chat.' : 'No MAS yet.';
    setHTML($('#subline'), n ? num(String(n)) + ' MAS in this folder<span class="sep" aria-hidden="true"> · </span>type a name, or <code>new</code>, in your assistant'
      : 'Type <code>next</code> in your assistant to start your first one.');
    setHTML($('#fresh'), (LIVE.on ? '<span class="live" title="Connected to mas-office serve: changes appear as they happen">Live</span>' : '') + 'updated ' + num(M.timeAgo(Date.now() - S.lastChange)));
  }
  function indexHtml() {
    const list = S.home.projects;
    const counts = (p) => [p.agents != null ? num(String(p.agents)) + ' agents' : '', p.runs != null ? num(String(p.runs)) + (p.runs === 1 ? ' run' : ' runs') : ''].filter(Boolean).join(' · ');
    const rows = list.map((p, i) => '<tr><td>' + num(String(i + 1).padStart(2, '0')) + '</td><td><span class="ix-title">' + esc(p.title) + '</span><span class="ix-folder num">' + esc(p.folder) + '/</span>' +
      (counts(p) ? '<span class="ix-meta">' + counts(p) + '</span>' : '') + '</td>' +
      '<td>' + stepOf(p) + '</td><td class="c-n">' + (p.agents != null ? num(String(p.agents)) : '—') + '</td><td class="c-n">' + (p.runs != null ? num(String(p.runs)) : '—') + '</td></tr>').join('');
    return '<table class="sheet-index"><caption>Sheet index</caption><thead><tr><th scope="col">No.</th><th scope="col">MAS</th><th scope="col">Step</th><th scope="col" class="c-n">Agents</th><th scope="col" class="c-n">Runs</th></tr></thead><tbody>' +
      (rows || '<tr><td>' + num('—') + '</td><td colspan="4" class="quiet">This folder has no MAS yet. Your assistant adds the first one here.</td></tr>') + '</tbody></table>' +
      '<div class="title-block ix-title-block">' + titleBlock() + '</div>'; // the sheet's own title block, bottom right
  }
  function folderHtml() {
    const list = S.home.projects;
    if (S.index) return '<h2>MAS in this folder ' + num(String(list.length)) + '</h2><p class="quiet">Your assistant asks which one to work on. This sheet follows its answer and draws that office.</p>';
    return '<h2>MAS in this folder ' + num(String(list.length)) + '</h2><ol class="mas-list">' + list.map((p) => {
      const cur = p.folder === S.home.current;
      return '<li' + (cur ? ' class="cur" aria-current="true"' : '') + '><span class="ml-title">' + esc(p.title) + '</span><span class="ml-step">' + stepOf(p) + '</span>' + (cur ? '<span class="ml-now">shown</span>' : '') + '</li>';
    }).join('') + '</ol>';
  }
  function renderTop() {
    if (S.index) return renderIndexTop();
    const d = data(), p = M.deriveProgress(d), s = struct(), mode = modeInfo(), sdk = M.isSdk(d), phase = d.state && d.state.phase;
    document.body.classList.toggle('sdk', sdk); // no four-step bar and no "type next" hints: a program runs this team
    $('#proj').textContent = (s && s.title) || (d.task && d.task.title) || (sdk && S.current) || 'Your project';
    setHTML($('#steps'), STEPS.map((name, i) => {
      const n = i + 1, cls = n < p.step || (p.done && n === 4) ? 'done' : n === p.step ? 'now' : '';
      return '<li class="' + cls + '"' + (cls === 'now' ? ' aria-current="step"' : '') + '>' + num('0' + n) + '<span class="lbl">' + esc(name) + '</span></li>';
    }).join(''));
    setHTML($('#steps-short'), num(p.step + '/4'));
    const mn = $('#mode-note');
    mn.hidden = !mode;
    if (mode) { mn.textContent = mode.short; mn.title = mode.tip; }
    $('#headline').textContent = M.headline(d, S.statuses);
    const tp = M.teamProgress(s, S.statuses), parts = [];
    const lead = S.statuses.lead;
    if (s && s.locked && (phase === 'failed' || (lead && lead.state === 'failed'))) // why it failed comes first
      parts.push(esc((lead && lead.state === 'failed' && (lead.flag || lead.say)) || (d.state && d.state.next) || 'The run failed.'));
    const over = !!S.run.end || phase === 'failed' || !!(lead && ENDED.includes(lead.state)); // the run has ended
    if (s && s.locked && (S.run.start || tp.finished)) {
      if (tp.active && !over) parts.push(esc(tp.active.group.id === 'dyn' ? M.groupCaption(tp.active.group, 0) : 'Group ' + tp.active.group.id));
      const busy = ['lead'].concat((s.roles || []).map((r) => r.id)).filter((id) => S.statuses[id] && BUSY.includes(S.statuses[id].state)).length;
      if (over || (tp.total && tp.finished === tp.total)) parts.push(num(String(tp.done)) + ' of ' + num(String(tp.total)) + ' roles done' + (tp.failed ? ' · ' + num(String(tp.failed)) + ' failed' : ''));
      else parts.push(num(String(busy)) + ' of ' + num(String((s.roles || []).length + 1)) + ' working' + (tp.failed ? ' · ' + num(String(tp.failed)) + ' failed' : ''));
      if (S.run.start) parts.push(num(clock((S.run.end || Date.now()) - S.run.start)) + (S.run.end ? ' total' : ' elapsed'));
    } else if (!parts.length && d.state && d.state.next) parts.push(sdk ? esc(d.state.next) : M.formatHint(d.state.next));
    if (mode && s) parts.push('<span title="' + esc(mode.tip) + '">' + esc(mode.long) + '</span>');
    setHTML($('#subline'), parts.join('<span class="sep" aria-hidden="true"> · </span>'));
    const w = Object.keys(S.warnings || {});
    const fresh = $('#fresh');
    setHTML(fresh, (w.length ? '<span class="warn" title="' + esc(w.join(', ')) + ' could not be read. Showing the last good version.">' + ICON.warn + 'file being written</span>' : '') +
      (LIVE.on ? '<span class="live" title="Connected to mas-office serve: changes appear as they happen">Live</span>' : '') +
      (S.demo ? 'demo replay' : Object.values(S.data).some(Boolean) ? 'updated ' + num(M.timeAgo(Date.now() - S.lastChange)) : 'waiting for files'));
  }

  /* ---------- the drawing ---------- */
  const office = window.MASOffice.create($('#drawing-host'), { onSelect: (id) => select(id) });
  /* ---------- embed mode: the host app's side of the drawing ---------- */
  // Tell the host (WKWebView message handler `masOffice`, or the parent of an iframe): {type: 'ready'} once,
  // {type: 'select', agentId} when the person clicks an agent (agentId null: clicked the empty office).
  function embedPost(msg) {
    if (!EMBED) return;
    try { const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.masOffice; if (h) h.postMessage(msg); } catch (e) { /* no native host */ }
    try { if (window.parent && window.parent !== window) window.parent.postMessage(msg, '*'); } catch (e) { /* no parent frame */ }
  }
  if (EMBED) {
    // The host's own selection: highlight it here without echoing a message back.
    window.MASEmbed = Object.freeze({
      select(id) { const v = typeof id === 'string' && id ? id : null; S.selected = v; S.stage = null; office.setSelected(v); if (S.loadedOnce) renderOffice(); },
      highlightStage(gid) { S.stage = typeof gid === 'string' && gid ? gid : null; if (S.loadedOnce) renderOffice(); }
    });
    embedPost({ type: 'ready' });
  }
  function renderOffice() {
    $('#drawing-host').hidden = S.index;
    $('#index-sheet').hidden = !S.index;
    if (S.index) { setHTML($('#index-sheet'), indexHtml()); return; }
    const d = data(), s = struct(), phase = d.state && d.state.phase;
    let a;
    if (!s) a = { mode: 'empty', structure: null, statuses: { lead: { state: 'working', say: M.isSdk(d) ? 'Waiting for the first run' : d.task ? 'Reading your task…' : 'Listening…' } } };
    else if (!s.locked && !S.demo) a = { mode: 'draft', structure: s, statuses: { lead: { state: 'working', say: 'Planning your team…' } } };
    else a = { mode: 'live', structure: s, statuses: S.statuses, entrance: phase === 'locked' && !Object.keys(S.statuses).length, runKey: (resultInfo() || {}).runKey };
    office.setData(Object.assign({ task: d.task, timing: S.timing }, a));
    // raised hands with wait clocks, reviewer → target lines, a selected stage
    const v = V(), live = a.mode === 'live', waits = M.dict();
    if (live) v.waiting.forEach((w) => { if (isFinite(w.since)) waits[w.id] = w.since; });
    office.setOverlay({ waits, pairs: live ? M.reviewPairs(s, v.board) : [], highlight: live && S.stage ? stageMembers(S.stage) : null });
  }

  /* ---------- title-block sidebar ---------- */
  function setSidebar(open) {
    S.sidebar = open;
    if (open) $('#sb-toggle').classList.remove('news');
    document.body.classList.toggle('sb-closed', !open);
    $('#sb-toggle').setAttribute('aria-expanded', String(open));
  }
  // Select an agent: in a running team its drawer opens over the office (transcript, outputs, chat);
  // while the team is still a draft, the title block shows its role card as before. Selecting it again closes it.
  function select(id, opts) {
    if (id && id === S.selected && !(opts && opts.keep)) id = null;
    if (EMBED) { // the host opens its own agent view: here the drawing only marks the selection
      S.selected = id || null; S.stage = null; office.setSelected(S.selected); renderOffice();
      embedPost({ type: 'select', agentId: S.selected });
      return;
    }
    const live = !!(struct() && struct().locked) && !S.index;
    S.selected = id;
    S.stage = null;
    office.setSelected(id);
    if (id && live) {
      S.drawerMode = 'agent'; S.drawerAgent = id;
      loadTranscript(id); loadOutputs(id);
      setDrawer(true, opts);
      renderDrawer(resultInfo());
    } else {
      if (S.drawer && S.drawerMode !== 'result') setDrawer(false, { focus: true });
      if (id && narrow() && window.innerWidth > 600) setSidebar(true);
    }
    renderOffice();
    renderSidebar();
    if (id && !live) { const c = $('#cells'); if (c) c.scrollTop = 0; }
  }
  function renderSidebar() {
    document.body.classList.toggle('index', S.index); // the index is one full-width sheet: no title-block column
    const folder = $('#c-folder');
    folder.hidden = !S.home || (!S.index && S.home.projects.length < 2);
    if (!folder.hidden) setHTML(folder, folderHtml());
    ['#c-task', '#c-team', '#c-activity'].forEach((k) => { $(k).hidden = S.index; });
    renderInbox();
    renderRunCell();
    if (S.index) {
      $('#c-role').hidden = true; $('#c-result').hidden = true;
      document.body.classList.remove('isolate');
      setDrawer(false);
      setHTML($('#title-block'), titleBlock());
      return;
    }
    const role = $('#c-role'), sel = S.selected;
    role.hidden = !sel;
    if (sel) setHTML(role, roleCard(sel));
    const ri = resultInfo();
    $('#c-result').hidden = !ri || !!sel;
    if (ri && !sel) setHTML($('#c-result'), resultCard(ri));
    if (!ri && S.drawerMode === 'result') setDrawer(false);
    renderDrawer(ri);
    $('#c-task').hidden = M.isSdk(data()) && !data().task; // an SDK run may have no task file
    setHTML($('#c-task'), taskHtml());
    setHTML($('#c-team'), teamHtml());
    setHTML($('#c-activity'), activityHtml());
    setHTML($('#title-block'), titleBlock());
    // isolate the selected thread in the sidebar too
    const m = sel && struct() && M.member(struct(), sel), serves = new Set((m && m.serves) || []);
    document.body.classList.toggle('isolate', !!sel);
    $$('[data-req]').forEach((el) => el.classList.toggle('on', serves.has(el.getAttribute('data-req'))));
    $$('[data-select]').forEach((el) => el.classList.toggle('on', el.getAttribute('data-select') === sel));
  }
  function taskHtml() {
    const d = data(), task = d.task, s = struct();
    if (!task) return '<h2>Task</h2><p class="quiet">Your requirements appear here once you have described the task to your assistant.</p>';
    const cov = M.coverage(s, task), reqs = task.requirements || [];
    return '<h2>Task ' + (reqs.length ? num(reqs[0].id + (reqs.length > 1 ? '–' + reqs[reqs.length - 1].id : '')) : '') + '</h2>' + (task.summary ? '<p class="summary">' + esc(task.summary) + '</p>' : '') +
      '<ul class="reqs">' + reqs.map((r) => {
        const ids = cov.servedBy[r.id] || [], miss = s && !ids.length;
        return '<li data-req="' + esc(r.id) + '">' + rid(r.id, task) + '<span class="rt">' + esc(r.text) + '</span>' +
          (miss ? '<span class="who miss">' + ICON.warn + 'no one</span>' : '<span class="who">' + ids.map((id) => '<span class="who-r"><span class="sw" style="background:' + (id === 'lead' ? '#1B1F23' : groupColor(s, (M.member(s, id) || {}).group)) + '"></span>' + esc(nameOf(s, id)) + '</span>').join('') + '</span>') + '</li>';
      }).join('') + '</ul>';
  }
  function stateWord(id) {
    const s = struct(), st = S.statuses[id];
    if (!s) return '';
    if (!s.locked) return 'draft';
    return st ? st.state : 'idle';
  }
  // The badge in the team list and role card: state class plus the plain word ("needs you", "failed", …).
  function stateBadge(id) {
    const w = stateWord(id), st = S.statuses[id], live = struct() && struct().locked && st;
    return '<span class="st st-' + esc(w) + (live && M.needsYou(st) ? ' st-ask' : '') + '">' + (live ? flagIcon(st) : '') + esc(live ? M.stateLabel(st) : w) + '</span>';
  }
  function teamHtml() {
    const s = struct(), task = data().task;
    const sdk = M.isSdk(data());
    if (!s) return '<h2>Team</h2><p class="quiet">' + (sdk ? 'The team appears here when the first run starts.' : 'Your assistant designs a team once the task is described.') + '</p>';
    const lead = s.lead || {}, roles = (s.roles || []).filter(Boolean), cost = M.costInfo(roles.length);
    const row = (id, m, color) => '<button class="org-row" type="button" data-select="' + esc(id) + '"><span class="sw" style="background:' + color + '"></span><span class="on-name">' + esc(m.name || id) + '</span>' +
      '<span class="reqs-in">' + (m.serves || []).map((r) => rid(r, task)).join('') + '</span>' + stateBadge(id) + '</button>';
    const tools = (r) => (Array.isArray(r.tools) ? r.tools : []).map(M.toolInfo).filter((t) => t && t.effect !== 'deny'); // a denied tool is not one it has
    const sub = (r) => '<div class="org-to">' + tools(r).map((t) => '<span title="' + esc(t.text) + '">' + (t.name === 'web search' ? ICON.globe : t.name === 'browse the web' ? ICON.browser : ICON.folder) + '</span>').join('') + ' hands to ' + esc(nameOf(s, r.handsTo || 'lead')) +
      (r.dynamic && r.parent && r.parent !== 'lead' ? ' · spawned by ' + esc(nameOf(s, r.parent)) : '') + '</div>';
    let html = '<h2>Team ' + num((s.locked ? 'v' : 'draft v') + (s.version || 1)) + '</h2><div class="org">' + row('lead', Object.assign({ name: 'Lead' }, lead), '#1B1F23');
    const groups = M.orderGroups(s), orphans = roles.filter((r) => !groups.some((g) => g.id === r.group));
    groups.concat(orphans.length ? [{ id: '?', label: 'No group yet', after: null }] : []).forEach((g, i) => {
      const ms = g.id === '?' ? orphans : roles.filter((r) => r.group === g.id);
      if (!ms.length) return;
      const note = g.id === 'dyn' ? ms.length + (ms.length === 1 ? ' agent' : ' agents') : ms.length > 1 ? ms.length + ' at the same time' : g.after ? 'after ' + esc(g.after) : 'starts first';
      html += '<div class="org-g"><div class="org-gh">' + esc(g.id === '?' ? g.label : M.groupCaption(g, i)) + '<span class="quiet"> · ' + note + '</span></div>' +
        ms.map((r) => row(r.id, r, GROUP[i % GROUP.length]) + sub(r)).join('') + '</div>';
    });
    html += '</div><p class="cost">' + (sdk ? num(String(cost.agents)) + (cost.agents === 1 ? ' agent' : ' agents') + ' · Lead included'
      : num(String(cost.agents)) + ' agents ≈ ' + num(cost.agents + '×') + ' the tokens of one assistant · more agents ≠ better') + '</p>';
    if (s.rationale) html += '<details class="why"><summary>Why this team</summary><p>' + esc(s.rationale) + '</p></details>';
    return html;
  }
  function activityHtml() {
    const s = struct();
    if (!S.feed.length) return '<h2>Activity</h2><p class="quiet">Each agent’s messages appear here, newest first, while the team runs.</p>';
    return '<h2>Activity</h2><ol class="feed">' + S.feed.map((e) => {
      const fl = M.flagInfo(e);
      const text = fl ? (fl.needsYou ? fl.title + ': ' : '') + (e.flag || e.say || '') : e.state === 'handoff' && e.to ? (e.say || 'Handing over') + ' → ' + nameOf(s, e.to) : e.say;
      return '<li class="fe-' + esc(e.state) + (fl && fl.needsYou ? ' fe-ask' : '') + '"' + (e.id ? ' data-select="' + esc(e.id) + '"' : '') + '>' + num(stamp(e.at)) + '<span><b>' + esc(nameOf(s, e.id)) + '</b> ' + flagIcon(e) + esc(text || '') + '</span></li>';
    }).join('') + '</ol>';
  }
  // The URL health of a source (from the checkers' evidence), as a word chip: never merged with the A–D grade badge.
  function healthChip(sourceId) {
    const ev = sourceId && V().ver && V().ver.evidence[sourceId];
    if (!ev || !ev.urlHealth) return '';
    return '<span class="hl hl-' + esc(ev.urlHealth) + '" title="Link checked' + (ev.httpStatus ? ': HTTP ' + ev.httpStatus : '') + '">' + esc(M.HEALTH[ev.urlHealth]) + '</span>';
  }
  function sourceItem(x, s, opts) {
    const ev = String(x.evidence || 'D').toUpperCase().slice(0, 1);
    const href = /^https?:\/\//i.test(x.url || '') ? x.url : null;
    const card = x.id && /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(x.id) ? ' · <a href="' + esc(ROOT + 'sources/' + x.id + '.md') + '" target="_blank" rel="noopener noreferrer">card</a>' : '';
    return '<li><span class="ev ev-' + esc(ev) + '" title="Evidence grade ' + esc(ev) + ': ' + esc(M.EVIDENCE[ev] || '') + '">' + esc(ev) + '</span><span>' + (href ? '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + esc(x.title || x.url) + '</a>' : esc(x.title || x.id || '')) +
      healthChip(x.id) + '<span class="quiet">' + (opts && opts.noFinder ? '' : ' · found by ' + esc(nameOf(s, x.foundBy))) + card + '</span></span></li>';
  }
  function sourcesHtml(r, s) {
    if (!(r.sources || []).length) return '';
    return '<h3>Sources ' + num(String(r.sources.length)) + '</h3><ul class="sources">' + r.sources.map((x) => sourceItem(x, s)).join('') + '</ul><p class="ev-key">' + Object.keys(M.EVIDENCE).map((k) => '<span><span class="ev ev-' + k + '">' + k + '</span>' + esc(M.EVIDENCE[k]) + '</span>').join('') + '</p>';
  }
  // The title block keeps a short card; the full result opens in the drawer over the office.
  function resultCard(ri) {
    const r = ri.r, last = ri.rounds[ri.rounds.length - 1], nf = (r.flags || []).filter(Boolean).length, ns = (r.sources || []).length;
    const counts = [ri.rounds.length > 1 ? ri.rounds.length + ' rounds' : '', nf ? nf + (nf > 1 ? ' flags' : ' flag') : '', ns ? ns + (ns > 1 ? ' sources' : ' source') : ''].filter(Boolean).join(' · ');
    return '<h2>Result ' + (r.run != null ? num('run ' + r.run) : '') + '</h2><p class="res-title">' + esc(r.title || 'Result') + '</p>' +
      (last.question ? '<p class="res-q"><span class="quiet">Latest follow-up</span> ' + esc(last.question) + '</p>' : '') +
      '<div class="md res-peek" aria-hidden="true" inert>' + md(last.markdown) + '</div>' +
      '<p class="res-open"><button class="dr-open" type="button" data-drawer="open">' + ICON.panel + 'Open result</button>' + (counts ? num(counts) : '') + '</p>';
  }
  function roundLabel(x) { return x.round === 1 && !x.question ? 'Result' : 'Follow-up'; }
  function drawerHtml(ri) {
    const r = ri.r, s = struct(), many = ri.rounds.length > 1;
    const art = (x) => '<article class="dr-round" id="dr-round-' + x.round + '" data-round="' + x.round + '">' + (!many ? '' :
      '<p class="dr-k">' + num('Round ' + String(x.round).padStart(2, '0')) + '<span>' + roundLabel(x) + '</span>' + (x.latest ? '<span class="dr-latest">Latest</span>' : '') + '</p>') +
      (x.question ? '<p class="dr-q"><span class="quiet">You asked</span>' + esc(x.question) + '</p>' : '') +
      (x.title && (x.latest || x.title !== r.title) ? '<p class="res-title">' + esc(x.title) + '</p>' : '') +
      '<div class="md">' + mdClaims(x.markdown) + '</div></article>';
    return credibilityHtml() + ri.rounds.map(art).join('') + resultExtras(r, s);
  }
  // "12 claims · 9 supported · 2 partial · 1 unknown · links: 7 live, 1 dead", over a bar in the verdict colours.
  function credibilityHtml() {
    const ver = V().ver;
    if (!ver || !ver.summary.claims) return '';
    const c = M.credibility(ver.summary);
    return '<section class="cred" aria-label="How the claims were checked"><p class="cred-k">Checked claims</p>' +
      (c.total ? '<div class="cred-bar" aria-hidden="true">' + c.segments.map((x) => '<i class="cs-' + x.status + '" style="flex-grow:' + x.n + '"></i>').join('') + '</div>' : '') +
      '<p class="cred-t">' + esc(c.text) + '</p><p class="cred-how quiet small">Underlined statements carry a checker verdict: hover, focus or click one to see who checked it and against which sources.</p></section>';
  }
  function renderDrawer(ri) {
    const dr = $('#drawer');
    if (S.drawerMode === 'agent' || S.drawerMode === 'stage') { renderAgentDrawer(); return; }
    $('#dr-foot').hidden = true;
    if (!ri) return;
    setHTML($('#dr-title'), 'Result ' + (ri.r.run != null ? num('run ' + ri.r.run) : ''));
    $('#dr-close').setAttribute('aria-label', 'Close the result');
    const nav = $('#dr-rounds');
    nav.hidden = ri.rounds.length < 2;
    setHTML(nav, ri.rounds.map((x) => '<button type="button" data-round-go="' + x.round + '">' + num(String(x.round).padStart(2, '0')) + '<span>' + roundLabel(x) + '</span></button>').join(''));
    setHTML($('#dr-body'), drawerHtml(ri));
    sizeButton();
    dr.classList.toggle('full', S.drawerFull);
  }
  function sizeButton() {
    setHTML($('#dr-size'), (S.drawerFull ? ICON.shrink : ICON.expand) + '<span>' + (S.drawerFull ? 'Side view' : 'Full screen') + '</span>');
  }
  // Open or close the one drawer. opts.focus moves focus into it (keyboard and button opens); closing returns focus to
  // whatever opened it. Closing an agent or stage drawer also ends that selection.
  function setDrawer(open, opts) {
    const dr = $('#drawer');
    if (!dr || (EMBED && open)) return; // embed mode: the host shows results and agents natively
    const was = S.drawer;
    S.drawer = !!open;
    dr.classList.toggle('open', S.drawer);
    dr.setAttribute('aria-hidden', String(!S.drawer));
    if ('inert' in dr) dr.inert = !S.drawer;
    document.body.classList.toggle('drawer-open', S.drawer);
    dr.dataset.mode = S.drawerMode;
    if (S.drawer && !was) {
      const a = document.activeElement;
      S.opener = a && a !== document.body && !dr.contains(a) ? a : null;
      if (S.drawerMode === 'result') showLatestRound(); else { renderAgentDrawer(); $('#dr-body').scrollTop = 0; }
      if (opts && opts.focus) $('#dr-close').focus();
    }
    if (!S.drawer && was) {
      hideClaim(true);
      const inside = dr.contains(document.activeElement);
      const mode = S.drawerMode;
      if (mode !== 'result') {
        S.drawerMode = 'result'; S.stage = null; S.selected = null;
        office.setSelected(null); renderOffice(); renderSidebar();
      }
      if (!S.sidebar && resultInfo()) $('#sb-toggle').classList.add('news'); // the result card waits in the closed title block
      if (inside || (opts && opts.focus)) { // never leave focus on a closed, inert drawer
        const visible = (el) => el && el.isConnected && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
        const to = [S.opener, $('[data-drawer="open"]'), $('#sb-toggle')].find(visible);
        if (to) to.focus(); else if (inside) document.activeElement.blur();
      }
      S.opener = null;
      $('#dr-foot').hidden = true;
    }
    if (S.drawer !== was && S.loadedOnce) { // what the drawer now covers changed: re-aim the edge pointers (again once it has slid)
      placePointers();
      clearTimeout(S.ptrTimer); S.ptrTimer = setTimeout(placePointers, 500);
    }
  }
  // Switch an open drawer to the result, or open it there.
  function openResult(opts) {
    if (S.drawer && S.drawerMode !== 'result') {
      S.drawerMode = 'result'; S.stage = null;
      if (S.selected) { S.selected = null; office.setSelected(null); }
      $('#drawer').dataset.mode = 'result';
      showLatestRound();
      renderOffice(); renderSidebar();
      if (opts && opts.focus) $('#dr-close').focus();
      return;
    }
    S.drawerMode = 'result';
    setDrawer(true, opts);
  }
  // Render the drawer and scroll it to the newest round: a follow-up opens at its own answer.
  function showLatestRound() {
    const ri = resultInfo();
    if (!ri || S.drawerMode !== 'result') return;
    renderDrawer(ri);
    const body = $('#dr-body'), last = $('#dr-round-' + ri.rounds[ri.rounds.length - 1].round);
    if (body) body.scrollTop = last && ri.rounds.length > 1 ? last.offsetTop - body.offsetTop : 0;
  }
  function resultExtras(r, s) {
    const flagLi = (f) => {
      const fl = M.flagInfo({ state: f.kind === 'error' ? 'failed' : 'flagged', flagKind: f.kind });
      return '<li>' + ICON[fl.icon] + '<span>' + (fl.needsYou || f.kind === 'error' ? esc(fl.title) + ': ' : '') + esc(f.text) + '<span class="quiet"> · ' + esc(nameOf(s, f.by)) + '</span></span></li>';
    };
    const flags = (r.flags || []).length ? '<h3>Flags</h3><ul class="flags">' + r.flags.filter(Boolean).map(flagLi).join('') + '</ul>' : '';
    const caught = caughtHtml(s);
    return caught || flags || (r.sources || []).length ? '<section class="dr-extras">' + caught + flags + sourcesHtml(r, s) + '</section>' : '';
  }
  // What the checkers caught: contradicted and unknown claims, and reviews that sent work back or up.
  function caughtHtml(s) {
    const v = V(), c = M.checkersCaught(v.ver, v.board);
    if (!c.claims.length && !c.reviews.length) return '';
    const note = (vd) => vd.filter((x) => x.note).map((x) => esc(nameOf(s, x.by)) + ': ' + esc(x.note)).join(' · ');
    return '<h3>What the checkers caught</h3><ul class="caught">' +
      c.claims.map((x) => '<li><span class="cl-word cs-' + esc(x.status) + '">' + esc(M.CLAIM_WORDS[x.status]) + '</span><span>' + esc(x.text) + (note(x.verdicts) ? '<span class="quiet"> · ' + note(x.verdicts) + '</span>' : '') + '</span></li>').join('') +
      c.reviews.map((x) => '<li><span class="cl-word cs-' + (x.verdict === 'escalate' ? 'contradicted' : 'partial') + '">' + esc(x.verdict === 'escalate' ? 'escalated' : 'sent back') + '</span><span>' + esc(nameOf(s, x.reviewer)) + ' on ' + esc(nameOf(s, x.target)) + (x.round > 1 ? ' (round ' + esc(String(x.round)) + ')' : '') + (x.note ? ': ' + esc(x.note) : '') + '</span></li>').join('') + '</ul>';
  }
  function roleCard(id) {
    const s = struct(), task = data().task, m = s ? M.member(s, id) : id === 'lead' ? { name: 'Lead' } : null;
    if (!m) return '';
    const st = S.statuses[id] || { state: stateWord(id) || 'idle' }, t = S.timing[id] || {}, fl = M.flagInfo(st);
    const g = id === 'lead' || !s ? null : (s.groups || []).find((x) => x.id === m.group);
    const row = (k, v) => (v ? '<dt>' + k + '</dt><dd>' + v + '</dd>' : '');
    const p = st.state === 'done' ? 100 : M.clampProgress(st.progress);
    const tm = BUSY.includes(st.state) && t.start ? clock(Date.now() - t.start) : ENDED.includes(st.state) && t.start && t.end ? clock(t.end - t.start) : '';
    const work = M.normalizeWork(data().result && data().result.work).find((w) => w.by === id);
    const hist = (S.history[id] || []).slice().reverse();
    return '<button class="back" type="button" data-select="">' + ICON.back + 'Back to the sheet</button>' +
      '<h2 class="rc-name">' + esc(m.name || 'Lead') + '</h2>' +
      '<p class="rc-state"><span class="st st-' + esc(st.state) + (fl && fl.needsYou ? ' st-ask' : '') + '">' + (fl ? ICON[fl.icon] : st.state === 'done' ? ICON.tick : '') + esc(M.stateLabel(st)) + '</span>' + (st.say && st.say !== st.flag ? '<span>' + esc(st.say) + '</span>' : '') + '</p>' +
      (p != null || tm ? '<p class="rc-prog">' + (p != null ? '<span class="bar"><i style="width:' + p + '%"></i></span>' : '') + num([p != null ? p + '%' : '', tm].filter(Boolean).join(' · ')) + '</p>' : '') +
      (st.flag ? '<p class="flagbox fk-' + esc(fl ? fl.icon : 'warn') + '">' + (fl ? ICON[fl.icon] : ICON.warn) + '<span>' + (fl ? '<b>' + esc(fl.title) + '</b> ' : '') + esc(st.flag) + '</span></p>' : '') +
      '<dl>' + row('Job', esc(m.job || '')) + row('Serves', (m.serves || []).map((r) => rid(r, task)).join('')) +
      (id === 'lead' || !s ? '' : row('Tools', (Array.isArray(m.tools) ? m.tools : []).map(M.toolInfo).filter(Boolean).map((t) => t.effect === 'deny' ? '<s>' + esc(t.name) + '</s> <span class="quiet">(not allowed)</span>' : esc(t.text)).join(', ') || 'none') + row('Group', g ? esc(M.groupCaption(g, M.orderGroups(s).indexOf(g))) : esc(m.group || '')) + row('Hands to', esc(nameOf(s, m.handsTo || 'lead')))) +
      (s ? row('Receives from', M.receivesFrom(s, id).map((x) => esc(nameOf(s, x))).join(', ')) : '') + row('Why', esc(m.why || '')) +
      (m.dynamic ? row('Spawned by', esc(nameOf(s, m.parent || 'lead')) + '<span class="quiet"> · at runtime</span>') : '') + '</dl>' +
      (work ? '<h3>Work summary</h3><div class="md">' + md(work.summary) + '</div>' : '') +
      '<h3>Latest messages</h3>' + (hist.length ? '<ol class="feed">' + hist.map((h) => '<li>' + num(stamp(h.at)) + '<span><b>' + esc(h.state) + '</b> ' + esc(h.say) + '</span></li>').join('') + '</ol>' : '<p class="quiet">Messages appear here while the team runs.</p>') +
      (M.isSdk(data()) ? '' : '<p class="quiet small">Instructions: <code>team/' + esc(id) + '.md</code></p>');
  }
  function titleBlock() {
    const cell = (k, v) => '<div><span class="tb-k">' + k + '</span><span class="tb-v">' + v + '</span></div>';
    if (S.index) {
      const n = S.home.projects.length, mode = modeInfo();
      return cell('Project', n ? num(String(n)) + ' MAS' : '—') + cell('Team', '—') + cell('Mode', mode ? esc(mode.short) : 'not set') + cell('Run', '—');
    }
    const d = data(), s = struct(), mode = modeInfo(), r = d.result, phase = d.state && d.state.phase;
    const leadFailed = S.statuses.lead && S.statuses.lead.state === 'failed';
    const runState = phase === 'failed' || leadFailed ? 'failed' : phase === 'running' || (S.run.start && !S.run.end) ? 'in progress' : resultInfo() ? 'done' : s && s.locked ? 'ready' : 'not started';
    return cell('Project', esc((s && s.title) || (d.task && d.task.title) || 'Untitled')) +
      cell('Team', s ? num('v' + (s.version || 1)) + ' · ' + (s.locked ? 'locked' : 'draft') : 'not designed') +
      cell('Mode', mode ? esc(mode.short) : M.isSdk(d) ? 'SDK run' : 'not set') +
      cell('Run', (r && r.run != null ? num(String(r.run).padStart(2, '0')) + ' · ' : '') + esc(runState));
  }
  document.addEventListener('click', (e) => {
    if (S.claim && S.claim.pin && !e.target.closest('#claim-card') && !e.target.closest('.claim[data-claim]')) hideClaim(true);
    const sel = e.target.closest('[data-select]');
    if (sel) { select(sel.dataset.select || null); return; }
    if (supervisionClick(e)) return;
    if (e.target.closest('#sb-toggle')) setSidebar(!S.sidebar);
    if (e.target.closest('[data-drawer="open"]')) { openResult({ focus: true }); return; }
    if (e.target.closest('#dr-close')) { setDrawer(false, { focus: true }); return; }
    if (e.target.closest('#dr-size')) { S.drawerFull = !S.drawerFull; sizeButton(); $('#drawer').classList.toggle('full', S.drawerFull); return; }
    const go = e.target.closest('[data-round-go]');
    if (go) { const a = $('#dr-round-' + go.dataset.roundGo), body = $('#dr-body'); if (a && body) body.scrollTo({ top: a.offsetTop - body.offsetTop, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); return; }
    if (e.target.closest('#replay')) { S.replays = (S.replays || 0) + 1; demoStart = performance.now(); S.history = M.dict(); S.feed = []; S.timing = M.dict(); S.run = { start: 0, end: 0 }; demoTick(); }
  });
  document.addEventListener('keydown', onKey);

  /* ---------- render ---------- */
  function render() {
    S.v = sup();
    renderTop();
    renderOffice();
    if (S.index) { renderSidebar(); afterRender(); return; }
    const ri = resultInfo();
    // A result file already there at the first look, before its run is done, is an old one: never pop it up later.
    // (A new result is written a moment before its run is marked done, so "present but not ready" alone proves nothing.)
    if (S.autoRun === undefined && S.loadedOnce && !ri && data().result) S.seenKeys.add(resultKeys(data().result).key);
    if (ri && ri.key !== S.autoRun) { // a new result or follow-up round: once per key
      // it arrived while the page was open: the drawer slides out over the office (the drawing keeps its size);
      // a result that was already there on opening only gets its card in the title block
      // the replayed demo (?demo=1, e.g. the website) keeps its wrap party in view: card only
      const due = !S.demo && !EMBED && M.drawerDue(S.autoRun, ri.key) && !S.seenKeys.has(ri.key);
      S.autoRun = ri.key; S.seenKeys.add(ri.key);
      if (due) {
        // already open on the result: jump to the new round; open on an agent: the person is busy there, the card waits
        if (S.drawer) { if (S.drawerMode === 'result') showLatestRound(); else if (!S.sidebar) $('#sb-toggle').classList.add('news'); }
        else { // let the team's wrap-up show for a moment, then slide out (unless something changed meanwhile)
          const key = ri.key;
          clearTimeout(S.drawerTimer);
          S.drawerTimer = setTimeout(() => {
            const now = resultInfo();
            if (!now || now.key !== key || S.index || S.drawer) return;
            if (S.selected) select(null);
            S.drawerMode = 'result';
            setDrawer(true);
          }, DRAWER_DELAY);
        }
      } else if (!S.sidebar) $('#sb-toggle').classList.add('news');
      const c = $('#cells'); if (c && !S.selected) c.scrollTop = 0;
    }
    // Looked and saw no ready result: the next one that arrives is new, unless its key was seen before
    // (a run that fails without writing a new result leaves the previous one in place).
    if (!ri && S.loadedOnce) S.autoRun = null;
    renderSidebar();
    afterRender();
  }

  /* ---------- demo ---------- */
  let demoStart = 0, demoScript = null, demoSig = '', demoLoop = 0;
  function demoTick() {
    const s = struct();
    if (!s) return;
    const sg = JSON.stringify(s);
    if (sg !== demoSig) { demoSig = sg; demoScript = M.buildDemoScript(s); }
    const t = (performance.now() - demoStart) / 1000, loop = Math.floor(t / demoScript.length);
    if (loop !== demoLoop) { demoLoop = loop; S.timing = M.dict(); S.feed = []; }
    const st = M.demoStatusesAt(demoScript, t), ss = statusSig(st);
    if (ss === S.sigs.statuses) return;
    S.sigs.statuses = ss;
    trackStatuses(st);
    S.lastChange = Date.now();
    render();
  }

  /* ================= supervision: inbox, agent drawer, chat, claims, keyboard ================= */

  /* ---------- the supervision view of the current data (computed once per render) ---------- */
  function sup() {
    const d = data(), s = struct(), now = Date.now();
    const inbox = I.normalizeInbox(d.inbox), board = M.normalizeBoard(d.board), ver = M.normalizeVerification(d.verification);
    if (inbox) inbox.pending.forEach((r) => { if (S.firstSeen[r.requestId] == null) S.firstSeen[r.requestId] = now; });
    const ar = I.arrangeInbox(inbox, s, S.statuses, S.firstSeen, now);
    const cmds = M.dict();
    if (inbox) inbox.commands.forEach((c) => { cmds[c.cmdId] = c; });
    const live = !!(s && s.locked);
    return { inbox, board, ver, ar, cmds, now, live, waiting: live ? I.waitingAgents(ar.human) : [], claimMap: M.claimStatusMap(ver) };
  }
  const V = () => S.v || (S.v = sup());
  const agentInfo = (id) => (V().board && V().board.agents[id]) || {};
  const accepts = (id, what) => Array.isArray(agentInfo(id).accepts) && agentInfo(id).accepts.includes(what);
  const httpOk = () => /^https?:$/.test(location.protocol) && !!window.fetch && !STATIC && !S.demo;
  const oneLine = (t) => M.oneLine(t);
  const clip = (t, n) => { const x = oneLine(t); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
  const timeOf = (ts) => { const t = Date.parse(ts || ''); return isFinite(t) ? new Date(t).toTimeString().slice(0, 8) : ''; };
  function agentChip(id) {
    const s = struct(), m = (s && M.member(s, id)) || {};
    return (m.emoji ? '<span class="emo" aria-hidden="true">' + esc(String(m.emoji).slice(0, 8)) + '</span>' : '') + '<span class="who-n">' + esc(nameOf(s, id)) + '</span>';
  }
  function stateBadgeFor(st) {
    const fl = M.flagInfo(st);
    return '<span class="st st-' + esc(st.state || 'idle') + (fl && fl.needsYou ? ' st-ask' : '') + '">' + (fl ? ICON[fl.icon] : st.state === 'done' ? ICON.tick : '') + esc(M.stateLabel(st)) + '</span>';
  }
  function stageMembers(gid) {
    const s = struct();
    return s ? (s.roles || []).filter((r) => r && r.group === gid).map((r) => r.id) : [];
  }
  const runActive = () => { const ph = data().state && data().state.phase; return ph === 'running' || Object.values(S.statuses).some((x) => BUSY.includes(x.state)); };

  /* ---------- session: may this page act? ---------- */
  const SESSION = { checked: false, token: false, runtime: false, terminal: false, reason: '' };
  async function api(path, opts) {
    const o = opts || {}, headers = {};
    const t = token();
    if (t) headers.Authorization = 'Bearer ' + t;
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, { method: o.method || 'GET', headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), cache: 'no-store', credentials: 'same-origin' });
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    return { status: res.status, ok: res.ok, json };
  }
  async function checkSession() {
    if (S.demo) SESSION.reason = 'Read-only: this is a replay of an example run.';
    else if (STATIC) SESSION.reason = 'Read-only: a published example.';
    else if (!/^https?:$/.test(location.protocol) || !window.fetch) SESSION.reason = 'Read-only: this page was opened as a file. Open it through mas-office serve to answer here.';
    else {
      try {
        const res = await api('/v0/session');
        if (!res.ok || !res.json) SESSION.reason = res.status === 404 ? 'Read-only: this server does not take answers from the page.' : 'Read-only: the server did not say whether this page may act.';
        else {
          SESSION.token = res.json.token === true; SESSION.runtime = res.json.runtime === true; SESSION.terminal = res.json.terminal === true;
          SESSION.reason = SESSION.token ? '' : token() ? 'Read-only: the access token in this tab is no longer valid. Open the link the server printed.' : 'Read-only: open the panel from the link the server printed; it carries the access token.';
        }
      } catch (e) { SESSION.reason = 'Read-only: no connection to the server.'; }
    }
    SESSION.checked = true;
    if (S.loadedOnce) render();
  }
  function project() {
    if (S.current) return S.current;
    const m = FIXED_ROOT && FIXED_ROOT.match(/^\.\.\/([a-z0-9][a-z0-9-]{0,39})\/$/);
    return m ? m[1] : null;
  }
  const canAct = () => SESSION.token && !S.demo && !STATIC && !!project();
  const actReason = () => (!SESSION.checked ? 'Checking whether this page may answer…' : SESSION.reason || (!project() ? 'Read-only: no project folder is selected.' : ''));

  /* ---------- commands: optimistic, with a visible receipt ---------- */
  function newCmdId() {
    const b = new Uint8Array(8);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(b); else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
    return 'cmd_' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }
  function errorText(res) {
    if (res.status === 401) return 'the access token is not valid';
    if (res.status === 403) return (res.json && typeof res.json.error === 'string' ? res.json.error : 'not allowed').slice(0, 160);
    return res.json && typeof res.json.error === 'string' ? res.json.error.slice(0, 160) : 'the server answered ' + res.status;
  }
  // Send one command; returns its cmdId at once. The receipt moves sending → sent here, then accepted / applied /
  // rejected from MAS_INBOX.commands; a 409 (already answered) settles it as "Already answered".
  function sendCommand(type, agentId, data) {
    const cmdId = newCmdId();
    S.local[cmdId] = { state: 'sending', error: null, type, agentId, text: typeof data.text === 'string' ? data.text : null, delivery: data.delivery || null, at: Date.now() };
    const done = (state, error) => { const l = S.local[cmdId]; if (l) { l.state = state; l.error = error || null; } refresh(); };
    api('/v0/commands?project=' + encodeURIComponent(project()), { method: 'POST', body: { type, agentId, data: Object.assign({ cmdId }, data) } })
      .then((res) => (res.ok ? done('sent') : res.status === 409 ? done('conflict') : done('failed', errorText(res))), () => done('failed', 'no connection to the server'));
    return cmdId;
  }
  function refresh() { S.v = sup(); renderSidebar(); renderOffice(); afterRender(); }

  /* ---------- keep typed text and focus across re-renders ---------- */
  const focusKey = (el) => el.tagName + JSON.stringify(Object.assign({}, el.dataset));
  function keepInputs(root, fn) {
    const keep = M.dict();
    let focusKeep = null, focusOther = null;
    root.querySelectorAll('[data-keep]').forEach((el) => {
      keep[el.dataset.keep] = { v: el.value, s: el.selectionStart, e: el.selectionEnd };
      if (el === document.activeElement) focusKeep = el.dataset.keep;
    });
    if (!focusKeep && root.contains(document.activeElement) && document.activeElement !== root) focusOther = focusKey(document.activeElement);
    fn();
    root.querySelectorAll('[data-keep]').forEach((el) => {
      const k = keep[el.dataset.keep];
      if (!k) return;
      if (el.value !== k.v) el.value = k.v;
      if (focusKeep === el.dataset.keep && document.activeElement !== el) { el.focus(); try { el.setSelectionRange(k.s, k.e); } catch (e) { /* not a text field */ } }
    });
    if (focusOther && !root.contains(document.activeElement)) {
      const tag = focusOther.slice(0, focusOther.indexOf('{'));
      const back = $$(tag, root).find((el) => focusKey(el) === focusOther);
      if (back) back.focus();
    }
  }

  /* ---------- the "needs you" inbox ---------- */
  function renderInbox() {
    const cell = $('#c-inbox'), v = V();
    const show = !S.index && !!v.inbox;
    cell.hidden = !show;
    if (show) keepInputs(cell, () => setHTML(cell, inboxHtml(v)));
    const n = show ? v.ar.human.length : 0, btn = $('#needs');
    btn.hidden = !n;
    if (n) setHTML(btn, '<span class="needs-dot" aria-hidden="true"></span>Needs you ' + num(String(n)));
  }
  const notifySupported = () => typeof window.Notification !== 'undefined';
  function inboxHtml(v) {
    const ar = v.ar, n = ar.human.length;
    let h = '<div class="ib-bar"><h2 id="ib-h" tabindex="-1">Needs you ' + num(String(n)) + '</h2>' +
      (notifySupported() && !S.demo && !STATIC ? '<button type="button" class="ib-tool" data-notify aria-pressed="' + S.notify + '">' + (S.notify ? 'Notifying' : 'Notify me') + '</button>' : '') +
      '<button type="button" class="ib-tool" data-keys aria-haspopup="dialog">Keys <kbd>?</kbd></button></div>';
    if (S.notifyNote) h += '<p class="ib-note">' + esc(S.notifyNote) + '</p>';
    if (!canAct()) h += '<p class="ib-ro">' + esc(actReason()) + '</p>';
    h += n ? '<div class="ib-list">' + ar.human.map((x) => itemHtml(x, 'inbox', false)).join('') + '</div>' : '<p class="quiet ib-empty">Nothing needs you right now.</p>';
    if (ar.withLead.length) {
      h += '<h3 class="ib-sub">With the Lead ' + num(String(ar.withLead.length)) + '</h3><p class="quiet small">The Lead sees these first; they come to you if it passes them up.</p>' +
        '<div class="ib-list">' + ar.withLead.map((x) => itemHtml(x, 'inbox', true)).join('') + '</div>';
    }
    if (ar.recent.length) {
      const open = S.expand.has('recent');
      h += '<button type="button" class="ib-fold" data-toggle="recent" aria-expanded="' + open + '">Recent decisions ' + num(String(ar.recent.length)) + '</button>' + (open ? recentHtml(ar.recent) : '');
    }
    return h;
  }
  // One request, answerable in place. `where` keeps inbox and drawer copies apart (inputs, folds).
  function itemHtml(x, where, dim) {
    const r = x.req, k = I.kindInfo(r.kind), s = struct(), v = V(), rid = r.requestId, key = where + ':' + rid;
    const sv = I.subjectView(r.subject), open = S.expand.has('subj:' + key);
    const ans = S.answers[rid], rc = ans ? I.receipt(S.local[ans.cmdId], v.cmds[ans.cmdId]) : null;
    const locked = !!rc && (!rc.final || rc.ok || rc.state === 'conflict'); // waiting for the outcome, or settled
    const wait = I.waited(x.since, v.now);
    const exp = r.expiresAt && isFinite(Date.parse(r.expiresAt)) ? 'times out at ' + new Date(Date.parse(r.expiresAt)).toTimeString().slice(0, 5) : '';
    const holds = I.holdsUpText(x.holds.map((id) => nameOf(s, id)));
    const ifParts = [r.onExpire, holds, exp].filter(Boolean).map(esc);
    const routed = dim ? (r.routeTo === 'lead' ? 'With the Lead' : 'With ' + nameOf(s, r.routeTo)) : '';
    let h = '<article class="ib-item tone-' + k.tone + (dim ? ' dim' : '') + '" data-req="' + esc(rid) + '" data-where="' + where + '" tabindex="-1" aria-label="' + esc(k.word + ' from ' + nameOf(s, r.agentId) + ': ' + r.title) + '">' +
      '<div class="ib-head"><span class="ib-kind">' + esc(k.word) + '</span>' + (r.urgency === 'high' ? '<span class="ib-urgent">Urgent</span>' : '') +
      (r.agentId && where === 'inbox' ? '<button type="button" class="ib-who" data-agent="' + esc(r.agentId) + '" title="Open this agent">' + agentChip(r.agentId) + '</button>' : '') +
      '<span class="ib-wait num"' + (x.since ? ' title="Waiting since ' + esc(new Date(x.since).toTimeString().slice(0, 5)) + '"' : '') + '>' + esc(wait) + '</span></div>' +
      (routed ? '<p class="ib-routed">' + esc(routed) + '</p>' : '') +
      '<p class="ib-title">' + esc(r.title) + '</p>' + (r.description ? '<p class="ib-desc">' + esc(r.description) + '</p>' : '');
    if (sv && (sv.text || sv.label)) {
      const more = sv.lines > 8 ? sv.lines + ' lines' : sv.text.length + ' characters';
      h += '<div class="ib-subj' + (sv.long && !open ? ' clamped' : '') + '"><p class="ib-subj-k">' + esc(sv.label) + '</p>' + (sv.text ? '<pre>' + esc(sv.text) + '</pre>' : '') +
        (sv.long ? '<button type="button" class="ib-more" data-toggle="subj:' + esc(key) + '" aria-expanded="' + open + '">' + (open ? 'Show less' : 'Show all ' + more) + '</button>' : '') + '</div>';
    }
    if (ifParts.length) h += '<p class="ib-if"><span class="ib-if-k">If you don’t answer</span>' + ifParts.join(' · ') + '</p>';
    if (canAct()) {
      const opts = I.answerOptions(r), dis = locked ? ' disabled' : '', revise = opts.find((o) => o.needsText);
      if (opts.length) h += '<div class="ib-opts" role="group" aria-label="Answers">' + opts.map((o) => '<button type="button" class="ib-opt o-' + o.tone + '" data-answer="' + esc(rid) + '" data-opt="' + esc(o.optionId) + '"' + dis + '>' + esc(o.name) + (o.always ? '<span class="ib-always">standing rule</span>' : '') + '</button>').join('') + '</div>';
      h += '<form class="ib-reply" data-reply="' + esc(rid) + '"' + (revise ? ' data-opt="' + esc(revise.optionId) + '"' : '') + '><input type="text" data-keep="reply:' + esc(key) + '" maxlength="2000" aria-label="' + esc((revise ? 'What should change: ' : 'Reply to: ') + r.title) + '" placeholder="' + (revise ? 'What should change?' : r.kind === 'gate' ? 'Or send it back with a note' : 'Or reply in a sentence') + '"' + dis + '>' +
        '<button type="submit" class="ib-send"' + dis + '>' + esc(revise ? revise.name : r.kind === 'gate' ? 'Send back' : 'Send') + '</button></form>';
      if (S.hint[rid]) h += '<p class="ib-hint">' + esc(S.hint[rid]) + '</p>';
    }
    if (rc) h += '<p class="ib-rc rc-' + rc.state + '" role="status">' + esc(ans.label) + ' · ' + esc(rc.text) + '</p>';
    return h + '</article>';
  }
  function recentHtml(list) {
    const s = struct();
    return '<ol class="ib-recent">' + list.slice(0, 12).map((r) => {
      const k = I.kindInfo(r.kind), t = S.tele[r.requestId] || {};
      const opened = Date.parse(r.openedAt || ''), res = Date.parse(r.resolvedAt || '');
      const since = isFinite(opened) ? opened : t.since;
      const ttn = t.seen != null && since != null ? I.durationText(t.seen - since) : '';
      const ttr = isFinite(res) && since != null ? I.durationText(res - since) : '';
      const tt = [ttn ? 'noticed after ' + ttn : '', ttr ? 'resolved after ' + ttr : ''].filter(Boolean).join(' · ');
      return '<li><span class="ib-kind-s tone-' + k.tone + '">' + esc(k.word) + '</span><span class="ib-r-main"><b>' + esc(r.title) + '</b>' +
        '<span>' + esc(I.outcomeText(r)) + ' · ' + esc(I.byText(r.by, (id) => nameOf(s, id))) + (r.agentId ? ' · for ' + esc(nameOf(s, r.agentId)) : '') + '</span>' +
        (tt ? '<span class="num ib-tt">' + esc(tt) + '</span>' : '') + '</span></li>';
    }).join('') + '</ol>';
  }
  const findPending = (rid) => { const ar = V().ar; return ar.human.concat(ar.withLead).find((x) => x.req.requestId === rid) || null; };
  function answer(rid, optId, text, itemEl) {
    const x = findPending(rid);
    if (!x || !canAct()) return;
    const req = x.req;
    const prev = S.answers[rid] && I.receipt(S.local[S.answers[rid].cmdId], V().cmds[S.answers[rid].cmdId]);
    if (prev && (!prev.final || prev.ok || prev.state === 'conflict')) return; // one answer at a time
    const opt = optId != null ? I.answerOptions(req).find((o) => o.optionId === optId) : null;
    if (optId != null && !opt) return;
    if (opt && opt.needsText && !String(text || '').trim()) {
      S.hint[rid] = 'Write what should change, then press ' + opt.name + '.';
      const where = itemEl ? itemEl.dataset.where : 'inbox';
      refresh(); // re-renders the item: find its text field again
      const item = $$('.ib-item[data-req]').find((el) => el.dataset.req === rid && el.dataset.where === where);
      const input = item && $('form[data-reply] input', item);
      if (input) input.focus();
      return;
    }
    const d = I.respondData(req, opt, text);
    if (!d) return;
    delete S.hint[rid];
    S.answers[rid] = { cmdId: sendCommand('command.respond', req.agentId, d), label: opt ? opt.name : 'Reply' };
    refresh();
  }
  // I: the inbox gets focus (the title block opens if it was closed; an open drawer that covers it closes).
  function focusInbox() {
    const cell = $('#c-inbox');
    if (cell.hidden) { announce('This project has no inbox.'); return; }
    if (S.drawer) setDrawer(false); // the drawer covers the title block (and, on a phone, the whole page)
    if (!S.sidebar) setSidebar(true);
    const first = $('.ib-item', cell) || $('#ib-h', cell);
    if (first) { first.focus({ preventScroll: true }); first.scrollIntoView({ block: 'nearest' }); }
  }

  /* ---------- the agent drawer (and the stage drawer for a group follow-up) ---------- */
  const TABS = [['transcript', 'Transcript'], ['outputs', 'Outputs'], ['terminal', 'Terminal']];
  function renderAgentDrawer() {
    const dr = $('#drawer'), mode = S.drawerMode, s = struct();
    dr.dataset.mode = mode;
    $('#dr-rounds').hidden = true;
    if (mode === 'agent') {
      const id = S.drawerAgent;
      setHTML($('#dr-title'), 'Agent' + (agentInfo(id).backend ? ' ' + num(M.backendLabel(agentInfo(id).backend)) : ''));
      $('#dr-close').setAttribute('aria-label', 'Close ' + nameOf(s, id));
      const body = $('#dr-body');
      if (body.dataset.for !== 'agent:' + id) { body.dataset.for = 'agent:' + id; body.scrollTop = 0; }
      keepInputs(body, () => setHTML(body, agentHtml(id)));
    } else {
      const g = s && (s.groups || []).find((x) => x.id === S.stage);
      setHTML($('#dr-title'), 'Stage ' + num(String(S.stage || '')));
      $('#dr-close').setAttribute('aria-label', 'Close the stage');
      const body = $('#dr-body');
      if (body.dataset.for !== 'stage:' + S.stage) { body.dataset.for = 'stage:' + S.stage; body.scrollTop = 0; }
      setHTML(body, stageHtml(g));
    }
    sizeButton();
    dr.classList.toggle('full', S.drawerFull);
    renderFoot();
  }
  function lastTask(id) {
    const b = V().board;
    let t = null;
    (b ? b.tasks : []).forEach((x) => { if (x.agentId === id) t = x; });
    return t;
  }
  function agentHtml(id) {
    const s = struct(), v = V(), m = (s && M.member(s, id)) || {}, st = S.statuses[id] || { state: 'idle' }, info = agentInfo(id);
    const u = M.usageInfo(v.board && v.board.usage[id]), task = lastTask(id);
    const meta = [stateBadgeFor(st), info.backend ? '<span>' + esc(M.backendLabel(info.backend)) + '</span>' : '', typeof info.model === 'string' && info.model ? '<span class="num">' + esc(info.model) + '</span>' : '',
      u && u.text ? '<span class="num">' + esc(u.text) + '</span>' : ''].filter(Boolean).join('<span class="sep" aria-hidden="true"> · </span>');
    const taskWord = task ? [task.state, task.attempt > 1 ? 'attempt ' + task.attempt : '', task.round > 1 ? 'round ' + task.round : ''].filter((x) => typeof x === 'string' && x).join(' · ') : '';
    let h = '<section class="ag-head"><h3 class="ag-name">' + (m.emoji ? '<span class="emo" aria-hidden="true">' + esc(String(m.emoji).slice(0, 8)) + '</span>' : '') + esc(nameOf(s, id)) + '</h3>' +
      (m.job ? '<p class="ag-job">' + esc(m.job) + '</p>' : '') + '<p class="ag-meta">' + meta + '</p>' +
      (u && u.warn ? '<p class="ag-warn">' + ICON.warn + esc(u.warn) + '</p>' : '') +
      (task ? '<p class="ag-task"><span class="ag-k">Task</span>' + esc(task.title || '') + (taskWord ? ' <span class="num quiet">' + esc(taskWord) + '</span>' : '') + '</p>' : '') + '</section>';
    const mine = v.ar.human.filter((x) => x.req.agentId === id), viaLead = v.ar.withLead.filter((x) => x.req.agentId === id);
    if (mine.length || viaLead.length) {
      h += '<section class="ag-wait" aria-label="Waiting on you"><h4 class="ag-h">Waiting on you ' + num(String(mine.length + viaLead.length)) + '</h4>' + (canAct() ? '' : '<p class="ib-ro">' + esc(actReason()) + '</p>') +
        mine.map((x) => itemHtml(x, 'drawer', false)).join('') + viaLead.map((x) => itemHtml(x, 'drawer', true)).join('') + '</section>';
    }
    h += stripHtml(id, st, task);
    h += '<div class="ag-tabs" role="tablist" aria-label="Agent views">' + TABS.map(([k, w]) => '<button type="button" role="tab" id="tab-' + k + '" data-tab="' + k + '" aria-selected="' + (S.agentTab === k) + '" aria-controls="ag-panel" tabindex="' + (S.agentTab === k ? 0 : -1) + '">' + w + '</button>').join('') + '</div>' +
      '<div class="ag-panel" id="ag-panel" role="tabpanel" aria-labelledby="tab-' + S.agentTab + '">' + (S.agentTab === 'outputs' ? outputsHtml(id) : S.agentTab === 'terminal' ? terminalHtml(id) : transcriptHtml(id)) + '</div>';
    return h;
  }
  // Three layers: what it is doing, why, and what comes next with how sure we can be.
  function stripHtml(id, st, task) {
    const s = struct(), v = V(), tx = S.tx[id], tool = tx ? I.currentTool(tx.entries) : null, ledger = v.board && v.board.ledger;
    const str = (x) => typeof x === 'string' && x;
    const doing = [st.state === 'flagged' && st.flag ? st.flag : st.say || (st.state === 'idle' ? 'Idle' : M.stateLabel(st)), tool ? 'Using ' + tool.tool + (tool.summary ? ': ' + tool.summary : '') : ''].filter(Boolean);
    const why = [];
    // the engine titles a task with the start of its brief: only add the brief when it says more
    if (task) why.push(str(task.brief) && !oneLine(task.brief).startsWith(oneLine(task.title || '').replace(/…$/, '')) ? (task.title || '') + ' — ' + clip(task.brief, 220) : str(task.brief) ? clip(task.brief, 260) : task.title || '');
    if (id === 'lead' && ledger) {
      if (str(ledger.instruction)) why.push(ledger.instruction);
      if (Array.isArray(ledger.plan)) { const p = ledger.plan.filter(str).slice(0, 6); if (p.length) why.push('Plan: ' + p.map((x, i) => (i + 1) + '. ' + x).join('  ')); }
      if (str(ledger.reason)) why.push(ledger.reason);
    }
    if (!why.length && M.member(s, id) && M.member(s, id).job) why.push(M.member(s, id).job);
    const next = [];
    if (id === 'lead') { const l = M.ledgerLine(ledger, (x) => nameOf(s, x)); if (l) next.push(l); }
    else if (M.member(s, id)) next.push('Then hands to ' + nameOf(s, M.member(s, id).handsTo || 'lead'));
    const got = M.dict();
    (v.board ? v.board.reviews : []).forEach((r) => { if (r.target === id && typeof r.reviewer === 'string') got[r.reviewer] = r; });
    Object.keys(got).forEach((rv) => { const r = got[rv]; next.push(nameOf(s, rv) + ': ' + (r.verdict === 'revise' ? 'sent it back' : r.verdict === 'escalate' ? 'passed it up to you' : 'accepted') + (r.round > 1 ? ' (round ' + r.round + ')' : '') + (str(r.note) ? ' — ' + clip(r.note, 160) : '')); });
    const srcs = ((data().result && data().result.sources) || []).filter((x) => x && x.foundBy === id);
    if (srcs.length) {
      const grades = srcs.map((x) => String(x.evidence || 'D').toUpperCase().slice(0, 1)).sort().join(' ');
      const dead = srcs.filter((x) => { const ev = v.ver && v.ver.evidence[x.id]; return ev && ev.urlHealth === 'hallucinated'; }).length;
      next.push('Evidence grades of its sources: ' + grades + (dead ? ' · ' + dead + ' dead ' + (dead === 1 ? 'link' : 'links') : ''));
    }
    const cell = (k, list) => '<div><dt>' + k + '</dt><dd>' + (list.length ? list.map((x) => '<span>' + esc(x) + '</span>').join('') : '<span class="quiet">—</span>') + '</dd></div>';
    return '<dl class="ag-strip">' + cell('Doing', doing) + cell('Why', why) + cell('Next &amp; confidence', next) + '</dl>';
  }
  function transcriptHtml(id) {
    if (S.demo || STATIC) return '<p class="quiet">This replay has no transcripts.</p>';
    if (!httpOk()) return '<p class="quiet">The transcript is read from the server. Open this page through <code>mas-office serve</code> to see it.</p>';
    const t = S.tx[id];
    if (!t || (t.state === 'loading' && !t.entries.length)) return '<p class="quiet">Loading the transcript…</p>';
    if (!t.entries.length) return '<p class="quiet">' + (t.state === 'missing' ? 'No transcript yet. It appears when this agent’s session starts.' : t.state === 'error' ? 'The transcript could not be read.' : 'The transcript is empty so far.') + '</p>';
    const shown = t.entries.slice(-t.limit), hidden = t.entries.length - shown.length;
    return (hidden ? '<button type="button" class="tx-earlier" data-earlier="' + esc(id) + '">Show earlier · ' + hidden + ' more</button>' : '') +
      '<ol class="tx">' + I.groupTranscript(shown).map((g, i) => rowHtml(id, g, i + hidden)).join('') + '</ol>';
  }
  const pre = (text, key) => {
    const t = String(text == null ? '' : text), open = S.expand.has(key), long = t.length > 700 || t.split('\n').length > 10;
    return '<div class="tx-pre' + (long && !open ? ' clamped' : '') + '"><pre>' + esc(t) + '</pre>' + (long ? '<button type="button" class="ib-more" data-toggle="' + esc(key) + '" aria-expanded="' + open + '">' + (open ? 'Show less' : 'Show all') + '</button>' : '') + '</div>';
  };
  const prettyJson = (v) => { try { return typeof v === 'string' ? v : JSON.stringify(v, null, 2); } catch (e) { return String(v); } };
  function rowHtml(id, g, i) {
    const s = struct(), v = V();
    if (g.kind === 'tools') {
      const first = g.steps[0], cid = (first.call && first.call.callId) || (first.result && first.result.callId);
      const key = 'txg:' + id + ':' + (typeof cid === 'string' ? cid : i), open = S.expand.has(key), last = g.steps[g.steps.length - 1];
      const sum = (last.call && last.call.summary) || (last.result && last.result.summary) || '';
      const steps = !open ? '' : '<ol class="tx-steps">' + g.steps.map((x, j) => '<li class="' + (x.result && x.result.ok === false ? 'failed' : '') + '">' +
        (x.call ? '<p><span class="tx-k">Call</span>' + esc(clip(x.call.summary || '', 200)) + '</p>' + (x.call.input !== undefined ? pre(prettyJson(x.call.input), key + ':in:' + j) : '') : '') +
        (x.result ? '<p><span class="tx-k">' + (x.result.ok === false ? 'Failed' : 'Result') + '</span>' + esc(clip(x.result.summary || '', 200)) + '</p>' + (typeof x.result.text === 'string' && x.result.text ? pre(x.result.text, key + ':out:' + j) : '') : '<p class="quiet">No result yet.</p>') + '</li>').join('') + '</ol>';
      return '<li class="tx-row tx-tools' + (g.failed ? ' failed' : '') + '"><span class="tx-t num">' + esc(timeOf(g.ts)) + '</span><div class="tx-main">' +
        '<button type="button" class="tx-tool" data-toggle="' + esc(key) + '" aria-expanded="' + open + '"><span class="tx-tn">' + esc(g.tool) + '</span>' + (g.count > 1 ? '<span class="num tx-n">×' + g.count + '</span>' : '') +
        '<span class="tx-sum">' + esc(clip(sum, 140)) + '</span>' + (g.failed ? '<span class="tx-fail">' + g.failed + ' failed</span>' : '') + (g.running ? '<span class="tx-run">running</span>' : '') + '</button>' + steps + '</div></li>';
    }
    const e = g.entry, t = '<span class="tx-t num">' + esc(timeOf(e.ts)) + '</span>', text = typeof e.text === 'string' ? e.text : '';
    const row = (cls, inner) => '<li class="tx-row ' + cls + '">' + t + '<div class="tx-main">' + inner + '</div></li>';
    switch (e.kind) {
      case 'user': return row('tx-user', '<p class="tx-k">' + (e.origin === 'human' ? 'From you' : e.origin === 'system' ? 'From the system' : 'From the Lead') + '</p>' + pre(text, 'txu:' + id + ':' + i));
      case 'assistant': return row('tx-say', '<div class="md">' + md(text) + '</div>');
      case 'thinking': {
        const key = 'txh:' + id + ':' + i, open = S.expand.has(key);
        return row('tx-think', '<button type="button" class="tx-tool" data-toggle="' + esc(key) + '" aria-expanded="' + open + '"><span class="tx-tn">Thinking</span><span class="tx-sum">' + esc(open ? '' : clip(text, 120)) + '</span></button>' + (open ? pre(text, key + ':t') : ''));
      }
      case 'request': {
        const rid = typeof e.requestId === 'string' ? e.requestId : '', p = findPending(rid), done = v.ar.recent.find((r) => r.requestId === rid);
        const req = p ? p.req : done, k = I.kindInfo(req ? req.kind : 'question');
        const state = p ? (p.req.routeTo === 'human' ? 'Waiting on you · answer it above' : 'With the Lead') : done ? I.outcomeText(done) + ' · ' + I.byText(done.by, (x) => nameOf(s, x)) : '';
        return row('tx-card tone-' + k.tone, '<p><span class="ib-kind">' + esc(k.word) + '</span>' + esc(e.title || (req && req.title) || '') + '</p>' + (state ? '<p class="quiet small">' + esc(state) + '</p>' : ''));
      }
      case 'resolved': return row('tx-line', '<p>Answered' + (typeof e.outcome === 'string' ? ': ' + esc(e.outcome) : '') + (typeof e.by === 'string' ? ' · by ' + esc(e.by === 'human' ? 'you' : e.by) : '') + '</p>');
      case 'command': {
        const c = typeof e.cmdId === 'string' ? v.cmds[e.cmdId] : null, rc = I.receipt(S.local[e.cmdId], c || (typeof e.status === 'string' ? { status: e.status } : null));
        return row('tx-cmd', '<p><span class="tx-k">' + esc(e.delivery ? 'Message · ' + e.delivery : 'Command') + '</span>' + esc(clip(text, 400)) + '</p><p class="ib-rc rc-' + rc.state + '">' + esc(rc.text) + '</p>');
      }
      case 'system': return row('tx-line', '<p class="quiet">' + esc(clip(text, 300)) + '</p>');
      case 'result': {
        const u = M.usageInfo(e.usage);
        return row('tx-line' + (e.ok === false ? ' failed' : ''), '<p>' + (e.ok === false ? 'Turn ended with an error' : 'Turn finished') + (u && u.text ? ' · <span class="num">' + esc(u.text) + '</span>' : '') + '</p>' + (e.ok === false && text ? pre(text, 'txr:' + id + ':' + i) : ''));
      }
      default: return '';
    }
  }
  function outputsHtml(id) {
    const s = struct(), r = data().result, o = S.out[id];
    let h = '';
    if (httpOk()) {
      if (!o || (o.state === 'loading' && !o.files.length)) h += '<p class="quiet">Loading this agent’s files…</p>';
      else if (!o.files.length) h += '<p class="quiet">No work files yet (<code>outputs/work/' + esc(id) + '.md</code>).</p>';
      else h += o.files.map((f) => '<article class="ag-file"><p class="ag-file-k num">outputs/work/' + esc(f.name) + '</p><div class="md">' + md(f.text) + '</div></article>').join('');
    } else {
      const work = M.normalizeWork(r && r.work).find((w) => w.by === id);
      h += work ? '<article class="ag-file"><p class="ag-file-k">Work summary</p><div class="md">' + md(work.summary) + '</div></article>'
        : '<p class="quiet">This agent’s files are read from the server. Open the page through <code>mas-office serve</code> to see them.</p>';
    }
    const src = ((r && r.sources) || []).filter((x) => x && x.foundBy === id);
    if (src.length) h += '<h4 class="ag-h">Sources ' + num(String(src.length)) + '</h4><ul class="sources">' + src.map((x) => sourceItem(x, s, { noFinder: true })).join('') + '</ul>';
    return h;
  }
  function terminalHtml(id) {
    if (!SESSION.terminal) return '<p class="quiet">Raw terminal needs the optional mas-office-terminal package.</p>';
    return '<div class="ag-term" data-terminal="' + esc(id) + '"><p class="quiet">The raw terminal for this agent is shown by the mas-office-terminal package.</p></div>';
  }
  function stageHtml(g) {
    const s = struct(), ids = g ? stageMembers(g.id) : [];
    if (!g) return '<p class="quiet">This stage is not in the team any more.</p>';
    const i = M.orderGroups(s).indexOf(g);
    return '<section class="ag-head"><h3 class="ag-name">' + esc(M.groupCaption(g, i)) + '</h3><p class="ag-job">' + ids.length + (ids.length === 1 ? ' agent' : ' agents') + ' in this stage. A message below goes to each of them that takes messages.</p></section>' +
      '<ul class="stg">' + ids.map((id) => { const st = S.statuses[id] || { state: 'idle' }; return '<li><button type="button" class="stg-row" data-agent="' + esc(id) + '">' + agentChip(id) + stateBadgeFor(st) + '<span class="quiet">' + esc(clip(st.flag || st.say || '', 120)) + '</span></button></li>'; }).join('') + '</ul>';
  }
  function openAgent(id, opts) { select(id, Object.assign({ keep: true }, opts)); }
  function openStage(gid) {
    S.selected = null; office.setSelected(null);
    S.stage = gid; S.drawerMode = 'stage';
    setDrawer(true);
    renderAgentDrawer();
    renderOffice(); renderSidebar();
  }

  /* ---------- transcripts and work files (http only) ---------- */
  function loadTranscript(id) {
    if (!httpOk() || !id) return;
    const t = S.tx[id] || (S.tx[id] = { entries: [], st: null, state: 'loading', limit: 300, busy: false, again: false, at: 0 });
    if (t.busy) { t.again = true; return; }
    t.busy = true; t.at = Date.now();
    const root = ROOT;
    fetch(root + 'mas/transcript/' + encodeURIComponent(id) + '.jsonl', { cache: 'no-store' })
      .then((res) => (res.status === 404 ? (t.state = 'missing', null) : !res.ok ? (t.state = 'error', null) : res.text()))
      .then((text) => {
        if (text == null || root !== ROOT) return;
        const r = I.jsonlAppend(t.st, text);
        t.entries = (r.reset ? r.entries : t.entries.concat(r.entries)).slice(-5000);
        t.st = r.state; t.state = 'ok';
      }, () => { t.state = 'error'; })
      .then(() => {
        t.busy = false;
        if (S.drawer && S.drawerMode === 'agent' && S.drawerAgent === id) renderAgentDrawer();
        if (t.again) { t.again = false; loadTranscript(id); }
      });
  }
  async function loadOutputs(id) {
    if (!httpOk() || !id) return;
    const o = S.out[id] || (S.out[id] = { files: [], state: 'loading', busy: false, at: 0 });
    if (o.busy) return;
    o.busy = true; o.at = Date.now();
    const root = ROOT, files = [], names = [id + '.md'].concat([2, 3, 4, 5, 6, 7, 8, 9].map((k) => id + '-round' + k + '.md'));
    for (let i = 0; i < names.length; i++) {
      try {
        const res = await fetch(root + 'outputs/work/' + encodeURIComponent(names[i]), { cache: 'no-store' });
        if (!res.ok) { if (i === 0) continue; break; }
        files.push({ name: names[i], text: (await res.text()).slice(0, 200000) });
      } catch (e) { break; }
    }
    o.busy = false;
    if (root !== ROOT) return;
    o.files = files; o.state = 'ok';
    if (S.drawer && S.drawerMode === 'agent' && S.drawerAgent === id) renderAgentDrawer();
  }
  // The event stream named a changed file: re-read the open agent's transcript or work files.
  function fileChanged(p) {
    if (!(S.drawer && S.drawerMode === 'agent')) return;
    const id = S.drawerAgent;
    if (p.endsWith('mas/transcript/' + id + '.jsonl')) loadTranscript(id);
    else if (p.indexOf('outputs/work/' + id) >= 0) loadOutputs(id);
  }

  /* ---------- the chat box (agent or stage) and Stop ---------- */
  const DELIVERY = { steer: 'At its next break, without stopping it.', queue: 'After its current turn ends.', interrupt: 'Stops the current turn, then delivers it.' };
  function chatTargets() { return S.drawerMode === 'agent' ? [S.drawerAgent] : S.drawerMode === 'stage' ? stageMembers(S.stage) : []; }
  function renderFoot() {
    const foot = $('#dr-foot'), mode = S.drawerMode, s = struct();
    const show = S.drawer && (mode === 'agent' || mode === 'stage');
    foot.hidden = !show;
    if (!show) return;
    const targets = chatTargets(), msg = targets.filter((id) => accepts(id, 'message'));
    const canMsg = canAct() && msg.length > 0, canStop = canAct() && mode === 'agent' && accepts(S.drawerAgent, 'interrupt');
    const reason = !canAct() ? actReason() : !canMsg && !canStop ? (mode === 'agent' ? 'This agent does not take messages from the panel.' : 'No one in this stage takes messages from the panel.') : '';
    const ro = $('#cf-ro');
    ro.hidden = !reason; ro.textContent = reason;
    $('#cf').hidden = !canMsg && !canStop;
    $('#cf-msg').hidden = !canMsg;
    $('#cf-stop').hidden = !canStop;
    const g = mode === 'stage' && s ? (s.groups || []).find((x) => x.id === S.stage) : null;
    $('#cf-lbl').textContent = mode === 'agent' ? 'Message ' + nameOf(s, S.drawerAgent) : 'Message everyone in ' + (g ? M.groupCaption(g, M.orderGroups(s).indexOf(g)) : 'this stage') + ' (' + msg.length + ')';
    const del = ($('input[name="cf-del"]:checked') || {}).value || 'steer';
    $('#cf-hint').textContent = DELIVERY[del] || '';
    setHTML($('#cf-log'), chatLogHtml(targets));
    const stop = mode === 'agent' ? S.stops[S.drawerAgent] : null, st = S.statuses[S.drawerAgent] || {};
    const ss = stop ? I.stopState(Object.assign({}, S.local[stop.cmdId], { key: stop.key }), V().cmds[stop.cmdId], stopKey(S.drawerAgent), st.stopReason) : null;
    if (ss && ss.state === 'stopped' && !stop.doneAt) stop.doneAt = Date.now();
    if (ss && ss.state === 'stopped' && Date.now() - stop.doneAt > 6000) delete S.stops[S.drawerAgent];
    $('#cf-stopstate').textContent = ss ? ss.text : '';
    $('#cf-stop').disabled = !!ss && ss.state === 'requested';
  }
  const stopKey = (id) => { const st = S.statuses[id]; return st ? M.statusKey(st) + '|' + (st.stopReason || '') : ''; };
  function chatLogHtml(targets) {
    const v = V(), s = struct(), many = targets.length > 1;
    const lines = [];
    targets.forEach((id) => {
      const snap = v.inbox ? v.inbox.commands.filter((c) => c.agentId === id && /^command\.(message|interrupt|assign)$/.test(c.type || '')) : [];
      const seen = new Set(snap.map((c) => c.cmdId));
      Object.keys(S.local).forEach((k) => { const l = S.local[k]; if (l.agentId === id && /message|interrupt/.test(l.type) && !seen.has(k)) snap.push({ cmdId: k, type: l.type, agentId: id, text: l.text, delivery: l.delivery, origin: { kind: 'human' }, at: l.at }); });
      snap.slice(-6).forEach((c) => lines.push(c));
    });
    if (!lines.length) return '';
    return lines.slice(-8).map((c) => {
      const rc = I.receipt(S.local[c.cmdId], v.cmds[c.cmdId]);
      const who = c.origin && c.origin.kind === 'human' ? 'You' : c.origin && c.origin.id ? nameOf(s, c.origin.id) : 'Lead';
      const what = c.type === 'command.interrupt' ? 'Stop' : c.type === 'command.assign' ? 'Task' : c.delivery || 'steer';
      return '<li><span class="cf-who">' + esc(who + (many ? ' → ' + nameOf(s, c.agentId) : '') + ' · ' + what) + '</span><span class="cf-txt">' + esc(clip(c.text || '', 200)) + '</span><span class="ib-rc rc-' + rc.state + '">' + esc(rc.text) + '</span></li>';
    }).join('');
  }
  function sendChat() {
    const ta = $('#cf-text'), text = ta.value.trim();
    if (!text || !canAct()) return;
    const delivery = ($('input[name="cf-del"]:checked') || {}).value || 'steer';
    const targets = chatTargets().filter((id) => accepts(id, 'message'));
    if (!targets.length) return;
    targets.forEach((id) => sendCommand('command.message', id, { text, delivery }));
    ta.value = '';
    renderFoot();
  }
  function stopAgent() {
    const id = S.drawerAgent;
    if (!id || !canAct() || !accepts(id, 'interrupt')) return;
    S.stops[id] = { cmdId: sendCommand('command.interrupt', id, { scope: 'turn', reason: 'Stopped from the panel' }), key: stopKey(id), doneAt: 0 };
    renderFoot();
  }

  /* ---------- run controls (token + runtime) ---------- */
  function renderRunCell() {
    const cell = $('#c-run'), html = S.index ? '' : runHtml();
    cell.hidden = !html;
    if (html) keepInputs(cell, () => setHTML(cell, html));
  }
  function runHtml() {
    const v = V(), s = struct(), b = v.board;
    const ledger = b ? M.ledgerLine(b.ledger, (x) => nameOf(s, x)) : '';
    const total = b ? M.usageTotal(b.usage) : null;
    const canRun = canAct() && SESSION.runtime && !!(s && s.locked) && !runActive();
    if (!ledger && !total && !canRun && !S.runPost) return '';
    let h = '<h2>Run</h2>';
    if (ledger) h += '<p class="run-l"><span class="ag-k">Lead</span>' + esc(ledger) + '</p>';
    if (total) h += '<p class="run-u num">' + esc(total.text) + '</p>' + total.warns.map((w) => '<p class="ag-warn">' + ICON.warn + esc(nameOf(s, w.id) + ': ' + w.text) + '</p>').join('');
    if (canRun) {
      const follow = !!resultInfo();
      h += '<form class="run-f" data-run="' + (follow ? 'followUp' : 'task') + '"><label for="run-text">' + (follow ? 'Ask a follow-up' : 'Give the team a task') + '</label>' +
        '<textarea id="run-text" data-keep="run" rows="2" maxlength="4000" placeholder="' + (follow ? 'A question about the result' : 'What should the team find out?') + '"></textarea>' +
        '<button type="submit" class="dr-open">' + (follow ? 'Ask' : 'Start') + '</button></form>';
    }
    if (S.runPost && S.runPost.state === 'applied' && Date.now() - S.runPost.at > 15000) S.runPost = null; // a success is news for a moment, a failure stays
    if (S.runPost) h += '<p class="ib-rc rc-' + esc(S.runPost.state) + '" role="status">' + esc(S.runPost.text) + '</p>';
    return h;
  }
  async function startRun(kind, text) {
    const t = String(text || '').trim();
    if (!t || !canAct() || !SESSION.runtime) return;
    S.runPost = { state: 'sending', text: 'Sending…' };
    refresh();
    try {
      const res = await api('/v0/runs?project=' + encodeURIComponent(project()), { method: 'POST', body: kind === 'followUp' ? { followUp: t } : { task: t } });
      S.runPost = res.ok ? { state: 'applied', at: Date.now(), text: kind === 'followUp' ? 'Asked. The Lead is reading your question.' : 'Started. The team is getting to work.' } : { state: 'failed', text: 'Not started: ' + errorText(res) };
      if (res.ok) { const ta = $('#run-text'); if (ta) ta.value = ''; }
    } catch (e) { S.runPost = { state: 'failed', text: 'Not started: no connection to the server' }; }
    refresh();
  }

  /* ---------- claim cards in the result ---------- */
  function claimCardHtml(c) {
    const s = struct(), ver = V().ver, r = data().result;
    const srcs = c.sources.map((sid) => {
      const ev = ver.evidence[sid] || {}, rs = ((r && r.sources) || []).find((x) => x && x.id === sid) || {};
      const grade = ev.grade || (rs.evidence ? String(rs.evidence).toUpperCase().slice(0, 1) : '');
      const url = ev.url || rs.url, href = /^https?:\/\//i.test(url || '') ? url : null, title = rs.title || url || sid;
      return '<li>' + (grade ? '<span class="ev ev-' + esc(grade) + '" title="Evidence grade ' + esc(grade) + ': ' + esc(M.EVIDENCE[grade] || '') + '">' + esc(grade) + '</span>' : '<span class="ev ev-none" title="Not graded">–</span>') +
        '<span>' + (href ? '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + esc(title) + '</a>' : esc(title)) + healthChip(sid) + '</span></li>';
    });
    return '<p class="cc-st"><span class="cl-word cs-' + esc(c.status) + '">' + esc(M.CLAIM_WORDS[c.status]) + '</span>' + (c.author ? '<span class="quiet">claimed by ' + esc(nameOf(s, c.author)) + '</span>' : '') + '</p>' +
      (c.verdicts.length ? '<p class="cc-h">Verdicts</p><ul class="cc-v">' + c.verdicts.map((x) => '<li><b>' + esc(nameOf(s, x.by)) + '</b><span class="cl-word cs-' + esc(x.status) + '">' + esc(M.CLAIM_WORDS[x.status]) + '</span>' +
        (x.backend ? '<span class="quiet">' + esc(M.backendLabel(x.backend)) + '</span>' : '') + (x.sourceId ? '<span class="quiet num">' + esc(x.sourceId) + '</span>' : '') + (x.note ? '<span class="cc-note">' + esc(x.note) + '</span>' : '') + '</li>').join('') + '</ul>'
        : '<p class="quiet small">No checker has looked at this claim yet.</p>') +
      '<p class="cc-h">Cited sources</p>' + (srcs.length ? '<ul class="cc-s">' + srcs.join('') + '</ul>' : '<p class="quiet small">No source cited.</p>');
  }
  function showClaim(el, pin) {
    const ver = V().ver, c = ver && ver.byId[el.getAttribute('data-claim')];
    if (!c) return;
    const card = $('#claim-card');
    clearTimeout(S.claimTimer);
    if (S.claim && S.claim.el !== el) S.claim.el.removeAttribute('aria-describedby');
    setHTML(card, claimCardHtml(c));
    card.hidden = false;
    S.claim = { el, pin: !!pin || !!(S.claim && S.claim.el === el && S.claim.pin) };
    el.setAttribute('aria-describedby', 'claim-card');
    const r = el.getBoundingClientRect(), w = card.offsetWidth, hgt = card.offsetHeight;
    let top = r.bottom + 8;
    if (top + hgt > window.innerHeight - 8 && r.top - hgt - 8 > 8) top = r.top - hgt - 8;
    card.style.left = Math.round(Math.max(8, Math.min(r.left, window.innerWidth - w - 8))) + 'px';
    card.style.top = Math.round(Math.max(8, top)) + 'px';
  }
  function hideClaim(force) {
    if (!S.claim || (S.claim.pin && !force)) return;
    S.claim.el.removeAttribute('aria-describedby');
    S.claim = null;
    $('#claim-card').hidden = true;
  }
  document.addEventListener('mouseover', (e) => {
    const c = e.target.closest && e.target.closest('#dr-body .claim[data-claim]');
    if (c) showClaim(c, false);
    else if (e.target.closest && e.target.closest('#claim-card')) clearTimeout(S.claimTimer);
  });
  document.addEventListener('mouseout', (e) => {
    const from = e.target.closest && (e.target.closest('#dr-body .claim[data-claim]') || e.target.closest('#claim-card'));
    if (from && S.claim && !S.claim.pin) { clearTimeout(S.claimTimer); S.claimTimer = setTimeout(() => hideClaim(false), 250); }
  });
  document.addEventListener('focusin', (e) => {
    const c = e.target.closest && e.target.closest('#dr-body .claim[data-claim]');
    if (c) showClaim(c, false);
  });
  document.addEventListener('focusout', (e) => {
    if (e.target.closest && e.target.closest('#dr-body .claim[data-claim]') && S.claim && !S.claim.pin && !$('#claim-card').contains(e.relatedTarget)) hideClaim(false);
  });

  /* ---------- clicks, forms and keys for the supervision views ---------- */
  function supervisionClick(e) {
    const t = e.target;
    const claim = t.closest('#dr-body .claim[data-claim]');
    if (claim) { if (S.claim && S.claim.el === claim && S.claim.pin) hideClaim(true); else showClaim(claim, true); return true; }
    const ag = t.closest('[data-agent]');
    if (ag) { openAgent(ag.dataset.agent, { focus: true }); return true; }
    const an = t.closest('[data-answer]');
    if (an) { const item = an.closest('.ib-item'), input = item && $('form[data-reply] input', item); answer(an.dataset.answer, an.dataset.opt, input ? input.value : '', item); return true; }
    const tg = t.closest('[data-toggle]');
    if (tg) { const k = tg.dataset.toggle; if (S.expand.has(k)) S.expand.delete(k); else S.expand.add(k); renderSidebar(); return true; }
    const tab = t.closest('[data-tab]');
    if (tab) { setTab(tab.dataset.tab, false); return true; }
    const earlier = t.closest('[data-earlier]');
    if (earlier) { const x = S.tx[earlier.dataset.earlier]; if (x) { x.limit += 300; renderAgentDrawer(); } return true; }
    if (t.closest('[data-notify]')) { toggleNotify(); return true; }
    if (t.closest('[data-keys]')) { toggleKeys(true); return true; }
    if (t.closest('#keys-close')) { toggleKeys(false); return true; }
    if (t.closest('#needs')) { focusInbox(); return true; }
    if (t.closest('#cf-stop')) { stopAgent(); return true; }
    const ptr = t.closest('[data-pointer]');
    if (ptr) { openAgent(ptr.dataset.pointer, { focus: true }); return true; }
    return false;
  }
  function setTab(k, focus) {
    if (!TABS.some((x) => x[0] === k)) return;
    S.agentTab = k;
    if (k === 'transcript') loadTranscript(S.drawerAgent);
    if (k === 'outputs') loadOutputs(S.drawerAgent);
    renderAgentDrawer();
    if (focus) { const b = $('#tab-' + k); if (b) b.focus(); }
  }
  document.addEventListener('submit', (e) => {
    const f = e.target;
    if (f.matches('form[data-reply]')) { e.preventDefault(); const input = $('input', f); answer(f.dataset.reply, f.dataset.opt || null, input ? input.value : '', f.closest('.ib-item')); return; }
    if (f.id === 'cf') { e.preventDefault(); sendChat(); return; }
    if (f.matches('form[data-run]')) { e.preventDefault(); const ta = $('textarea', f); startRun(f.dataset.run, ta ? ta.value : ''); }
  });
  document.addEventListener('change', (e) => { if (e.target.name === 'cf-del') $('#cf-hint').textContent = DELIVERY[e.target.value] || ''; });
  const typing = (el) => !!el && (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' ||
    (el.tagName === 'INPUT' && !/^(radio|checkbox|button|submit|reset|range|color|file)$/i.test(el.type || '')));
  const nextUp = new I.NextUp(), nextIdle = new I.NextUp();
  function onKey(e) {
    if (EMBED) return; // embed mode: the host app owns the keyboard
    const t = e.target;
    if (t && t.id === 'cf-text' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat(); return; }
    if (e.key === 'Escape') {
      if (typing(t)) { t.blur(); return; } // first Esc leaves the text field; the next one closes
      if (S.claim) { const el = S.claim.el; hideClaim(true); if (el.isConnected) el.focus(); return; }
      if (!$('#keys').hidden) { toggleKeys(false); return; }
      if (S.drawer) setDrawer(false, { focus: true });
      else if (S.stage) { S.stage = null; renderOffice(); }
      else if (S.selected) select(null);
      return;
    }
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(t) || S.index) return;
    if (t && t.getAttribute && t.getAttribute('role') === 'tab' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      const i = TABS.findIndex((x) => x[0] === S.agentTab), n = TABS.length;
      setTab(TABS[(i + (e.key === 'ArrowRight' ? 1 : n - 1)) % n][0], true);
      e.preventDefault(); return;
    }
    const k = e.key;
    if (k === '?') { toggleKeys($('#keys').hidden); e.preventDefault(); return; }
    if (!V().live) return;
    if (k === 'n' || k === 'N') {
      e.preventDefault();
      const here = S.drawer && S.drawerMode === 'agent' ? S.drawerAgent : null;
      if (e.shiftKey) {
        const w = nextIdle.next(I.idleAgents(struct(), S.statuses), here);
        if (w) openAgent(w.id, { focus: true }); else announce('Nobody is free right now.');
        return;
      }
      const w = nextUp.next(V().waiting, here);
      if (!w) { announce('Nobody needs you right now.'); return; }
      openAgent(w.id, { focus: true });
      const first = $('#dr-body .ag-wait .ib-item');
      if (first) first.focus();
      return;
    }
    if (k === 'i' || k === 'I') { e.preventDefault(); focusInbox(); return; }
    if (k === 'a' || k === 'A' || k === 'd' || k === 'D') {
      const item = document.activeElement && document.activeElement.closest && document.activeElement.closest('.ib-item[data-req]');
      if (!item) return;
      e.preventDefault();
      const x = findPending(item.dataset.req), pair = x && I.quickPair(x.req);
      if (!pair) { announce('A and D work only on a request with one allow and one decline choice. Use its buttons.'); return; }
      if (!canAct()) { announce(actReason()); return; }
      const list = $$('.ib-item[data-req]', item.parentElement), i = list.indexOf(item), nx = list[i + 1] || list[i - 1];
      const nextId = nx && nx !== item ? nx.dataset.req : null, where = item.dataset.where;
      answer(item.dataset.req, (k === 'a' || k === 'A' ? pair.allow : pair.reject).optionId, '', item);
      // after answering, the next request is one key press away (a natural break point: P3)
      const next = nextId && $$('.ib-item[data-req]').find((el) => el.dataset.req === nextId && el.dataset.where === where);
      if (next) next.focus();
      return;
    }
    if (k === 'Enter' && S.drawer && S.drawerMode !== 'result' && (t === document.body || t === $('#drawer') || t === $('#dr-body'))) {
      const ta = $('#cf-text');
      if (ta && ta.offsetParent) { e.preventDefault(); ta.focus(); }
      return;
    }
    if (/^[1-9]$/.test(k)) {
      const s = struct(), groups = M.orderGroups(s).filter((g) => stageMembers(g.id).length), g = groups[Number(k) - 1];
      if (!g) return;
      e.preventDefault();
      openStage(g.id);
    }
  }
  function toggleKeys(open) {
    const k = $('#keys');
    k.hidden = !open;
    if (open) $('#keys-close').focus();
    else if (k.contains(document.activeElement)) document.activeElement.blur();
  }

  /* ---------- notifications (negotiated: never a toast, an OS notice only when the tab is hidden) ---------- */
  const NOTIFY_KEY = 'mas-office-notify';
  async function toggleNotify() {
    if (!notifySupported()) return;
    let on = !S.notify;
    S.notifyNote = '';
    if (on && Notification.permission !== 'granted') {
      let p = Notification.permission;
      try { if (p === 'default') p = await Notification.requestPermission(); } catch (e) { p = 'denied'; }
      if (p !== 'granted') { on = false; S.notifyNote = 'Notifications are blocked for this page in your browser settings.'; }
    }
    S.notify = on;
    try { localStorage.setItem(NOTIFY_KEY, on ? '1' : '0'); } catch (e) { /* storage blocked: on for this visit only */ }
    if (on) S.notifyNote = 'You get a system notice when someone has waited 30 s while this tab is in the background.';
    refresh();
  }
  function notifyTick() {
    const v = V(), waitingIds = new Set(v.waiting.map((w) => w.id));
    Object.keys(S.osNotes).forEach((id) => { if (!waitingIds.has(id)) { try { S.osNotes[id].close(); } catch (e) { /* gone */ } delete S.osNotes[id]; } });
    if (!notifySupported() || !S.notify || EMBED) return; // embed mode: the host app notifies
    const s = struct();
    v.waiting.forEach((w) => {
      const key = I.waitKey(w.id, w.since);
      if (!I.shouldNotify({ enabled: S.notify, permission: Notification.permission, hidden: document.hidden, blocking: true, routeTo: 'human', waitedMs: v.now - w.since, notified: S.notified.has(key) })) return;
      S.notified.add(key);
      const req = findPending(w.requestIds[0]);
      try {
        const n = new Notification(nameOf(s, w.id) + ' needs you', { body: req ? req.req.title : '', tag: 'mas-office-' + w.id });
        n.onclick = () => { try { window.focus(); } catch (e) { /* ignore */ } openAgent(w.id, { focus: true }); n.close(); };
        S.osNotes[w.id] = n;
      } catch (e) { /* some browsers only allow notifications from a service worker */ }
    });
  }

  /* ---------- after every render: pointers, title, telemetry, announcements, notifications ---------- */
  const BASE_TITLE = document.title;
  function afterRender() {
    const v = V(), n = S.index ? 0 : v.ar.human.length;
    const title = (n ? '(' + n + ') ' : '') + BASE_TITLE;
    if (document.title !== title) document.title = title;
    setFavicon(n > 0);
    if (v.inbox) {
      const ids = v.ar.human.map((x) => x.req.requestId);
      v.ar.human.concat(v.ar.withLead).forEach((x) => { const t = S.tele[x.req.requestId] || (S.tele[x.req.requestId] = {}); if (t.since == null) t.since = x.since; });
      if (!S.announced) S.announced = new Set(ids);
      else {
        const fresh = v.ar.human.filter((x) => !S.announced.has(x.req.requestId));
        fresh.forEach((x) => S.announced.add(x.req.requestId));
        if (fresh.length) announce(fresh.length === 1 ? 'New in your inbox: ' + fresh[0].req.title + ', from ' + nameOf(struct(), fresh[0].req.agentId) + '.' : fresh.length + ' new requests in your inbox.');
      }
    }
    noteSeen();
    placePointers();
    notifyTick();
    if (S.drawer && S.drawerMode !== 'result') {
      const id = S.drawerAgent, t = id && S.tx[id], o = id && S.out[id], gap = LIVE.on ? 10000 : 4000;
      if (S.drawerMode === 'agent' && S.agentTab === 'transcript' && t && !t.busy && Date.now() - t.at > gap) loadTranscript(id);
      if (S.drawerMode === 'agent' && S.agentTab === 'outputs' && o && !o.busy && Date.now() - o.at > gap * 2) loadOutputs(id);
    }
  }
  function setFavicon(on) {
    let l = $('link[rel="icon"][data-mas]');
    if (!on) { if (l) l.remove(); return; }
    if (l) return;
    l = document.createElement('link');
    l.rel = 'icon'; l.dataset.mas = '1';
    l.href = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="1" y="1" width="14" height="14" fill="#E04E2A" stroke="#1B1F23" stroke-width="1.5"/></svg>');
    document.head.appendChild(l);
  }
  function announce(text) {
    const el = $('#sr-live');
    el.textContent = '';
    setTimeout(() => { el.textContent = text; }, 40);
  }
  // HCI timing: the first moment each request's card was on screen in a foreground tab (time-to-notice).
  function noteSeen() {
    if (document.hidden) return;
    const dr = S.drawer ? $('#drawer').getBoundingClientRect() : null;
    const sideShown = window.innerWidth <= 600 || S.sidebar;
    $$('.ib-item[data-req]').forEach((el) => {
      const rid = el.dataset.req, t = S.tele[rid] || (S.tele[rid] = {});
      if (t.seen != null) return;
      const r = el.getBoundingClientRect();
      if (!r.width || r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) return;
      if (el.closest('#sidebar') && !sideShown) return;
      if (dr && !el.closest('#drawer') && r.left + r.width / 2 > dr.left && r.top + 12 < dr.bottom) return; // under the drawer
      t.seen = Date.now();
    });
  }
  // Edge pointers: an agent who waits on you but is hidden behind the drawer or the title block, or scrolled away.
  function placePointers() {
    const host = $('#pointers'), v = V();
    const list = [];
    if (v.live && !S.index && v.waiting.length) {
      const stage = $('.stage').getBoundingClientRect(), rule = $('.rule').getBoundingClientRect(), margin = 30;
      let right = Math.min(stage.right, window.innerWidth);
      if (S.drawer) right = Math.min(right, $('#drawer').getBoundingClientRect().left);
      if (narrow() && S.sidebar && window.innerWidth > 600) right = Math.min(right, $('#sidebar').getBoundingClientRect().left);
      const box = { left: Math.max(0, stage.left) + margin, right: right - margin, top: Math.max(stage.top, rule.bottom) + margin, bottom: Math.min(window.innerHeight, stage.bottom) - margin };
      if (box.right - box.left > 160 && box.bottom - box.top > 120) {
        const pts = v.waiting.filter((w) => !(S.drawer && S.drawerMode === 'agent' && S.drawerAgent === w.id)).map((w) => {
          const r = office.figRect(w.id);
          return r && r.width ? { id: w.id, x: r.left + r.width / 2, y: r.top + r.height * 0.35, since: w.since } : null;
        }).filter(Boolean);
        I.edgeMarks(pts, box).forEach((m) => list.push(Object.assign(m, { since: pts.find((p) => p.id === m.id).since })));
      }
    }
    const s = struct();
    setHTML(host, list.map((m) => '<button type="button" class="ptr ptr-' + m.edge + '" data-pointer="' + esc(m.id) + '" style="left:' + Math.round(m.x) + 'px;top:' + Math.round(m.y) + 'px" aria-label="' + esc(nameOf(s, m.id) + ' needs you. Open') + '">' +
      '<span class="ptr-arrow" style="transform:rotate(' + m.angle.toFixed(2) + 'rad)" aria-hidden="true"></span>' + agentChip(m.id) + '<span class="num">' + esc(I.waited(m.since, v.now) || 'now') + '</span></button>').join(''));
  }

  // Start-up for the supervision views: the saved "Notify me" choice, the session check, pointer upkeep.
  function startSupervision() {
    $('#keys-close').innerHTML = ICON.close;
    try { S.notify = localStorage.getItem(NOTIFY_KEY) === '1'; } catch (e) { S.notify = false; }
    checkSession();
    window.addEventListener('resize', () => { if (S.loadedOnce) placePointers(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && S.loadedOnce) afterRender(); });
  }

  /* ---------- live mode: `mas-office serve` pushes changes over Server-Sent Events ---------- */
  // Only over http(s) (never on file://) and only when the server answers /v0/health with {ok: true}.
  const LIVE = { on: false, es: null, retry: 0, timer: 0, debounce: 0 };
  function setLive(on) { if (LIVE.on !== on) { LIVE.on = on; renderTop(); } }
  async function startLive() {
    if (STATIC || !/^https?:$/.test(location.protocol) || !window.EventSource || !window.fetch) return;
    clearTimeout(LIVE.timer);
    let ok = false;
    try {
      const ctl = window.AbortController ? new AbortController() : null, t = setTimeout(() => ctl && ctl.abort(), 3000);
      const res = await fetch('/v0/health', { cache: 'no-store', signal: ctl ? ctl.signal : undefined });
      clearTimeout(t);
      ok = res.ok && (await res.json()).ok === true;
    } catch (e) { ok = false; }
    if (!ok) return; // a plain static server: keep polling, nothing else changes
    const es = LIVE.es = new EventSource('/v0/stream');
    const changed = (e) => {
      let p = '';
      try { p = String((JSON.parse(e.data) || {}).path || ''); } catch (err) { p = ''; }
      if (p) fileChanged(p);
      clearTimeout(LIVE.debounce); LIVE.debounce = setTimeout(() => poll(true), 100);
    };
    es.addEventListener('change', changed);
    es.addEventListener('mas', changed);
    es.onopen = () => { LIVE.retry = 0; setLive(true); poll(true); }; // catch up on anything missed while disconnected
    es.onerror = () => {
      setLive(false);
      if (es.readyState !== EventSource.CLOSED) return; // the browser is already reconnecting
      es.close(); LIVE.es = null;
      LIVE.timer = setTimeout(startLive, Math.min(30000, 2000 * Math.pow(2, LIVE.retry++))); // back off: 2, 4, 8 … 30 s
    };
  }

  /* ---------- start ---------- */
  $('#replay').hidden = !S.demo;
  $('#sb-toggle').innerHTML = ICON.panel + '<span>Title block</span>';
  $('#dr-close').innerHTML = ICON.close;
  setSidebar(S.sidebar);
  renderTop();
  renderSidebar();
  poll();
  startSupervision();
  // Fallback polling: every 2 s, slowed to every 10 s while the event stream tells us about changes.
  if (!STATIC) setInterval(() => { if (!LIVE.on || Date.now() - lastPoll >= 9900) poll(); }, 2000);
  startLive();
  setInterval(() => { if (S.loadedOnce) { S.v = sup(); renderTop(); renderOffice(); renderSidebar(); afterRender(); } }, 1000);
  if (S.demo) { demoStart = performance.now(); setInterval(demoTick, 250); }
})();
