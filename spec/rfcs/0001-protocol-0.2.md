# RFC 0001: Protocol 0.2 — requests, commands, tasks and verification

- Status: Accepted (implemented in `mas-office` 0.3.0)
- Spec version: 0.1 → **0.2** (additive)
- Background: `docs/research/landscape/05-protocols-hci.md` §A.4, `04-frameworks-research.md` §3.2–3.3

## Summary

Protocol 0.1 flows one way: agents report, the panel draws. 0.2 adds the other direction and the facts a supervisor needs:

1. **Requests**: everything that waits on a person has an id, options and a wait clock (`request.opened` / `request.resolved`).
2. **Commands**: what a person or the Lead asks of an agent, in the same log, with acknowledgements (`command.*`, `command.ack`).
3. **Tasks, ledger, reviews**: what the Lead assigned, how it judges progress, what a reviewer decided.
4. **Verification**: claims, evidence and verdicts as first-class events.
5. Three new snapshots: `mas/inbox`, `mas/board`, `outputs/verification`.

Everything is additive. A 0.1 log reduces to the same `structure`, `statuses`, `state` and `result` as before, apart from the two new status fields in §4.

## Design rules

- **Intent and fact are separate, in one log.** A `command.*` is intent. Only what an adapter reports (`command.ack`, `agent.status`, `agent.stopped`, `request.resolved`) is fact, and the reducer changes agent state on facts only. An accepted interrupt is not a stopped agent.
- **Every pending item has an id; every answer names the id.** The first `request.resolved` for an id wins. Later ones are ignored.
- **No new status states.** A 0.1 reducer drops an `agent.status` whose `state` it does not know.
- **Only the server writes `origin.kind: "human"`.** It does so for callers that present the UI token. Agents, including the Lead, are `agent`; deterministic rules are `policy`.

## 1. Envelope

Unchanged. `v` is `"0.2"` for new producers; a reducer MUST accept any `v`.

## 2. New event types

Fields in **bold** are required and must be strings unless noted. An event missing a required field is invalid and dropped (§4.1 rule 2 of the spec).

### 2.1 Requests

| `type` | `data` |
|---|---|
| `request.opened` | **`requestId`**, **`kind`**, **`title`**, `description?`, `subject?` (object), `toolCallId?`, `options?` (array), `responseSchema?` (object), `blocking?` (boolean, default `true`), `routeTo?` (default `"human"`), `resolver?` (default `"anyone"`), `urgency?` (default `"normal"`), `expiresAt?`, `onExpire?`, `source?` (object) |
| `request.resolved` | **`requestId`**, **`outcome`**, `optionId?`, `payload?` (any JSON), `note?`, `by?` (object), `cmdId?` |

- `kind`: `approval` (a tool call wants permission), `question` (the agent asks something), `decision` (a choice about the work: plan, recovery, budget), `flag` (a checker or verifier found a problem that needs a ruling), `gate` (a stage checkpoint the design asked for). Other values are kept as given and treated like `question`.
- `subject`: what the request is about. `{"type": "tool_call" | "command" | "file_change" | "plan" | "claim" | "stage" | …, …}`. Unknown types are kept untouched.
- `options[]`: `{"optionId": string, "name": string, "kind": "allow_once" | "allow_always" | "reject_once" | "reject_always" | "choice"}`. Items that are not objects with a string `optionId` are dropped.
- `routeTo`: `human`, `lead` or an agent id: who sees it first. `resolver`: `anyone`, `human_only` (the Lead and policies may not answer) or `not_creator` (the agent that opened it may not answer).
- `urgency`: `low | normal | high`. Any other value reads as `normal`.
- `onExpire`: one plain sentence saying what happens if nobody answers (shown as "if you don't answer").
- `outcome`: `selected` (an option), `submitted` (free text or a form in `payload`), `declined`, `cancelled`, `expired`, `superseded` (answered somewhere else, e.g. in the terminal), `stale` (the thing it was about changed).
- `by`: `{"kind": "human" | "agent" | "policy" | "terminal" | "system", "id"?: string, "rule"?: string}`.

### 2.2 Commands

