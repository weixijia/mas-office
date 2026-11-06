# MAS Office Protocol — version 0.1

Status: **Draft**. Spec versions are `Major.Minor`; packages follow semver separately. Breaking changes go through an RFC (see [`rfcs/`](rfcs/)).

The protocol lets any multi-agent system — a framework run, an SDK script, or a coding assistant following `AGENTS.md` — show its team in the MAS Office panel. It has three layers:

| Layer | What it is | Who writes it |
|---|---|---|
| **Workspace layout** | Folders and file names the panel reads | everyone |
| **Snapshots** | `structure`, `status`, `state`, `result` documents (JSON, plus a `.js` twin for `file://`) | hand-written by an assistant, **or** derived by the reducer |
| **Events** | An append-only `mas/events.jsonl` log; a deterministic reducer turns it into snapshots | SDKs, integrations, `mas-office serve` |

A producer can work at either level. The AGENTS.md kit writes snapshots by hand; SDKs emit events and let the reducer write snapshots. The panel only ever reads snapshots.

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
    mas/events.jsonl                   optional: the event log (source of truth when present)
    outputs/result.json (+ .js)        the final answer
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
{"state": "working", "say": "Searching Currys…", "to": null, "flag": null, "flagKind": null, "progress": 40, "t": "2026-11-06T10:00:02Z"}
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

`markdown` and `work[].summary` may use headings, lists, tables, bold, italics, code and links only. `evidence`: `A` can be bought or run · `B` study with data · `C` demo or marketing · `D` opinion.

### 2.5 `home/projects`

```json
{"current": "headphone-deals", "projects": [{"folder": "headphone-deals", "title": "Headphone deals", "step": 4, "phase": "done", "agents": 4, "runs": 1}]}
```

`current: null` makes the panel show the list of projects.

## 3. Events

### 3.1 Envelope

One JSON object per line in `<project>/mas/events.jsonl` (UTF-8, `\n`-terminated):

```json
{"v": "0.1", "seq": 5, "ts": "2026-11-06T10:00:05Z", "runId": "r1", "type": "handoff",
 "agentId": "finder-a", "agentName": "Retail finder", "parentId": "lead",
 "data": {"to": "checker"}, "raw": null, "trace": {"traceId": "…", "spanId": "…"}}
```

| Field | Required | Meaning |
|---|---|---|
| `v` | yes | protocol version, `"0.1"` |
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
| `agent.registered` | `name?`, `emoji?`, `job?`, `group?`, `handsTo?`, `role?` | `SUBAGENT_STARTED` | `create_agent` | Agent Card subset |
| `agent.status` | **`state`**, `say?`, `progress?`, `to?`, `flag?`, `flagKind?` | `ACTIVITY_SNAPSHOT` | span attributes | `TaskStatusUpdateEvent` |
| `agent.finished` | `say?` | `SUBAGENT_FINISHED` | `invoke_agent` span end | `COMPLETED` |
| `agent.failed` | `reason?` | `SUBAGENT_ERROR` | span end + `error.type` | `FAILED` |
| `handoff` | **`to`**, `say?`, `reason?` | `CUSTOM` | span link | `referenceTaskIds` |
| `message` | **`text`**, `to?` | `TEXT_MESSAGE_*` | `gen_ai.output.messages` | `Message` |
| `tool.started` | **`name`**, `say?`, `callId?` | `TOOL_CALL_START` | `execute_tool` span start | — |
| `tool.finished` / `tool.failed` | `name?`, `callId?`, `error?` | `TOOL_CALL_RESULT` | `execute_tool` span end | — |
| `flag.raised` | **`text`**, `kind?` | interrupt | — | `INPUT_REQUIRED` |
| `flag.resolved` | — | — | — | — |
| `artifact` | `kind`, and for `kind: "source"` a `source` object | `CUSTOM` | — | `TaskArtifactUpdateEvent` |
| `result` | `title?`, `markdown?`, `sources?`, `flags?`, `work?` | `RUN_FINISHED.result` | — | final `Artifact` |
| `custom.<name>` | anything | `CUSTOM` | — | `metadata` |

Fields in **bold** are required for that type.

Conformance (after AG-UI): a producer MUST emit at least `run.started` and `agent.status`; a consumer MUST accept every type and MAY ignore types it does not know.

