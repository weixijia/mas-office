/* MAS Office — pure model functions.
   Loaded by the browser (window.MASModel) and by Node tests (module.exports).
   Everything here is side-effect free so it can be tested without a DOM. */
(function () {
  'use strict';

  const TOOLS = ['web search', 'browse the web', 'read my files'];
  const STATES = ['idle', 'waiting', 'working', 'handoff', 'flagged', 'done', 'failed'];
  const FINISHED = ['done', 'failed']; // terminal states: nothing more will happen at this desk this run
  const MAX_DESKS = 12; // roles drawn at a desk; the rest are counted ("+N more") and listed in the Team cell
  const ROLE_COLORS = ['#E8735A', '#2F9E8F', '#E2A23B', '#8E6BB8', '#4D8FD1', '#7AAE5B', '#D9668C', '#C2703D'];
  const GROUP_COLORS = ['#E8735A', '#2F9E8F', '#E2A23B', '#8E6BB8', '#4D8FD1', '#7AAE5B'];
  const EVIDENCE = { A: 'Can be bought or run', B: 'Study with data', C: 'Demo or marketing', D: 'Opinion' };

  const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
  // A map keyed by agent ids that come from files: no prototype, so ids like "constructor" or "__proto__" are plain keys.
  const dict = (from) => Object.assign(Object.create(null), from);
  // `?root=` (the examples): a relative folder that stays inside the workspace, the panel's parent folder.
  // Anything else (a URL, `//host`, an absolute path, backslashes, %-escapes, `..` above the workspace) is refused,
  // because the panel loads <script> files from it.
  function safeRoot(value) {
    if (typeof value !== 'string' || !value || /^[a-z][a-z0-9+.-]*:|^\/\/|\\/i.test(value)) return null;
    if (value.startsWith('/') || !/^[A-Za-z0-9._~/-]+$/.test(value)) return null;
    let depth = 0;
    for (const seg of value.split('/')) {
      if (seg === '..') depth--;
      else if (seg && seg !== '.') depth++;
      if (depth < -1) return null; // above the workspace
    }
    return value.endsWith('/') ? value : value + '/';
  }
  const oneLine = (s) => String(s == null ? '' : s).replace(/\s*\n\s*/g, ' ').trim();

  function hash(str) {
    let h = 2166136261;
    for (const ch of String(str)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  const colorFor = (id) => (id === 'lead' ? '#3D5A80' : ROLE_COLORS[hash(id) % ROLE_COLORS.length]);

  /* ---------- structure helpers ---------- */
  function roleName(s, id) {
    const lead = (s && s.lead) || {};
    if (!id || id === 'lead') return lead.name || 'Lead';
    const r = ((s && s.roles) || []).find((x) => x.id === id);
    return r ? r.name : id;
  }
  function member(s, id) {
    if (!s) return null;
    if (id === 'lead') return s.lead || null;
    return (s.roles || []).find((r) => r.id === id) || null;
  }
  // Groups in run order: follow the `after` chain; unreachable groups keep array order at the end.
  function orderGroups(s) {
    const groups = (s && s.groups) || [];
    const out = [], seen = new Set();
    let frontier = groups.filter((g) => !g.after || !groups.some((x) => x.id === g.after));
    while (frontier.length) {
      frontier.forEach((g) => { if (!seen.has(g.id)) { seen.add(g.id); out.push(g); } });
      frontier = groups.filter((g) => !seen.has(g.id) && seen.has(g.after));
    }
    groups.forEach((g) => { if (!seen.has(g.id)) out.push(g); });
    return out;
  }
  const DYN = 'dyn', DYN_LABEL = 'Spawned at runtime';
  function groupCaption(g, index) {
    if (g.id === DYN) return g.label || DYN_LABEL;
    return (index > 0 ? 'then ' : '') + g.id + ' · ' + (g.label || 'Group ' + g.id);
  }
  function zoneCaption(g, count) {
    if (g.id === DYN) return g.label || DYN_LABEL;
    if (g.after) return g.id + ' · after ' + g.after;
    return g.id + (count > 1 ? ' · in parallel' : ' · first');
  }
  // Agents that appeared at runtime (`dynamic: true`) live in group `dyn`; add that group when a hand-written
  // structure forgot it, so they get a room of their own instead of "No group yet". Other roles are untouched.
  function withDynamicGroup(s) {
    if (!s || !Array.isArray(s.roles)) return s;
    const roles = s.roles.map((r) => (r && r.dynamic && !r.group ? Object.assign({}, r, { group: DYN }) : r));
    const groups = Array.isArray(s.groups) ? s.groups : [];
    const need = roles.some((r) => r && r.group === DYN) && !groups.some((g) => g && g.id === DYN);
    if (!need && roles.every((r, i) => r === s.roles[i])) return s;
    const last = groups.length ? groups[groups.length - 1].id : null;
    return Object.assign({}, s, { roles, groups: need ? groups.concat({ id: DYN, label: DYN_LABEL, after: last }) : groups });
  }
  // Roles in drawing order (run order of their groups, orphans last), split into the first `max` (drawn at desks) and
  // the rest (counted). New agents are appended at the end, so the drawn set stays put while a run spawns more.
  function capRoles(s, max) {
    const roles = ((s && s.roles) || []).filter(Boolean), cap = max == null ? MAX_DESKS : max;
    const order = orderGroups(s).map((g) => g.id), rank = (r) => { const i = order.indexOf(r.group); return i < 0 ? order.length : i; };
    const sorted = roles.map((r, i) => [r, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0]);
    const shown = new Set(sorted.slice(0, cap).map((r) => r.id));
    const hidden = sorted.slice(cap).map((r) => r.id);
    if (!hidden.length) return { structure: s, hidden };
    return { structure: Object.assign({}, s, { roles: roles.filter((r) => shown.has(r.id)) }), hidden };
  }
  function receivesFrom(s, id) {
    return ((s && s.roles) || []).filter((r) => (r.handsTo || 'lead') === id && r.id !== id).map((r) => r.id);
  }

  /* ---------- checks ---------- */
  function coverage(s, task) {
    const reqIds = ((task && task.requirements) || []).map((r) => r.id);
    const servedBy = dict(Object.fromEntries(reqIds.map((id) => [id, []])));
    const people = s ? [s.lead || {}].concat(s.roles || []) : [];
    const rolesWithoutReq = [], unknownRefs = [];
    people.forEach((p) => {
      const valid = (p.serves || []).filter((r) => !reqIds.length || reqIds.includes(r));
      (p.serves || []).forEach((r) => {
        if (servedBy[r]) servedBy[r].push(p.id || 'lead');
        else if (reqIds.length) unknownRefs.push({ id: p.id || 'lead', req: r });
      });
      if (p.id && p.id !== 'lead' && !valid.length) rolesWithoutReq.push(p.id);
    });
    const unservedReqs = s ? reqIds.filter((id) => !servedBy[id].length) : [];
    return { servedBy, rolesWithoutReq, unservedReqs, unknownRefs };
  }
  function costInfo(roleCount) {
    const agents = Math.max(0, roleCount | 0) + 1;
    return {
      agents,
      text: agents + (agents === 1 ? ' agent' : ' agents') + ' ≈ ' + agents + '× the tokens of one assistant',
      sub: 'Lead + ' + (agents - 1) + (agents === 2 ? ' role' : ' roles'),
      level: agents <= 3 ? 'calm' : agents <= 5 ? 'warm' : 'hot',
      fraction: Math.min(agents / 10, 1)
    };
  }

  /* ---------- progress ---------- */
  const isSdk = (d) => !!(d && d.state && d.state.mode === 'sdk');
  function deriveProgress(d) {
    const st = (d && d.state) || {};
    const s = d && d.structure;
    if (isSdk(d)) { // a program runs the team: there is no describe → design → lock journey and no task file to wait for
      const step = !s ? 2 : !s.locked ? 3 : 4;
      return { step, done: st.phase === 'done' && step === 4, started: true, sdk: true };
    }
    const derived = !d.task ? 1 : !s ? 2 : !s.locked ? 3 : 4;
    const n = Number(st.step);
    let step = n >= 1 && n <= 4 ? Math.max(n, derived) : derived;
    if (s && !s.locked) step = Math.min(step, 3);
    if (!d.task) step = 1;
    const done = st.phase === 'done' && step === 4;
    return { step, done, started: !!(d.env || d.state || d.task) };
  }
  // Wrap the command the student should type in <code>. Input is escaped first.
  function formatHint(text) {
    return esc(text || 'Type next in your assistant to start.')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/(\b[Tt]ype\s+)(run again|next|unlock|run)\b/g, '$1<code>$2</code>');
  }
  /* ---------- safe markdown ---------- */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function safeHref(url, resolve) {
    const u = String(url).trim();
    if (/^(https?:|mailto:)/i.test(u) || u.startsWith('#')) return u;
    if (/^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith('//')) return null;
    return resolve ? resolve(u) : u;
  }
  function emphasis(t) {
    return t.replace(/\*\*(?=\S)(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/__(?=\S)(.+?)__/g, '<strong>$1</strong>')
      .replace(/(^|[^\w*])\*(?=\S)([^*]+?)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/(^|[^\w])_(?=\S)([^_]+?)_(?!\w)/g, '$1<em>$2</em>');
  }
  function inlineMd(text, opts) {
    const re = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    const out = [];
    let last = 0, m;
    while ((m = re.exec(text))) {
      out.push(emphasis(esc(text.slice(last, m.index))));
      if (m[1] != null) out.push('<code>' + esc(m[1]) + '</code>');
      else {
        const href = safeHref(m[3], opts && opts.resolveLink);
        const label = emphasis(esc(m[2]));
        out.push(href == null ? label : '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>');
      }
      last = re.lastIndex;
    }
    out.push(emphasis(esc(text.slice(last))));
    return out.join('');
  }
  function renderMarkdown(md, opts) {
    const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
    const html = [];
    const isSep = (l) => l != null && l.includes('-') && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
    const isHr = (l) => /^\s*([-*_])(\s*\1){2,}\s*$/.test(l);
    const listRe = /^\s*([-*+]|\d+[.)])\s+/;
    const startsBlock = (l, n) => /^#{1,6}\s/.test(l) || listRe.test(l) || /^>/.test(l) || isHr(l) || (l.includes('|') && isSep(n));
    const row = (l) => { let s = l.trim(); if (s.startsWith('|')) s = s.slice(1); if (s.endsWith('|')) s = s.slice(0, -1); return s.split('|').map((c) => c.trim()); };
    let i = 0, m;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { i++; continue; }
      if ((m = l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/))) {
        html.push('<h' + m[1].length + '>' + inlineMd(m[2], opts) + '</h' + m[1].length + '>'); i++; continue;
      }
      if (isHr(l)) { html.push('<hr>'); i++; continue; }
      if (l.includes('|') && isSep(lines[i + 1])) {
        const head = row(l);
        const al = row(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
        const cell = (tag, c, j) => '<' + tag + (al[j] ? ' style="text-align:' + al[j] + '"' : '') + '>' + inlineMd(c || '', opts) + '</' + tag + '>';
        const body = [];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) body.push(row(lines[i++]));
        html.push('<div class="md-table"><table><thead><tr>' + head.map((c, j) => cell('th', c, j)).join('') + '</tr></thead><tbody>' +
          body.map((r) => '<tr>' + head.map((_, j) => cell('td', r[j], j)).join('') + '</tr>').join('') + '</tbody></table></div>');
        continue;
      }
      if (listRe.test(l)) {
        const ordered = /^\s*\d/.test(l);
        const itemRe = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
        const items = [];
        while (i < lines.length && (m = lines[i].match(itemRe))) {
          let t = m[1]; i++;
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !listRe.test(lines[i])) t += ' ' + lines[i++].trim();
          items.push('<li>' + inlineMd(t, opts) + '</li>');
        }
        const tag = ordered ? 'ol' : 'ul';
        html.push('<' + tag + '>' + items.join('') + '</' + tag + '>');
        continue;
      }
      if (/^>/.test(l)) {
        const q = [];
        while (i < lines.length && /^>/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ''));
        html.push('<blockquote>' + inlineMd(q.join(' '), opts) + '</blockquote>');
        continue;
      }
      const para = [l.trim()];
      i++;
      while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) para.push(lines[i++].trim());
      html.push('<p>' + inlineMd(para.join(' '), opts) + '</p>');
    }
    return html.join('\n');
  }

  /* ---------- data files ---------- */
  // Evaluate a data file (`window.MAS_X = {...}`) against a fresh object instead of the real window.
  function evalDataFile(text) {
    const win = {};
    new Function('window', String(text))(win); // eslint-disable-line no-new-func
    return win;
  }
  function pushSay(history, id, status, max) {
    if (!status || !status.say) return false;
    const list = history[id] || (history[id] = []);
    const last = list[list.length - 1];
    if (last && last.say === status.say && last.state === status.state) return false;
    list.push({ say: status.say, state: status.state, at: Date.now() });
    while (list.length > (max || 5)) list.shift();
    return true;
  }
  function timeAgo(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return Math.floor(s / 86400) + ' d ago';
  }

  /* ---------- live view helpers ---------- */
  const PHASE_LINES = {
    setup: 'Getting set up.',
    describe: 'Tell your assistant about your task.',
    design: 'Task captured. Next, your assistant designs a team.',
    refine: 'Your team design is ready. Refine it by chatting with your assistant.',
    locked: 'Team locked. Ready to run.',
    running: 'Your team is working.',
    done: 'Result ready.',
    failed: 'The run failed.'
  };
  // One plain sentence about what is happening now (from MAS_STATE.phase, else from which files exist).
  function phaseLine(d) {
    const ph = d && d.state && d.state.phase;
    if (PHASE_LINES[ph]) return PHASE_LINES[ph];
    if (!d || (!d.env && !d.state && !d.task)) return 'Waiting for your assistant. Say hi to it to start.';
    if (!d.task) return PHASE_LINES.describe;
    if (!d.structure) return PHASE_LINES.design;
    if (!d.structure.locked) return PHASE_LINES.refine;
    return d.result ? PHASE_LINES.done : PHASE_LINES.locked;
  }
  // What a role's screen shows, guessed from its `say` text (English + a few Chinese keywords).
  const ACTIVITY_RULES = [
    ['search', /\b(search|look|find|brows|googl)|搜|查找|寻找|浏览/i],
    ['check', /\b(reads?\b|reading|check|re-?check|verif|review|audit|confirm|compar|inspect)|核|检查|审|校对/i],
    ['sheet', /\b(prices?|pricing|add(s|ed|ing)?\b|total|budget|calculat|sums?\b|costs?|fees?)|[£€$¥]|价|预算|计算|费用/i],
    ['write', /\b(writ|draft|summar|combin|compil|shortlist|report|merg)|撰|写|汇总|整合|总结/i],
    ['plan', /\b(plan|schedul|itinerar|timeline|calendar|assign)|计划|规划|日程|安排/i]
  ];
  function activityFor(st) {
    if (!st || st.state === 'idle') return 'off';
    if (st.state === 'waiting') return 'screensaver';
    if (st.state === 'done') return 'done';
    if (st.state === 'failed') return 'failed';
    const say = String(st.say || '');
    for (const [k, re] of ACTIVITY_RULES) if (re.test(say)) return k;
    return 'type';
  }
  function clampProgress(p) {
    const n = typeof p === 'string' ? parseFloat(p) : p;
    return typeof n === 'number' && isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
  }
  function formatElapsed(ms) {
    const t = Math.max(0, Math.floor((ms || 0) / 1000));
    if (t < 60) return t + 's';
    if (t < 3600) return Math.floor(t / 60) + 'm ' + String(t % 60).padStart(2, '0') + 's';
    return Math.floor(t / 3600) + 'h ' + String(Math.floor(t / 60) % 60).padStart(2, '0') + 'm';
  }
  const BUSY = ['working', 'flagged', 'handoff'];
  function teamProgress(s, statuses) {
    const roles = (s && s.roles) || [], st = statuses || {};
    const busy = (x) => !!x && BUSY.includes(x.state);
    const done = roles.filter((r) => st[r.id] && st[r.id].state === 'done').length;
    const failed = roles.filter((r) => st[r.id] && st[r.id].state === 'failed').length, finished = done + failed;
    let active = null;
    for (const g of orderGroups(s)) {
      const ms = roles.filter((r) => r.group === g.id), w = ms.filter((r) => busy(st[r.id])).length;
      if (w) { active = { group: g, working: w, size: ms.length }; break; }
    }
    const text = active ? 'Group ' + active.group.id + ' · ' + (active.working > 1 ? active.working + ' working in parallel' : '1 working')
      : busy(st.lead) ? 'Lead is working'
      : roles.length && done === roles.length ? 'All roles done'
      : roles.length && finished === roles.length ? 'All roles finished · ' + failed + ' failed'
      : roles.some((r) => st[r.id] && st[r.id].state === 'waiting') ? 'Team waiting to start' : 'Nobody is working right now';
    return { done, failed, finished, total: roles.length, active, text, fraction: roles.length ? finished / roles.length : 0 };
  }
  // How the run ends for the office: null while anyone still has work to do; 'party' when everyone is done;
  // 'quiet' when everyone has finished but someone failed (no bunting, no games: coffee and the sofa).
  function wrapUp(states) {
    const list = (states || []).map((x) => (x && typeof x === 'object' ? x.state : x));
    if (!list.length || !list.every((x) => FINISHED.includes(x))) return null;
    return list.includes('failed') ? 'quiet' : 'party';
  }
  /* ---------- flags: a found problem vs. a question for the person watching ---------- */
  const FLAG_KINDS = {
    concern: { word: 'flagged', title: 'Found a problem', icon: 'warn' },
    needs_input: { word: 'needs you', title: 'Needs your input', icon: 'ask', needsYou: true },
    needs_approval: { word: 'needs you', title: 'Needs your approval', icon: 'ask', needsYou: true },
    error: { word: 'failed', title: 'Failed', icon: 'fail' }
  };
  // The wording for a status: the badge word, the flag box title and the icon (null when there is nothing to flag).
  function flagInfo(st) {
    if (!st) return null;
    if (st.state === 'failed') return FLAG_KINDS.error;
    if (st.state !== 'flagged') return null;
    return FLAG_KINDS[st.flagKind] && st.flagKind !== 'error' ? FLAG_KINDS[st.flagKind] : FLAG_KINDS.concern;
  }
  const stateLabel = (st) => { const f = flagInfo(st); return f ? f.word : (st && st.state) || 'idle'; };
  const needsYou = (st) => { const f = flagInfo(st); return !!(f && f.needsYou); };
  // Content of a status that matters for the feed and animations (never the timestamp).
  // Run clock for people: 0:07, 1:24, 12:03, 1:02:03 (tabular, never "1m 20s").
  function formatClock(ms) {
    const t = Math.max(0, Math.floor((ms || 0) / 1000)), h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = String(t % 60).padStart(2, '0');
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + s : m + ':' + s;
  }
  const statusKey = (x) => (x ? [x.state, x.say, x.to, x.flag].join('|') + (x.flagKind ? '|' + x.flagKind : '') : '');

  /* ---------- the drawing: plan geometry (units ≈ metres) ---------- */
  const PLAN = { CELL_X: 2.5, CELL_Y: 2.4, PAD: 0.3, GAP: 0.3, BACK: 3.0, LEAD_W: 3.8, LOUNGE_MIN: 4.6, MAX_ROW: 11.6, WALL: 1.25 };
  // Desk cell → furniture and the spots a figure can stand or sit on.
  function deskSpots(x, y) {
    return {
      desk: { x: x + 0.3, y: y + 0.25, w: 1.6, d: 0.75, h: 0.74 },
      monitor: { x: x + 0.65, y: y + 0.3, w: 0.8, d: 0.07, z: 0.74, h: 0.5 },
      chair: { x: x + 0.62, y: y + 1.1, w: 0.46, d: 0.46, h: 0.44 },
      seat: { x: x + 0.85, y: y + 1.36 },
      stand: { x: x + 2.05, y: y + 1.3 },
      visit: { x: x + 1.65, y: y + 1.12 },
      stack: { x: x + 1.42, y: y + 0.42 }
    };
  }
  function planOffice(s) {
    const P = PLAN, roles = (s && s.roles) || [];
    const list = orderGroups(s).map((g) => ({ g, members: roles.filter((r) => r.group === g.id) })).filter((z) => z.members.length);
    const orphans = roles.filter((r) => !list.some((z) => z.g.id === r.group));
    if (orphans.length) list.push({ g: { id: '?', label: 'No group yet', after: null }, members: orphans });
    const rooms = [], desks = dict();
    let x = 0, y = P.BACK + P.GAP, rowH = 0, maxX = 0;
    list.forEach((z, i) => {
      const k = z.members.length, cols = k <= 2 ? k : k <= 4 ? 2 : k <= 9 ? 3 : 4, rows = Math.ceil(k / cols);
      const w = Math.max(3.4, cols * P.CELL_X + P.PAD * 2), h = rows * P.CELL_Y + P.PAD * 2;
      if (x > 0 && x + w > P.MAX_ROW) { x = 0; y += rowH + P.GAP; rowH = 0; }
      const inner = (w - cols * P.CELL_X) / 2;
      rooms.push({ kind: 'group', id: z.g.id, g: z.g, index: i, x0: x, y0: y, x1: x + w, y1: y + h, members: z.members.map((r) => r.id) });
      z.members.forEach((r, j) => { desks[r.id] = Object.assign({ room: z.g.id, index: i }, deskSpots(x + inner + (j % cols) * P.CELL_X, y + P.PAD + Math.floor(j / cols) * P.CELL_Y)); });
      x += w + P.GAP; rowH = Math.max(rowH, h); maxX = Math.max(maxX, x - P.GAP);
    });
    const empty = !s;
    const W = empty ? P.LEAD_W : Math.max(maxX, P.LEAD_W + P.GAP + P.LOUNGE_MIN);
    const D = list.length ? y + rowH : P.BACK;
    rooms.unshift({ kind: 'lead', id: 'lead', x0: 0, y0: 0, x1: P.LEAD_W, y1: P.BACK });
    if (!empty) rooms.splice(1, 0, { kind: 'lounge', id: 'lounge', x0: P.LEAD_W + P.GAP, y0: 0, x1: W, y1: P.BACK });
    desks.lead = Object.assign({ room: 'lead', index: -1 }, deskSpots(1.1, 0.5));
    const lx0 = P.LEAD_W + P.GAP, spots = [];
    if (!empty) {
      for (let k = 0; k < 2; k++) spots.push({ x: lx0 + 0.75 + k * 0.7, y: 0.82, pose: 'bench' });
      spots.push({ x: W - 0.9, y: 1.55, pose: 'counter' }, { x: W - 2.45, y: 2.25, pose: 'counter' });
      for (let k = 2; k < 4; k++) spots.push({ x: lx0 + 0.75 + k * 0.7, y: 0.82, pose: 'bench' });
      for (let k = 0; k < 8; k++) spots.push({ x: lx0 + 0.6 + (k % 4) * 0.75, y: 2.15 + Math.floor(k / 4) * 0.5, pose: 'stand' });
    }
    return { W, D, rooms, desks, spots, door: { x: 0.25, y: P.BACK + P.GAP / 2 }, aisle: P.BACK + P.GAP / 2, lounge: empty ? null : { x0: lx0, x1: W } };
  }
  // Walk along the plan grid (x then y legs), using the main aisle between the back row and the rooms.
  function gridRoute(plan, a, b) {
    const pts = [];
    const near = Math.abs(a.x - b.x) < 3.2 && Math.abs(a.y - b.y) < 1.4; // inside one room: no detour
    const sameBand = near || Math.abs(a.y - b.y) < 0.05 || (a.y < plan.aisle && b.y < plan.aisle && Math.abs(a.x - b.x) < 3.2);
    if (sameBand) { if (Math.abs(a.x - b.x) > 0.01) pts.push({ x: b.x, y: a.y }); }
    else { const c = plan.aisle; pts.push({ x: a.x, y: c }, { x: b.x, y: c }); }
    pts.push({ x: b.x, y: b.y });
    return pts.filter((p, i) => i === pts.length - 1 || Math.hypot(p.x - (i ? pts[i - 1].x : a.x), p.y - (i ? pts[i - 1].y : a.y)) > 0.01);
  }
  // Horizontal extent of a convex polygon at screen height y (null when outside).
  function polyXRange(poly, y) {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      if ((y < Math.min(a[1], b[1])) || (y > Math.max(a[1], b[1]))) continue;
      const x = a[1] === b[1] ? Math.min(a[0], b[0]) : a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
      const x2 = a[1] === b[1] ? Math.max(a[0], b[0]) : x;
      min = Math.min(min, x, x2); max = Math.max(max, x, x2);
    }
    return min === Infinity ? null : [min, max];
  }
  function convexHull(points) {
    const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [], upper = [];
    p.forEach((q) => { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); });
    p.slice().reverse().forEach((q) => { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); });
    return lower.slice(0, -1).concat(upper.slice(0, -1));
  }
  // One elbow per leader: a 45° diagonal from the desk anchor, then horizontal into the label.
  function leaderPath(a, l) {
    const ty = l.y + 11, tx = l.side === 'left' ? l.x + l.w + 4 : l.x - 4, dir = l.side === 'left' ? -1 : 1;
    let ex = a[0] + dir * Math.abs(ty - a[1]);
    ex = dir < 0 ? Math.min(a[0], Math.max(ex, tx + 12)) : Math.max(a[0], Math.min(ex, tx - 12));
    return [a, [ex, ty], [tx, ty]];
  }
  function segmentsCross(p, q, r, s) {
    const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const d1 = d(r, s, p), d2 = d(r, s, q), d3 = d(p, q, r), d4 = d(p, q, s);
    return ((d1 > 1e-6 && d2 < -1e-6) || (d1 < -1e-6 && d2 > 1e-6)) && ((d3 > 1e-6 && d4 < -1e-6) || (d3 < -1e-6 && d4 > 1e-6));
  }
  function pathsCross(a, b) {
    for (let i = 0; i < a.length - 1; i++) for (let j = 0; j < b.length - 1; j++) if (segmentsCross(a[i], a[i + 1], b[j], b[j + 1])) return true;
    return false;
  }
  // Screen boxes of each role's desk (with monitor) and seated figure, so leaders can steer around them.
  function roleBoxes(plan, ids, P, U) {
    const out = [];
    ids.forEach((id) => {
      const k = plan.desks[id];
      if (!k) return;
      const d = k.desk, q = [];
      [d.x, d.x + d.w].forEach((x) => [d.y, d.y + d.d].forEach((y) => [0, d.h + 0.6].forEach((z) => q.push(P(x, y, z)))));
      const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
      out.push({ id, x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
      const f = P(k.seat.x, k.seat.y, 0);
      out.push({ id, x0: f[0] - 0.24 * U, y0: f[1] - 1.95 * U, x1: f[0] + 0.24 * U, y1: f[1] });
    });
    return out;
  }
  function segmentHitsBox(a, b, r) {
    const inside = (p) => p[0] > r.x0 && p[0] < r.x1 && p[1] > r.y0 && p[1] < r.y1;
    if (inside(a) || inside(b)) return true;
    const c = [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]];
    for (let i = 0; i < 4; i++) if (segmentsCross(a, b, c[i], c[(i + 1) % 4])) return true;
    return false;
  }
  // How many other roles' desks/figures a leader runs over (its own desk does not count).
  function leaderHits(path, id, boxes) {
    let n = 0;
    (boxes || []).forEach((r) => { if (r.id === id) return; for (let i = 0; i < path.length - 1; i++) if (segmentHitsBox(path[i], path[i + 1], r)) { n++; break; } });
    return n;
  }
  const leaderCrossings = (labels, boxes) => labels.reduce((n, l) => n + leaderHits(l.path, l.id, boxes), 0);
  const pathLength = (p) => p.reduce((n, q, i) => (i ? n + Math.hypot(q[0] - p[i - 1][0], q[1] - p[i - 1][1]) : 0), 0);
  // Separating-axis test for two convex polygons.
  function polysOverlap(A, B) {
    for (const S of [A, B]) for (let i = 0; i < S.length; i++) {
      const p = S[i], q = S[(i + 1) % S.length], ax = [q[1] - p[1], p[0] - q[0]];
      const span = (Q) => Q.reduce((r, v) => { const t = v[0] * ax[0] + v[1] * ax[1]; return [Math.min(r[0], t), Math.max(r[1], t)]; }, [Infinity, -Infinity]);
      const a = span(A), b = span(B);
      if (a[1] <= b[0] || b[1] <= a[0]) return false;
    }
    return true;
  }
  // Room names lettered on the slab's lip: front-row rooms under their own floor, rooms further back queued along the
  // front lip, anything that does not fit continues up the right lip. Returns each label with its rotated outline.
  function letterRooms(plan, P, U, measure) {
    const rooms = plan.rooms.filter((r) => r.kind === 'group').sort((a, b) => (b.y1 >= plan.D - 0.01) - (a.y1 >= plan.D - 0.01) || a.x0 - b.x0);
    let front = 0, right = 0.3;
    return rooms.map((r) => {
      const text = zoneCaption(r.g, r.members.length), px = measure ? measure(text) : text.length * 7.4, len = px / U + 0.35;
      const start = Math.max(r.x0 + 0.25, front);
      let at, angle;
      if (start + len <= plan.W + 0.1) { at = P(start, plan.D + 0.15, -0.3); angle = 30; front = start + len + 0.45; }
      else { at = P(plan.W + 0.15, plan.D - right, -0.3); angle = -30; right += len + 0.45; }
      const a = (angle * Math.PI) / 180, d = [Math.cos(a), Math.sin(a)], n = [-Math.sin(a), Math.cos(a)];
      const c = (u, v) => [at[0] + u * d[0] + v * n[0], at[1] + u * d[1] + v * n[1]];
      return { id: r.id, text, at, angle, poly: [c(-3, 1), c(px + 3, 1), c(px + 3, 21), c(-3, 21)] }; // text hangs 15px below the lip edge
    });
  }
  // Annotations in a left and a right margin beside the drawing. items: {id, ax, ay, left: [x, y], right: [x, y]} —
  // the side follows the anchor's screen x, labels keep their anchors' vertical order, never overlap each other or the
  // drawing, slots are chosen to keep leaders off other roles' desks and figures, and leaders are uncrossed by swapping slots.
  function layoutLabels(items, opt) {
    const o = Object.assign({ gap: 10, margin: 8, avoid: true }, opt);
    const xs = o.poly.map((p) => p[0]), cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cap = Math.floor((o.height - 2 * o.margin + o.gap) / (o.lh + o.gap));
    const sides = { left: items.filter((it) => it.ax < cx), right: items.filter((it) => it.ax >= cx) };
    const move = (from, to, pick) => { const it = sides[from].slice().sort(pick)[0]; sides[from] = sides[from].filter((x) => x !== it); sides[to].push(it); };
    while (sides.left.length > cap && sides.right.length < cap) move('left', 'right', (a, b) => b.ax - a.ax);
    while (sides.right.length > cap && sides.left.length < cap) move('right', 'left', (a, b) => a.ax - b.ax);
    if (sides.left.length > cap || sides.right.length > cap) return { ok: false, labels: [] };
    let best = solve(sides, o, cx);
    if (!best.ok || !o.avoid) return best;
    // try moving a label whose leader runs over someone else's desk to the other margin
    for (let round = 0; round < items.length && best.hits > 0; round++) {
      let improved = false;
      for (const l of best.labels.filter((x) => leaderHits(x.path, x.id, o.boxes) > 0)) {
        const from = l.side, to = from === 'left' ? 'right' : 'left';
        if (sides[to].length >= cap) continue;
        const it = sides[from].find((x) => x.id === l.id);
        const trial = { [from]: sides[from].filter((x) => x !== it), [to]: sides[to].concat(it) };
        const res = solve(trial, o, cx);
        if (res.ok && res.hits < best.hits) { best = res; sides.left = trial.left; sides.right = trial.right; improved = true; break; }
      }
      if (!improved) break;
    }
    // lopsided margins with long leaders: move the label nearest the centre across, if that shortens the leaders overall
    const cost = (r) => r.labels.reduce((n, l) => n + pathLength(l.path), 0) + r.hits * 400;
    for (let round = 0; round < items.length; round++) {
      const nl = sides.left.length, nr = sides.right.length;
      const from = nl - nr >= 2 ? 'left' : nr - nl >= 2 ? 'right' : null;
      if (!from || !best.labels.some((l) => l.side === from && pathLength(l.path) > 120)) break;
      const to = from === 'left' ? 'right' : 'left';
      if (sides[to].length >= cap) break;
      const it = sides[from].slice().sort((a, b) => (from === 'left' ? b.ax - a.ax : a.ax - b.ax))[0];
      const trial = { [from]: sides[from].filter((x) => x !== it), [to]: sides[to].concat(it) };
      const res = solve(trial, o, cx);
      if (!res.ok || res.hits === Infinity || cost(res) >= cost(best)) break;
      best = res; sides.left = trial.left; sides.right = trial.right;
    }
    return best;
  }
  function solve(sides, o, cx) {
    const { width, height, poly, lw, lh, gap, margin, boxes, avoid } = o;
    const out = [];
    for (const side of ['left', 'right']) {
      const anchorOf = (it) => it[side] || [it.ax, it.ay];
      const col = sides[side].slice().sort((a, b) => anchorOf(a)[1] - anchorOf(b)[1]);
      // x of a label at height y, or null when it would touch the drawing, leave the area, or sit across its own leader
      const fit = (y, a) => {
        let edge = side === 'left' ? Infinity : -Infinity;
        for (let yy = y - 4; yy <= y + lh + 4; yy += 4) { const r = polyXRange(poly, yy); if (r) edge = side === 'left' ? Math.min(edge, r[0]) : Math.max(edge, r[1]); }
        if (!isFinite(edge)) edge = side === 'left' ? Math.min(cx, width - margin) : Math.max(cx, margin);
        const x = side === 'left' ? Math.min(edge - gap, a[0] - 20) - lw : Math.max(edge + gap, a[0] + 20);
        if (x < margin || x + lw > width - margin) return null;
        const box = [[x - 4, y - 4], [x + lw + 4, y - 4], [x + lw + 4, y + lh + 4], [x - 4, y + lh + 4]];
        return (o.obstacles || []).some((q) => polysOverlap(box, q)) ? null : x; // never over a room's name
      };
      const placed = [];
      let prev = null;
      for (let i = 0; i < col.length; i++) {
        const a = anchorOf(col[i]), want = a[1] - 11, lb = prev ? prev.y + lh + gap : margin, ub = height - margin - lh - (col.length - 1 - i) * (lh + gap);
        let pick = null;
        for (let y = lb; y <= ub; y += 4) {
          const x = fit(y, a);
          if (x == null) continue;
          const hits = avoid ? leaderHits(leaderPath(a, { side, x, y, w: lw }), col[i].id, boxes) : 0;
          const score = hits * 10000 + Math.abs(y - want);
          if (!pick || score < pick.score) pick = { x, y, score };
        }
        if (!pick) return { ok: false, labels: [] };
        prev = { id: col[i].id, side, x: pick.x, y: pick.y, w: lw, h: lh, anchor: a };
        placed.push(prev);
      }
      placed.forEach((l) => { l.path = leaderPath(l.anchor, l); });
      for (let n = 0, swapped = true; swapped && n < 60; n++) { // uncross: swap the slots of two crossing leaders
        swapped = false;
        for (let i = 0; i < placed.length && !swapped; i++) for (let j = i + 1; j < placed.length && !swapped; j++) {
          const A = placed[i], B = placed[j];
          if (!pathsCross(A.path, B.path)) continue;
          const xa = fit(A.y, B.anchor), xb = fit(B.y, A.anchor);
          if (xa == null || xb == null) continue; // a swap must still keep both labels clear of the drawing
          [A.id, B.id] = [B.id, A.id]; [A.anchor, B.anchor] = [B.anchor, A.anchor];
          A.x = xa; B.x = xb;
          A.path = leaderPath(A.anchor, A); B.path = leaderPath(B.anchor, B);
          swapped = true;
        }
      }
      out.push(...placed);
    }
    for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) if (pathsCross(out[i].path, out[j].path)) return { ok: true, labels: out, hits: Infinity };
    return { ok: true, labels: out, hits: leaderCrossings(out, boxes) };
  }
  // home/projects.js: several MAS in one workspace. Folders must be plain slugs; the first entry for a folder wins;
  // a valid `current` is kept even before its entry is written. Returns null when there is no home file (legacy layout).
  const FOLDER_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
  function normalizeHome(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const seen = new Set(), projects = [];
    const count = (v) => (typeof v === 'number' && isFinite(v) && v >= 0 ? Math.floor(v) : null);
    (Array.isArray(raw.projects) ? raw.projects : []).forEach((p) => {
      if (!p || typeof p.folder !== 'string' || !FOLDER_RE.test(p.folder) || seen.has(p.folder)) return;
      seen.add(p.folder);
      const step = Number(p.step);
      projects.push({
        folder: p.folder,
        title: typeof p.title === 'string' && p.title.trim() ? p.title.trim() : p.folder,
        step: step >= 1 && step <= 4 ? Math.floor(step) : null,
        phase: typeof p.phase === 'string' && p.phase ? p.phase : null,
        agents: count(p.agents), runs: count(p.runs)
      });
    });
    const current = typeof raw.current === 'string' && FOLDER_RE.test(raw.current) ? raw.current : null;
    return { current, projects };
  }

  /* ---------- after-work life: lounge stations, scheduler, wrap party ---------- */
  // Stable per-figure randomness (mulberry32 seeded from a string), so choices survive re-renders.
  function seededRandom(key) {
    let a = hash(key) || 1;
    return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  // A figure's head-and-chest box on screen, in units of U (legs and hips may pass behind someone; heads and chests may not).
  // Chat spots include the speech bubble, drawn above the head on the side away from the partner.
  const C30 = Math.cos(Math.PI / 6);
  function figBox(p, pose) {
    const sx = (p.x - p.y) * C30, sy = (p.x + p.y) * 0.5, d = pose === 'sit' ? 0.36 : 0;
    const b = { x0: sx - 0.3, x1: sx + 0.3, y0: sy - 2.02 + d, y1: sy - 1.2 + d }; // head + chest
    if (pose === 'chat-l') { b.x0 = sx - 0.76; b.y0 = sy - 2.38; } // bubbles face outward, away from the partner
    if (pose === 'chat-r') { b.x1 = sx + 0.76; b.y0 = sy - 2.38; }
    return b;
  }
  const boxesOverlap = (a, b, gap) => a.x0 < b.x1 + gap && b.x0 < a.x1 + gap && a.y0 < b.y1 + gap && b.y0 < a.y1 + gap;
  const poseOf = (st) => (st.kind === 'sofa' ? 'sit' : st.kind === 'chat' ? 'chat-' + st.side : 'stand');
  // Furniture and stations inside the lounge rectangle (plan units). Every spot is nudged (≤ 0.6) until it is inside the
  // lounge, clear of furniture, and its figure box clears every other spot's, so any set of them can be occupied at once.
  // A pair (table tennis, chat) is kept whole or dropped. The party ring is built the same way (used on its own), and
  // `overflow` lists ring points that also clear every station, for figures who find no station.
  function loungeLayout(plan, need) {
    const L = plan && plan.lounge;
    if (!L) return { furniture: [], stations: [], party: null, overflow: [] };
    const x0 = L.x0, x1 = L.x1, w = x1 - x0, D = PLAN.BACK, GAP = 0.06;
    const furniture = [];
    const sofaW = Math.max(1.6, Math.min(2.8, w - 2.4)), seats = Math.max(2, Math.min(3, Math.floor(sofaW / 0.9)));
    furniture.push({ kind: 'sofa', x: x0 + 0.3, y: 0.12, w: sofaW, d: 0.62, h: 0.42 });
    furniture.push({ kind: 'counter', x: x1 - 1.25, y: 0.15, w: 1.05, d: 0.6, h: 0.95 });
    const pc = { x: x0 + w * 0.56, y: 1.6 };
    furniture.push({ kind: 'party', x: pc.x - 0.3, y: pc.y - 0.3, w: 0.6, d: 0.6, h: 1.0 });
    furniture.push({ kind: 'tt', x: x0 + 0.55, y: 2.15, w: 1.3, d: 0.62, h: 0.72 });
    const inside = (p) => p.x >= x0 + 0.12 && p.x <= x1 - 0.12 && p.y >= 0.12 && p.y <= D - 0.12;
    const clear = (p, m) => !furniture.some((f) => p.x > f.x - m && p.x < f.x + f.w + m && p.y > f.y - m && p.y < f.y + f.d + m);
    const OFFS = [[0, 0]];
    for (let r = 0.1; r <= 0.61; r += 0.1) for (let k = 0; k < 8; k++) OFFS.push([Math.round(Math.cos((k * Math.PI) / 4) * r * 100) / 100, Math.round(Math.sin((k * Math.PI) / 4) * r * 100) / 100]);
    const stations = [], boxes = [];
    // place a group of spots that move together (a pair keeps its spacing); returns false when no nudge works
    function place(group, fixed) {
      for (const [dx, dy] of fixed ? [[0, 0]] : OFFS) {
        const moved = group.map((c) => Object.assign({}, c, { x: c.x + dx, y: c.y + dy }));
        const bx = moved.map((c) => figBox(c, poseOf(c)));
        const ok = moved.every((c) => inside(c) && clear(c, c.kind === 'sofa' ? 0.18 : 0.15)) &&
          bx.every((b, i) => !boxes.some((o) => boxesOverlap(b, o, GAP)) && bx.every((o, j) => i === j || !boxesOverlap(b, o, GAP)));
        if (ok) { moved.forEach((c, i) => { stations.push(c); boxes.push(bx[i]); }); return true; }
      }
      return false;
    }
    const tt = furniture[3];
    place([{ id: 'tt-0', kind: 'tt', side: 'l', pair: 'tt-1', x: tt.x - 0.32, y: tt.y + tt.d / 2 }, { id: 'tt-1', kind: 'tt', side: 'r', pair: 'tt-0', x: tt.x + tt.w + 0.32, y: tt.y + tt.d / 2 }], true);
    const chatAt = (cx, gap) => [{ id: 'chat-0', kind: 'chat', side: 'l', pair: 'chat-1', x: cx - gap / 2, y: 2.6 }, { id: 'chat-1', kind: 'chat', side: 'r', pair: 'chat-0', x: cx + gap / 2, y: 2.6 }];
    const tryChat = () => [x1 - 1.55, x1 - 2.2, x0 + w * 0.62].some((cx) => [1.1, 0.95].some((gp) => place(chatAt(cx, gp))));
    const sofa = furniture[0], sofaSeat = (k, n) => ({ id: 'sofa-' + k, kind: 'sofa', x: x0 + 0.3 + (sofa.w * (k + 0.5)) / n, y: 0.95 });
    const mark = stations.length;
    for (let k = 0; k < seats; k++) place([sofaSeat(k, seats)], true);
    if (!tryChat()) { // a conversation reads better than a long sofa: a two-seater frees the front corner, then try again
      stations.splice(mark); boxes.splice(mark);
      sofa.w = 1.9;
      for (let k = 0; k < 2; k++) place([sofaSeat(k, 2)], true);
      tryChat();
    }
    place([{ id: 'coffee-0', kind: 'coffee', x: x1 - 0.72, y: 1.1 }]);
    const c0 = stations.find((c) => c.id === 'coffee-0');
    if (c0) place([{ id: 'coffee-1', kind: 'coffee', x: c0.x, y: c0.y + 1.2 }], true); // the queue, 1.2 behind along the counter's axis
    // party ring: front of the table first, then round the sides; boxes only need to clear each other
    const cand = [];
    [0.85, 1.15, 1.45, 1.75].forEach((r) => { for (let k = 0; k < 24; k++) { const a = (k / 24) * Math.PI * 2; cand.push({ x: pc.x + Math.cos(a) * r, y: pc.y + Math.sin(a) * r * 0.8, r, a }); } });
    cand.sort((p, q) => (q.x + q.y) - (p.x + p.y) + (p.r - q.r) * 1.5);
    const ring = [], rb = [];
    for (const c of cand) {
      if (ring.length >= (need || 9)) break;
      const b = figBox(c, 'stand');
      if (inside(c) && clear(c, 0.15) && !rb.some((o) => boxesOverlap(b, o, GAP))) { ring.push({ x: c.x, y: c.y }); rb.push(b); }
    }
    const overflow = ring.filter((p) => !boxes.some((o) => boxesOverlap(figBox(p, 'stand'), o, GAP)));
    return { furniture, stations, party: { x: pc.x, y: pc.y, ring }, overflow };
  }
  // Next after-work station for a figure, or null (stay). Only done figures get one; while the team still works,
  // finishers stay quiet (coffee, then the sofa); a half-filled pair is joined first; once three or more are done the
  // sofa fills before standing spots; nothing is ever double-booked.
  const AFTER_WORK = ['tt', 'chat', 'coffee', 'sofa'];
  function pickStation(lounge, occupied, fig, opt) {
    const o = opt || {};
    if (!fig || fig.state !== 'done' || !lounge || !lounge.stations.length) return null;
    const free = lounge.stations.filter((s) => (!occupied[s.id] || occupied[s.id] === fig.id) && s.id !== o.current);
    const kinds = o.teamBusy ? ['coffee', 'sofa'] : AFTER_WORK;
    const pool = free.filter((s) => kinds.includes(s.kind));
    if (!pool.length) return null;
    const many = (o.doneCount || 0) >= 3;
    if (!o.teamBusy) {
      const join = pool.find((s) => s.pair && occupied[s.pair] && occupied[s.pair] !== fig.id);
      if (join) return join;
    }
    const startable = (s) => !s.pair || (o.remaining == null ? true : o.remaining >= 2); // never open a pair nobody can join
    if (o.ordered) {
      for (const k of o.teamBusy ? kinds : many ? ['tt', 'sofa', 'chat', 'coffee'] : AFTER_WORK) { const s = pool.find((x) => x.kind === k && startable(x)); if (s) return s; }
      return null;
    }
    if (o.teamBusy && !o.current) { const c = pool.find((s) => s.kind === 'coffee'); if (c) return c; } // finishing early: coffee first
    const cur = o.current && lounge.stations.find((s) => s.id === o.current);
    if (many && !o.teamBusy) {
      if (cur && cur.kind === 'sofa') return null; // the calmest place: stay seated
      const seat = pool.find((s) => s.kind === 'sofa');
      if (seat) return seat;
    }
    const pick = pool.filter(startable);
    const s = pick.length ? pick[Math.floor((o.rng ? o.rng() : Math.random()) * pick.length)] : null;
    return s && cur && s.kind === cur.kind ? null : s;
  }
  // The wrap party plays once per finished run, and only when the finish was seen live (not on opening a finished run).
  const partyDue = (lastKey, key, allDone, live) => !!(allDone && live && key != null && key !== lastKey);

  // MAS_RESULT.work may be [{by, summary}] (documented) or {roleId: summary} (seen in real runs).
  function normalizeWork(w) {
    if (Array.isArray(w)) return w.filter((x) => x && x.by != null).map((x) => ({ by: String(x.by), summary: String(x.summary || '') }));
    if (w && typeof w === 'object') return Object.keys(w).map((k) => ({ by: k, summary: typeof w[k] === 'string' ? w[k] : String((w[k] && w[k].summary) || '') }));
    return [];
  }
  // A result is one round of a run (round 1) or the answer to a follow-up question (round 2, 3 …).
  // Earlier rounds of the same run travel in result.previous, oldest first. Returns every round, oldest first.
  function resultRounds(r) {
    if (!r || typeof r !== 'object') return [];
    const int = (n) => (Number.isInteger(n) && n > 0 ? n : null);
    const text = (v) => (typeof v === 'string' ? v : '');
    const prev = (Array.isArray(r.previous) ? r.previous : []).filter((x) => x && typeof x === 'object' && typeof x.markdown === 'string');
    let last = 0; // round numbers always increase, so each round has its own anchor
    const rounds = prev.map((x) => { last = Math.max(int(x.round) || 0, last + 1); return { round: last, question: text(x.question), title: text(x.title), markdown: x.markdown, updated: text(x.updated), latest: false }; });
    rounds.push({ round: Math.max(int(r.round) || 0, last + 1), question: text(r.question), title: text(r.title), markdown: text(r.markdown), updated: text(r.updated), latest: true });
    return rounds;
  }
  // The result drawer slides out by itself once for each result (or follow-up round) that arrives while the page
  // is open, never for one that was already there when the page opened. lastKey: undefined before the first look,
  // null once the page has looked and seen no result, else the key of the last result seen.
  const drawerDue = (lastKey, key) => key != null && lastKey !== undefined && key !== lastKey;
  const VERBS = { search: 'searching', check: 'checking', sheet: 'working out the numbers', write: 'writing', plan: 'planning', type: 'working' };
  const listJoin = (a) => (a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);
  // The one status sentence at the top of the sheet.
  function headline(d, statuses) {
    const s = d && d.structure, st = statuses || {}, phase = d && d.state && d.state.phase;
    const who = (id) => (id === 'lead' ? 'The Lead' : roleName(s, id));
    const whom = (id) => (!id || id === 'lead' ? 'the Lead' : roleName(s, id));
    if (isSdk(d) && (!s || !s.locked)) return phase === 'failed' ? 'The run failed.' : s ? 'The team is being set up.' : 'Waiting for the first run.';
    if (!s || !s.locked) {
      if (s) return 'Your team is drafted. Refine it in the chat.';
      if (d && d.task) return 'Your task is on the board.';
      if (phase === 'setup') return 'Your assistant is setting up.';
      return d && (d.env || d.state) ? 'Tell your assistant about your task.' : 'Say hi to your assistant to begin.';
    }
    const roles = s.roles || [], ids = ['lead'].concat(roles.map((r) => r.id));
    if (phase === 'failed' || (st.lead && st.lead.state === 'failed')) return 'The run failed.';
    const asking = ids.find((id) => needsYou(st[id]));
    if (asking) return who(asking) + ' needs you.';
    const failed = roles.filter((r) => st[r.id] && st[r.id].state === 'failed').map((r) => r.id);
    const finished = (st.lead && st.lead.state === 'done') || phase === 'done';
    const failedText = failed.length === 1 ? who(failed[0]) + ' failed' : failed.length + ' agents failed';
    if (failed.length && !finished) return failedText + '.';
    const flagged = ids.find((id) => st[id] && st[id].state === 'flagged');
    if (flagged) return who(flagged) + ' flagged a problem.';
    const hand = ids.find((id) => st[id] && st[id].state === 'handoff');
    if (hand) return who(hand) + ' is handing work to ' + whom(st[hand].to) + '.';
    const working = roles.filter((r) => st[r.id] && st[r.id].state === 'working').map((r) => r.id);
    if (working.length >= 2) {
      const verbs = Array.from(new Set(working.map((id) => VERBS[activityFor(st[id])])));
      return (working.length <= 3 ? listJoin(working.map(who)) : working.length + ' agents') + ' are ' + (verbs.length === 1 ? verbs[0] : 'working') + ' at the same time.';
    }
    if (working.length === 1) return who(working[0]) + ' is ' + VERBS[activityFor(st[working[0]])] + '.';
    if (st.lead && st.lead.state === 'working') return 'The Lead is ' + VERBS[activityFor(st.lead)] + '.';
    if (finished) return (d.result ? 'The result is ready' : 'The run is finished') + (failed.length ? ', but ' + failedText + '.' : '.');
    if (ids.some((id) => st[id] && st[id].state === 'waiting')) return 'The team is waiting for its turn.';
    return phase === 'running' ? 'Your team is starting.' : isSdk(d) ? 'The team is ready.' : 'Your team is locked and ready to run.';
  }

  /* ---------- demo ---------- */
  const DEMO_LINES = {
    lead: { plan: 'Planning the run', final: ['Writing the shortlist', 'Linking every source card'] },
    'retail-finder': { says: ['Searching Currys…', 'Currys: £279, free delivery', 'Checking John Lewis…', 'John Lewis: £289, next day', 'Saving 2 source cards'] },
    'marketplace-finder': { says: ['Searching eBay…', 'eBay seller X: £249 + £15 post', 'Browsing Amazon sellers…', 'Adding up delivery costs'] },
    'catch-checker': { says: ['Reading 3 offers…', 'Checking eBay seller X…', 'Checking delivery times…', 'Verifying shipping costs…'], flag: 'eBay seller X: refurbished' }
  };
  const DEMO_WORK = {
    lead: '- Combined the checked offers\n- Wrote a 3-row shortlist with links\n- Left the final choice to you',
    'retail-finder': '- Searched **Currys** and **John Lewis**\n- Lowest new price: **£279** at Currys, free delivery\n- Saved 2 source cards',
    'marketplace-finder': '- Searched eBay and Amazon sellers\n- Cheapest: eBay seller X, **£249 + £15** post\n- Saved 1 source card',
    'catch-checker': '- Checked 3 offers for refurbs, imports and shipping\n- ⚠️ eBay seller X is **refurbished** — fails R2\n- Currys and John Lewis pass every check'
  };
  function genericSays(r) {
    const text = (r.name || '') + ' ' + (r.job || '');
    if (/check|verif|review|audit/i.test(text)) return ['Reading what I was handed…', 'Checking each claim…', 'Verifying the totals…', 'Writing up what I found'];
    if (/plan|schedul|itinerar|day/i.test(text)) return ['Reading both lists…', 'Planning day 1…', 'Scheduling day 2 and 3…', 'Adding up the costs…'];
    return ['Searching the web…', 'Browsing the best results…', 'Comparing prices…', 'Saving source cards'];
  }
  function demoWork(s) {
    return ['lead'].concat(((s && s.roles) || []).map((r) => r.id)).map((id) => {
      const m = member(s, id) || {};
      return { by: id, summary: DEMO_WORK[id] || '- ' + (oneLine(m.job) || 'Did my part') + '\n- Passed my notes to ' + roleName(s, m.handsTo || 'lead') };
    });
  }
  function buildDemoScript(s) {
    const roles = (s && s.roles) || [];
    const groups = orderGroups(s).filter((g) => roles.some((r) => r.group === g.id));
    const ev = [];
    const push = (t, id, state, say, extra) => ev.push({ t: Math.round(t * 100) / 100, id, status: Object.assign({ state, say: say || '', to: null, flag: null }, extra) });
    const ids = ['lead'].concat(roles.map((r) => r.id));
    const lead = DEMO_LINES.lead;
    ids.forEach((id) => push(0, id, 'idle', ''));
    push(1.5, 'lead', 'working', lead.plan, { progress: 30 });
    push(3.5, 'lead', 'working', 'Handing out the work', { progress: 70 });
    roles.forEach((r) => push(3.5, r.id, 'waiting', 'Waiting for my turn'));
    push(7, 'lead', 'waiting', 'Waiting for the team');
    const START = 7, END = 35, span = (END - START) / Math.max(groups.length, 1);
    const flagRole = roles.find((r) => DEMO_LINES[r.id] && DEMO_LINES[r.id].flag) || roles.find((r) => /check|review|verif/i.test(r.id + ' ' + r.name));
    groups.forEach((g, gi) => {
      const g0 = START + gi * span;
      roles.filter((r) => r.group === g.id).forEach((r, ri) => {
        const lines = DEMO_LINES[r.id] || {};
        const says = lines.says || genericSays(r);
        const w0 = g0 + ri * 0.6, hand = g0 + span * 0.68 + ri * 1.6;
        const fw = r === flagRole ? [g0 + span * 0.25, g0 + span * 0.5] : null;
        let progress = 5;
        says.forEach((say, k) => {
          const t = w0 + ((hand - 0.8 - w0) * k) / says.length;
          progress = Math.round(8 + (80 * k) / says.length);
          if (!fw || t < fw[0] || t >= fw[1]) push(t, r.id, 'working', say, { progress });
        });
        if (fw) {
          push(fw[0], r.id, 'flagged', 'Found a problem', { flag: lines.flag || 'Something needs a second look', progress: 45 });
          push(fw[1], r.id, 'working', 'Noted it. Carrying on.', { progress: 60 });
        }
        const to = r.handsTo || 'lead';
        push(hand, r.id, 'handoff', 'Passing my notes to ' + roleName(s, to), { to, progress: 95 });
        push(hand + 3.6, r.id, 'done', 'Finished', { progress: 100 });
      });
    });
    push(36, 'lead', 'working', lead.final[0], { progress: 40 });
    push(38.8, 'lead', 'working', lead.final[1], { progress: 85 });
    ids.forEach((id) => push(41, id, 'done', id === 'lead' ? 'Result ready' : 'Finished', { progress: 100 }));
    ev.sort((a, b) => a.t - b.t);
    return { length: 74, events: ev }; // done at 41 s: the wrap party and after-work life play out before the loop
  }
  function demoStatusesAt(script, t) {
    const tt = ((t % script.length) + script.length) % script.length;
    const out = dict();
    for (const e of script.events) { if (e.t > tt) break; out[e.id] = e.status; }
    return out;
  }

  // Fallback data for ?demo=1 when no project data is found (same as examples/price-compare).
  const DEMO_DATA = {
    env: { tool: 'Claude Code', os: 'macOS', canWrite: true, canSearch: true, subagents: 'parallel' },
    state: { step: 4, phase: 'running', next: 'Watch your team work.', version: 1, locked: true },
    task: { title: 'Headphone deal finder', summary: 'Find the best UK deal on noise-cancelling headphones under £300.', repeat: 'Monthly',
      requirements: [{ id: 'R1', text: 'Cheapest new price in the UK' }, { id: 'R2', text: 'New only (no refurbished), delivered within 3 days' },
        { id: 'R3', text: 'Total under £300 including shipping' }, { id: 'R4', text: 'A short buying shortlist I can act on' }] },
    structure: { title: 'Headphone deal finder', version: 1, locked: true,
      rationale: 'Two finders search different kinds of shop at the same time (R1). A separate checker guards R2 and R3 because mistakes there cost money. The Lead writes the shortlist (R4).',
      lead: { id: 'lead', name: 'Lead', emoji: '🧭', job: 'Combine the checked offers into a buying shortlist', serves: ['R4'] },
      groups: [{ id: 'A', label: 'Search in parallel', after: null }, { id: 'B', label: 'Check', after: 'A' }],
      roles: [
        { id: 'retail-finder', name: 'Retail finder', emoji: '🔎', serves: ['R1'], job: 'Search major UK retailers for the lowest new price', tools: ['web search'], group: 'A', handsTo: 'catch-checker' },
        { id: 'marketplace-finder', name: 'Marketplace finder', emoji: '🛒', serves: ['R1'], job: 'Search eBay and Amazon marketplace sellers', tools: ['web search'], group: 'A', handsTo: 'catch-checker' },
        { id: 'catch-checker', name: 'Catch checker', emoji: '🛡️', serves: ['R2', 'R3'], job: 'Flag refurbished stock, parallel imports and hidden shipping', tools: ['web search'], group: 'B', handsTo: 'lead' }] },
    result: { title: 'Headphone deal finder — run 1', run: 1,
      markdown: '## Shortlist\n| Shop | Total | Notes |\n|---|---|---|\n| Currys | **£279** | new · 2–3 days |\n| John Lewis | £289 | new · next day |\n| eBay seller X | £264 | ⚠️ refurbished — fails R2 |\n\n## Your decision\nCurrys and John Lewis meet every requirement.',
      sources: [{ id: 'currys-xm6', title: 'Sony WH-1000XM6 — Currys', url: 'https://www.currys.co.uk/', evidence: 'A', foundBy: 'retail-finder' },
        { id: 'johnlewis-xm6', title: 'Sony WH-1000XM6 — John Lewis', url: 'https://www.johnlewis.com/', evidence: 'A', foundBy: 'retail-finder' },
        { id: 'ebay-x-xm6', title: 'Sony WH-1000XM6 — eBay seller X', url: 'https://www.ebay.co.uk/', evidence: 'A', foundBy: 'marketplace-finder' }],
      flags: [{ by: 'catch-checker', text: "eBay seller X: listing says 'Excellent - Refurbished'" }] }
  };

  const api = {
    TOOLS, STATES, FINISHED, MAX_DESKS, EVIDENCE, GROUP_COLORS, DEMO_DATA,
    clone, dict, safeRoot, oneLine, esc, hash, colorFor, roleName, member, orderGroups, groupCaption, zoneCaption, receivesFrom, withDynamicGroup, capRoles,
    coverage, costInfo, isSdk, deriveProgress, wrapUp, flagInfo, stateLabel, needsYou, formatHint, renderMarkdown, evalDataFile, pushSay, timeAgo,
    phaseLine, activityFor, clampProgress, formatElapsed, formatClock, teamProgress, statusKey,
    buildDemoScript, demoStatusesAt, demoWork,
    PLAN, planOffice, gridRoute, polyXRange, convexHull, layoutLabels, leaderPath, pathsCross, roleBoxes, leaderCrossings, pathLength, polysOverlap, letterRooms, normalizeWork, resultRounds, drawerDue, normalizeHome, headline, seededRandom, loungeLayout, pickStation, partyDue, figBox, boxesOverlap
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.MASModel = api;
})();
