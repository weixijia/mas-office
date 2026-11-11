# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); packages use [Semantic Versioning](https://semver.org/), the protocol uses `Major.Minor`.

## [Unreleased]

### Added

- **A native Mac app** (`apps/mac`, SwiftUI and AppKit): inbox, agent page with transcript and chat, result with checked claims, run controls, team design, setup check, settings, a menu bar item, notifications with Allow once / Deny, and the Dock badge are native; the office drawing is the panel in a web view. It starts `mas-office up` itself, with the Node you have installed. Built with `apps/mac/scripts/build-app.sh`; signed ad hoc.
- `mas-office up --json`: one JSON line with the address and token for a program that embeds the engine; it stops when its stdin closes.
- Panel embed mode `?view=office`: only the office drawing, with `window.MASEmbed` for a host to select agents.
- `mas-office up` indexes project folders that hold a team design but are not in `home/projects` yet.

## [0.3.0] — 2026-11-10

MAS Office now runs the team, not only shows it. Every role of a locked design is a real Claude Code or Codex session on your computer, signed in by you, and the panel is where you answer and steer it.

### Added
- **`mas-office-runtime`**, a new npm package (`packages/runtime`) that drives a locked team of real sessions. It depends on `mas-office` and `@anthropic-ai/claude-agent-sdk`; `mas-office` itself stays zero-dependency.
  - **Claude Code backend**: the Agent SDK pointed at your installed `claude`, one streaming session per role. Approvals go through `canUseTool` and a `PreToolUse` hook; messages can steer, queue or interrupt; sessions resume by id.
  - **Codex backend**: one shared `codex app-server` (your installed `codex`), one thread per role. Every approval server request goes to the engine; `turn/steer`, `thread/resume`; MCP servers a role was not given are switched off for its thread.
  - **The engine**: the Lead, itself a real session, plans and writes each role's brief; a deterministic scheduler validates every JSON turn the Lead returns. Stages run in parallel, at most 3 sessions at once by default. A reviewer can send work back for a bounded number of rounds; then the person decides, never a silent accept. Gates (plan, stage, final). The Lead writes the answer to `outputs/result.md` with `<claim id src>` tags; every source URL is checked; checkers judge each claim; flags open when `verify.flagWhen` thresholds are crossed. Follow-up rounds send back only the roles needed. Stall detection: a nudge, then the Lead picks a recovery, then the person. Approvals are delegated by policy or to the Lead within an allow-list, and every such decision is logged. A restart continues an unfinished run and expires requests the old process left open.
- **CLI**:
  - `mas-office up [workspace] --project <p> --task "…"` runs a locked team with the panel. It needs `mas-office-runtime` and prints the install command when it is missing.
  - `mas-office team check|lock|show <project>` checks a team design, locks it with a signature, or prints it as Markdown.
  - `mas-office verify <project>` lists an answer's claims, checks each source link (private addresses are never fetched) and appends the findings to the project's log.
- **Protocol 0.2** (`spec/rfcs/0001-protocol-0.2.md`), all additive: `request.opened` / `request.resolved`; `command.message`, `command.respond`, `command.assign`, `command.interrupt` with `command.ack`; `agent.stopped`; `task.assigned` / `task.updated` / `task.finished`, `lead.ledger`, `review.verdict`, `recovery.chosen`; `claim.added`, `evidence.checked`, `verdict.recorded`; `round.started`; `usage`. New snapshots `mas/inbox`, `mas/board` and `outputs/verification`, with JSON Schemas. Statuses gain `waitingOn` and `stopReason`. The reducer now builds result rounds (`round`, `question`, `previous`). The JS and Python reducers agree on 16 conformance cases (09–16 are new).
- **Team design v2** (optional fields on `mas/structure`; a 0.1 structure stays valid): a `backend` per role, a fixed tool vocabulary with `allow` / `ask` / `deny`, `reviewerOf` and `review` rounds with escalation, `cleanContext`, gates, `lead.delegate` rules, `budget`, and a `signature` set at lock. The design is compiled into each backend's options and enforced at one point (`decideTool`) for every tool call.
- **Server**: `POST /v0/commands`, `POST /v0/runs`, `GET /v0/session`, `GET /v0/inbox`, and replay on `GET /v0/stream` with `since` (or `Last-Event-ID`). Without a runtime, commands are left in `<project>/mas/commands/<agentId>.jsonl` for a file-only assistant.
- **SDKs** (JS and Python): `request` / `resolve`, `stopped`, `usage`, `claim`, `evidence`, `verdict` and `followUp` / `follow_up`.
- **Panel**: the "Needs you" inbox with wait clocks, what each request holds up, and answers in place; an agent drawer with transcript, outputs, a chat box (steer / queue / interrupt) with delivery receipts, and Stop; reviewer lines and raised hands in the office; keyboard shortcuts (`N`, `I`, `A` / `D`, `1`–`9`, `?`); in the result, claims highlighted by verdict, a credibility line and "What the checkers caught".
- **`eval/`**: an evaluation harness (Python, standard library only) with 9 research and decision tasks, three locked designs (a team with a cross-vendor checker, the same team with a same-vendor checker, a single agent), metrics computed from the event log, rubric sheets, import of answers from other systems, and an HCI study protocol. No evaluation runs have been made yet.

