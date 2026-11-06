// `mas-office serve`: the panel, the workspace files (read-only) and the event API (spec §5).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  ProjectLog, EventError, SPEC_VERSION, describeDocument, jsTwin, isValidFolder,
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

/**
 * Start the server.
 * @param {{workspace: string, port?: number, host?: string, panel?: string|null, poll?: boolean}} options
 * @returns {Promise<{url: string, port: number, server: http.Server, watchMode: string, close(): Promise<void>}>}
 */
export async function startServer({ workspace, port = 4747, host = '127.0.0.1', panel = panelDir(), poll = false }) {
  const root = fs.realpathSync(path.resolve(workspace));
  if (!fs.statSync(root).isDirectory()) throw new Error(`Not a folder: ${root}`);
  const realPanel = panel ? fs.realpathSync(panel) : null;
  const loopbackOnly = LOOPBACK.has(host);
  const clients = new Set();
  const logs = new Map();

  const broadcast = (event, data, id) => {
    const message = `event: ${event}\n${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(message);
  };
  const watcher = watchTree(root, (rel) => broadcast('change', { path: rel }), { poll });
  const heartbeat = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, HEARTBEAT_MS);
  heartbeat.unref();

  async function postEvents(req, res, params) {
    if (req.method !== 'POST') throw new HttpError(405, 'Use POST', { allow: 'POST' });
    const project = params.get('project');
    if (!isValidFolder(project)) throw new HttpError(400, 'Query parameter "project" must be a folder name matching ^[a-z0-9][a-z0-9-]{0,39}$.');
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (!JSON_TYPES.has(type)) throw new HttpError(415, 'Content-Type must be application/json or application/x-ndjson.');
    const events = parseEventsBody(await readBody(req));
    let log = logs.get(project);
    if (!log) {
      log = new ProjectLog(root, project);
      logs.set(project, log);
    }
    let result;
    try {
      result = log.append(events);
    } catch (err) {
      if (err instanceof EventError) {
        throw new HttpError(400, 'Invalid events: none of this batch was accepted.', { invalid: err.invalid });
      }
      throw err;
    }
    for (const e of result.events) broadcast('mas', { project, event: e }, e.seq);
    sendJson(res, 200, { accepted: result.accepted, lastSeq: result.lastSeq });
  }

  function stream(req, res) {
    res.writeHead(200, {
      ...BASE_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
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
    if (urlPath === '/v0/stream') return stream(req, res);
    if (urlPath === '/v0/events') return postEvents(req, res, params);
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
    watchMode: watcher.mode,
    close: () => new Promise((resolve) => {
      watcher.close();
      clearInterval(heartbeat);
      for (const res of clients) res.end();
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}
