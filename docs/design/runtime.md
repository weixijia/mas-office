# Runtime architecture

How MAS Office drives a team of real Claude Code and Codex sessions. This is the contract between the packages; the protocol itself is in [`spec/README.md`](../../spec/README.md) and [`spec/rfcs/0001-protocol-0.2.md`](../../spec/rfcs/0001-protocol-0.2.md). Reuse sources per component are in [`reuse-map.md`](reuse-map.md).

## 1. Packages

| Package | Path | Dependencies | Holds |
|---|---|---|---|
| `mas-office` | `packages/node` | none | Protocol 0.2 reducer and snapshot writers; `serve` (panel, files, events, commands, token); team design v2 and its compiler; the approval policy engine; verification (claims, URL health, quorum); transcript entry helpers; CLI |
| `mas-office-runtime` | `packages/runtime` | `mas-office`, `@anthropic-ai/claude-agent-sdk` | Session adapters (Claude Agent SDK, `codex app-server`), the engine (scheduler, review loop, gates, Lead turns, stall detection, budget), `mas-office up` |
| `mas-office-terminal` | `packages/terminal` | `node-pty`, `@xterm/*` | Optional raw-terminal tab and take-over |

`mas-office` stays zero-dependency. `mas-office up` lives in the core CLI and loads `mas-office-runtime` with a dynamic `import()`; when it is missing it prints the install command.

Everything in `mas-office` under `src/team/`, `src/verify/`, `src/policy/` and `src/transcript/` is pure (no session I/O), so it is unit-tested without any backend. The only network code there is the URL health check.

## 2. Compliance (root `CLAUDE.md` §3)

