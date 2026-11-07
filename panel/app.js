/* MAS Office · live panel — a read-only drawing sheet of a multi-agent team.
   The team is run elsewhere (an AI assistant following AGENTS.md, or a program using an SDK); this page only reads
   the project's snapshot files. Over http(s) from `mas-office serve` it also listens to the event stream. */
(function () {
  'use strict';
  const M = window.MASModel;
  const esc = M.esc;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const params = new URLSearchParams(location.search);
  // ?root= (examples) and ?demo=1 show one fixed project; otherwise home/projects.js says which MAS to follow.
  // Only a relative folder inside the workspace is accepted (scripts load from it); anything else means normal mode.
  const FIXED_ROOT = params.get('root') === null ? null : M.safeRoot(params.get('root'));
  let ROOT = FIXED_ROOT || '../';
  const FIXED = !!FIXED_ROOT || params.get('demo') === '1';
  // Published examples are immutable: load once, without live-server probing or snapshot polling.
  const STATIC = params.get('static') === '1';

  const FILES = { env: 'mas/env.js', state: 'mas/state.js', task: 'me/task.js', structure: 'mas/structure.js', result: 'outputs/result.js' };
  const GLOBALS = { env: 'MAS_ENV', state: 'MAS_STATE', task: 'MAS_TASK', structure: 'MAS_STRUCTURE', result: 'MAS_RESULT' };
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
    globe: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M1.8 8h12.4M8 1.8c-3 3.4-3 9 0 12.4M8 1.8c3 3.4 3 9 0 12.4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    folder: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 3.25h4.5l1.5 1.5h6.5v8H1.75z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    ask: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.6" fill="#BDCBEA" stroke="#1B1F23" stroke-width="1.2"/><path d="M6 6.3a2 2 0 1 1 2.6 1.9c-.5.2-.6.5-.6 1v.5M8 11.3v.5" fill="none" stroke="#1B1F23" stroke-width="1.4" stroke-linecap="round"/></svg>',
    fail: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="1.5" width="13" height="13" fill="#F4C2B1" stroke="#1B1F23" stroke-width="1.2"/><path d="M5.2 5.2l5.6 5.6M10.8 5.2l-5.6 5.6" stroke="#1B1F23" stroke-width="1.6" stroke-linecap="square"/></svg>'
  };
  // The icon for a status that carries a flag (a found problem, a question for you, a failure), else ''.
  const flagIcon = (st) => { const f = M.flagInfo(st); return f ? ICON[f.icon] : ''; };
  const narrow = () => window.innerWidth <= 1100;
  const S = {
    demo: params.get('demo') === '1', data: {}, statuses: M.dict(), history: M.dict(), feed: [], timing: M.dict(), run: { start: 0, end: 0 },
    sigs: {}, lastChange: 0, loadedOnce: false, warnings: {}, selected: null, phase: undefined,
    sidebar: params.get('sidebar') ? params.get('sidebar') === 'open' : !narrow(), userSidebar: !!params.get('sidebar'), autoRun: undefined, drawer: false, drawerFull: false,
    home: null, current: undefined, index: false
  };
  // A different MAS is now followed: everything per project starts over, as if the page had just opened.
  function resetProject() {
    Object.assign(S, { data: {}, statuses: M.dict(), history: M.dict(), feed: [], timing: M.dict(), run: { start: 0, end: 0 }, sigs: {}, selected: null,
      phase: undefined, warnings: {}, loadedOnce: false, autoRun: undefined });
    document.body.classList.remove('isolate');
    setDrawer(false);
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
    const cur = home ? home.current : '';
    if (cur !== S.current) { if (S.current !== undefined) resetProject(); S.current = cur; }
    const homeChanged = homeSig !== S.sigs.home;
    S.home = home; S.sigs.home = homeSig;
    ROOT = !home ? '../' : '../' + home.current + '/';
    S.index = !!home && !home.current;
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
    Object.keys(FILES).forEach((k) => { const sg = sigOf(next[k]); if (sg !== S.sigs[k]) { changed = true; S.sigs[k] = sg; } });
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
  }

  /* ---------- title-block sidebar ---------- */
  function setSidebar(open) {
    S.sidebar = open;
    if (open) $('#sb-toggle').classList.remove('news');
    document.body.classList.toggle('sb-closed', !open);
    $('#sb-toggle').setAttribute('aria-expanded', String(open));
  }
  function select(id) {
    if (id && id === S.selected) id = null;
    S.selected = id;
    if (id) setDrawer(false);
    office.setSelected(id);
    if (id && narrow() && window.innerWidth > 600) setSidebar(true);
    renderSidebar();
    if (id) { const c = $('#cells'); if (c) c.scrollTop = 0; }
  }
  function renderSidebar() {
    document.body.classList.toggle('index', S.index); // the index is one full-width sheet: no title-block column
    const folder = $('#c-folder');
    folder.hidden = !S.home || (!S.index && S.home.projects.length < 2);
    if (!folder.hidden) setHTML(folder, folderHtml());
    ['#c-task', '#c-team', '#c-activity'].forEach((k) => { $(k).hidden = S.index; });
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
    if (!ri) setDrawer(false);
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
    const sub = (r) => '<div class="org-to">' + (r.tools || []).map((t) => (t === 'web search' ? ICON.globe : ICON.folder)).join('') + ' hands to ' + esc(nameOf(s, r.handsTo || 'lead')) +
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
  function sourcesHtml(r, s) {
    if (!(r.sources || []).length) return '';
    return '<h3>Sources ' + num(String(r.sources.length)) + '</h3><ul class="sources">' + r.sources.map((x) => {
      const ev = String(x.evidence || 'D').toUpperCase().slice(0, 1);
      const href = /^https?:\/\//i.test(x.url || '') ? x.url : null;
      return '<li><span class="ev ev-' + esc(ev) + '" title="' + esc(M.EVIDENCE[ev] || '') + '">' + esc(ev) + '</span><span>' + (href ? '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + esc(x.title || x.url) + '</a>' : esc(x.title || x.id || '')) +
        '<span class="quiet"> · found by ' + esc(nameOf(s, x.foundBy)) + (x.id ? ' · <a href="' + esc(ROOT + 'sources/' + x.id + '.md') + '" target="_blank" rel="noopener">card</a>' : '') + '</span></span></li>';
    }).join('') + '</ul><p class="ev-key">' + Object.keys(M.EVIDENCE).map((k) => '<span><span class="ev ev-' + k + '">' + k + '</span>' + esc(M.EVIDENCE[k]) + '</span>').join('') + '</p>';
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
    const art = (x) => '<article class="dr-round" id="dr-round-' + x.round + '" data-round="' + x.round + '">' +
      '<p class="dr-k">' + num('Round ' + String(x.round).padStart(2, '0')) + '<span>' + roundLabel(x) + '</span>' + (x.latest && many ? '<span class="dr-latest">Latest</span>' : '') + '</p>' +
      (x.question ? '<p class="dr-q"><span class="quiet">You asked</span>' + esc(x.question) + '</p>' : '') +
      (x.title && (x.latest || x.title !== r.title) ? '<p class="res-title">' + esc(x.title) + '</p>' : '') +
      '<div class="md">' + md(x.markdown) + '</div></article>';
    return ri.rounds.map(art).join('') + resultExtras(r, s);
  }
  function renderDrawer(ri) {
    const dr = $('#drawer');
    if (!ri) return;
    setHTML($('#dr-title'), 'Result ' + (ri.r.run != null ? num('run ' + ri.r.run) : ''));
    const nav = $('#dr-rounds');
    nav.hidden = ri.rounds.length < 2;
    setHTML(nav, ri.rounds.map((x) => '<button type="button" data-round-go="' + x.round + '">' + num(String(x.round).padStart(2, '0')) + '<span>' + roundLabel(x) + '</span></button>').join(''));
    setHTML($('#dr-body'), drawerHtml(ri));
    const full = $('#dr-size');
    setHTML(full, (S.drawerFull ? ICON.shrink : ICON.expand) + '<span>' + (S.drawerFull ? 'Side view' : 'Full screen') + '</span>');
    dr.classList.toggle('full', S.drawerFull);
  }
  function setDrawer(open, opts) {
    const dr = $('#drawer');
    if (!dr) return;
    const was = S.drawer;
    S.drawer = !!open;
    dr.classList.toggle('open', S.drawer);
    dr.setAttribute('aria-hidden', String(!S.drawer));
    if ('inert' in dr) dr.inert = !S.drawer;
    document.body.classList.toggle('drawer-open', S.drawer);
    if (S.drawer && !was) {
      showLatestRound();
      if (opts && opts.focus) $('#dr-close').focus();
    }
    if (!S.drawer && was) {
      const inside = dr.contains(document.activeElement);
      if (!S.sidebar && resultInfo()) $('#sb-toggle').classList.add('news'); // the result card waits in the closed title block
      if (inside || (opts && opts.focus)) { // never leave focus on a closed, inert drawer
        const visible = (el) => el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
        const to = [$('[data-drawer="open"]'), $('#sb-toggle')].find(visible);
        if (to) to.focus(); else if (inside) document.activeElement.blur();
      }
    }
  }
  // Render the drawer and scroll it to the newest round: a follow-up opens at its own answer.
  function showLatestRound() {
    const ri = resultInfo();
    if (!ri) return;
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
    return flags || (r.sources || []).length ? '<section class="dr-extras">' + flags + sourcesHtml(r, s) + '</section>' : '';
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
      (id === 'lead' || !s ? '' : row('Tools', esc((m.tools || []).join(', ') || 'none')) + row('Group', g ? esc(M.groupCaption(g, M.orderGroups(s).indexOf(g))) : esc(m.group || '')) + row('Hands to', esc(nameOf(s, m.handsTo || 'lead')))) +
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
    const sel = e.target.closest('[data-select]');
    if (sel) { select(sel.dataset.select || null); return; }
    if (e.target.closest('#sb-toggle')) setSidebar(!S.sidebar);
    if (e.target.closest('[data-drawer="open"]')) { if (S.selected) select(null); setDrawer(true, { focus: true }); return; }
    if (e.target.closest('#dr-close')) { setDrawer(false, { focus: true }); return; }
    if (e.target.closest('#dr-size')) { S.drawerFull = !S.drawerFull; renderDrawer(resultInfo()); return; }
    const go = e.target.closest('[data-round-go]');
    if (go) { const a = $('#dr-round-' + go.dataset.roundGo), body = $('#dr-body'); if (a && body) body.scrollTo({ top: a.offsetTop - body.offsetTop, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); return; }
    if (e.target.closest('#replay')) { S.replays = (S.replays || 0) + 1; demoStart = performance.now(); S.history = M.dict(); S.feed = []; S.timing = M.dict(); S.run = { start: 0, end: 0 }; demoTick(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (S.drawer) setDrawer(false, { focus: true });
    else if (S.selected) select(null);
  });

  /* ---------- render ---------- */
  function render() {
    renderTop();
    renderOffice();
    if (S.index) { renderSidebar(); return; }
    const ri = resultInfo();
    if (ri && ri.key !== S.autoRun) { // a new result or follow-up round: once per key
      // it arrived while the page was open: the drawer slides out over the office (the drawing keeps its size);
      // a result that was already there on opening only gets its card in the title block
      // the replayed demo (?demo=1, e.g. the website) keeps its wrap party in view: card only
      const due = !S.demo && M.drawerDue(S.autoRun, ri.key);
      S.autoRun = ri.key;
      if (due) {
        if (S.selected) select(null);
        if (S.drawer) showLatestRound(); else setDrawer(true); // already open: jump to the new round
      } else if (!S.sidebar) $('#sb-toggle').classList.add('news');
      const c = $('#cells'); if (c && !S.selected) c.scrollTop = 0;
    }
    // looked and saw no ready result: the next one that arrives is new. A stale result file from the previous
    // run or round keeps its key, so it never pops up again as if it were new (e.g. a run that fails without one).
    if (!ri && S.loadedOnce) S.autoRun = data().result ? resultKeys(data().result).key : null;
    renderSidebar();
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
    const changed = () => { clearTimeout(LIVE.debounce); LIVE.debounce = setTimeout(() => poll(true), 100); };
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
  // Fallback polling: every 2 s, slowed to every 10 s while the event stream tells us about changes.
  if (!STATIC) setInterval(() => { if (!LIVE.on || Date.now() - lastPoll >= 9900) poll(); }, 2000);
  startLive();
  setInterval(() => { if (S.loadedOnce) { renderTop(); renderOffice(); renderSidebar(); } }, 1000);
  if (S.demo) { demoStart = performance.now(); setInterval(demoTick, 250); }
})();
