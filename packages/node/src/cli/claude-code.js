// Map one Claude Code hook input to MAS Office events. Experimental.
// Hook inputs share session_id, cwd and hook_event_name; inside a subagent agent_id and
// agent_type are set; tool hooks add tool_name, tool_input and tool_use_id.

import path from 'node:path';
import { sanitizeId } from '../sdk/index.js';

/** Tools that spawn subagents: covered by SubagentStart / SubagentStop instead. */
const SPAWN_TOOLS = new Set(['Agent', 'Task']);

const short = (text, max = 60) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const fileName = (p) => (typeof p === 'string' && p ? path.basename(p) : 'a file');

/** A plain, short `say` line for a tool call. Never includes command arguments or file contents. */
export function describeTool(name, input = {}) {
  switch (name) {
    case 'Read': return short(`Reading ${fileName(input.file_path)}`);
    case 'Write': return short(`Writing ${fileName(input.file_path)}`);
    case 'Edit':
    case 'MultiEdit': return short(`Editing ${fileName(input.file_path)}`);
    case 'NotebookEdit': return short(`Editing ${fileName(input.notebook_path)}`);
    case 'Bash': {
      const program = String(input.command ?? '').trim().split(/\s+/)[0];
      return short(program ? `Running ${path.basename(program)}` : 'Running a command');
    }
    case 'Grep': return 'Searching the code';
    case 'Glob': return 'Finding files';
    case 'WebSearch': return 'Searching the web';
    case 'WebFetch': {
      try { return short(`Reading ${new URL(input.url).hostname}`); } catch { return 'Reading a web page'; }
    }
    case 'TodoWrite': return 'Updating the plan';
    default: return short(`Using ${String(name).replace(/^mcp__[^_]+__/, '')}`);
  }
}

/** A one-line question for a permission prompt. Like `describeTool`, it never includes arguments. */
export function describePermission(name, input = {}) {
  switch (name) {
    case 'Bash': {
      const program = String(input.command ?? '').trim().split(/\s+/)[0];
      return short(program ? `Run ${path.basename(program)}?` : 'Run a command?', 80);
    }
    case 'Write': return short(`Write ${fileName(input.file_path)}?`, 80);
    case 'Edit':
    case 'MultiEdit': return short(`Edit ${fileName(input.file_path)}?`, 80);
    case 'WebSearch': return 'Search the web?';
    case 'WebFetch': {
      try { return short(`Read ${new URL(input.url).hostname}?`, 80); } catch { return 'Read a web page?'; }
    }
    default: return short(`Use ${String(name).replace(/^mcp__[^_]+__/, '')}?`, 80);
  }
}

const HOOK_SOURCE = 'hook:PermissionRequest';

/**
 * @param {object} input the hook's stdin JSON
 * @param {{state: object, statuses: object, inbox?: object}} snapshot the project's current reducer snapshot
 * @param {{now?: number}} [options]
 * @returns {object[]} events without seq (the log assigns it)
 */
export function mapHook(input, snapshot, { now = Date.now() } = {}) {
  const runId = String(input.session_id ?? 'session');
  const running = snapshot.state.phase === 'running' && snapshot.state.runId === runId;
  const inSubagent = typeof input.agent_id === 'string' && input.agent_id !== '';
  const agentId = inSubagent ? sanitizeId(input.agent_id) : 'lead';
  const agentName = inSubagent ? String(input.agent_type ?? 'Subagent') : undefined;
  const raw = {};
  for (const k of ['hook_event_name', 'session_id', 'agent_id', 'agent_type', 'tool_name', 'tool_use_id']) {
    if (input[k] !== undefined) raw[k] = input[k];
  }
  const event = (type, data = {}, who = agentId) => ({
    runId, type, agentId: who, ...(who !== 'lead' && agentName && { agentName }), data, raw,
  });
  // The lead's "needs your input" flag clears as soon as the lead works again.
  const unflagLead = () => (agentId === 'lead' && snapshot.statuses.lead?.state === 'flagged' ? [event('flag.resolved')] : []);
  const tool = input.tool_name;
  // This session is one the person opened themselves: we only watch it. A permission prompt shows
  // up in the inbox (with its wait clock) and is answered in its own terminal; any sign that the
  // session moved on closes the inbox entry.
  const waiting = (snapshot.inbox?.pending ?? []).filter((r) => r.agentId === agentId && r.source?.raw === HOOK_SOURCE);
  // A tool result closes the prompt for that tool call; other signs of life close them all.
  const answeredInTerminal = (toolCallId) => waiting.filter((r) => !toolCallId || !r.toolCallId || r.toolCallId === toolCallId).map((r) => event('request.resolved', {
    requestId: r.requestId, outcome: 'superseded', by: { kind: 'terminal' },
  }));

  switch (input.hook_event_name) {
    case 'SessionStart':
    case 'UserPromptSubmit':
      if (!running) return [event('run.started', { title: 'Claude Code' }, 'lead')];
      return [...answeredInTerminal(), ...unflagLead()];
    case 'PermissionRequest': {
      if (typeof tool !== 'string') return [];
      if (waiting.some((r) => r.toolCallId && r.toolCallId === input.tool_use_id)) return [];
      const requestId = `hook_${sanitizeId(input.tool_use_id ?? `${agentId}-${now.toString(36)}`)}`;
      return [event('request.opened', {
        requestId,
        kind: 'approval',
        title: describePermission(tool, input.tool_input),
        subject: { type: 'tool_call', tool },
        ...(typeof input.tool_use_id === 'string' && { toolCallId: input.tool_use_id }),
        options: [],
        blocking: true,
        routeTo: 'human',
        onExpire: 'Answer it in the terminal where this session runs.',
        source: { backend: 'claude-code', raw: HOOK_SOURCE },
      })];
    }
    case 'PermissionDenied':
      return answeredInTerminal();
    case 'SubagentStart':
      if (!inSubagent) return [];
      return [
        { ...event('agent.registered', { name: agentName }), parentId: 'lead' },
        event('agent.status', { state: 'working', say: short(`Started as ${agentName}`) }),
      ];
    case 'SubagentStop':
      return inSubagent ? [event('agent.finished')] : [];
    case 'PreToolUse':
      if (typeof tool !== 'string' || SPAWN_TOOLS.has(tool)) return [];
      return [...unflagLead(), event('tool.started', { name: tool, callId: input.tool_use_id, say: describeTool(tool, input.tool_input) })];
    case 'PostToolUse':
      if (typeof tool !== 'string' || SPAWN_TOOLS.has(tool)) return answeredInTerminal();
      return [...answeredInTerminal(input.tool_use_id), event('tool.finished', { name: tool, callId: input.tool_use_id })];
    case 'PostToolUseFailure':
      if (typeof tool !== 'string' || SPAWN_TOOLS.has(tool)) return answeredInTerminal();
      return [...answeredInTerminal(input.tool_use_id), event('tool.failed', { name: tool, callId: input.tool_use_id, error: short(input.error ?? 'Tool failed', 200) })];
    case 'Notification':
      // A permission prompt that is already in the inbox as a request needs no second flag.
      if (input.notification_type === 'permission_prompt' && (snapshot.inbox?.pending ?? []).some((r) => r.source?.raw === HOOK_SOURCE)) return [];
      return [event('flag.raised', { text: short(input.message ?? 'Claude needs your input'), kind: 'needs_input' }, 'lead')];
    case 'Stop':
      return [...answeredInTerminal(), ...(running ? [event('run.finished', { say: 'Done — your turn' }, 'lead')] : [])];
    default:
      return [];
  }
}
