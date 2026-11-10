// The fixed tool vocabulary of team design v2 (docs/design/runtime.md §5) and what each word
// means for each backend. Tool and parameter names are checked against the official docs
// snapshots in references/docs/ (claude__agent-sdk_typescript.md, codex__app-server.md,
// codex__agent-approvals-security.md) and the kit's own settings (kit/.claude/settings.json).

import { matchesPrefix, hasPrefixUnsafe } from './paths.js';

export const EFFECTS = ['allow', 'ask', 'deny'];
export const WORDS = ['web search', 'browse the web', 'read my files', 'write notes', 'run commands'];

/** The kit's role browser (kit/.mcp.json). `browse the web` means this MCP server. */
export const BROWSER_SERVER = 'mas-browser';
/** Browser tools the kit denies (kit/.claude/settings.json `permissions.deny`). */
export const BROWSER_DENIED_TOOLS = ['upload_file', 'screencast_start', 'screencast_stop', 'lighthouse_audit'];

/** Claude Code built-in tool names (Agent SDK TypeScript reference, "Tool input types"). */
export const CLAUDE_READ_TOOLS = ['Read', 'Glob', 'Grep'];
export const CLAUDE_WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit', 'MultiEdit'];
export const CLAUDE_WEB_TOOLS = ['WebSearch', 'WebFetch'];
export const CLAUDE_COMMAND_TOOLS = ['Bash'];
export const CLAUDE_KNOWN_TOOLS = [
  ...CLAUDE_READ_TOOLS, ...CLAUDE_WRITE_TOOLS, ...CLAUDE_WEB_TOOLS, ...CLAUDE_COMMAND_TOOLS,
  'AskUserQuestion', 'Agent', 'Task', 'TodoWrite', 'TaskStop', 'Monitor', 'Workflow', 'PowerShell', 'Skill',
];

/** What each fixed word compiles to on Claude Code. */
export const CLAUDE_MAPPING = {
  'web search': { tools: ['WebSearch', 'WebFetch'] },
  'browse the web': { tools: [], mcpServer: BROWSER_SERVER },
  'read my files': { tools: ['Read', 'Glob', 'Grep'], paths: ['raw/**'] },
  'write notes': { tools: ['Write', 'Edit'] },
  'run commands': { tools: ['Bash'] },
};

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Parse one entry of a role's `tools`: a string (effect `allow`) or `{name, effect}`.
 * The fixed words are matched ignoring case and extra spaces; `mcp:` server names and
 * `cli:` prefixes keep their case.
 * @returns {{ok: true, tool: {name: string, effect: string, word: string, server?: string, prefix?: string}} | {ok: false, message: string}}
 */
export function parseToolEntry(entry) {
  let name;
  let effect = 'allow';
  if (typeof entry === 'string') {
    name = entry;
  } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    name = entry.name;
    if (entry.effect !== undefined) effect = entry.effect;
  } else {
    return { ok: false, message: 'must be a tool name or {"name", "effect"}' };
  }
  if (typeof name !== 'string' || !name.trim()) return { ok: false, message: 'needs a tool name' };
  if (!EFFECTS.includes(effect)) return { ok: false, message: `effect must be one of ${EFFECTS.join(', ')}` };
  const trimmed = name.trim().replace(/\s+/g, ' ');
  const lower = trimmed.toLowerCase();
  if (WORDS.includes(lower)) return { ok: true, tool: { name: lower, effect, word: lower } };
  if (lower.startsWith('mcp:')) {
    const server = trimmed.slice(4).trim();
    if (!SERVER_NAME.test(server)) return { ok: false, message: `"${trimmed}": an MCP server name uses letters, digits, "-" and "_"` };
    return { ok: true, tool: { name: `mcp:${server}`, effect, word: 'mcp', server } };
  }
  if (lower.startsWith('cli:')) {
    const prefix = trimmed.slice(4).trim();
    if (!prefix) return { ok: false, message: `"${trimmed}": a cli: entry needs a command prefix` };
    if (hasPrefixUnsafe(prefix) || /["']/.test(prefix)) return { ok: false, message: `"${trimmed}": a command prefix cannot contain quotes or shell syntax` };
    return { ok: true, tool: { name: `cli:${prefix}`, effect, word: 'cli', prefix } };
  }
  return { ok: false, message: `"${trimmed}" is not a known tool. Use ${WORDS.map((w) => `"${w}"`).join(', ')}, "mcp:<server>" or "cli:<command prefix>"` };
}

/** Split `mcp__<server>__<tool>` (Claude Code's MCP tool naming). */
export function parseMcpToolName(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(name));
  return m ? { server: m[1], tool: m[2] } : null;
}

/** The MCP server a vocabulary entry stands for, if any. */
export const serverOf = (tool) => (tool.word === 'browse the web' ? BROWSER_SERVER : tool.word === 'mcp' ? tool.server : null);

/** Is `prefix` covered by one of the allowed prefixes (same words, or a longer command)? */
export const prefixAllowed = (prefix, allowed) => (allowed ?? []).some((a) => typeof a === 'string' && matchesPrefix(prefix, a));

/** Files every role owns: its work file, its follow-up rounds and the shared source cards. */
export const roleWritable = (roleId) => [
  `outputs/work/${roleId}.md`,
  `outputs/work/${roleId}-round[0-9]*.md`,
  'sources/*.md',
];

/** Files the Lead owns: the answer and its own notes. It never creates source cards. */
export const LEAD_WRITABLE = ['outputs/result.md', 'outputs/work/lead.md', 'outputs/work/lead-round[0-9]*.md'];
