# MAS Office Protocol — version 0.2

Status: **Draft**. Spec versions are `Major.Minor`; packages follow semver separately. Breaking changes go through an RFC (see [`rfcs/`](rfcs/)).

The protocol lets any multi-agent system — a framework run, an SDK script, or a coding assistant following `AGENTS.md` — show its team in the MAS Office panel, and lets a person answer and steer it from there. It has three layers:

| Layer | What it is | Who writes it |
|---|---|---|
| **Workspace layout** | Folders and file names the panel reads | everyone |
| **Snapshots** | `structure`, `status`, `state`, `result`, `inbox`, `board`, `verification` documents (JSON, plus a `.js` twin for `file://`) | hand-written by an assistant, **or** derived by the reducer |
| **Events** | An append-only `mas/events.jsonl` log; a deterministic reducer turns it into snapshots | SDKs, integrations, `mas-office serve` |

A producer can work at either level. The AGENTS.md kit writes snapshots by hand; SDKs emit events and let the reducer write snapshots. The panel only ever reads snapshots.

Version 0.2 adds the other direction — requests that wait on a person, commands to agents — plus tasks, reviews and claim verification. It is additive: a 0.1 log reduces to the same snapshots as before, apart from two new status fields and the new, empty `inbox` and `board` documents. The rationale is in [RFC 0001](rfcs/0001-protocol-0.2.md).

The key words MUST, SHOULD and MAY are used as in RFC 2119.

---

## 1. Workspace layout

```
<workspace>/
  home/
    projects.json  (+ projects.js)     which projects exist, which one the panel follows
    env.json       (+ env.js)          optional: what the producing tool can do
  <project>/                           one folder per MAS, name: [a-z0-9-]{1,40}
    me/task.json   (+ task.js)         optional: title, summary, requirements
    mas/structure.json (+ .js)         the team
    mas/state.json (+ .js)             where the project stands
    mas/status/<agent-id>.json (+ .js) one live status per agent, plus lead
    mas/inbox.json (+ .js)             open and recent requests, and commands (0.2)
    mas/board.json (+ .js)             tasks, ledger, reviews, recoveries, usage (0.2)
    mas/events.jsonl                   optional: the event log (source of truth when present)
    outputs/result.json (+ .js)        the final answer
    outputs/verification.json (+ .js)  optional: claims, evidence and verdicts (0.2)
    outputs/work/<agent-id>.md         optional: each agent's own write-up
    sources/<slug>.md                  optional: evidence cards
```

