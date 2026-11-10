// Request subjects: bring an AskRequest subject (Claude tool call, Codex command or file change)
// into one shape, and decide whether it falls under a vocabulary word (for delegation rules).

import path from 'node:path';
import {
  resolvePath, matchGlob, matchesPrefix, hasPrefixUnsafe, isBlockedUrl, isCredentialPath, isProtectedPath,
} from './paths.js';
import {
  parseToolEntry, CLAUDE_KNOWN_TOOLS, CLAUDE_READ_TOOLS, CLAUDE_WRITE_TOOLS, CLAUDE_WEB_TOOLS, BROWSER_SERVER,
  roleWritable, LEAD_WRITABLE,
} from './vocabulary.js';

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isAbsolutish = (p) => /^(?:\/|~|[A-Za-z]:)/.test(p);

/** Everything up to the first segment with a glob character: `../x/*.md` → `../x`. */
export function staticPrefix(pattern) {
  const segs = String(pattern).replace(/\\/g, '/').split('/');
  const i = segs.findIndex((s) => /[*?[\]{}]/.test(s));
  const fixed = (i === -1 ? segs : segs.slice(0, i)).join('/');
  return fixed || (String(pattern).startsWith('/') ? '/' : '.');
}

const under = (base, pattern) => (isAbsolutish(pattern) ? staticPrefix(pattern) : path.posix.join(base.replace(/\\/g, '/'), staticPrefix(pattern)));

/**
 * One shape for every subject: the official tool name, the MCP server, the command, every path
 * it touches, the folders a search covers (`searchRoots`) and any URL.
 * Codex `command` → Bash; `file_change` → Write.
 * Glob searches `path` + the fixed start of `pattern`; Grep searches `path` narrowed by the fixed
 * start of `glob` (a glob without a folder, or a negated one, does not narrow it).
 */
export function normalizeSubject(subject) {
  const s = isObject(subject) ? subject : {};
  const input = isObject(s.input) ? s.input : {};
  const type = s.type ?? 'tool_call';
  const out = { type, tool: '', requested: '', oddCase: false, server: null, mcpTool: null, command: null, paths: [], searchRoots: [], url: null, input };
  if (type === 'question') return out;
  const raw = type === 'command' ? 'Bash' : type === 'file_change' ? 'Write' : typeof s.tool === 'string' ? s.tool : '';
  out.requested = raw;
  const mcp = /^mcp__(.+?)__(.+)$/i.exec(raw);
  if (mcp) {
    out.tool = raw;
    out.server = mcp[1];
    out.mcpTool = mcp[2];
    out.oddCase = !raw.startsWith('mcp__');
  } else {
    const known = CLAUDE_KNOWN_TOOLS.find((t) => t.toLowerCase() === raw.toLowerCase());
    out.tool = known ?? raw;
    out.oddCase = Boolean(known) && known !== raw;
  }
  const command = s.command ?? input.command;
  if (typeof command === 'string') out.command = command;
  else if (Array.isArray(command) && command.every((a) => typeof a === 'string')) out.command = command.join(' '); // argv form
  const url = input.url ?? s.url;
  if (url !== undefined && url !== null) out.url = String(url);

  const add = (p) => { if (p !== undefined && p !== null) out.paths.push(p); };
  if (type === 'file_change') {
    if (Array.isArray(s.paths)) s.paths.forEach(add); else add(s.path ?? input.path ?? input.file_path);
  } else if (['Read', 'Write', 'Edit', 'MultiEdit'].includes(out.tool)) {
    add(input.file_path ?? s.path);
  } else if (out.tool === 'NotebookEdit') {
    add(input.notebook_path ?? s.path);
  } else if (out.tool === 'Glob' || out.tool === 'Grep') {
    const base = typeof input.path === 'string' && input.path ? input.path : '.';
    const narrowing = out.tool === 'Glob' ? input.pattern : input.glob;
    const root = typeof narrowing === 'string' && narrowing && !narrowing.startsWith('!') ? under(base, narrowing) : base;
    add(base);
    if (root !== base) add(root);
    out.searchRoots.push(root);
  } else if (s.path !== undefined) {
    add(s.path);
  }
  return out;
}

const noFilePath = (s) => s.input.filePath === undefined || s.input.filePath === null || s.input.filePath === '';
const urlOk = (s) => s.url === null || !isBlockedUrl(s.url);

/**
 * Does a request subject fall under a vocabulary name? Used by delegation rules, whose `tools`
 * are vocabulary names, so it is strict: a word matches only what the role design means by it.
 * - `read my files`: a read whose every path (and search folder) is inside the project's raw/.
 * - `write notes`: a write whose every path is one of the requesting role's own files.
 * - `cli:<prefix>`: that prefix alone, without shell or glob syntax.
 * - web and MCP words: never a blocked URL or an MCP `filePath`.
 * Tool names in odd letter case never match. Path words need `ctx.project` (and `ctx.agentId`
 * for `write notes`); without them they match nothing.
 * @param {object} subject an AskRequest subject
 * @param {string} name a vocabulary name
 * @param {{project?: string, home?: string, agentId?: string}} [ctx]
 */
export function subjectMatchesWord(subject, name, ctx = {}) {
  const parsed = parseToolEntry(name);
  if (!parsed.ok || !isObject(subject)) return false;
  const t = parsed.tool;
  const s = normalizeSubject(subject);
  if (s.oddCase || !s.tool) return false;
  const resolved = () => (ctx.project ? s.paths.map((p) => resolvePath(typeof p === 'string' ? p : '', ctx)) : []);
  switch (t.word) {
    case 'web search': return CLAUDE_WEB_TOOLS.includes(s.tool) && urlOk(s);
    case 'browse the web': return s.server === BROWSER_SERVER && noFilePath(s) && urlOk(s);
    case 'mcp': return s.server === t.server && noFilePath(s) && urlOk(s);
    case 'read my files': {
      if (!CLAUDE_READ_TOOLS.includes(s.tool)) return false;
      const rs = resolved();
      return rs.length > 0 && rs.every((r) => r && r.relFold !== null && r.relFold !== ''
        && matchGlob('raw/**', r.relFold, { ignoreCase: true }) && !isCredentialPath(r.abs));
    }
    case 'write notes': {
      if (!CLAUDE_WRITE_TOOLS.includes(s.tool) || typeof ctx.agentId !== 'string' || !ctx.agentId) return false;
      const own = ctx.agentId === 'lead' ? LEAD_WRITABLE : roleWritable(ctx.agentId);
      const rs = resolved();
      return rs.length > 0 && rs.every((r) => r && r.rel !== null && !isProtectedPath(r.rel) && !isCredentialPath(r.abs)
        && own.some((g) => matchGlob(g, r.rel)));
    }
    case 'run commands': return s.tool === 'Bash' && typeof s.command === 'string' && s.command.trim() !== '';
    case 'cli': return s.tool === 'Bash' && typeof s.command === 'string' && !hasPrefixUnsafe(s.command) && matchesPrefix(s.command, t.prefix);
    default: return false;
  }
}