| `type` | `data` |
|---|---|
| `command.message` | **`cmdId`**, **`text`**, `delivery?` (`steer` \| `queue` \| `interrupt`, default `steer`), `intent?` (`add` \| `revise` \| `retract`), `origin?` |
| `command.respond` | **`cmdId`**, **`requestId`**, **`outcome`**, `optionId?`, `payload?`, `note?`, `origin?` |
| `command.assign` | **`cmdId`**, **`title`**, `brief?`, `taskId?`, `handsTo?`, `origin?` |
| `command.interrupt` | **`cmdId`**, `scope?` (`turn` \| `agent`, default `turn`), `reason?`, `origin?` |
| `command.ack` | **`cmdId`**, **`status`** (`accepted` \| `applied` \| `rejected` \| `unsupported` \| `expired`), `reason?` |

- `agentId` on a command is the agent it is addressed to.
- `origin`: `{"kind": "human" | "agent" | "policy", "id"?: string}`. Missing means `{"kind": "agent", "id": "lead"}`.
- `delivery`: `steer` = at the agent's next break point without stopping it; `queue` = after the current turn; `interrupt` = stop the turn, then deliver. Backends differ; the adapter says what it really did in `command.ack.reason`.
- `status`: `accepted` = the adapter has it; `applied` = it reached the session (the message was delivered, the answer was handed to the tool call, the turn stopped); `rejected` = refused (`reason` says why, e.g. `already_resolved`, `not_allowed`, `no_session`); `unsupported` = this agent cannot take that command; `expired` = it waited too long.

### 2.3 Lifecycle additions

| `type` | `data` |
|---|---|
| `agent.stopped` | `reason?`, `scope?` (`turn` \| `agent`, default `turn`), `by?` |
| `agent.registered` | 0.1 fields plus `backend?`, `model?`, `session?` (object), `accepts?` (array of strings), `reviewerOf?` (array of strings) |
| `agent.status` | 0.1 fields plus `stopReason?` |
| `usage` | `inputTokens?`, `outputTokens?`, `costUsd?`, `turns?` (numbers, **totals so far** for this agent), `limit?` (object) |

- `session`: `{"backend": "claude-code" | "codex" | …, "id": string, "resumable"?: boolean, "attach"?: string}`. Never a credential.
- `accepts`: which commands the agent takes: `message`, `respond`, `interrupt`, `assign`. A viewer shows controls only for these.
- `limit`: what the backend reported about usage limits, e.g. `{"status": "allowed_warning", "resetsAt": "…", "kind": "five_hour"}`.

### 2.4 Tasks, ledger, reviews

| `type` | `data` |
|---|---|
| `task.assigned` | **`taskId`**, **`title`**, `brief?`, `from?` (default `lead`), `round?` (number, default 1), `attempt?` (number, default 1) |
| `task.updated` | **`taskId`**, `state?` (`working` \| `blocked` \| `review`), `say?` |
| `task.finished` | **`taskId`**, `outcome?` (`success` \| `failed` \| `cancelled`, default `success`), `summary?` |
| `lead.ledger` | `satisfied?`, `looping?`, `progressing?` (booleans), `next?`, `instruction?`, `reason?`, `plan?` (array of strings), `stalls?` (number) |
| `review.verdict` | **`target`**, **`verdict`** (`accept` \| `revise` \| `escalate`), `round?` (number, default 1), `note?` |
| `recovery.chosen` | **`strategy`** (`retry` \| `reassign` \| `replan` \| `split` \| `ask-human`), `target?`, `note?` |

`agentId` is the worker for `task.*`, the Lead for `lead.ledger` and `recovery.chosen`, the reviewer for `review.verdict`.

### 2.5 Verification

| `type` | `data` |
|---|---|
| `claim.added` | **`claimId`**, **`text`**, `sources?` (array of source ids), `serves?`, `checkworthy?` (boolean, default `true`) |
| `evidence.checked` | **`sourceId`**, `url?`, `urlHealth?` (`live` \| `stale` \| `hallucinated` \| `blocked` \| `unknown`), `httpStatus?` (number), `archivedUrl?`, `grade?` (`A`–`D`), `quote?`, `note?` |
| `verdict.recorded` | **`claimId`**, **`status`** (`supported` \| `partial` \| `contradicted` \| `unknown` \| `not-checkworthy`), `sourceId?`, `relationship?` (`supports` \| `refutes` \| `irrelevant`), `method?`, `note?`, `backend?` |