### Changed
- **Protocol version** is `0.2`. A 0.1 log reduces to the same structure, statuses, state and result as before, apart from the two new status fields (`waitingOn`, `stopReason`). Cases 01–08 gain those fields and the new empty snapshots in `expected.json`.
- **`mas-office hook claude-code`**: a permission prompt in a Claude Code session you opened yourself now appears in the inbox. You answer it in your own terminal; the panel only watches that session.
- **Panel**: without the token the panel is read-only; the examples and `?demo=1` work as before.
- **Examples**: `price-compare` is a locked v2 design: a Codex checker reviews both finders, `web search` approvals are given by policy, and a gate sits before the check stage.
- **Docs**: README (both languages), ROADMAP, `docs/design/runtime.md`, `packages/runtime/README.md`, `eval/README.md`.

### Security
- **Sessions**: only the unmodified `claude` and `codex` the user installed and signed in to (`claude auth login`, `codex login`). Login state is checked with `claude auth status` and Codex `account/read`; no credential is read, stored or passed. Child processes get a minimal environment. Claude roles run with `settingSources: []`, so no user or project setting widens a role. Codex roles run in a read-only sandbox with `on-request` approvals, so every write goes through the policy.
- **Server**: the printed panel link carries a token; only a browser opened from it can answer requests, message agents or start runs. Only the server writes `origin: human`. `POST /v0/events` refuses `command.*` (other than `command.ack`) and refuses a `request.resolved` that claims `by.kind: "human"` without the token.

## [0.2.2] — 2026-11-07

### Fixed
- **Panel**: the result drawer did not slide out when a run finished live (both the kit Lead and the SDK write the result just before marking the run done, and that result was mistaken for an old one). It now slides out about 2.5 s after the run finishes, so the team's wrap-up shows first. A single-round result no longer shows a round label.

### Changed
- **Docs**: README (both languages) and website describe the result drawer, follow-up rounds and the new roadmap; new demo GIF and result screenshot.

## [0.2.1] — 2026-11-07

### Added
- **Kit**: the team in Claude Code's status line. A one-line summary shows the MAS, its phase, every role, progress and flags, plus a link to the office; each running role also gets its own subagent row. Users who stay in the terminal no longer miss the office.
- **Kit**: a real browser for roles (`mas-browser`, a project MCP server running `chrome-devtools-mcp` pinned to an exact version): a Chrome window with a temporary profile and none of the user's logins. A new tool word, `browse the web`, covers pages that block simple fetches (403 / "Access Denied", consent walls, JavaScript-built pages, search forms). Setup tests it and records `canBrowse` in `home/env.js`.

### Changed
- **Kit**: role briefs list each role's tools and their meaning, and say to read a file before overwriting it. Setup explains that Claude Code applies the folder's settings only after the user trusts the folder.
- **Kit security**:
  - Roles can no longer edit `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `SETUP.md`, `.claude/` or `.mcp.json` anywhere in the folder, nor `~/.claude`. A nested `CLAUDE.md` would otherwise become instructions for the Lead.
  - The browser cannot upload files, open `file:` URLs or run caller-supplied JavaScript. A guard hook stops it from saving snapshots or screenshots to disk.
  - The browser cannot reach loopback, private, link-local or carrier-grade NAT addresses, `.local`/`.internal` names, or hostnames that resolve to them (host-resolver rules plus a proxy auto-config).
  - Role briefs say that web pages are information, not instructions.
  - The status line strips terminal control sequences and bidi overrides from agent-written text, and ignores data files over 256 KiB.

## [0.2.0] — 2026-11-07

### Added
- **Panel**: the result opens in a drawer that slides out from the right over the office, slightly see-through, with a side view and a full-screen view (Esc closes). It slides out by itself once for each result that arrives while you watch; the title block keeps a short card with an *Open result* button. The office never changes size for it.
- **Panel**: a result can hold several **rounds** — the run's own answer, then answers to follow-up questions — shown as one thread with round tabs.
- **Kit**: `follow-up` — after a result, ask a question or for more work in plain words. The Lead decides which roles the question needs and sends only those back to work (each again a fresh agent with a clean context that reads its earlier work file first), then adds the answer as a new round.
- **Spec**: optional `round`, `question` and `previous` fields on `result` (schema updated; the reducer does not produce them yet).

## [0.1.1] — 2026-11-06

### Fixed
- **Panel**: the office viewport stays stable across status headline changes and when the result appears; people animation is no longer accompanied by unintended office resizing.

## [0.1.0] — 2026-11-06

First public version. MAS Office grows out of [awesome-mas](https://github.com/weixijia/awesome-mas) (the classroom edition), whose workspaces remain valid.

### Added
- **Protocol 0.1** (`spec/`): workspace layout, snapshot documents with `.js` twins for `file://`, an append-only event log with 18 event types (plus `custom.*`) mapped to AG-UI, OpenTelemetry GenAI and A2A, a deterministic reducer, JSON Schemas and conformance cases.
- **`mas-office`** on npm (JS SDK + CLI in one package) and **`mas-office`** on PyPI (Python SDK): reducer, file and HTTP transports, one shared API shape.
- **`mas-office` CLI**: `serve` with live Server-Sent Events, `validate`, `init` (and `--kit`), `reduce`, `export --ag-ui`, `hook claude-code`, `demo`.
- **Panel**: SDK mode, `failed` state, typed flags, agents spawned at runtime, live updates over HTTP.
- **Experimental integrations**: OpenAI Agents SDK, LangGraph, Claude Agent SDK, Claude Code hooks.
- **Kit**: the AGENTS.md no-code mode from awesome-mas.
