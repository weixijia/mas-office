// `decideTool`: the single enforcement point for a compiled role (docs/design/runtime.md §5).
// The engine calls it for every permission request a session raises (Claude `canUseTool`, Codex
// approval requests) and, ideally, from a Claude PreToolUse hook so calls that need no approval
// are checked too. `allow` and `deny` are answered at once; `ask` becomes an inbox request.
//
// Hard rules come first and no team design can widen them:
// - credentials (`~/.ssh`, `~/.claude`, `~/.claude.json`, `~/.codex`, `.env*`, `*.pem`, keychains, …)
//   are never read, and a command that names one is denied;
// - writes go only to `compiled.writable`, inside the project folder, never to instruction or
//   settings files (CLAUDE.md, AGENTS.md, GEMINI.md, SETUP.md, .claude/, .mcp.json, .git/, .codex/);
// - MCP tools of servers the role was not given are denied, and an MCP call with a `filePath`
//   argument is denied (the server would write that file itself, outside these rules;
//   see kit/.claude/mas-guard.mjs);
// - web and browser tools never open non-http(s) URLs or the user's own machine or network, and
//   no command names a loopback, private or local URL or host;
// - a command granted only by `cli:<prefix>` must start with that prefix and contain no shell
//   chaining, substitution, redirection, glob or expansion syntax (`* ? [ ] { } ~ $ \`). Such a
//   command is denied, not asked: the role can run the plain command again, and a person should
//   not have to read shell syntax to approve it;
// - every path-like word of a command is held to the role's raw/ rule as well;
// - a Grep over the project root (or any folder above it) is denied: it would read raw/ and any
//   `.env` file in the project. The role is told to pass a narrower `path`.
// Then the compiled rules apply in order (first match wins), then the role's `unknownTools`.
// A command Codex ran inside its read-only sandbox (`sandboxed: true`) that only reads the
// project folder is allowed without a command grant (sandboxed.js).
// Deny and ask rules match paths ignoring letter case (on macOS `RAW/x.pdf` opens `raw/x.pdf`);
// allow rules, and so the writable set, keep the exact case.
// Tool names that differ from the official spelling only in letter case are checked as the
// official tool but never allowed outright.

import {
  resolvePath, isCredentialPath, isProtectedPath, matchGlob, hasPrefixUnsafe, matchesPrefix,
  commandTouchesCredentials, commandTouchesProtected, commandTouchesLocalHost, commandPathTokens, isBlockedUrl,
  normalizeRoot,
} from './paths.js';
import { CLAUDE_READ_TOOLS, CLAUDE_WRITE_TOOLS, CLAUDE_WEB_TOOLS } from './vocabulary.js';
import { normalizeSubject } from './subject.js';
import { decideSandboxedRead } from './sandboxed.js';

export { normalizeSubject };

/** Is folder `a` (relative, '' = project root) the folder `b` or one above it? Case-insensitive. */
const coversFolder = (a, b) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === '' || x === y || y.startsWith(`${x}/`);
};

/** Is `abs` the project folder or a folder above it (case-insensitive)? */
const isProjectOrAbove = (abs, project) => {
  if (!abs) return false;
  const a = abs.toLowerCase().replace(/\/$/, '');
  const p = normalizeRoot(project).toLowerCase();
  return a === p || a === '' || p.startsWith(`${a}/`) || a === '/';
};

/** Does one compiled rule match a normalised subject? */
function ruleMatches(rule, s, resolved, roots) {
  if (rule.tool !== undefined && rule.tool !== s.tool) return false;
  if (rule.mcpServer !== undefined && rule.mcpServer !== s.server) return false;
  if (rule.mcpTool !== undefined && rule.mcpTool !== s.mcpTool) return false;
  if (rule.commandPrefix !== undefined) {
    if (s.command === null || hasPrefixUnsafe(s.command) || !matchesPrefix(s.command, rule.commandPrefix)) return false;
  }
  if (rule.pathGlob !== undefined) {
    // An allow rule must cover every path the call touches, in exact case. An ask or deny rule
    // applies when any path falls under it, ignoring case.
    const allowed = (r) => Boolean(r) && r.rel !== null && matchGlob(rule.pathGlob, r.rel);
    const caught = (r) => Boolean(r) && r.relFold !== null && matchGlob(rule.pathGlob, r.relFold, { ignoreCase: true });
    if (!resolved.length || (rule.effect === 'allow' ? !resolved.every(allowed) : !resolved.some(caught))) return false;
  }
  if (rule.searchCovers !== undefined) {
    if (!roots.some((r) => r && r.relFold !== null && coversFolder(r.relFold, rule.searchCovers))) return false;
  }
  return true;
}

/**
 * Decide one tool call, command or file change for a compiled role.
 * @param {object} compiled from compileRole / compileLead
 * @param {{type: 'tool_call'|'command'|'file_change'|'question', tool?: string, input?: object, command?: string, path?: string, paths?: string[]}} subject
 * @returns {{effect: 'allow'|'ask'|'deny', rule: string, reason: string}}
 */
