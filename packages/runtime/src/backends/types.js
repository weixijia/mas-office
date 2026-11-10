// Shared shapes for session adapters. The contract is docs/design/runtime.md §4.

/**
 * @typedef {'steer' | 'queue' | 'interrupt'} Delivery
 *
 * @typedef {object} SessionSpec
 * @property {string} agentId role id or "lead"
 * @property {string} cwd the project folder
 * @property {string} systemPrompt role contract, appended to the backend's own system prompt
 * @property {object} compiled CompiledRole from mas-office/team
 * @property {string} [resume] backend session id to resume
 * @property {string} [model]
 *
 * @typedef {object} AskRequest
 * @property {'approval' | 'question'} kind
 * @property {string} title
 * @property {string} [description]
 * @property {{type: string, tool?: string, input?: object, command?: string, path?: string}} subject
 * @property {string} [toolCallId]
 * @property {{optionId: string, name: string, kind: string}[]} options
 * @property {object[]} [questions]
 * @property {{backend: string, raw: string}} source
 *
 * @typedef {object} AskAnswer
 * @property {'allow' | 'deny' | 'cancel'} behavior
 * @property {string} [optionId]
 * @property {object} [updatedInput]
 * @property {string} [message]
 * @property {object} [answers]
 * @property {boolean} [remember]
 *
 * @typedef {object} SessionSink
 * @property {(type: string, data?: object) => void} event
 * @property {(entry: object) => void} transcript
 * @property {(request: AskRequest) => Promise<AskAnswer>} ask
 * @property {(subject: AskRequest['subject']) => ({effect: 'allow' | 'ask' | 'deny', reason?: string} | undefined)} [precheck]
 *   Called for every tool call, also those the backend runs without asking. Only `deny` has an
 *   effect (the call is blocked); it never opens a request.
 * @property {(toolCallId: string, info?: {requestId?: string}) => void} [resolvedElsewhere] the backend reports that a pending
 *   ask was answered somewhere else (its own terminal)
 *
 * @typedef {object} TurnResult
 * @property {boolean} ok
 * @property {string} text
 * @property {'end_turn' | 'cancelled' | 'error' | 'max_turns'} stopReason
 * @property {string} [error]
 * @property {object} [usage]
 *
 * @typedef {object} AgentSession
 * @property {string} id
 * @property {'running' | 'requires_action' | 'idle' | 'closed'} state
 * @property {(text: string, delivery: Delivery) => Promise<{status: 'applied' | 'rejected', reason?: string}>} send
 * @property {(text: string) => Promise<TurnResult>} turn
 * @property {() => Promise<void>} interrupt
 * @property {() => Promise<void>} close
 *
 * @typedef {object} AgentBackend
 * @property {'claude-code' | 'codex'} name
 * @property {() => Promise<{available: boolean, version?: string, loggedIn?: boolean, detail?: string}>} probe
 * @property {(spec: SessionSpec, sink: SessionSink) => Promise<AgentSession>} start
 * @property {() => Promise<void>} close
 */

export const DELIVERIES = ['steer', 'queue', 'interrupt'];

/** Environment variables a child session may inherit (never the daemon's whole env). */
export const CHILD_ENV_KEYS = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'SystemRoot', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE',
];

/** The minimal environment for a child session. */
export function childEnv(extra = {}, source = process.env) {
  const env = {};
  for (const key of CHILD_ENV_KEYS) if (source[key] !== undefined) env[key] = source[key];
  return { ...env, ...extra };
}
