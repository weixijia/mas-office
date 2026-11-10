// `mas-office serve`: the panel, the workspace files (read-only), the event API and the
// command API (spec §5, docs/design/runtime.md §3).

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  ProjectLog, EventError, SPEC_VERSION, describeDocument, jsTwin, isValidFolder, isValidAgentId,
} from '../sdk/index.js';
import { watchTree } from './watch.js';
import { panelDir } from './paths.js';

const BODY_LIMIT = 1024 * 1024;
// A body over the limit is still read (and thrown away), up to this much more or this long, so the
// client gets the 413 instead of a reset connection.
const DRAIN_LIMIT = 16 * 1024 * 1024;
const DRAIN_MS = 10_000;
const HEARTBEAT_MS = 15_000;
const JSON_TYPES = new Set(['application/json', 'application/x-ndjson', 'application/ndjson', 'application/jsonl']);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const REPLAY_LIMIT = 5000;

// What a person (or the Lead) may ask of an agent, and the string fields each needs (RFC 0001 §2.2).
const COMMANDS = {
  'command.message': ['text'],
  'command.respond': ['requestId', 'outcome'],
  'command.assign': ['title'],
  'command.interrupt': [],
};
const RESPOND_OUTCOMES = new Set(['selected', 'submitted', 'declined', 'cancelled']);
const DELIVERIES = new Set(['steer', 'queue', 'interrupt']);
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
// With a runtime attached these are its facts: decisions, verdicts and results that gates rest on.
// Nobody else may write them without the token (a role's shell command could otherwise vouch for
// its own work, or answer its own request).
const RUNTIME_OWNED = /^(request|run|round|result|claim|verdict|evidence|review|task|lead|recovery|command)\b|^agent\.stopped$/;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

// The panel's own files: scripts only from the server itself.
const PANEL_CSP = "script-src 'self'; object-src 'none'; base-uri 'none'";
// Workspace files are written by agents: never let one run as a page in this origin.
const WORKSPACE_CSP = "sandbox; default-src 'none'";
// Workspace files the panel loads with <script> or fetch(): served as is (still nosniff), without the sandbox.
const WORKSPACE_DATA = new Set(['.js', '.json']);
// Workspace files a browser would render as an active document are served as plain text.
const WORKSPACE_AS_TEXT = new Set(['.html', '.htm', '.xhtml', '.svg', '.xml', '.mjs']);

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const BASE_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

function sendText(req, res, status, body, contentType, headers = {}) {
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': contentType, 'content-length': Buffer.byteLength(body), ...headers });
  res.end(req.method === 'HEAD' ? undefined : body);
}