## 4. The reducer

The reducer is a pure function `reduce(lines) → {structure, statuses, state, result}`. Both reference implementations (`packages/node`, `packages/python`) MUST produce identical output for every case in [`conformance/`](conformance/).

### 4.1 Reading the log

1. Split the file on `\n` only (not on other Unicode line separators) and parse each line as JSON exactly as written — only JSON whitespace (space, tab, CR) may surround it. Skip blank lines and lines that are not JSON objects.
2. **Drop invalid events**: missing `v`, `seq` (integer, 1 ≤ seq ≤ 2^53 − 1), `ts` (string) or `type` (string); a `data` that is present but not an object (including `null`); or a type whose required `data` field (bold above) is missing or the wrong type; or an `agent.status` whose `state` is not one of the seven states. Dropped events have no effect at all.
3. Sort by `seq`, stable. If several events share a `seq`, keep the first in file order.
4. Apply events in that order. An `agentId` that is missing, empty or not a string means `lead`.

### 4.2 Defaults

- **Default structure** (before any `run.started` provides one): `{"title": "Untitled MAS", "version": 1, "locked": true, "topology": "dynamic", "lead": {"id": "lead", "name": "Lead", "emoji": "🧭", "job": "", "serves": []}, "groups": [], "roles": []}`.
- **Status shape**: every status has exactly `state, say, to, flag, flagKind, progress, t`. A new status starts as `idle`, `say` `"Ready"`, `progress` 0, the rest `null`, `t` = the event's `ts`.
- **"Given"**: in the rules below, a `data` field whose value is `null` counts as not given (`??` semantics), and so does a field of the wrong type: `say`, `to`, `flag`, `flagKind`, `name`, `emoji`, `job`, `group`, `handsTo`, `role`, `reason`, `title`, `markdown`, `text` must be strings, `progress` a number, `work` / `sources` / `flags` arrays. The same applies to the envelope's `agentName` and `parentId`, and to fields read from a structure (e.g. a role whose `name` is `null` is displayed by its id).
- **Run phase**: the project is *running* between `run.started` and `run.finished` / `run.failed`.
- Whenever an event changes at least one field of a status, that status's `t` becomes the event's `ts`. An event that changes nothing (e.g. `flag.resolved` on an agent that is not flagged) leaves `t` alone.
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
| `run.started` | Increment `run`, set `runId`. If `data.structure` is given, it **replaces** the structure, with `locked: true`, `version` defaulting to 1, `topology` defaulting to `staged`, `lead` defaulting to the default lead, `roles` to `[]` and `groups` to `[]` (roles are otherwise kept exactly as given), `title` defaulting to `data.title`, then `"Untitled MAS"`. Otherwise keep the current structure; if `data.title` is given and no structure was ever provided, set the title. Every role becomes `waiting` / `"Waiting for my turn"`, progress 0, `to`/`flag`/`flagKind` null. The lead becomes `working` / `"Planning the run"`, progress 0. When a structure replaces the old one, the statuses are rebuilt for the lead plus the new roles only (agents of the old structure disappear). Clear the run's collected sources and flags and the result. Phase: running. |
| `agent.registered` | Registration only (4.3). Already-known agents are unchanged. |
| `agent.status` | `state` ← `data.state`; `say` ← `data.say` if given; `progress` ← `data.progress` if given; `to` ← (state is `handoff`) ? `data.to` ?? previous `to` : null (an unknown `to` here is **not** registered — only `handoff` events register their target); `flag` ← (state is `flagged`) ? `data.flag` ?? previous `flag` : null; `flagKind` ← (state is `flagged`) ? `data.flagKind` ?? previous `flagKind` ?? `"concern"` : null. |
| `agent.finished` | `done`, `say` ← `data.say` ?? `"Done"`, progress 100, `to`/`flag`/`flagKind` null. |
| `agent.failed` | `failed`, `say` ← `data.reason` ?? `"Failed"`, `flag` ← `data.reason` ?? null, `flagKind` `"error"`, `to` null. |
| `handoff` | `handoff`, `to` ← `data.to`, `say` ← `data.say` ?? `"Handing over to <name of to>"`, `flag`/`flagKind` null. |
| `message` | `say` ← `data.text`. If the state was `idle` or `waiting`, it becomes `working`. |
| `tool.started` | `say` ← `data.say` ?? `"Using <data.name>"`. If the state was `idle` or `waiting`, it becomes `working`. |
| `flag.raised` | `flagged`, `flag` ← `data.text`, `flagKind` ← `data.kind` ?? `"concern"`, `to` null. Append `{by, kind, text}` to the run's flags. |
| `flag.resolved` | If `flagged`: `working`, `flag`/`flagKind` null. |
| `artifact` | If `data.kind` is `source` and `data.source.id` is a string: append the source with `foundBy` defaulting to `agentId`, unless a source with that id was already collected this run. |
| `result` | `result` ← `{title: data.title ?? "<structure.title> — run <run>", run, updated: ts, markdown: data.markdown ?? "", sources: collected sources then data.sources (only objects with a string `id`; deduplicated by id, first wins), flags: collected flags then data.flags (only objects), work: data.work (only objects) ?? []}`. |
| `run.finished` | Applies even without an earlier `run.started` (some frameworks emit unmatched end events). Lead: `done`, `say` ← `data.say` ?? `"Result ready"`, progress 100, `to`/`flag`/`flagKind` null. Phase `done`. Other agents are unchanged. |
| `run.failed` | Lead: `failed`, `say` ← `data.reason` ?? `"Run failed"`, `flag` ← `data.reason` ?? null, `flagKind` `"error"`, `to` unchanged. Phase `failed`. |
| `stage.*`, `tool.finished`, `tool.failed`, `custom.*`, unknown | No effect on snapshots (they stay in the log). |