This is the same layout as [awesome-mas](https://github.com/weixijia/awesome-mas); awesome-mas folders are valid MAS Office workspaces.

### 1.1 The `.js` twin (file transport)

Browsers cannot `fetch()` local files from a page opened with `file://`, but they can load `<script>` tags. So every snapshot MAY have a `.js` twin that assigns the same JSON to a global:

| Document | Global |
|---|---|
| `home/projects` | `window.MAS_HOME = {...};` |
| `home/env`, `mas/env` | `window.MAS_ENV = {...};` |
| `me/task` | `window.MAS_TASK = {...};` |
| `mas/structure` | `window.MAS_STRUCTURE = {...};` |
| `mas/state` | `window.MAS_STATE = {...};` |
| `outputs/result` | `window.MAS_RESULT = {...};` |
| `mas/inbox` | `window.MAS_INBOX = {...};` |
| `mas/board` | `window.MAS_BOARD = {...};` |
| `outputs/verification` | `window.MAS_VERIFICATION = {...};` |
| `mas/status/<id>` | `window.MAS_STATUS = window.MAS_STATUS \|\| {}; window.MAS_STATUS["<id>"] = {...};` |

Rules:

- The value MUST be valid JSON (double quotes, no comments, no trailing commas).
- Writers that want the `file://` panel to work MUST write the `.js` twin. Writers SHOULD also write the `.json` file; readers that are not browsers SHOULD prefer `.json`.
- `mas-office serve` serves a missing `.js` by wrapping the `.json` on the fly, so HTTP-only producers can write just `.json`.
- Writers SHOULD replace files atomically (write a temp file in the same folder, then rename).

## 2. Snapshots

JSON Schemas for every document are in [`schemas/`](schemas/). Unknown fields MUST be ignored by readers, so producers MAY add their own.

### 2.1 `structure`

```json
{
  "title": "Headphone deals",
  "version": 1,
  "locked": true,
  "topology": "staged",
  "lead":   {"id": "lead", "name": "Lead", "emoji": "🧭", "job": "Write the shortlist", "serves": ["R1"]},
  "groups": [{"id": "A", "label": "Search", "after": null}, {"id": "B", "label": "Check", "after": "A"}],
  "roles": [
    {"id": "finder-a", "name": "Retail finder", "emoji": "🔎", "job": "Search retailers",
     "serves": ["R1"], "tools": ["web search"], "group": "A", "handsTo": "checker"}
  ]
}
```

- The lead's id is always `lead`. Role ids match `^[a-z0-9][a-z0-9-]*$` and MUST NOT be `lead`.
- **Groups are parallel stages.** Roles in one group run at the same time; a group starts after the group named in `after` (`null` = first). This compiles to a DAG: every member of group `X` precedes every member of the group whose `after` is `X`.
- `handsTo` is a role id or `lead` (default `lead`): where the role's output goes.
- `topology` tells the panel how the team was formed: `staged` (declared groups), `graph` (declared edges only), `dynamic` (agents appear at runtime). Default `staged`.
- `locked: true` means "this is the running configuration". The panel shows live statuses only for a locked structure.
- Agents that were not declared but appeared at runtime carry `"dynamic": true` and `"parent": "<agent-id>"`.

### 2.2 `status` (one per agent)

```json
{"state": "working", "say": "Searching Currys…", "to": null, "flag": null, "flagKind": null, "progress": 40, "t": "2026-11-06T10:00:02Z",
 "waitingOn": [], "stopReason": null}
```

| `state` | Meaning | A2A `TaskState` | OpenTelemetry GenAI |
|---|---|---|---|
| `idle` | declared, not scheduled | — | no span |
| `waiting` | scheduled, dependencies not done | `SUBMITTED` | no span yet |
| `working` | running | `WORKING` | `invoke_agent` span open |
| `handoff` | passing output to `to` | `WORKING` | span event |
| `flagged` | raised a problem or needs a human (`flag`, `flagKind`) | `INPUT_REQUIRED` / `AUTH_REQUIRED` | span open |
| `done` | finished | `COMPLETED` | span ended OK |
| `failed` | errored or was cancelled (`flag` holds the reason) | `FAILED` / `CANCELED` | span ended, `error.type` |

- `say`: one short, plain line (≤ ~60 characters) — what the agent is doing now.
- `to`: an agent id when `state` is `handoff`, otherwise `null`.
- `flagKind`: `concern` (a quality problem found), `needs_input`, `needs_approval`, or `error` (used with `failed`).
- `progress`: the agent's own rough completion, an integer 0–100.
- `t`: ISO 8601 UTC time of the last change, when known.
- `waitingOn`: ids of the blocking requests (2.6) this agent opened and that are still pending, oldest first. `[]` by default.
- `stopReason`: why the agent last stopped (`"cancelled"` when it was stopped, or what the backend reported, e.g. `"end_turn"`), `null` while it works. `null` by default.

There are no states for "waiting on a person" or "stopped": an agent with a blocking request is `flagged` (`needs_approval` or `needs_input`); a stopped turn is `idle`, a stopped agent `done`, each with `stopReason`.
### 2.3 `state`

```json
{"mode": "sdk", "step": 4, "phase": "running", "locked": true, "version": 1, "run": 1, "runId": "r1",
 "updated": "2026-11-06T10:00:05Z", "next": "Watch the office panel — the team is working."}
```

- `mode`: `kit` (an assistant guiding a person through describe → design → lock → run, as in awesome-mas) or `sdk` (a program runs the team). In `sdk` mode the panel hides the four-step bar.
- `phase`: `setup | describe | design | refine | locked | running | done | failed`.
- `next`: one plain sentence telling the viewer what happens or what to do next.

### 2.4 `result`

```json
{"title": "Headphone deals — run 1", "run": 1, "updated": "…", "markdown": "## Shortlist\n…",
 "sources": [{"id": "currys-xm6", "title": "…", "url": "https://…", "evidence": "A", "foundBy": "finder-a"}],
 "flags":   [{"by": "checker", "kind": "concern", "text": "eBay unit is refurbished"}],
 "work":    [{"by": "checker", "summary": "Checked 2 offers."}]}
```

Optional, for producers that keep a conversation about a result (the kit's follow-ups): `round` (integer ≥ 1; 1 = the run's own result, 2+ = answers to follow-up questions), `question` (the follow-up this round answers) and `previous` (earlier rounds of the same run, oldest first: `{round?, question?, title?, markdown, updated?}`). A viewer shows the rounds as one thread; without them a result is round 1. The reducer produces them from the second result of a run on, or when a result names its `round` or `question` (4.4). A producer opens a follow-up round with `round.started`.

`markdown` may wrap a statement as `<claim id="c3" src="currys-xm6,ebay-xm6">…</claim>`: the tag marks a claim (2.8) and the source ids it cites. Viewers strip the tag and may highlight the span by the claim's status.

`markdown` and `work[].summary` may use headings, lists, tables, bold, italics, code and links only. `evidence`: `A` can be bought or run · `B` study with data · `C` demo or marketing · `D` opinion.

### 2.5 `home/projects`

```json
{"current": "headphone-deals", "projects": [{"folder": "headphone-deals", "title": "Headphone deals", "step": 4, "phase": "done", "agents": 4, "runs": 1}]}
```

`current: null` makes the panel show the list of projects.

### 2.6 `inbox` (0.2)

Everything that waits on a person, and what was asked of the agents.

```json
{"pending": [{"requestId": "req-7", "agentId": "finder-a", "kind": "approval", "title": "Open currys.co.uk in the browser?",
              "description": null, "subject": {"type": "tool_call", "tool": "browser"}, "toolCallId": "toolu_01",
              "options": [{"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"}], "responseSchema": null,
              "blocking": true, "routeTo": "human", "resolver": "anyone", "urgency": "normal",
              "expiresAt": null, "onExpire": "The search skips Currys.", "source": null, "openedAt": "…", "seq": 41, "run": 1}],
 "recent":  [{"requestId": "req-6", "…": "the fields above, plus",
              "outcome": "selected", "optionId": "allow-once", "payload": null, "note": null,
              "by": {"kind": "human"}, "cmdId": "cmd-9", "resolvedAt": "…"}],
 "commands": [{"cmdId": "cmd-9", "type": "command.respond", "agentId": "finder-a", "origin": {"kind": "human"},
               "text": null, "delivery": null, "requestId": "req-6", "status": "applied", "reason": null,
               "sentAt": "…", "ackAt": "…", "seq": 44}]}
```

- `pending`: open requests, by urgency (`high`, `normal`, `low`), then by `seq`. `recent`: the newest 50 closed requests, newest first. `commands`: the newest 100 commands, oldest first.
- `kind`: `approval` (a tool call wants permission), `question` (the agent asks something), `decision` (a choice about the work: plan, recovery, budget), `flag` (a checker found a problem that needs a ruling), `gate` (a stage checkpoint the design asked for). Other values are kept and treated like `question`.
- `subject`: what the request is about, `{"type": "tool_call" | "command" | "file_change" | "plan" | "claim" | "stage" | …, …}`.
- `options[].kind`: `allow_once`, `allow_always`, `reject_once`, `reject_always` or `choice`.
- `routeTo`: who sees it first: `human`, `lead` or an agent id. `resolver`: who may answer: `anyone`, `human_only` (not the Lead, not a policy) or `not_creator` (not the agent that asked).
- `onExpire`: one plain sentence saying what happens if nobody answers.
- `outcome`: `selected` (an option), `submitted` (free text or a form, in `payload`), `declined`, `cancelled`, `expired`, `superseded` (answered elsewhere, e.g. in the terminal) or `stale` (the thing it was about changed).
- `by`: `{"kind": "human" | "agent" | "policy" | "terminal" | "system", "id"?, "rule"?}`.
- Command `status`: `sent` (logged), `accepted` (the adapter has it), `applied` (it reached the session), `rejected` (`reason` says why, e.g. `already_resolved`, `not_allowed`, `no_session`), `unsupported` (this agent cannot take it) or `expired`.

### 2.7 `board` (0.2)

What the Lead assigned, how it judges progress, what reviewers decided, and what each agent has used.

```json
{"tasks": [{"taskId": "t1", "agentId": "finder-a", "title": "Search retailers", "brief": null, "from": "lead", "round": 1, "attempt": 1,
            "state": "working", "say": null, "outcome": null, "summary": null, "assignedAt": "…", "finishedAt": null}],
 "ledger": {"satisfied": false, "looping": false, "progressing": true, "next": "checker", "instruction": "Check the eBay offer",
            "reason": null, "plan": ["search", "check", "write"], "stalls": 0, "updated": "…"},
 "reviews": [{"reviewer": "checker", "target": "finder-a", "verdict": "revise", "round": 1, "note": null, "at": "…"}],
 "recoveries": [{"by": "lead", "strategy": "retry", "target": "finder-b", "note": null, "at": "…"}],
 "usage": {"finder-a": {"inputTokens": 1200, "outputTokens": 300, "costUsd": 0.05, "turns": 1, "limit": null, "updated": "…"}},
 "agents": {"finder-a": {"backend": "claude-code", "model": null, "session": {"backend": "claude-code", "id": "…"},
                         "accepts": ["message", "respond", "interrupt"], "reviewerOf": []}}}
```

- Task `state`: `assigned`, `working`, `blocked`, `review` or `done`; `outcome` (when done): `success`, `failed` or `cancelled`.
- `ledger` is the Lead's last progress check, or `null`.
- `usage` holds totals so far per agent; `limit` is what the backend reported about usage limits, e.g. `{"status": "allowed_warning", "resetsAt": "…", "kind": "five_hour"}`.
- `agents[id].session` says which official session runs the agent (never a credential); `accepts` lists the commands it takes (`message`, `respond`, `interrupt`, `assign`), and a viewer shows controls only for these.

### 2.8 `verification` (0.2)

Claims in the result, the evidence behind them and checker verdicts. Writers remove the file when a run has no claims and no checked evidence.

```json
{"claims": [{"claimId": "c1", "text": "Currys sells the XM6 for £279", "sources": ["currys-xm6"], "serves": "R1", "checkworthy": true,
             "author": "lead", "status": "supported",
             "verdicts": [{"by": "checker", "status": "supported", "sourceId": "currys-xm6", "relationship": "supports",
                           "method": null, "note": null, "backend": null, "at": "…"}]}],
 "evidence": [{"sourceId": "currys-xm6", "url": "https://…", "urlHealth": "live", "httpStatus": 200, "archivedUrl": null,
               "grade": "A", "quote": null, "note": null, "checkedBy": "checker", "at": "…"}],
 "summary": {"claims": 1, "checkworthy": 1, "supported": 1, "partial": 0, "contradicted": 0, "unknown": 0, "unchecked": 0,
             "sources": 1, "live": 1, "stale": 0, "hallucinated": 0, "blocked": 0, "uncited": 0}}
```

- Claim `status`: `unchecked`, `supported`, `partial`, `contradicted`, `unknown` or `not-checkworthy` (4.4, "Claim status").
- The evidence `grade` (A–D, what kind of source it is, as in 2.4) and a verdict's `relationship` (`supports`, `refutes`, `irrelevant`: how the source bears on the claim) are different things and are stored separately.
- `urlHealth`: `live`, `stale`, `hallucinated` (the page does not exist), `blocked` or `unknown`.

## 3. Events

### 3.1 Envelope

One JSON object per line in `<project>/mas/events.jsonl` (UTF-8, `\n`-terminated):

```json
{"v": "0.2", "seq": 5, "ts": "2026-11-06T10:00:05Z", "runId": "r1", "type": "handoff",
 "agentId": "finder-a", "agentName": "Retail finder", "parentId": "lead",
 "data": {"to": "checker"}, "raw": null, "trace": {"traceId": "…", "spanId": "…"}}
```

| Field | Required | Meaning |
|---|---|---|
| `v` | yes | protocol version, `"0.2"` for new producers. A reducer MUST accept any value. |
| `seq` | yes | integer ≥ 1, strictly increasing within one log. **The ordering key.** |
| `ts` | yes | ISO 8601 UTC. Informational; clocks may drift. |
| `type` | yes | see 3.2 |
| `runId` | no | id of the run this event belongs to |
| `agentId` | no | the agent instance; defaults to `lead` |
| `agentName` | no | display name, used when the agent is first registered |
| `parentId` | no | the agent that spawned this one |
| `data` | no | type-specific object (default `{}`) |
| `raw` | no | the source framework's original payload, untouched |
| `trace` | no | `traceId` / `spanId` for correlating with OpenTelemetry |

### 3.2 Event types

| `type` | `data` | AG-UI | OTel GenAI | A2A |
|---|---|---|---|---|
| `run.started` | `title?`, `structure?` | `RUN_STARTED` | workflow span start | — |
| `run.finished` | `say?` | `RUN_FINISHED` | workflow span end | — |
| `run.failed` | `reason?` | `RUN_ERROR` | span end + `error.type` | — |
| `stage.started` / `stage.finished` | `group` | `STEP_STARTED` / `STEP_FINISHED` | internal span | — |
| `agent.registered` | `name?`, `emoji?`, `job?`, `group?`, `handsTo?`, `role?`, `backend?`, `model?`, `session?` (object), `accepts?`, `reviewerOf?` (arrays of strings) | `SUBAGENT_STARTED` | `create_agent` | Agent Card subset |
| `agent.status` | **`state`**, `say?`, `progress?`, `to?`, `flag?`, `flagKind?`, `stopReason?` | `ACTIVITY_SNAPSHOT` | span attributes | `TaskStatusUpdateEvent` |
| `agent.finished` | `say?` | `SUBAGENT_FINISHED` | `invoke_agent` span end | `COMPLETED` |
| `agent.failed` | `reason?` | `SUBAGENT_ERROR` | span end + `error.type` | `FAILED` |
| `agent.stopped` | `reason?`, `scope?` (`turn` \| `agent`), `by?` | `CUSTOM` | span end | `CANCELED` |
| `handoff` | **`to`**, `say?`, `reason?` | `CUSTOM` | span link | `referenceTaskIds` |
| `message` | **`text`**, `to?` | `TEXT_MESSAGE_*` | `gen_ai.output.messages` | `Message` |
| `tool.started` | **`name`**, `say?`, `callId?` | `TOOL_CALL_START` | `execute_tool` span start | — |
| `tool.finished` / `tool.failed` | `name?`, `callId?`, `error?` | `TOOL_CALL_RESULT` | `execute_tool` span end | — |
| `flag.raised` | **`text`**, `kind?` | interrupt | — | `INPUT_REQUIRED` |
| `flag.resolved` | — | — | — | — |
| `artifact` | `kind`, and for `kind: "source"` a `source` object | `CUSTOM` | — | `TaskArtifactUpdateEvent` |
| `result` | `title?`, `markdown?`, `sources?`, `flags?`, `work?`, `round?`, `question?` | `RUN_FINISHED.result` | — | final `Artifact` |
| `round.started` | `round?`, `question?` | `CUSTOM` | — | — |
| `request.opened` | **`requestId`**, **`kind`**, **`title`**, `description?`, `subject?`, `toolCallId?`, `options?`, `responseSchema?`, `blocking?` (default `true`), `routeTo?`, `resolver?`, `urgency?`, `expiresAt?`, `onExpire?`, `source?` | `CUSTOM` `interrupt` (an `Interrupt`) | — | `INPUT_REQUIRED` |
| `request.resolved` | **`requestId`**, **`outcome`**, `optionId?`, `payload?`, `note?`, `by?`, `cmdId?` | `CUSTOM` `resume` (a `ResumeEntry`) | — | `Message` with `taskId` |
| `command.message` | **`cmdId`**, **`text`**, `delivery?` (`steer` \| `queue` \| `interrupt`), `intent?`, `origin?` | `CUSTOM` | — | `SendMessage` |
| `command.respond` | **`cmdId`**, **`requestId`**, **`outcome`**, `optionId?`, `payload?`, `note?`, `origin?` | `CUSTOM` | — | `Message` |
| `command.assign` | **`cmdId`**, **`title`**, `brief?`, `taskId?`, `handsTo?`, `origin?` | `CUSTOM` | — | `SendMessage` |
| `command.interrupt` | **`cmdId`**, `scope?`, `reason?`, `origin?` | `CUSTOM` | — | `CancelTask` |
| `command.ack` | **`cmdId`**, **`status`**, `reason?` | `CUSTOM` | — | — |
| `usage` | `inputTokens?`, `outputTokens?`, `costUsd?`, `turns?` (totals so far), `limit?` | `CUSTOM` | `gen_ai.usage.*` | — |
| `task.assigned` | **`taskId`**, **`title`**, `brief?`, `from?`, `round?`, `attempt?` | `ACTIVITY_SNAPSHOT` (`TASK`) | — | `Task` |
| `task.updated` | **`taskId`**, `state?` (`working` \| `blocked` \| `review`), `say?` | `ACTIVITY_SNAPSHOT` (`TASK`) | — | `TaskStatusUpdateEvent` |
| `task.finished` | **`taskId`**, `outcome?` (`success` \| `failed` \| `cancelled`), `summary?` | `ACTIVITY_SNAPSHOT` (`TASK`) | — | `COMPLETED` |
| `lead.ledger` | `satisfied?`, `looping?`, `progressing?`, `next?`, `instruction?`, `reason?`, `plan?`, `stalls?` | `CUSTOM` | — | — |
| `review.verdict` | **`target`**, **`verdict`** (`accept` \| `revise` \| `escalate`), `round?`, `note?` | `CUSTOM` | — | — |
| `recovery.chosen` | **`strategy`** (`retry` \| `reassign` \| `replan` \| `split` \| `ask-human`), `target?`, `note?` | `CUSTOM` | — | — |
| `claim.added` | **`claimId`**, **`text`**, `sources?`, `serves?`, `checkworthy?` | `CUSTOM` | — | — |
| `evidence.checked` | **`sourceId`**, `url?`, `urlHealth?`, `httpStatus?`, `archivedUrl?`, `grade?`, `quote?`, `note?` | `CUSTOM` | — | — |
| `verdict.recorded` | **`claimId`**, **`status`** (`supported` \| `partial` \| `contradicted` \| `unknown` \| `not-checkworthy`), `sourceId?`, `relationship?`, `method?`, `note?`, `backend?` | `CUSTOM` | — | — |
| `custom.<name>` | anything | `CUSTOM` | — | `metadata` |

Fields in **bold** are required for that type. Listed values in a bold field are the only values allowed; listed values in an optional field are the only ones the reducer keeps.

- `agentId` is the agent that asks (`request.opened`), the agent a command is addressed to (`command.*`), the worker (`task.*`), the Lead (`lead.ledger`, `recovery.chosen`), the reviewer (`review.verdict`), the claim's author (`claim.added`) or the checker (`evidence.checked`, `verdict.recorded`).
- `origin` (commands): `{"kind": "human" | "agent" | "policy", "id"?}`; missing means `{"kind": "agent", "id": "lead"}`. Only `mas-office serve` writes `kind: "human"`, for callers that present the UI token.
- **Intent and fact.** A `command.*` is intent and never changes an agent's status. Only what an adapter reports (`command.ack`, `agent.status`, `agent.stopped`, `request.resolved`) is fact. An accepted interrupt is not a stopped agent.
- `delivery`: `steer` reaches the agent at its next break point without stopping it, `queue` after the current turn, `interrupt` stops the turn first. Backends differ; the adapter says what it really did in `command.ack.reason`.

Conformance (after AG-UI): a producer MUST emit at least `run.started` and `agent.status`; a consumer MUST accept every type and MAY ignore types it does not know.

## 4. The reducer

The reducer is a pure function `reduce(lines) → {structure, statuses, state, result, inbox, board, verification}`. Both reference implementations (`packages/node`, `packages/python`) MUST produce identical output for every case in [`conformance/`](conformance/).

### 4.1 Reading the log

1. Split the file on `\n` only (not on other Unicode line separators) and parse each line as JSON exactly as written — only JSON whitespace (space, tab, CR) may surround it. Skip blank lines and lines that are not JSON objects.
2. **Drop invalid events**: missing `v`, `seq` (integer, 1 ≤ seq ≤ 2^53 − 1), `ts` (string) or `type` (string); a `data` that is present but not an object (including `null`); or a type whose required `data` fields (bold above, all strings, own properties of `data`) are missing or the wrong type; or a required field outside its listed values: `agent.status.state` (the seven states), `request.resolved.outcome`, `command.ack.status`, `review.verdict.verdict`, `recovery.chosen.strategy`, `verdict.recorded.status`. Dropped events have no effect at all.
3. Sort by `seq`, stable. If several events share a `seq`, keep the first in file order.
4. Apply events in that order. An `agentId` that is missing, empty or not a string means `lead`.

### 4.2 Defaults

- **Default structure** (before any `run.started` provides one): `{"title": "Untitled MAS", "version": 1, "locked": true, "topology": "dynamic", "lead": {"id": "lead", "name": "Lead", "emoji": "🧭", "job": "", "serves": []}, "groups": [], "roles": []}`.
- **Status shape**: every status has exactly `state, say, to, flag, flagKind, progress, t, waitingOn, stopReason`. A new status starts as `idle`, `say` `"Ready"`, `progress` 0, `waitingOn` `[]`, the rest `null`, `t` = the event's `ts`.
- **"Given"**: in the rules below, a `data` field whose value is `null` counts as not given (`??` semantics), and so does a field of the wrong type: `say`, `to`, `flag`, `flagKind`, `name`, `emoji`, `job`, `group`, `handsTo`, `role`, `reason`, `title`, `markdown`, `text` must be strings, `progress` a number, `work` / `sources` / `flags` arrays. The same applies to the envelope's `agentName` and `parentId`, and to fields read from a structure (e.g. a role whose `name` is `null` is displayed by its id).
- **Run phase**: the project is *running* between `run.started` and `run.finished` / `run.failed`.
- Whenever an event changes at least one field of a status, that status's `t` becomes the event's `ts`. An event that changes nothing (e.g. `flag.resolved` on an agent that is not flagged) leaves `t` alone.
- **`stopReason`** is set by `agent.stopped` (`"cancelled"`) and by an `agent.status` that gives `data.stopReason`. Any later event that changes the agent's `state` (different before and after the event) to `working`, `waiting` or `handoff` resets it to `null`, unless that event itself gives `stopReason`; so does `run.started`.
- **Run-scoped and kept state.** Requests, tasks, the ledger, reviews, recoveries, claims, evidence and the result belong to a run. Closed requests (`recent`), commands, `usage` and `agents` are kept across runs.
- `progress` values are rounded half-up to an integer — exactly like JavaScript `Math.round`: `n = floor(x)`, then `n + 1` if `x − n ≥ 0.5` — and clamped to 0–100.

### 4.3 Auto-registration

Before applying **any** valid event — including types that otherwise have no effect, such as `tool.finished` or `custom.*` — if `agentId` is not `lead` and is not in `structure.roles`, register it:

```json
{"id": "<agentId>", "name": "<data.name ?? agentName ?? agentId>", "emoji": "<data.emoji ?? 🤖>",
 "job": "<data.job ?? ''>", "serves": [], "tools": [], "group": "<data.group ?? 'dyn'>",
 "handsTo": "<data.handsTo ?? 'lead'>", "dynamic": true, "parent": "<parentId ?? 'lead'>"}
```

(`data.*` fields are only read from `agent.registered` events; `role` is copied when present.) If the role's group does not exist, append `{"id": <group>, "label": "Spawned at runtime" for "dyn" else "Group <group>", "after": <id of the last group in the array, or null>}`. The new agent's status is `waiting` / `"Waiting for my turn"` while running, otherwise `idle` / `"Ready"`.

`handoff.data.to`, when it names an unknown agent other than `lead`, registers that agent the same way, with `name` = its id and `parent` = the sender (the event's `agentName` describes the sender, not the target).

### 4.4 Event rules

| Event | Effect |
|---|---|
| `run.started` | Increment `run`, set `runId`. If `data.structure` is given, it **replaces** the structure, with `locked: true`, `version` defaulting to 1, `topology` defaulting to `staged`, `lead` defaulting to the default lead, `roles` to `[]` and `groups` to `[]` (roles are otherwise kept exactly as given), `title` defaulting to `data.title`, then `"Untitled MAS"`. Otherwise keep the current structure; if `data.title` is given and no structure was ever provided, set the title. Every role becomes `waiting` / `"Waiting for my turn"`, progress 0, `to`/`flag`/`flagKind` null. The lead becomes `working` / `"Planning the run"`, progress 0. When a structure replaces the old one, the statuses are rebuilt for the lead plus the new roles only (agents of the old structure disappear). Clear the run's collected sources and flags and the result. Phase: running. Also (0.2): every status gets `waitingOn` `[]` and `stopReason` `null`; every pending request moves to `recent` with outcome `cancelled`, `by` `{"kind": "system"}`, `resolvedAt` = ts; tasks, the ledger, reviews, recoveries, claims and evidence are cleared. |
| `agent.registered` | Registration (4.3); already-known agents are not re-registered. When at least one of `backend`, `model`, `session`, `accepts`, `reviewerOf` is given (known and unknown agents alike): `agents[id]` ← the given ones merged over the existing entry (start: `null`, arrays `[]`; arrays keep their string items). |
| `agent.status` | `state` ← `data.state`; `say` ← `data.say` if given; `progress` ← `data.progress` if given; `to` ← (state is `handoff`) ? `data.to` ?? previous `to` : null (an unknown `to` here is **not** registered — only `handoff` events register their target); `flag` ← (state is `flagged`) ? `data.flag` ?? previous `flag` : null; `flagKind` ← (state is `flagged`) ? `data.flagKind` ?? previous `flagKind` ?? `"concern"` : null. `stopReason` ← `data.stopReason` if given (4.2). |
| `agent.finished` | `done`, `say` ← `data.say` ?? `"Done"`, progress 100, `to`/`flag`/`flagKind` null. |
| `agent.failed` | `failed`, `say` ← `data.reason` ?? `"Failed"`, `flag` ← `data.reason` ?? null, `flagKind` `"error"`, `to` null. |
| `agent.stopped` | `scope` `turn` (default; any other value reads as `turn`): `idle`. `scope` `agent`: `done`, progress unchanged. Both: `say` ← `data.reason` ?? `"Stopped"`, `to`/`flag`/`flagKind` null, `stopReason` `"cancelled"`, `waitingOn` `[]`, and each of this agent's pending requests moves to `recent` with outcome `cancelled`, `by` ← `data.by` ?? `{"kind": "system"}`. |
| `handoff` | `handoff`, `to` ← `data.to`, `say` ← `data.say` ?? `"Handing over to <name of to>"`, `flag`/`flagKind` null. |
| `message` | `say` ← `data.text`. If the state was `idle` or `waiting`, it becomes `working`. |
| `tool.started` | `say` ← `data.say` ?? `"Using <data.name>"`. If the state was `idle` or `waiting`, it becomes `working`. |
| `flag.raised` | `flagged`, `flag` ← `data.text`, `flagKind` ← `data.kind` ?? `"concern"`, `to` null. Append `{by, kind, text}` to the run's flags. |
| `flag.resolved` | If `flagged`: `working`, `flag`/`flagKind` null. |
| `artifact` | If `data.kind` is `source` and `data.source.id` is a string: append the source with `foundBy` defaulting to `agentId`, unless a source with that id was already collected this run. |
| `result` | `result` ← `{title: data.title ?? "<structure.title> — run <run>", run, updated: ts, markdown: data.markdown ?? "", sources: collected sources then data.sources (only objects with a string `id`; deduplicated by id, first wins), flags: collected flags then data.flags (only objects), work: data.work (only objects) ?? []}`. **Rounds** (0.2): let `p` be the `round` of this run's previous result (0 when there is none, 1 when it has no `round`). `round` ← `data.round` when it is an integer (a number with an integral value) greater than `p`, otherwise `p + 1`; `question` ← `data.question` when given; `previous` ← the previous result's `previous` (or `[]`) with the previous result appended as `{round, question?, title, markdown, updated}`. A run's first result omits `round`, `question` and `previous` unless `data.round` or `data.question` is given (then `previous` is `[]`). |
| `round.started` | A follow-up round on the current run (0.2). If `run` is 0: no effect. Otherwise phase `running`; lead: `working`, `say` ← `"Working on your follow-up"`, progress 0, `to`/`flag`/`flagKind` null, `stopReason` null. Everything else is kept (result, collected sources and flags, tasks, claims, evidence, inbox, other statuses); the next `result` is the next round, and `run.finished` / `run.failed` end the round as they end a run. |
| `request.opened` | If `requestId` is pending or in `recent`: no effect. Otherwise add it to `pending` with the defaults of 2.6 (`options`: only objects with a string `optionId`; `urgency`: a listed value, else `normal`), `agentId`, `openedAt` = ts, `seq`, `run`. If `blocking`: append `requestId` to the agent's `waitingOn`; unless the agent is `done` or `failed`, also `flagged`, `flag` ← `title`, `flagKind` ← `needs_approval` for `kind` `approval`, else `needs_input`, `to` null. |
| `request.resolved` | If `requestId` is not pending: no effect (the first answer wins). Otherwise move it to the front of `recent` with `outcome`, `optionId`, `payload`, `note`, `by` (default `{"kind": "system"}`), `cmdId`, `resolvedAt` = ts, and keep the newest 50. Remove it from the **opener's** `waitingOn`. Then, only if the opener is `flagged` with `flagKind` `needs_approval` or `needs_input`: when `waitingOn` is now empty, `working`, `flag`/`flagKind` null; otherwise `flag` ← the title of the oldest remaining request and `flagKind` from its kind. |
| `command.message` / `command.respond` / `command.assign` / `command.interrupt` | No status change (auto-registration still applies). If `cmdId` is new, record `{cmdId, type, agentId, origin (default {"kind": "agent", "id": "lead"}), text (message: data.text; assign: data.title; else null), delivery (message: a listed value, else "steer"; else null), requestId (respond only, else null), status: "sent", reason: null, sentAt: ts, ackAt: null, seq}` and keep the newest 100. |
| `command.ack` | If `cmdId` is recorded and its `status` is not yet `applied`, `rejected`, `unsupported` or `expired`: `status` ← `data.status`, `reason` ← `data.reason` ?? null, `ackAt` ← ts. Otherwise no effect. |
| `usage` | `usage[id]` ← the given numbers (`inputTokens`, `outputTokens`, `costUsd`, `turns`) and `limit` (object) merged over the existing entry (start: numbers 0, `limit` null); `updated` ← ts. |
| `task.assigned` | New `taskId`: add `{taskId, agentId, title, brief, from (default "lead"), round (default 1), attempt (default 1), state: "assigned", say: null, outcome: null, summary: null, assignedAt: ts, finishedAt: null}`. Known: `title`, and `brief`, `round`, `attempt` when given; `state` `"assigned"`; `outcome`, `summary`, `finishedAt` null. No status change. |
| `task.updated` | Known task: `state` ← `data.state` if listed; `say` ← `data.say` if given. When `data.say` is given, the agent's status changes as for `message`. |
| `task.finished` | Known task: `state` `"done"`, `outcome` ← `data.outcome` if listed, else `"success"`; `summary` ← `data.summary` ?? null; `finishedAt` ← ts. No status change. |
| `lead.ledger` | `ledger` ← `{satisfied, looping, progressing, next, instruction, reason, plan, stalls, updated: ts}`: booleans, strings, `plan` (an array of strings only) and `stalls` (number) when given with the right type, otherwise null. |
| `review.verdict` | Append `{reviewer: agentId, target, verdict, round (default 1), note, at: ts}` to `reviews`. |
| `recovery.chosen` | Append `{by: agentId, strategy, target, note, at: ts}` to `recoveries`. |
| `claim.added` | New `claimId`: add `{claimId, text, sources (string items only, default []), serves, checkworthy (default true), author: agentId, status, verdicts: []}`. Known: `text`, and `sources`, `serves`, `checkworthy` when given. Recompute `status`. |
| `evidence.checked` | `evidence[sourceId]` ← the given `url`, `urlHealth` (listed values), `httpStatus`, `archivedUrl`, `grade` (`A`–`D`), `quote`, `note` merged over the existing entry (start: all null); `checkedBy` ← agentId; `at` ← ts. |
| `verdict.recorded` | Unknown `claimId`: no effect. Otherwise append `{by: agentId, status, sourceId, relationship (listed values), method, note, backend, at: ts}` to the claim's `verdicts` and recompute its `status`. |
| `run.finished` | Applies even without an earlier `run.started` (some frameworks emit unmatched end events). Lead: `done`, `say` ← `data.say` ?? `"Result ready"`, progress 100, `to`/`flag`/`flagKind` null. Phase `done`. Other agents are unchanged. Pending requests stay open (a final gate may outlive the run's last turn); producers close them. |
| `run.failed` | Lead: `failed`, `say` ← `data.reason` ?? `"Run failed"`, `flag` ← `data.reason` ?? null, `flagKind` `"error"`, `to` unchanged. Phase `failed`. |
| `stage.*`, `tool.finished`, `tool.failed`, `custom.*`, unknown | No effect on snapshots (they stay in the log). |

`lead` is a valid target for every agent event (e.g. a `message` from the lead).

**Claim status.** A claim that is not checkworthy is `not-checkworthy`. With no verdicts it is `unchecked`. Otherwise take the **last verdict of each distinct `by`**: if any is `contradicted`, the claim is `contradicted`; else if they disagree, `unknown`; else their shared status.

### 4.5 Output

- `structure`: as above.
- `statuses`: an object keyed by agent id, including `lead`, in registration order (lead first).
- `state`: `{"mode": "sdk", "step": 4, "phase": "running" | "done" | "failed", "locked": true, "version": structure.version, "run", "runId", "updated": ts of the last applied event, "next"}` where `next` is `"Watch the office panel — the team is working."`, `"Run finished — open the result."` or `"Run failed — see the Lead's desk."`. While running with `n` ≥ 1 pending requests whose `routeTo` is `"human"`, `next` is `"<n> things need you — open the inbox."` (`"1 thing needs you — open the inbox."` for one). Before any `run.started`, `phase` is `"locked"`, `run` is 0, `runId` is null and `next` is `"Waiting for the first run."`
- `result`: the last `result` of the current run, or `null`. When it is `null`, writers MUST remove `outputs/result.json` and `outputs/result.js` if they exist, so a viewer never shows the previous run's result as the current one.
- `inbox`: `{pending, recent, commands}`, ordered as in 2.6.
- `board`: `{tasks, ledger, reviews, recoveries, usage, agents}`; lists in insertion order, `usage` and `agents` keyed by agent id in first-seen order.
- `verification`: `null` when there are no claims and no evidence. Otherwise `{claims, evidence, summary}`, both lists in insertion order, where `summary` counts: `claims`; `checkworthy`; checkworthy claims by `status` (`supported`, `partial`, `contradicted`, `unknown`, `unchecked`); evidence entries (`sources`) and those by `urlHealth` (`live`, `stale`, `hallucinated`, `blocked`); and `uncited`, the evidence entries whose `sourceId` is in no claim's `sources`. When it is `null`, writers MUST remove `outputs/verification.json` and `.js`.

Writers then store these as `mas/structure`, `mas/status/<id>`, `mas/state`, `mas/inbox`, `mas/board`, `outputs/result` and `outputs/verification` (JSON + `.js` twin). A status file for an agent no longer in the structure MAY be left in place; the panel only reads ids in the structure. Writers MUST NOT write a status file for an id that does not match `^[a-z0-9][a-z0-9-]*$` (it could escape the folder).

## 5. Transport over HTTP (`mas-office serve`)

| Endpoint | Method | Body / response |
|---|---|---|
| `/v0/events?project=<folder>` | `POST` | one event object, a JSON array, or NDJSON. The server assigns `seq` (and `ts`, `v` when missing), appends to the log, re-runs the reducer, writes snapshots. Response `{"accepted": n, "lastSeq": n}`. `command.*` events other than `command.ack` are refused with `400` (use `/v0/commands`), and so is a `request.resolved` claiming `by.kind: "human"` without the UI token. |
| `/v0/commands?project=<folder>` | `POST` | One command, `{"type": "command.*", "agentId": "…", "data": {…}}`. Needs the UI token. The server sets `data.origin` to `{"kind": "human"}`, fills `data.cmdId` when missing, appends the event and routes it. `200 {"accepted": true, "cmdId", "seq"}`; `409` when the request it answers was already resolved. |
| `/v0/stream` | `GET` | Server-Sent Events. `event: change` with `data: {"path": "<changed file>"}` whenever a workspace file changes; `event: mas` with `id: <seq>` and `data: {"project": "<folder>", "event": {…}}` for each posted event (`seq` is per project). With `?project=<folder>&since=<seq>` or a `Last-Event-ID` header, the server first replays that project's logged events with a higher `seq`. |
| `/v0/health` | `GET` | `{"ok": true, "spec": "0.2"}` |
| `/office/` | `GET` | the panel |
| `/<path>` | `GET` | workspace files, read-only, never outside the workspace |

## 6. Mapping notes

- **AG-UI**: `mas-office export --ag-ui` maps types with the table in 3.2 and puts our original event in `rawEvent`. AG-UI 1.0 ends a run at an interrupt and answers it in the next run's input; our sessions are long-lived, so `request.opened` / `request.resolved` are exported as `CUSTOM` events named `interrupt` / `resume` whose value has the AG-UI `Interrupt` / `ResumeEntry` shape, and the "no new input while an interrupt is pending" rule is not adopted.
- **OpenTelemetry GenAI**: `agentName` ↔ `gen_ai.agent.name`, `agentId` ↔ `gen_ai.agent.id`, `tool.*.data.name` ↔ `gen_ai.tool.name`. The GenAI conventions are still in *Development* status; mappings may change in a minor version.
- **A2A**: status states map as in 2.2 (a blocking request reads as `INPUT_REQUIRED`); `result` maps to the final task artifact.
- **ACP**: `request.opened` ↔ `session/request_permission` and elicitation; `command.message` ↔ `session/prompt`; `command.interrupt` / `agent.stopped` ↔ `session/cancel`; `task.*` ↔ subagent updates.

Background and sources for these choices: [`docs/research/prior-art.md`](../docs/research/prior-art.md).