The evidence **grade** (A–D, what kind of source it is) and the **verdict** (how the source relates to the claim) are different things and are stored separately.

In a result's markdown, a statement may be wrapped as `<claim id="c3" src="currys-xm6,ebay-xm6">…</claim>`. The tag marks the span; viewers strip it and may highlight the span by verdict. `src` lists source ids.

### 2.6 Result rounds

`result.data` gains `round?` (integer ≥ 1) and `question?`. The reducer now builds `previous` (§4.3).

| `type` | `data` |
|---|---|
| `round.started` | `round?` (number), `question?` (string) |

`round.started` (from the Lead) opens a follow-up round on the current run's result. It is not a new run: everything the run collected stays, and the next `result` becomes the next round.

## 3. New snapshots

| Document | Global | Content |
|---|---|---|
| `mas/inbox` | `window.MAS_INBOX` | `{"pending": Request[], "recent": Request[], "commands": Command[]}` |
| `mas/board` | `window.MAS_BOARD` | `{"tasks": Task[], "ledger": Ledger \| null, "reviews": Review[], "recoveries": Recovery[], "usage": {agentId: Usage}, "agents": {agentId: AgentInfo}}` |
| `outputs/verification` | `window.MAS_VERIFICATION` | `{"claims": Claim[], "evidence": Evidence[], "summary": Summary}` or `null` (file removed) when the run has no claims and no checked evidence |

```jsonc
// Request (pending)
{"requestId": "req_7", "agentId": "finder-a", "kind": "approval", "title": "Open currys.co.uk in the browser?",
 "description": null, "subject": null, "toolCallId": null, "options": [], "responseSchema": null,
 "blocking": true, "routeTo": "human", "resolver": "anyone", "urgency": "normal",
 "expiresAt": null, "onExpire": null, "source": null, "openedAt": "<ts>", "seq": 41, "run": 1}
// Request (recent) = the same plus
{"outcome": "selected", "optionId": "allow-once", "payload": null, "note": null,
 "by": {"kind": "human"}, "cmdId": "cmd_9", "resolvedAt": "<ts>"}
// Command
{"cmdId": "cmd_9", "type": "command.respond", "agentId": "finder-a", "origin": {"kind": "human"},
 "text": null, "delivery": null, "requestId": "req_7", "status": "applied", "reason": null,
 "sentAt": "<ts>", "ackAt": "<ts>", "seq": 44}
// Task
{"taskId": "t1", "agentId": "finder-a", "title": "…", "brief": null, "from": "lead", "round": 1, "attempt": 1,
 "state": "working", "say": null, "outcome": null, "summary": null, "assignedAt": "<ts>", "finishedAt": null}
// Ledger = the data of the last lead.ledger (only the fields listed in 2.4, missing ones null) plus "updated": "<ts>"
// Review
{"reviewer": "checker", "target": "finder-a", "verdict": "revise", "round": 1, "note": null, "at": "<ts>"}
// Recovery
{"by": "lead", "strategy": "retry", "target": "finder-a", "note": null, "at": "<ts>"}
// Usage
{"inputTokens": 0, "outputTokens": 0, "costUsd": 0, "turns": 0, "limit": null, "updated": "<ts>"}
// AgentInfo (from agent.registered; null / [] when never given)
{"backend": "claude-code", "model": null, "session": null, "accepts": [], "reviewerOf": []}
// Claim
{"claimId": "c1", "text": "…", "sources": ["currys-xm6"], "serves": null, "checkworthy": true, "author": "lead",
 "status": "supported", "verdicts": [{"by": "checker", "status": "supported", "sourceId": "currys-xm6",
   "relationship": "supports", "method": null, "note": null, "backend": null, "at": "<ts>"}]}
// Evidence
{"sourceId": "currys-xm6", "url": "https://…", "urlHealth": "live", "httpStatus": 200, "archivedUrl": null,
 "grade": "A", "quote": null, "note": null, "checkedBy": "lead", "at": "<ts>"}
// Summary
{"claims": 4, "checkworthy": 4, "supported": 2, "partial": 1, "contradicted": 0, "unknown": 1, "unchecked": 0,
 "sources": 3, "live": 2, "stale": 0, "hallucinated": 1, "blocked": 0, "uncited": 1}
```