`lead` is a valid target for every agent event (e.g. a `message` from the lead).

### 4.5 Output

- `structure`: as above.
- `statuses`: an object keyed by agent id, including `lead`, in registration order (lead first).
- `state`: `{"mode": "sdk", "step": 4, "phase": "running" | "done" | "failed", "locked": true, "version": structure.version, "run", "runId", "updated": ts of the last applied event, "next"}` where `next` is `"Watch the office panel — the team is working."`, `"Run finished — open the result."` or `"Run failed — see the Lead's desk."`. Before any `run.started`, `phase` is `"locked"`, `run` is 0, `runId` is null and `next` is `"Waiting for the first run."`
- `result`: the last `result` of the current run, or `null`. When it is `null`, writers MUST remove `outputs/result.json` and `outputs/result.js` if they exist, so a viewer never shows the previous run's result as the current one.

Writers then store these as `mas/structure`, `mas/status/<id>`, `mas/state` and `outputs/result` (JSON + `.js` twin). A status file for an agent no longer in the structure MAY be left in place; the panel only reads ids in the structure. Writers MUST NOT write a status file for an id that does not match `^[a-z0-9][a-z0-9-]*$` (it could escape the folder).

## 5. Transport over HTTP (`mas-office serve`)

| Endpoint | Method | Body / response |
|---|---|---|
| `/v0/events?project=<folder>` | `POST` | one event object, a JSON array, or NDJSON. The server assigns `seq` (and `ts`, `v` when missing), appends to the log, re-runs the reducer, writes snapshots. Response `{"accepted": n, "lastSeq": n}`. |
| `/v0/stream` | `GET` | Server-Sent Events. `event: change` with `data: {"path": "<changed file>"}` whenever a workspace file changes; `event: mas` with `id: <seq>` and `data: {"project": "<folder>", "event": {…}}` for each posted event (`seq` is per project). |
| `/v0/health` | `GET` | `{"ok": true, "spec": "0.1"}` |
| `/office/` | `GET` | the panel |
| `/<path>` | `GET` | workspace files, read-only, never outside the workspace |

## 6. Mapping notes

- **AG-UI**: `mas-office export --ag-ui` maps types with the table in 3.2 and puts our original event in `rawEvent`.
- **OpenTelemetry GenAI**: `agentName` ↔ `gen_ai.agent.name`, `agentId` ↔ `gen_ai.agent.id`, `tool.*.data.name` ↔ `gen_ai.tool.name`. The GenAI conventions are still in *Development* status; mappings may change in a minor version.
- **A2A**: status states map as in 2.2; `result` maps to the final task artifact.

Background and sources for these choices: [`docs/research/prior-art.md`](../docs/research/prior-art.md).