const isInside = (root, p) => {
  const rel = path.relative(root, p);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

/**
 * Map a URL path onto a file under `root`, or null when it must not be served:
 * undecodable, NUL, backslashes, `..`/`.` or dot segments (hidden files), drive letters.
 */
export function resolveRequestPath(root, urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const segments = decoded.split('/').filter(Boolean);
  if (segments.some((s) => s.startsWith('.') || s.includes(':'))) return null;
  const abs = path.join(root, ...segments);
  if (!isInside(root, abs)) return null;
  return { abs, rel: segments.join('/'), dir: decoded.endsWith('/') };
}

/** Resolve symlinks and check the real file is still inside the (real) root. */
function realInside(realRoot, abs) {
  try {
    const real = fs.realpathSync(abs);
    return isInside(realRoot, real) ? { real, stat: fs.statSync(real) } : null;
  } catch {
    return null;
  }
}

/**
 * Response headers for a static file. Panel files get the panel CSP. Workspace files get the
 * sandbox CSP, except the `.js` / `.json` data files the panel loads; HTML, SVG, XML and
 * module scripts from the workspace are sent as text/plain so they never render.
 */
export function staticHeaders(file, { workspace }) {
  const ext = path.extname(file).toLowerCase();
  if (!workspace) return { 'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream', 'content-security-policy': PANEL_CSP };
  if (WORKSPACE_DATA.has(ext)) return { 'content-type': CONTENT_TYPES[ext] };
  const type = WORKSPACE_AS_TEXT.has(ext) ? CONTENT_TYPES['.txt'] : CONTENT_TYPES[ext] ?? 'application/octet-stream';
  return { 'content-type': type, 'content-security-policy': WORKSPACE_CSP };
}

function serveStatic(req, res, realRoot, urlPath, { twins, mount = '' }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed', { allow: 'GET, HEAD' });
  const target = resolveRequestPath(realRoot, urlPath);
  if (!target) throw new HttpError(404, 'Not found');
  let found = realInside(realRoot, target.abs);
  if (found?.stat.isDirectory()) {
    if (!target.dir) {
      // Rebuilt from the clean segments: always one leading slash, never `//host/` (an open redirect).
      const segments = [mount.replace(/^\/+/, ''), ...target.rel.split('/')].filter(Boolean).map(encodeURIComponent);
      res.writeHead(301, { ...BASE_HEADERS, location: `/${segments.join('/')}/` });
      res.end();
      return;
    }
    found = realInside(realRoot, path.join(target.abs, 'index.html'));
  }
  const workspace = twins; // only the workspace gets twins; the panel does not
  if (found?.stat.isFile()) {
    res.writeHead(200, { ...BASE_HEADERS, ...staticHeaders(found.real, { workspace }), 'content-length': found.stat.size });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(found.real).on('error', () => res.destroy()).pipe(res);
    return;
  }
  // A missing `.js` twin is built from its `.json` (spec §1.1), so HTTP producers can write JSON only.
  const doc = twins && target.rel.endsWith('.js') ? describeDocument(target.rel) : null;
  const json = doc && realInside(realRoot, `${target.abs.slice(0, -3)}.json`);
  if (json?.stat.isFile()) {
    let value;
    try { value = JSON.parse(fs.readFileSync(json.real, 'utf8')); } catch { throw new HttpError(404, 'Not found'); }
    sendText(req, res, 200, jsTwin(doc.global, value, doc.statusId), CONTENT_TYPES['.js']);
    return;
  }
  // The panel probes for data files with <script>: a missing one is a plain 404 in a script type, so the
  // browser reports a missing file instead of a "refused to execute JSON" error on every poll.
  if (twins && target.rel.endsWith('.js')) return sendText(req, res, 404, '// Not found\n', CONTENT_TYPES['.js']);
  throw new HttpError(404, 'Not found');
}

/** Read and discard the rest of a request body, up to DRAIN_LIMIT bytes or DRAIN_MS. */
function drain(req) {
  return new Promise((resolve) => {
    let drained = 0;
    const done = () => {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', done);
      req.off('error', done);
      req.off('close', done);
      resolve();
    };
    const onData = (chunk) => {
      drained += chunk.length;
      if (drained > DRAIN_LIMIT) done();
    };
    const timer = setTimeout(done, DRAIN_MS);
    if (req.complete) return done();
    req.on('data', onData);
    req.on('end', done);
    req.on('error', done);
    req.on('close', done);
    req.resume();
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const tooBig = () => drain(req).then(() => reject(new HttpError(413, 'Body larger than 1 MB')));
    if (Number(req.headers['content-length']) > BODY_LIMIT) {
      tooBig();
      return;
    }
    const chunks = [];
    let size = 0;
    const onData = (chunk) => {
      size += chunk.length;
      if (size <= BODY_LIMIT) {
        chunks.push(chunk);
        return;
      }
      req.off('data', onData);
      req.off('end', onEnd);
      chunks.length = 0;
      tooBig();
    };
    const onEnd = () => resolve(Buffer.concat(chunks).toString('utf8'));
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', reject);
  });
}

/** One event object, a JSON array of events, or NDJSON (one event per line). */
export function parseEventsBody(text) {
  const body = text.trim();
  if (!body) throw new HttpError(400, 'Empty body: send one event, a JSON array or NDJSON.');
  try {
    const value = JSON.parse(body);
    return Array.isArray(value) ? value : [value];
  } catch {
    return body.split(/\r?\n/).filter((line) => line.trim()).map((line, i) => {
      try { return JSON.parse(line); } catch { throw new HttpError(400, `Body is not JSON, and NDJSON line ${i + 1} is not valid JSON.`); }
    });
  }
}

// Reject requests whose Host header is not loopback when we listen on loopback (DNS rebinding).
function hostAllowed(req, loopbackOnly) {
  if (!loopbackOnly || !req.headers.host) return true;
  const host = req.headers.host.replace(/:\d+$/, '').toLowerCase();
  return LOOPBACK.has(host);
}

/** Open the default browser; failures are ignored (the URL is printed anyway). */
export function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* no browser available */ }
}

