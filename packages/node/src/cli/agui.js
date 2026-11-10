// Map MAS Office events to AG-UI-shaped events (spec §3.2 and §6). Experimental.
// Every AG-UI event carries `timestamp` (ms) and our original event as `rawEvent`.
//
// AG-UI 1.0 has no mid-run interrupt event: interrupts end a run and answers arrive with the next
// input. Our sessions are long-lived, so `request.opened` / `request.resolved` are exported as
// CUSTOM events named `interrupt` / `resume` whose value has the AG-UI `Interrupt` / `ResumeEntry` shape.

const ANSWERED = ['selected', 'submitted', 'declined']; // declined is an answer; the rest abandon the request
const TASK_EVENTS = { 'task.assigned': 'assigned', 'task.finished': 'done' };

/** AG-UI `Interrupt.reason`: an open string with a few well-known values. */
function interruptReason(d) {
  if (d.kind === 'approval') return typeof d.toolCallId === 'string' ? 'tool_call' : 'confirmation';
  if (d.kind === 'question') return 'input_required';
  return `mas:${d.kind}`;
}

const SIMPLE = {
  'run.failed': (e, d) => ({ type: 'RUN_ERROR', message: d.reason ?? 'Run failed' }),
  'stage.started': (e, d) => ({ type: 'STEP_STARTED', stepName: String(d.group ?? '') }),
  'stage.finished': (e, d) => ({ type: 'STEP_FINISHED', stepName: String(d.group ?? '') }),
  'agent.registered': (e, d, agentId) => ({ type: 'SUBAGENT_STARTED', agentId, name: d.name ?? e.agentName ?? agentId, parentId: e.parentId ?? 'lead' }),
  'agent.finished': (e, d, agentId) => ({ type: 'SUBAGENT_FINISHED', agentId }),
  'agent.failed': (e, d, agentId) => ({ type: 'SUBAGENT_ERROR', agentId, message: d.reason ?? 'Failed' }),
  'agent.status': (e, d, agentId) => ({
    type: 'ACTIVITY_SNAPSHOT', messageId: `status-${agentId}`, activityType: 'mas.agent.status', content: { agentId, ...d },
  }),
};

/**
 * @param {object[]} events valid events in seq order (see `parseLog`)
 * @param {{threadId?: string}} [options] `threadId` is usually the project folder
 * @returns {object[]} AG-UI events
 */
export function toAgUi(events, { threadId = null } = {}) {
  const out = [];
  const calls = new Map(); // agent + tool name → last toolCallId, for results without a callId
  const tasks = new Map(); // taskId → merged task content, so each ACTIVITY_SNAPSHOT is complete
  let result; // a `result` is also attached to the run's RUN_FINISHED

  for (const e of events) {
    const d = e.data ?? {};
    const agentId = e.agentId ?? 'lead';
    const timestamp = Date.parse(e.ts);
    const push = (fields) => out.push({ ...fields, ...(Number.isFinite(timestamp) && { timestamp }), rawEvent: e });

    if (Object.hasOwn(SIMPLE, e.type)) {
      push(SIMPLE[e.type](e, d, agentId));
      continue;
    }
    switch (e.type) {
      case 'run.started':
        result = undefined;
        push({ type: 'RUN_STARTED', threadId, runId: e.runId ?? null });
        break;
      case 'run.finished':
        push({ type: 'RUN_FINISHED', threadId, runId: e.runId ?? null, ...(result !== undefined && { result }) });
        result = undefined;
        break;
      case 'message': {
        const messageId = `msg-${e.seq}`;
        push({ type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' });
        push({ type: 'TEXT_MESSAGE_CONTENT', messageId, delta: d.text });
        push({ type: 'TEXT_MESSAGE_END', messageId });
        break;
      }
      case 'tool.started': {
        const toolCallId = d.callId ?? `call-${e.seq}`;
        calls.set(`${agentId}\n${d.name}`, toolCallId);
        push({ type: 'TOOL_CALL_START', toolCallId, toolCallName: d.name });
        break;
      }
      case 'tool.finished':
      case 'tool.failed':
        push({
          type: 'TOOL_CALL_RESULT',
          messageId: `tool-${e.seq}`,
          toolCallId: d.callId ?? calls.get(`${agentId}\n${d.name}`) ?? `call-${e.seq}`,
          content: e.type === 'tool.failed' ? String(d.error ?? 'Tool failed') : '',
          role: 'tool',
        });
        break;
      case 'result':
        result = d;
        push({ type: 'CUSTOM', name: 'result', value: d });
        break;
      case 'request.opened':
        push({
          type: 'CUSTOM',
          name: 'interrupt',
          value: {
            id: d.requestId,
            reason: interruptReason(d),
            message: d.title,
            ...(typeof d.toolCallId === 'string' && { toolCallId: d.toolCallId }),
            ...(d.responseSchema !== undefined && { responseSchema: d.responseSchema }),
            ...(typeof d.expiresAt === 'string' && { expiresAt: d.expiresAt }),
            metadata: { agentId, kind: d.kind, ...(Array.isArray(d.options) && { options: d.options }) },
          },
        });
        break;
      case 'request.resolved':
        push({
          type: 'CUSTOM',
          name: 'resume',
          value: {
            interruptId: d.requestId,
            status: ANSWERED.includes(d.outcome) ? 'resolved' : 'cancelled',
            ...(d.payload !== undefined ? { payload: d.payload } : typeof d.optionId === 'string' && { payload: { optionId: d.optionId } }),
            metadata: { outcome: d.outcome, ...(d.by !== undefined && { by: d.by }) },
          },
        });
        break;
      case 'task.assigned':
      case 'task.updated':
      case 'task.finished': {
        const content = { ...tasks.get(d.taskId), ...d, agentId };
        content.state = TASK_EVENTS[e.type] ?? content.state ?? 'assigned';
        tasks.set(d.taskId, content);
        push({ type: 'ACTIVITY_SNAPSHOT', messageId: `task-${d.taskId}`, activityType: 'TASK', content });
        break;
      }
      default: // handoff, flag.*, artifact, commands, agent.stopped, verification, custom.*, unknown types
        push({ type: 'CUSTOM', name: e.type.startsWith('custom.') ? e.type.slice('custom.'.length) : e.type, value: d });
    }
  }
  return out;
}