## 4. Reducer rules

All 0.1 rules stand. "Given" has its 0.1 meaning (null or wrong type = not given). New state: `pending` (ordered map by `requestId`), `recent` (list), `commands` (ordered map by `cmdId`), `tasks` (ordered map by `taskId`), `ledger`, `reviews`, `recoveries`, `usage`, `agents`, `claims` (ordered map), `evidence` (ordered map by `sourceId`).

### 4.1 Validation additions

An event is invalid, and dropped, when a required field from §2 is missing or not a string. `command.ack.status`, `review.verdict.verdict`, `recovery.chosen.strategy`, `verdict.recorded.status` and `request.resolved.outcome` must also be one of their listed values.

### 4.2 Status shape

Every status has two more fields: `waitingOn` (array of request ids, `[]` by default) and `stopReason` (`null` by default). A change to either moves `t`.

`stopReason` is set by `agent.stopped` (`"cancelled"`) and by an `agent.status` that gives `data.stopReason`. It is reset to `null` by any later event that changes the agent's `state` (different before and after the event) to `working`, `waiting` or `handoff`, unless that event itself gives `stopReason`, and by `run.started`.

### 4.3 Event rules

| Event | Effect |
|---|---|
| `run.started` | 0.1 effect. Also: every pending request moves to `recent` with outcome `cancelled`, `by: {"kind": "system"}`, `resolvedAt` = ts. `tasks`, `ledger`, `reviews`, `recoveries`, `claims` and `evidence` are cleared. `usage`, `commands` and `agents` are kept. Every status gets `waitingOn: []`, `stopReason: null`. The previous run's result rounds are discarded. |
| `request.opened` | If `requestId` is already pending or in `recent`: no effect. Otherwise add to `pending` with the defaults of §2.1, `openedAt` = ts, `seq`, `run`. If `blocking`: the agent's status becomes `flagged`, `flag` ← `title`, `flagKind` ← `needs_approval` when `kind` is `approval`, otherwise `needs_input`, `to` null, and `requestId` is appended to `waitingOn`. A `failed` or `done` agent's `state`, `flag` and `flagKind` are left alone (only `waitingOn` changes). |
| `request.resolved` | If `requestId` is not pending: no effect. Otherwise move it to the front of `recent` with `outcome`, `optionId`, `payload`, `note`, `by` (default `{"kind": "system"}`), `cmdId`, `resolvedAt` = ts; keep the newest 50. Remove the id from the **opener's** `waitingOn`. Then, only if the opener is `flagged` with `flagKind` `needs_approval` or `needs_input`: when `waitingOn` is now empty, state `working`, `flag`/`flagKind` null; when other blocking requests remain, `flag` ← title of the oldest remaining one, `flagKind` from its kind. |
| `command.message` / `respond` / `assign` / `interrupt` | No change to any status (auto-registration of an unknown `agentId` still applies, as for every event). If `cmdId` is new: record `{cmdId, type, agentId, origin (default {"kind":"agent","id":"lead"}), text (message: data.text; assign: data.title; else null), delivery (message only: a listed value, else "steer"; null for the others), requestId (respond only; else null), status: "sent", reason: null, sentAt: ts, ackAt: null, seq}`. Keep the newest 100 commands. |
| `command.ack` | If `cmdId` is known: `status` ← `data.status`, `reason` ← `data.reason` ?? null, `ackAt` ← ts. Once a command is `applied`, `rejected`, `unsupported` or `expired`, later acks are ignored. Unknown `cmdId`: no effect. |
| `agent.stopped` | `scope` `turn` (default): state `idle`, `say` ← `data.reason` ?? `"Stopped"`. `scope` `agent`: state `done`, `say` ← `data.reason` ?? `"Stopped"`, progress unchanged. Both: `to`/`flag`/`flagKind` null, `stopReason` `"cancelled"`, `waitingOn` `[]`, and each of this agent's pending requests moves to `recent` with outcome `cancelled`, `by` ← `data.by` ?? `{"kind":"system"}`. |
| `agent.registered` | 0.1 effect (registers unknown agents only). Also, for known and unknown agents alike, when at least one of `backend`, `model`, `session`, `accepts`, `reviewerOf` is given: `agents[id]` ← merge of the given ones over the existing entry (start: `null`, arrays `[]`; arrays keep their string items). |
| `agent.status` | 0.1 effect, plus `stopReason` per §4.2. |
| `usage` | `usage[id]` ← merge of the given numeric fields and `limit` over the existing entry (start: all 0, `limit` null); `updated` ← ts. |
| `task.assigned` | If `taskId` is new: add `{taskId, agentId, title, brief, from (default "lead"), round (default 1), attempt (default 1), state: "assigned", say: null, outcome: null, summary: null, assignedAt: ts, finishedAt: null}`. Known `taskId`: update `title`, `brief`, `round`, `attempt` when given, set `state` `"assigned"`, clear `outcome`, `summary`, `finishedAt`. No status change. |
| `task.updated` | Known task: `state` ← `data.state` if given and listed; `say` ← `data.say` if given. If `data.say` is given, the agent's status `say` ← it as well (state rule as for `message`: `idle`/`waiting` become `working`). Unknown task: only the status effect. |
| `task.finished` | Known task: `state` ← `"done"`, `outcome` ← `data.outcome` if listed, else `"success"`; `summary` ← `data.summary` ?? null; `finishedAt` ← ts. No status change. |
| `lead.ledger` | `ledger` ← `{satisfied, looping, progressing, next, instruction, reason, plan, stalls, updated: ts}`; booleans, strings, `plan` (an array whose items are all strings) and `stalls` (number) when given with the right type, otherwise `null`. |
| `review.verdict` | Append `{reviewer: agentId, target, verdict, round (default 1), note, at: ts}` to `reviews`. |
| `recovery.chosen` | Append `{by: agentId, strategy, target, note, at: ts}` to `recoveries`. |
| `claim.added` | New `claimId`: add `{claimId, text, sources (strings only, default []), serves, checkworthy (default true), author: agentId, status: checkworthy ? "unchecked" : "not-checkworthy", verdicts: []}`. Known: update `text`, `sources`, `serves`, `checkworthy` when given; recompute `status`. |
| `evidence.checked` | `evidence[sourceId]` ← merge of the given `url`, `urlHealth` (listed values only), `httpStatus`, `archivedUrl`, `grade` (`A`–`D` only), `quote`, `note` over the existing entry (start: all null); `checkedBy` ← agentId; `at` ← ts. |
| `verdict.recorded` | Unknown `claimId`: no effect. Otherwise append `{by: agentId, status, sourceId, relationship (listed values only), method, note, backend, at: ts}` to the claim's `verdicts` and recompute `status`. |
| `result` | 0.1 effect, plus rounds. Let `p` be the `round` of this run's previous result (0 when there is none; 1 when that result has no `round`). `round` ← `data.round` when it is an integer greater than `p`, otherwise `p + 1`; `question` ← `data.question` when given. `previous` is the earlier result's own `previous` (or `[]`) with that earlier result appended as `{round, question?, title, markdown, updated}`; a run's first result that carries `round` has `previous: []`. "Integer" means a JSON number with an integral value. `round`, `question` and `previous` are **omitted** from a run's first result when `data.round` and `data.question` are not given, so 0.1 logs keep their 0.1 result. |
| `round.started` | If no run was ever started (`run` is 0): no effect (auto-registration still applies). Otherwise phase `running`; the lead's status becomes `working`, `say` ← `"Working on your follow-up"`, progress 0, `to`/`flag`/`flagKind` null, `stopReason` null. Nothing else changes: the result, collected sources and flags, tasks, claims, evidence, the inbox and the other agents' statuses are kept. A later `result` is the next round (above); `run.finished` / `run.failed` end the round as they end a run. |