/** Read one JSON object from a request body (`application/json` only). */
async function readJsonObject(req) {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json.');
  let value;
  try { value = JSON.parse(await readBody(req)); } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'Body is not valid JSON.');
  }
  if (!isObject(value)) throw new HttpError(400, 'Body must be a JSON object.');
  return value;
}

/** Check a command body; returns the clean `{type, agentId, data}` or throws a 400. */
export function parseCommand(body) {
  const { type, agentId = 'lead', data = {} } = body;
  if (!Object.hasOwn(COMMANDS, type)) {
    throw new HttpError(400, `"type" must be one of ${Object.keys(COMMANDS).join(', ')}.`);
  }
  if (!isValidAgentId(agentId)) throw new HttpError(400, '"agentId" must match ^[a-z0-9][a-z0-9-]{0,63}$.');
  if (!isObject(data)) throw new HttpError(400, '"data" must be an object.');
  for (const field of COMMANDS[type]) {
    if (typeof data[field] !== 'string' || !data[field]) throw new HttpError(400, `"${type}" needs a string "data.${field}".`);
  }
  if (data.cmdId !== undefined && (typeof data.cmdId !== 'string' || !/^[\w.:-]{1,80}$/.test(data.cmdId))) {
    throw new HttpError(400, '"data.cmdId" must be 1–80 letters, digits, "_", ".", ":" or "-".');
  }
  if (type === 'command.message' && data.delivery !== undefined && !DELIVERIES.has(data.delivery)) {
    throw new HttpError(400, '"data.delivery" must be steer, queue or interrupt.');
  }
  if (type === 'command.respond' && !RESPOND_OUTCOMES.has(data.outcome)) {
    throw new HttpError(400, '"data.outcome" must be selected, submitted, declined or cancelled.');
  }
  if (data.note !== undefined && (typeof data.note !== 'string' || data.note.length > 1000)) {
    throw new HttpError(400, '"data.note" must be a string of at most 1000 characters.');
  }
  if (type === 'command.interrupt' && data.scope !== undefined && data.scope !== 'turn' && data.scope !== 'agent') {
    throw new HttpError(400, '"data.scope" must be turn or agent.');
  }
  return { type, agentId, data };
}

/**
 * Start the server.
 *
 * `runtime` (optional, also settable later with `attach`) is what drives real sessions:
 * `{handleCommand(project, event): Promise<void>, startRun?(project, body): Promise<object>,
 *   info?(): object, close?(): Promise<void>}`. Without one the server is the 0.1 viewer plus a
 * mailbox: commands are logged, written to `<project>/mas/commands/<agentId>.jsonl` for a
 * file-only assistant to poll, and answers to requests are applied directly.
 *
 * @param {{workspace: string, port?: number, host?: string, panel?: string|null, poll?: boolean,
 *   token?: string, runtime?: object}} options
 * @returns {Promise<{url: string, port: number, token: string, server: http.Server, watchMode: string,
 *   emit(project: string, events: object[]): {accepted: number, lastSeq: number, events: object[]},
 *   log(project: string): ProjectLog, attach(runtime: object|null): void, clients(): number,
 *   close(): Promise<void>}>}
 */