export function decideTool(compiled, subject) {
  const fallback = compiled.unknownTools === 'deny' ? 'deny' : 'ask';
  const s = normalizeSubject(subject);
  const decision = (effect, rule, reason) => ({ effect, rule, reason });
  if (s.type === 'question') return decision('ask', 'question', 'A question for the Lead or a person');
  if (!s.tool) return decision(fallback, 'default', 'The request does not name a tool');

  const where = { project: compiled.project, home: compiled.home };
  const resolved = s.paths.map((p) => resolvePath(typeof p === 'string' ? p : '', where));
  const roots = s.searchRoots.map((p) => resolvePath(typeof p === 'string' ? p : '', where));
  const rules = compiled.rules ?? [];
  const isWrite = CLAUDE_WRITE_TOOLS.includes(s.tool);
  const isRead = CLAUDE_READ_TOOLS.includes(s.tool);

  // Hard rules
  for (let i = 0; i < s.paths.length; i += 1) {
    const raw = s.paths[i];
    const r = resolved[i];
    if (isCredentialPath(raw) || (r?.abs && isCredentialPath(r.abs))) return decision('deny', 'hard:credentials', 'Credential files are never read or written');
  }
  if (isWrite) {
    if (!resolved.length) return decision('deny', 'hard:write-path', 'A write must name its file');
    for (let i = 0; i < resolved.length; i += 1) {
      const r = resolved[i];
      if (!r) return decision('deny', 'hard:write-path', 'A write must name a usable file path');
      if (r.rel === null) return decision('deny', 'hard:outside-project', 'Writes stay inside the project folder');
      if (isProtectedPath(r.rel) || isProtectedPath(String(s.paths[i]))) return decision('deny', 'hard:protected-file', 'Instruction and settings files are never changed by a role');
      if (!(compiled.writable ?? []).some((g) => matchGlob(g, r.rel))) return decision('deny', 'hard:not-writable', `A role writes only its own files (${(compiled.writable ?? []).join(', ') || 'none'})`);
    }
  }
  if (s.tool === 'Bash') {
    if (s.command === null || !s.command.trim()) return decision('deny', 'hard:no-command', 'The command is missing');
    if (commandTouchesCredentials(s.command)) return decision('deny', 'hard:credentials', 'Commands never touch credential files');
    if (commandTouchesProtected(s.command)) return decision('deny', 'hard:protected-file', 'Commands never touch instruction or settings files');
    if (commandTouchesLocalHost(s.command)) return decision('deny', 'hard:blocked-url', 'Commands never reach this computer or its network');
    // Every path-like word is held to the role's raw/ rule (the deny or ask rules on Read).
    const words = commandPathTokens(s.command).map((t) => resolvePath(t, where)).filter((r) => r && r.relFold !== null && r.relFold !== '');
    for (let i = 0; i < rules.length; i += 1) {
      const r = rules[i];
      if (r.tool !== 'Read' || r.pathGlob === undefined || r.effect === 'allow') continue;
      if (words.some((w) => matchGlob(r.pathGlob, w.relFold, { ignoreCase: true }))) return decision(r.effect, `rules[${i}]`, r.reason);
    }
  }
  if (s.tool === 'Grep' && roots.some((r) => !r || (r.relFold === '') || (r.relFold === null && isProjectOrAbove(r.abs, compiled.project)))) {
    return decision('deny', 'hard:broad-search', 'Searching the whole project would also read raw/ and secret files; pass a narrower path such as outputs/ or sources/');
  }
  if (s.server !== null) {
    if (!(compiled.mcpServerNames ?? []).includes(s.server)) return decision('deny', 'hard:mcp-not-granted', `This role was not given the MCP server "${s.server}"`);
    const filePath = s.input.filePath;
    if (filePath !== undefined && filePath !== null && filePath !== '') return decision('deny', 'hard:mcp-file-path', 'MCP tools may not save files themselves; return the content instead');
  }
  if (s.url !== null && (CLAUDE_WEB_TOOLS.includes(s.tool) || s.server !== null) && isBlockedUrl(s.url)) {
    return decision('deny', 'hard:blocked-url', 'Only public http(s) pages; never this computer or its network');
  }

  // Compiled rules, then reads outside the project, then the default
  let result = null;
  for (let i = 0; i < rules.length; i += 1) {
    if (ruleMatches(rules[i], s, resolved, roots)) { result = decision(rules[i].effect, `rules[${i}]`, rules[i].reason); break; }
  }
  if (!result && isRead && resolved.some((r) => !r || r.rel === null)) {
    result = decision(fallback, 'read-outside-project', 'Reading outside the project folder');
  }
  if (!result) result = decision(fallback, 'default', 'No rule covers this tool');
  // Codex ran this command inside its read-only sandbox: a plain read of the project folder is
  // allowed even without a command grant, held to the same rules as a Read (see sandboxed.js).
  if (s.tool === 'Bash' && result.effect !== 'allow' && subject?.sandboxed === true) {
    const sandboxed = decideSandboxedRead(compiled, s.command, subject.cwd);
    if (sandboxed) return sandboxed;
  }
  if (s.oddCase && result.effect === 'allow') {
    return decision(fallback, 'hard:tool-name-case', `"${s.requested}" is not spelled like the official tool name "${s.tool}"`);
  }
  return result;
}
