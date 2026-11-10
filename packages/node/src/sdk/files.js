// Snapshot files: JSON documents plus their `.js` twins (spec §1.1), written atomically.

import fs from 'node:fs';
import path from 'node:path';
import { isValidAgentId } from './names.js';

/** The global each document's `.js` twin assigns (spec §1.1). */
export const GLOBALS = {
  projects: 'MAS_HOME',
  env: 'MAS_ENV',
  task: 'MAS_TASK',
  structure: 'MAS_STRUCTURE',
  state: 'MAS_STATE',
  result: 'MAS_RESULT',
  status: 'MAS_STATUS',
  inbox: 'MAS_INBOX',
  board: 'MAS_BOARD',
  verification: 'MAS_VERIFICATION',
};

const DOCUMENTS = [
  [/(?:^|\/)home\/projects$/, 'projects'],
  [/(?:^|\/)(?:home|mas)\/env$/, 'env'],
  [/(?:^|\/)me\/task$/, 'task'],
  [/(?:^|\/)mas\/structure$/, 'structure'],
  [/(?:^|\/)mas\/state$/, 'state'],
  [/(?:^|\/)outputs\/result$/, 'result'],
  [/(?:^|\/)mas\/inbox$/, 'inbox'],
  [/(?:^|\/)mas\/board$/, 'board'],
  [/(?:^|\/)outputs\/verification$/, 'verification'],
  [/(?:^|\/)mas\/status\/([^/]+)$/, 'status'],
];

/**
 * Which snapshot document a path is, from its last segments (extension optional).
 * `describeDocument('demo/mas/status/lead.json')` → `{kind: 'status', global: 'MAS_STATUS', statusId: 'lead'}`.
 * @returns {{kind: string, global: string, statusId?: string} | null}
 */
export function describeDocument(filePath) {
  const p = filePath.split(path.sep).join('/').replace(/\.(json|js)$/, '');
  for (const [re, kind] of DOCUMENTS) {
    const m = re.exec(p);
    if (m) return kind === 'status' ? { kind, global: GLOBALS.status, statusId: m[1] } : { kind, global: GLOBALS[kind] };
  }
  return null;
}

/** The `.js` twin of a JSON value: `window.NAME = {...};`, or the shared-object form for statuses. */
export function jsTwin(globalName, value, statusId) {
  const json = JSON.stringify(value, null, 2);
  if (statusId === undefined) return `window.${globalName} = ${json};\n`;
  return `window.${globalName} = window.${globalName} || {};\nwindow.${globalName}[${JSON.stringify(statusId)}] = ${json};\n`;
}

/** Write a file by renaming a temp file in the same folder, so readers never see half a file. */
export function writeFileAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  fs.writeFileSync(tmp, content);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Write `<base>.json` and `<base>.js`. With a `cache` (Map), files whose content
 * did not change since the last call are skipped.
 */
export function writeDocument(base, globalName, value, { statusId, cache } = {}) {
  const files = [
    [`${base}.json`, `${JSON.stringify(value, null, 2)}\n`],
    [`${base}.js`, jsTwin(globalName, value, statusId)],
  ];
  for (const [file, content] of files) {
    if (cache?.get(file) === content) continue;
    writeFileAtomic(file, content);
    cache?.set(file, content);
  }
}

/**
 * Write a reducer snapshot into a project folder: `mas/structure`, `mas/state`,
 * `mas/status/<id>` for every status, `mas/inbox`, `mas/board`, and `outputs/result` and
 * `outputs/verification` when there is one (removed when there is none, per spec §4.5).
 * Statuses whose id is not a safe file name are skipped.
 */
export function writeSnapshots(projectDir, snapshot, { cache } = {}) {
  const at = (rel) => path.join(projectDir, rel);
  writeDocument(at('mas/structure'), GLOBALS.structure, snapshot.structure, { cache });
  writeDocument(at('mas/state'), GLOBALS.state, snapshot.state, { cache });
  for (const [id, status] of Object.entries(snapshot.statuses)) {
    if (isValidAgentId(id)) writeDocument(at(`mas/status/${id}`), GLOBALS.status, status, { statusId: id, cache });
  }
  if (snapshot.inbox) writeDocument(at('mas/inbox'), GLOBALS.inbox, snapshot.inbox, { cache });
  if (snapshot.board) writeDocument(at('mas/board'), GLOBALS.board, snapshot.board, { cache });
  // Never show the previous run's result or verification as current.
  for (const kind of ['result', 'verification']) {
    if (snapshot[kind]) writeDocument(at(`outputs/${kind}`), GLOBALS[kind], snapshot[kind], { cache });
    else removeDocument(at(`outputs/${kind}`), { cache });
  }
}