export async function startServer({
  workspace, port = 4747, host = '127.0.0.1', panel = panelDir(), poll = false, token, runtime = null,
}) {
  const root = fs.realpathSync(path.resolve(workspace));
  if (!fs.statSync(root).isDirectory()) throw new Error(`Not a folder: ${root}`);
  const realPanel = panel ? fs.realpathSync(panel) : null;
  const loopbackOnly = LOOPBACK.has(host);
  const clients = new Set();
  const logs = new Map();
  const secret = token ?? crypto.randomBytes(32).toString('hex');
  const secretHash = crypto.createHash('sha256').update(secret).digest();
  let driver = runtime;

  // Constant-time check of `Authorization: Bearer <token>`.
  const authed = (req) => {
    const header = String(req.headers.authorization ?? '');
    if (!header.startsWith('Bearer ')) return false;
    const given = crypto.createHash('sha256').update(header.slice(7).trim()).digest();
    return crypto.timingSafeEqual(given, secretHash);
  };
  const requireToken = (req) => {
    if (!authed(req)) throw new HttpError(401, 'This needs the panel token: open the panel from the URL that `mas-office` printed.');
  };
  const projectParam = (params) => {
    const project = params.get('project');
    if (!isValidFolder(project)) throw new HttpError(400, 'Query parameter "project" must be a folder name matching ^[a-z0-9][a-z0-9-]{0,39}$.');
    return project;
  };
  const getLog = (project) => {
    let log = logs.get(project);
    if (!log) {
      log = new ProjectLog(root, project);
      logs.set(project, log);
    }
    return log;
  };

  const broadcast = (event, data, id) => {
    const message = `event: ${event}\n${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) if (!res.writableEnded) res.write(message); // a stream that ended (close()) gets nothing
  };
  const watcher = watchTree(root, (rel) => broadcast('change', { path: rel }), { poll });
  const heartbeat = setInterval(() => { for (const res of clients) if (!res.writableEnded) res.write(': ping\n\n'); }, HEARTBEAT_MS);
  heartbeat.unref();

  /** Append events to a project's log (the only writer), rewrite snapshots, tell the stream. */
  function emit(project, events) {
    const result = getLog(project).append(events);
    for (const e of result.events) broadcast('mas', { project, event: e }, e.seq);
    return result;
  }

  async function postEvents(req, res, params) {
    if (req.method !== 'POST') throw new HttpError(405, 'Use POST', { allow: 'POST' });
    const project = projectParam(params);
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (!JSON_TYPES.has(type)) throw new HttpError(415, 'Content-Type must be application/json or application/x-ndjson.');
    const events = parseEventsBody(await readBody(req));
    // Intent comes in through /v0/commands, where the origin is known. Here, nobody may claim
    // to be the person at the panel (RFC 0001: only the server writes origin "human").
    const trusted = authed(req);
    for (const e of events) {
      if (!isObject(e) || typeof e.type !== 'string') continue;
      if (e.type.startsWith('command.') && e.type !== 'command.ack') {
        throw new HttpError(400, 'Commands are sent to POST /v0/commands, not /v0/events.');
      }
      if (e.type === 'request.resolved' && e.data?.by?.kind === 'human' && !trusted) {
        throw new HttpError(403, 'Only the panel may record a person\'s answer.');
      }
      if (driver && !trusted && RUNTIME_OWNED.test(e.type)) {
        throw new HttpError(403, `While a team is running here, "${e.type}" events come only from the runtime.`);
      }
    }
    let result;
    try {
      result = emit(project, events);
    } catch (err) {
      if (err instanceof EventError) {
        throw new HttpError(400, 'Invalid events: none of this batch was accepted.', { invalid: err.invalid });
      }
      throw err;
    }
    sendJson(res, 200, { accepted: result.accepted, lastSeq: result.lastSeq });
  }

  const ack = (project, agentId, cmdId, status, reason) => emit(project, [{
    type: 'command.ack', agentId, data: { cmdId, status, ...(reason ? { reason } : {}) },
  }]);

  /** Kit mode: leave the command where a file-only assistant can find it. */
  function mailbox(project, event) {
    const file = path.join(root, project, 'mas', 'commands', `${event.agentId}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
  }

  async function postCommand(req, res, params) {
    if (req.method !== 'POST') throw new HttpError(405, 'Use POST', { allow: 'POST' });
    requireToken(req);
    const project = projectParam(params);
    const { type, agentId, data } = parseCommand(await readJsonObject(req));
    const log = getLog(project);
    const cmdId = data.cmdId ?? `cmd_${crypto.randomBytes(9).toString('base64url')}`;
    const origin = { kind: 'human' };

    // The same cmdId again (a retry, a double click): one command, one effect.
    const known = (log.snapshot().inbox?.commands ?? []).find((c) => c.cmdId === cmdId);
    if (known) return sendJson(res, 200, { accepted: true, cmdId, seq: known.seq, duplicate: true });

    if (type === 'command.respond') {
      const pending = log.snapshot().inbox?.pending ?? [];
      // With a runtime, "still waiting" is what the runtime says: it holds the session's callback.
      const request = driver?.waitsOn
        ? driver.waitsOn(project, data.requestId)
        : pending.find((r) => r.requestId === data.requestId);
      // A prompt in a terminal the person opened themselves is answered there; the panel only shows it.
      if (pending.find((r) => r.requestId === data.requestId)?.options?.length === 0
        && pending.find((r) => r.requestId === data.requestId)?.source?.raw?.startsWith('hook:')) {
        throw new HttpError(409, 'Answer this one in the terminal where that session runs.', { reason: 'answer_in_terminal' });
      }
      if (!request) {
        // Someone else (the terminal, the Lead, a policy, another tab) got there first.
        throw new HttpError(409, 'That request is no longer waiting.', { reason: 'already_resolved' });
      }
    }
    const [event] = emit(project, [{ type, agentId, data: { ...data, cmdId, origin } }]).events;
    sendJson(res, 200, { accepted: true, cmdId, seq: event.seq });

    if (driver?.handleCommand) {
      // The runtime owns the session: it applies the command and writes the ack.
      Promise.resolve()
        .then(() => driver.handleCommand(project, event))
        .catch((err) => ack(project, agentId, cmdId, 'rejected', `runtime error: ${err.message}`));
      return;
    }
    mailbox(project, event);
    if (type === 'command.respond') {
      const { requestId, outcome, optionId, payload, note } = data;
      emit(project, [{
        type: 'request.resolved',
        agentId,
        data: {
          requestId, outcome, by: origin, cmdId,
          ...(optionId !== undefined && { optionId }), ...(payload !== undefined && { payload }), ...(note !== undefined && { note }),
        },
      }]);
      ack(project, agentId, cmdId, 'applied');
    } else {
      ack(project, agentId, cmdId, 'accepted', 'No runtime attached: left in mas/commands for the assistant to pick up.');
    }
  }

  async function postRun(req, res, params) {
    if (req.method !== 'POST') throw new HttpError(405, 'Use POST', { allow: 'POST' });
    requireToken(req);
    const project = projectParam(params);
    if (!driver?.startRun) throw new HttpError(409, 'No runtime attached. Start the team with: mas-office up', { reason: 'no_runtime' });
    const body = await readJsonObject(req);
    const task = typeof body.task === 'string' ? body.task.trim() : '';
    const followUp = typeof body.followUp === 'string' ? body.followUp.trim() : '';
    if (!task === !followUp) throw new HttpError(400, 'Send either "task" or "followUp" (a non-empty string).');
    try {
      sendJson(res, 200, { accepted: true, ...(await driver.startRun(project, task ? { task } : { followUp })) });
    } catch (err) {
      throw new HttpError(409, err.message, { reason: err.code ?? 'refused' });
    }
  }

  /** Logged events of one project with a seq above `since`, for a stream that reconnects. */
  function replay(project, since) {
    let text;
    try { text = fs.readFileSync(getLog(project).file, 'utf8'); } catch { return []; }
    const events = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (isObject(e) && Number.isSafeInteger(e.seq) && e.seq > since) events.push(e);
      } catch { /* not an event line */ }
    }
    return events.slice(-REPLAY_LIMIT);
  }

  function stream(req, res, params) {
    res.writeHead(200, {
      ...BASE_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const project = params.get('project');
    const since = Number(params.get('since') ?? req.headers['last-event-id']);
    if (isValidFolder(project) && Number.isSafeInteger(since) && since >= 0) {
      for (const e of replay(project, since)) {
        res.write(`event: mas\nid: ${e.seq}\ndata: ${JSON.stringify({ project, event: e })}\n\n`);
      }
    }
    clients.add(res);
    req.on('close', () => clients.delete(res));
  }

  async function handle(req, res) {
    if (!hostAllowed(req, loopbackOnly)) throw new HttpError(403, 'Forbidden host');
    const q = req.url.indexOf('?');
    const urlPath = q === -1 ? req.url : req.url.slice(0, q);
    const params = new URLSearchParams(q === -1 ? '' : req.url.slice(q + 1));
    if (!urlPath.startsWith('/')) throw new HttpError(400, 'Bad request');

    if (urlPath === '/v0/health') return sendJson(res, 200, { ok: true, spec: SPEC_VERSION });
    if (urlPath === '/v0/stream') return stream(req, res, params);
    if (urlPath === '/v0/events') return postEvents(req, res, params);
    if (urlPath === '/v0/commands') return postCommand(req, res, params);
    if (urlPath === '/v0/runs') return postRun(req, res, params);
    if (urlPath === '/v0/session') {
      return sendJson(res, 200, {
        token: authed(req), runtime: Boolean(driver), spec: SPEC_VERSION, terminal: false, ...(driver?.info?.() ?? {}),
      });
    }
    if (urlPath === '/v0/inbox') {
      return sendJson(res, 200, getLog(projectParam(params)).snapshot().inbox ?? { pending: [], recent: [], commands: [] });
    }
    if (urlPath.startsWith('/v0/')) throw new HttpError(404, 'Unknown endpoint');
    if (urlPath === '/' || urlPath === '/office') {
      res.writeHead(urlPath === '/' ? 302 : 301, { ...BASE_HEADERS, location: '/office/' });
      return res.end();
    }
    if (urlPath.startsWith('/office/')) {
      if (!realPanel) throw new HttpError(404, 'The panel is not available in this installation.');
      return serveStatic(req, res, realPanel, urlPath.slice('/office'.length), { twins: false, mount: '/office' });
    }
    return serveStatic(req, res, root, urlPath, { twins: true });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) return res.destroy();
      const status = err instanceof HttpError ? err.status : 500;
      const { allow, ...extra } = err instanceof HttpError ? err.extra : {};
      const headers = allow ? { allow } : {};
      if (status === 413) headers.connection = 'close';
      sendJson(res, status, { error: status === 500 ? `Internal error: ${err.message}` : err.message, ...extra }, headers);
      // A body we stopped draining (too large or too slow): close the socket once the 413 is out.
      if (status === 413 && !req.complete) res.on('finish', () => req.destroy());
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const actualPort = server.address().port;
  const shownHost = host.includes(':') ? `[${host}]` : host === '0.0.0.0' ? '127.0.0.1' : host;
  return {
    server,
    port: actualPort,
    url: `http://${shownHost}:${actualPort}`,
    token: secret,
    watchMode: watcher.mode,
    emit,
    log: getLog,
    attach: (next) => { driver = next; },
    clients: () => clients.size,
    close: () => new Promise((resolve) => {
      watcher.close();
      clearInterval(heartbeat);
      for (const res of clients) res.end();
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}