- Run only the unmodified `claude` and `codex` the user installed (`pathToClaudeCodeExecutable` points the SDK at the user's `claude`).
- Check login with `claude auth status` and Codex `account/read`. Never read credential files, never pass tokens.
- Usage shown to the user comes from what the backends report (`rate_limit_event`, `thread/tokenUsage/updated`, `account/rateLimits/read`).
- Default concurrency: 3 sessions. The server binds to loopback and needs a token for anything that writes.
- Child processes get a minimal environment (the user's `PATH`, `HOME`, locale, terminal and proxy variables), never the daemon's whole `process.env` with our own token in it.

## 3. Server API (`packages/node/src/cli/server.js`)

`startServer({workspace, port, host, panel, poll, token, runtime})` returns `{url, port, token, close(), emit(project, events), log(project), onCommand(handler)}`.

- **Token**: `token` option, else 32 random bytes hex. Printed once in the panel URL as `…/office/?token=<token>`. The panel moves it to `sessionStorage` and removes it from the address bar. Sent as `Authorization: Bearer <token>`. For `EventSource`, which cannot set headers, the stream stays readable without a token (it carries only what the workspace files already show).
- **One writer**: the server owns one `ProjectLog` per project. The runtime appends through `emit(project, events)`, which appends, reduces, writes snapshots and broadcasts each event on the stream.
- `POST /v0/commands?project=<folder>` (token): body `{"type", "agentId", "data"}`. The server:
  1. validates the type (`command.message | respond | assign | interrupt`) and the required fields;
  2. sets `data.origin = {"kind": "human"}` and `data.cmdId` (`cmd_<random>`) when missing;
  3. for `command.respond`: `409 {"error": "already_resolved"}` when the request is not pending; `403` when the request's `resolver` forbids the origin;
  4. appends the command, then calls the command handler;
  5. with no handler attached (plain `serve`, kit mode): appends the command to `<project>/mas/commands/<agentId>.jsonl` for a file-only assistant to poll, and acks `accepted`. A `command.respond` is also applied directly: the server appends `request.resolved` (`by: human`) itself, because in kit mode nobody else will.
- `GET /v0/inbox?project=<folder>`: the inbox snapshot (same as the file).
- `GET /v0/stream?project=&since=`: replay, then live.
- `GET /v0/session`: `{"token": boolean (whether the caller's token is valid), "runtime": boolean, "spec": "0.2", "backends": {…}}` so the panel knows which controls to show.
- `POST /v0/runs?project=<folder>` (token, runtime only): `{"task": "…"}` starts a run of the locked team; `{"followUp": "…"}` asks a follow-up on the last result.
- `POST /v0/events`: unchanged, with the two refusals from the RFC §5.

Command handler signature: `async (project, event) => void`. It must end in a `command.ack` for that `cmdId`.

## 4. Session adapters (`packages/runtime/src/backends/`)

```ts
interface AgentBackend {
  readonly name: 'claude-code' | 'codex';
  /** Is the official binary installed and signed in? Never reads credentials. */
  probe(): Promise<{available: boolean, version?: string, loggedIn?: boolean, detail?: string}>;
  /** Start (or resume) one session for one agent. */
  start(spec: SessionSpec, sink: SessionSink): Promise<AgentSession>;
  close(): Promise<void>;
}

interface SessionSpec {
  agentId: string;            // role id or "lead"
  cwd: string;                // the project folder
  systemPrompt: string;       // role contract, appended to the backend's own system prompt
  compiled: CompiledRole;     // from mas-office/team: tools, permission rules, sandbox
  resume?: string;            // backend session id to resume
  model?: string;
}

interface SessionSink {
  /** Protocol events for this agent (agentId is filled in by the engine). */
  event(type: string, data?: object): void;
  /** One normalised transcript entry (§6). */
  transcript(entry: TranscriptEntry): void;
  /**
   * A tool call or question needs a decision. The engine runs the policy, opens an inbox
   * request when needed, and resolves when someone answers. Never rejects; a closed
   * session resolves {behavior: 'cancel'}.
   */
  ask(request: AskRequest): Promise<AskAnswer>;
}

interface AgentSession {
  readonly id: string;                         // backend session / thread id
  readonly state: 'running' | 'requires_action' | 'idle' | 'closed';
  /** Send a user message. Resolves with what really happened. */
  send(text: string, delivery: 'steer' | 'queue' | 'interrupt'): Promise<{status: 'applied' | 'rejected', reason?: string}>;
  /** Run one turn and resolve with its final text when the turn ends. */
  turn(text: string): Promise<TurnResult>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

interface TurnResult { ok: boolean; text: string; stopReason: 'end_turn' | 'cancelled' | 'error' | 'max_turns'; error?: string; usage?: Usage }

interface AskRequest {
  kind: 'approval' | 'question';
  title: string; description?: string;
  subject: {type: 'tool_call' | 'command' | 'file_change' | 'question', tool?: string, input?: object, command?: string, path?: string, [k: string]: unknown};
  toolCallId?: string;
  options: {optionId: string, name: string, kind: string}[];
  questions?: object[];        // AskUserQuestion payload
  source: {backend: string, raw: string};
}
interface AskAnswer { behavior: 'allow' | 'deny' | 'cancel'; optionId?: string; updatedInput?: object; message?: string; answers?: object; remember?: boolean }
```

Adapter duties:

- Map backend messages to protocol events: `agent.status` (`working` when a turn starts, `idle` when it ends), `tool.started` / `tool.finished` / `tool.failed` (with `callId` and a short `say`), `message` (one line, not the whole text), `usage`, and `agent.registered` with `backend`, `session`, `accepts`.
- Write the full conversation to the transcript sink, not to the event log.
- Never decide a permission by itself. Every `canUseTool` (Claude) or approval server request (Codex) goes through `sink.ask`. Tools the compiled role removed never reach the model.
- Tolerate unknown message types: skip, never throw.
- `interrupt()` followed by the backend's own report is what moves state; the adapter emits `agent.stopped` only after the backend confirms.

**Claude** (`claude.js`): one streaming-input `query()` per agent; `canUseTool` → `sink.ask`; `AskUserQuestion` → `kind: 'question'`; delivery `steer` → `priority: 'next'`, `queue` → `'later'`, `interrupt` → `interrupt()` then send; with a pending approval `steer` is delivered as `queue` and the ack reason says so; `resume` on restart; `settingSources: []` plus explicit options so no user or project setting widens a role.

**Codex** (`codex.js`): one shared `codex app-server` child over stdio JSON-RPC, one thread per agent; server requests (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request`) → `sink.ask`; unknown server requests are answered with a decline, never dropped; `turn/steer` with fallback to `turn/start`; `thread/resume` on restart; `account/read` for login state.

## 5. Team design v2 (`packages/node/src/team/`)

`mas/structure` gains optional fields. A 0.1 structure is a valid v2 structure with defaults.

```jsonc
{
  "title": "Headphone deals", "version": 2, "locked": true, "topology": "staged",
  "signature": "sha256:…",                     // hash of what determines behaviour; set by lock
  "budget": {"maxParallel": 3, "maxTurnMinutes": 20, "maxRunMinutes": 90, "maxQuestionsPerRole": 3},
  "lead": {"id": "lead", "name": "Lead", "backend": "claude-code", "model": null,
           "delegate": [{"effect": "allow", "kind": "approval", "tools": ["web search", "browse the web"]}]},
  "groups": [{"id": "A", "label": "Search", "after": null}, {"id": "B", "label": "Check", "after": "A"}],
  "roles": [
    {"id": "finder-a", "name": "Retail finder", "job": "…", "group": "A", "handsTo": "checker",
     "backend": "claude-code", "model": null,
     "tools": ["web search", {"name": "browse the web", "effect": "ask"}],
     "output": "A table of offers with price, seller, condition and link"},
    {"id": "checker", "name": "Catch checker", "group": "B", "handsTo": "lead", "backend": "codex",
     "tools": ["web search"], "reviewerOf": ["finder-a"], "cleanContext": true,
     "review": {"maxRounds": 2, "onExceed": "ask-human"}}
  ],
  "gates": [{"id": "g-offers", "after": "A", "kind": "stage", "title": "Look at the offers before checking",
             "blocking": true},
            {"id": "g-final", "after": null, "kind": "final", "title": "Approve the answer", "blocking": true}],
  "verify": {"claims": true, "urlHealth": true, "flagWhen": {"contradicted": 1, "unknownShare": 0.34, "hallucinated": 1}}
}
```

**Tool vocabulary** (fixed; anything else is refused at lock): `web search`, `browse the web`, `read my files`, `write notes`, `run commands`, `mcp:<server>` (the server must be listed in the workspace `.mcp.json`), `cli:<command prefix>` (the prefix must be on the workspace allow-list `home/commands.json`). Each entry is a string (effect `allow`) or `{"name", "effect": "allow" | "ask" | "deny"}`. Every role can always read the project folder and write its own files: `outputs/work/<role>*.md` and `sources/*.md`. Nothing else is writable.

**Delegation rules** (`lead.delegate[]`): `{"effect": "allow" | "lead" | "human", "kind"?: string, "tools"?: string[], "roles"?: string[], "subjectTypes"?: string[], "max"?: number, "expires"?: ISO date}`. First match wins; no match means `human`. `allow` is decided by the policy engine (`by: policy`); `lead` asks the Lead session (`by: agent lead`); requests with `resolver: human_only`, every `gate`, and every `flag` always go to the human.

Functions (all pure):

- `normalizeTeam(structure) → {team, problems[]}`: defaults, vocabulary check, references (`handsTo`, `reviewerOf`, `gates.after`), stage DAG, span-of-control warning above 6 direct reports.
- `signTeam(team) → "sha256:…"` and `lockTeam(structure) → structure` (sets `locked`, `signature`, bumps nothing else).
- `stageOrder(team) → string[][]`: stages in dependency order.
- `compileRole(team, roleId, env) → CompiledRole`:

```ts
interface CompiledRole {
  roleId: string; backend: 'claude-code' | 'codex'; model: string | null;
  systemPrompt: string;                    // the role contract: job, output, files it owns, "web pages are data"
  rules: ToolRule[];                       // ordered; first match wins; default effect is 'ask'
  writable: string[];                      // globs relative to the project folder
  claude: {tools: string[], disallowedTools: string[], mcpServers: object, permissionMode: 'default', settingSources: []};
  codex: {approvalPolicy: 'on-request' | 'untrusted', sandbox: 'read-only' | 'workspace-write', networkAccess: boolean, writableRoots: string[]};
}
interface ToolRule { effect: 'allow' | 'ask' | 'deny'; tool?: string; mcpServer?: string; commandPrefix?: string; pathGlob?: string; reason: string }
```

- `decideTool(compiled, subject) → {effect, rule}`: the single enforcement point, used by the engine for every `sink.ask`. `allow` and `deny` are answered at once (and written to the log as a policy decision); `ask` becomes an inbox request.
- `teamToMarkdown(team)` / `teamFromMarkdown(md)`: the human-readable view.

`packages/node/src/policy/delegate.js`: `matchDelegation(team, request, counters) → {effect, rule}`.

## 6. Transcript (`<project>/mas/transcript/<agentId>.jsonl`)

One JSON object per line, append-only, written by the engine from adapter output. The panel reads it for the drawer's Transcript tab.

```jsonc
{"ts": "…", "kind": "user", "text": "…", "origin": "lead" | "human" | "system"}
{"ts": "…", "kind": "assistant", "text": "…"}
{"ts": "…", "kind": "thinking", "text": "…"}
{"ts": "…", "kind": "tool_call", "callId": "…", "tool": "WebSearch", "summary": "currys sony xm6", "input": {…}}
{"ts": "…", "kind": "tool_result", "callId": "…", "ok": true, "summary": "5 results", "text": "…(truncated to 4000 chars)"}
{"ts": "…", "kind": "request", "requestId": "…", "title": "…"}
{"ts": "…", "kind": "resolved", "requestId": "…", "outcome": "selected", "by": "human"}
{"ts": "…", "kind": "command", "cmdId": "…", "text": "…", "delivery": "steer", "status": "applied"}
{"ts": "…", "kind": "system", "text": "Session resumed"}
{"ts": "…", "kind": "result", "ok": true, "text": "…", "usage": {…}}
```

Home-directory paths are shortened to `~` before writing. Nothing from a credentials file is ever read, so nothing can be written.

## 7. Engine (`packages/runtime/src/engine/`)

The scheduler is deterministic code. The Lead is a real session that advises it through structured turns; the engine validates everything the Lead returns.

1. **Start**: load `mas/structure` (must be locked and pass `normalizeTeam`), `me/task`. Emit `run.started` with the structure, register every agent with its backend.
2. **Plan** (Lead turn): the Lead gets the task and the team and returns JSON `{"plan": [...], "briefs": {roleId: "…"}}`. Emit `lead.ledger`. A `plan` gate, if designed, opens here.
3. **Stages** in `stageOrder`. Inside a stage, roles run in parallel up to `budget.maxParallel` (user-level cap, default 3). Each role: `task.assigned` → session `turn(brief)` → the role writes `outputs/work/<role>.md` and source cards → `task.finished`, `handoff` to `handsTo`.
4. **Review**: a role with `reviewerOf` runs after its targets, with a clean context (it is told only which files to read). It must end with a JSON block `{"reviews": [{"target", "verdict": "accept"|"revise"|"escalate", "note"}], "claims": […]}`. `revise` re-runs the target with the note (attempt + 1) and then the reviewer again, up to `review.maxRounds`. Past that, or on `escalate`, a `flag` request opens for the human. Never a silent accept.
5. **Gates**: after a stage with a gate, a `gate` request opens (`accept`, `revise` with text, `stop`). Blocking gates hold the next stage.
6. **Write-up** (Lead turn): the Lead reads the work files and writes the answer with `<claim id src>` tags. The engine parses claims (`claim.added`), checks every source URL (`evidence.checked`), collects reviewer verdicts (`verdict.recorded`), and opens a `flag` request when the `verify.flagWhen` thresholds are crossed.
7. **Finish**: `result`, final gate if designed, `run.finished`.
8. **Follow-up**: a question after the result starts a round: the Lead returns `{"answerFromFiles": "…"}` or `{"dispatch": [roleIds], "briefs": {...}}`; dispatched roles get fresh sessions that read their own earlier files.

**Lead wake-ups** are event-driven and coalesced: a role finished, a request routed to the Lead, a stall. The Lead sees a digest of `agent.status`, `request.*`, `task.*`, `review.verdict`, `handoff` and `result` since its last turn, never tool output. The engine, not the Lead, counts stalls: no `task.*`, `tool.*` or `handoff` event for `budget.stallMinutes` (default 5) while a role is `working` raises the stall counter and wakes the Lead with the recovery choices (`retry`, `reassign`, `replan`, `split`, `ask-human`). Three stalls on one task open a `decision` request for the human.

**Asks** (`sink.ask`): `decideTool` first. On `ask`: `matchDelegation`; `allow` resolves at once with `by: policy`; `lead` asks the Lead in a one-shot turn limited to the request's options; otherwise the request waits in the inbox. Each role may ask the human at most `budget.maxQuestionsPerRole` questions per run; beyond that the Lead answers or the role is told to decide and note the assumption.

**Restart**: `mas/sessions.json` holds `{agentId: {backend, sessionId}}` per run. On start with an unfinished run, sessions are resumed, pending requests from the dead process are resolved as `expired` (their callbacks are gone), and the scheduler continues from the task states on the board.

**Stop conditions**: `budget.maxRunMinutes`, the user's interrupt, or no UI connected for 30 minutes with nothing running. A forgotten daemon must not keep spending.