/** Remove `<base>.json` and `<base>.js` if they exist. */
export function removeDocument(base, { cache } = {}) {
  for (const file of [`${base}.json`, `${base}.js`]) {
    fs.rmSync(file, { force: true });
    cache?.delete(file);
  }
}

// The fixed text before the JSON value of a `.js` twin. Every `\s*` sits between literal tokens,
// so matching is linear (agent-written files must not be able to stall `validate`).
const IDENT = '[A-Za-z_$][\\w$]*';
const PLAIN_HEAD = new RegExp(`^window\\.(${IDENT})\\s*=\\s*`);
const SHARED_HEAD = new RegExp(
  `^window\\.(${IDENT})\\s*=\\s*window\\.\\1\\s*\\|\\|\\s*\\{\\s*\\}\\s*;\\s*`
  + `window\\.\\1\\s*\\[\\s*("(?:[^"\\\\]|\\\\.)*"|'[^'\\\\]*')\\s*\\]\\s*=\\s*`,
);

/**
 * Split a `.js` twin into its parts without running it: `{global, statusId?, json}`, where
 * `json` is the assigned text (not parsed yet). Accepts the two shapes of spec §1.1 with any
 * whitespace: `window.X = {...};` and
 * `window.MAS_STATUS = window.MAS_STATUS || {}; window.MAS_STATUS["id"] = {...};`.
 * Returns null for anything else.
 */
export function splitJsTwin(code) {
  let text = String(code).trim();
  if (text.endsWith(';')) text = text.slice(0, -1).trimEnd();
  const shared = SHARED_HEAD.exec(text);
  if (shared) {
    const [head, global, quoted] = shared;
    let statusId;
    try { statusId = quoted.startsWith('"') ? JSON.parse(quoted) : quoted.slice(1, -1); } catch { return null; }
    return { global, statusId, json: text.slice(head.length) };
  }
  const plain = PLAIN_HEAD.exec(text);
  return plain ? { global: plain[1], json: text.slice(plain[0].length) } : null;
}

/** Read the JSON value out of a `.js` twin (either shape of spec §1.1) without running it. */
export function parseJsTwin(code) {
  const parts = splitJsTwin(code);
  if (!parts) return undefined;
  try { return JSON.parse(parts.json); } catch { return undefined; }
}

/** Read a document, preferring `<base>.json` and falling back to the `.js` twin. */
export function readDocument(base) {
  try { return JSON.parse(fs.readFileSync(`${base}.json`, 'utf8')); } catch { /* try the twin */ }
  try { return parseJsTwin(fs.readFileSync(`${base}.js`, 'utf8')); } catch { return undefined; }
}

/**
 * Insert or update one project in `home/projects` and make it the current one.
 * Other projects' entries are kept. Nothing is written when nothing changed.
 * @param {string} workspace
 * @param {{folder: string, title?: string, step?: number, phase?: string, agents?: number, runs?: number}} entry
 */
export function updateProjectsIndex(workspace, entry) {
  const base = path.join(workspace, 'home', 'projects');
  const old = readDocument(base);
  const keep = typeof old === 'object' && old !== null && !Array.isArray(old) ? old : {};
  const home = {
    ...keep,
    current: entry.folder,
    projects: Array.isArray(keep.projects) ? keep.projects.filter((p) => typeof p === 'object' && p !== null) : [],
  };
  const i = home.projects.findIndex((p) => p.folder === entry.folder);
  if (i === -1) home.projects.push({ ...entry });
  else home.projects[i] = { ...home.projects[i], ...entry };
  if (JSON.stringify(home) === JSON.stringify(old)) return;
  writeDocument(base, GLOBALS.projects, home);
}