**Claim status.** A claim that is not checkworthy is `not-checkworthy`. With no verdicts it is `unchecked`. Otherwise look at the **last verdict from each distinct `by`**: any `contradicted` → `contradicted`; else if they disagree (not all the same status) → `unknown`; else that shared status.

**Run phase.** `run.finished` and `run.failed` do not resolve pending requests (a final gate may outlive the run's last turn). Producers close them.

### 4.4 Output

`reduce(lines) → {structure, statuses, state, result, inbox, board, verification}`.

- `inbox.pending` is sorted by urgency (`high`, `normal`, `low`), then by `seq`. `inbox.recent` is newest first. `inbox.commands` is oldest first.
- `board.tasks`, `reviews`, `recoveries` are in insertion order; `usage` and `agents` are keyed by agent id in first-seen order.
- `verification` is `null` when there are no claims and no evidence. Otherwise `claims` and `evidence` are in insertion order and `summary` is:
  - `claims`: number of claims; `checkworthy`: those with `checkworthy` true;
  - `supported`, `partial`, `contradicted`, `unknown`, `unchecked`: checkworthy claims by `status`;
  - `sources`: number of evidence entries; `live`, `stale`, `hallucinated`, `blocked`: evidence by `urlHealth`;
  - `uncited`: evidence entries whose `sourceId` appears in no claim's `sources`.
- `state.next` gains one case: while the phase is `running` and at least one pending request has `routeTo` `"human"`, `next` is `"<n> things need you — open the inbox."`, where `n` counts those requests (`"1 thing needs you — open the inbox."` for one).

Writers store `mas/inbox`, `mas/board` and `outputs/verification` like the other snapshots (JSON + `.js` twin). When `verification` is `null`, writers remove `outputs/verification.json` and `.js`.

## 5. Transport

`mas-office serve` gains (see `docs/design/runtime.md` for the full API):

| Endpoint | Method | Purpose |
|---|---|---|
| `/v0/commands?project=<folder>` | `POST` | One command: `{"type": "command.*", "agentId": "…", "data": {…}}`. Needs the UI token. The server sets `data.origin` to `{"kind": "human"}`, fills `data.cmdId` when missing, appends it, routes it. `200 {"accepted": true, "cmdId", "seq"}`; `409` when the request was already resolved. |
| `/v0/stream?project=<folder>&since=<seq>` | `GET` | As 0.1, plus replay: with `since` or a `Last-Event-ID` header, the server first sends that project's logged events with a higher `seq`. |
| `/v0/events` | `POST` | As 0.1, except: `command.*` (other than `command.ack`) is refused with `400` (use `/v0/commands`), and a `request.resolved` claiming `by.kind: "human"` without the token is refused. |

## 6. Mappings

| MAS Office 0.2 | AG-UI 1.0 | A2A 1.0 | ACP |
|---|---|---|---|
| `request.opened` | `Interrupt` | `TaskStatusUpdateEvent{INPUT_REQUIRED}` | `session/request_permission`, elicitation |
| `request.resolved` | `resume[]{interruptId, status, payload}` | `Message` with `taskId` | permission / elicitation response |
| `command.message` | new `RunAgentInput.messages` | `SendMessage` | `session/prompt` |
| `command.interrupt` / `agent.stopped` | `RUN_FINISHED{outcome: cancelled}` | `CancelTask` / `CANCELED` | `session/cancel` |
| `task.*` | `ACTIVITY_SNAPSHOT{activityType: "TASK"}` | `Task` | subagent update |

## 7. Conformance cases

New cases 09–16 cover: request lifecycle and `waitingOn`; duplicate and late answers; commands and acks; `agent.stopped` in both scopes; tasks, ledger and reviews; claims, evidence, verdict merging and the summary; result rounds; a new run clearing run-scoped state. Cases 01–08 gain the new status fields and the new empty snapshots in `expected.json`; nothing else in them changes.

## Drawbacks and alternatives

- **Dual-emitting `flag.raised` for 0.1 viewers** was considered and dropped: viewers read snapshots, and the 0.2 reducer already turns a blocking request into a `flagged` status that a 0.1 panel draws.
- **A separate command log** would keep `events.jsonl` to facts only, but two logs cannot be replayed in one order. One log, with the rule that commands never change agent state, keeps replay and audit simple.
- **AG-UI's "a run ends at an interrupt"** does not fit long-lived sessions, and its "block new input while an interrupt is pending" conflicts with steering an agent while an approval waits. Neither is adopted.
