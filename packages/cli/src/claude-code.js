// Map one Claude Code hook input to MAS Office events. Experimental.
// Hook inputs share session_id, cwd and hook_event_name; inside a subagent agent_id and
// agent_type are set; tool hooks add tool_name, tool_input and tool_use_id.

import path from 'node:path';
import { sanitizeId } from '@mas-office/sdk';

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

/**
 * @param {object} input the hook's stdin JSON
 * @param {{state: object, statuses: object}} snapshot the project's current reducer snapshot
 * @returns {object[]} events without seq (the log assigns it)
 */
export function mapHook(input, snapshot) {
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

  switch (input.hook_event_name) {
    case 'SessionStart':
    case 'UserPromptSubmit':
      if (!running) return [event('run.started', { title: 'Claude Code' }, 'lead')];
      return unflagLead();
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
      if (typeof tool !== 'string' || SPAWN_TOOLS.has(tool)) return [];
      return [event('tool.finished', { name: tool, callId: input.tool_use_id })];
    case 'PostToolUseFailure':
      if (typeof tool !== 'string' || SPAWN_TOOLS.has(tool)) return [];
      return [event('tool.failed', { name: tool, callId: input.tool_use_id, error: short(input.error ?? 'Tool failed', 200) })];
    case 'Notification':
      return [event('flag.raised', { text: short(input.message ?? 'Claude needs your input'), kind: 'needs_input' }, 'lead')];
    case 'Stop':
      return running ? [event('run.finished', { say: 'Done — your turn' }, 'lead')] : [];
    default:
      return [];
  }
}
