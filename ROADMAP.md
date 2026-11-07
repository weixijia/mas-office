# Roadmap

This is a direction, not a promise. Items link to issues once someone picks them up — comment there if you want to help.

## Where we are going

MAS Office started as a protocol and a live view of multi-agent runs. The next step is to **drive** the team too:

> A research team you design, can watch, and that checks its own work — running on the AI subscriptions you already have.

Single-agent harnesses (Claude Code, Codex, pi, OpenCode) make one agent good at a task. Parallel orchestrators (Claude Squad, Conductor, Vibe Kanban) run many independent agents side by side. MAS Office is about the **team**: a designed and locked set of roles, staged groups, independent checkers with clean contexts (optionally on another vendor's model), evidence cards with grades, a Lead who writes the answer, follow-up rounds that send only the roles a question needs, and an office where you see all of it.

Principles:

- **We orchestrate; we don't build another single-agent harness.** Each role runs in an official agent the user already has (`claude -p`, `codex exec` / Codex app-server, Gemini CLI, ACP adapters), so every model call happens in the vendor's own program under the user's own login.
- **Research and decision tasks first**: price comparison, planning, literature and feasibility checks, product selection, policy and visa checks.
- **Conversation and office in one window.** Terminal, desktop and IDE views share one event model; the office is never a separate page you forget to open.
- **Prove the team is better.** An evaluation set compares one agent with a MAS team on the same tasks before we invest further.
- **TypeScript** for the orchestrator and every view; Python for SDK integrations and evaluation.

## Shipped

- [x] **v0.1** — Protocol 0.1 (workspace layout, snapshots, event log, deterministic reducer, JSON Schemas, conformance cases); `mas-office` on npm (JS SDK + CLI: `serve`, `validate`, `init --kit`, `reduce`, `export --ag-ui`, `hook claude-code`, `demo`); live panel; experimental integrations (OpenAI Agents SDK, LangGraph, Claude Agent SDK, Claude Code hooks); project website
- [x] **v0.1.1** — the office keeps its size while agents work
- [x] **v0.2.0** — result drawer over the office; kit follow-up rounds (the Lead sends only the roles a question needs back to work)
- [x] **v0.2.1** — kit: a real browser for roles (`mas-browser`, confined to public addresses), the team in Claude Code's status line, security hardening

## M0 — evidence and feasibility (next)

- [ ] Evaluation harness: 8–10 research tasks, each run as one agent, as a MAS team, and with a Deep Research product for reference; measure fact accuracy (spot-checked), source grades (A–D), errors caught by checkers, cost and time
- [ ] Role backends: run one role through `claude -p --output-format stream-json` and through `codex exec --json`, map both event streams onto protocol events, show them live in the panel
- [ ] Terminal prototype: conversation with the Lead and a pixel office (half-block characters) in one screen
- [ ] Study prior art in depth (e.g. deepseek-ai/deepseek-harness subagent backends and agent teams)

## M1 — `mas run`: the team runs itself

- [ ] Team design v2: each role names its backend and its harness
- [ ] Per-role harness: tools from a fixed vocabulary (`web search`, `browse the web`, `read my files`, `mcp:<server>`, `cli:<prefix>`, `skill:<name>`) compiled deterministically into each backend's agent definition (e.g. Claude Code `.claude/agents/*.md` with `tools`, `mcpServers`, `hooks`, `permissionMode`), never written by a model
- [ ] Scheduler: groups in order, roles in a group in parallel, concurrency limit, budgets and timeouts
- [ ] Checker rework loop with a retry limit; follow-up rounds; resume from `events.jsonl` after an interruption
- [ ] Each role writes only its own files; optional worktree per role
- [ ] Protocol 0.2: approval, retry and usage/cost events, plus conformance cases for result rounds (`round`, `question`, `previous`)

## M2 — any coding agent can be the Lead

- [ ] `mas` MCP server (`design_team`, `lock_team`, `run_group`, `dispatch_role`, `followup`, `read_artifact`, …) so Claude Code or Codex can lead a team
- [ ] Move the AGENTS.md kit onto it

## M3 — one window

- [ ] `mas` terminal app: chat with the Lead, the office, approvals and flags in one screen
- [ ] Panel controls when served locally with a token: approve, ask a follow-up, stop or re-run a role (file:// and embeds stay read-only)
- [ ] IDE view (VS Code / Cursor panel next to the terminal)

## M4 — desktop and beyond

- [ ] Desktop app (Tauri around the panel and the orchestrator)
- [ ] Cross-vendor checkers by default
- [ ] Reproducible evaluation set published with results

## Producers and protocol (any time, contributions welcome)

- [ ] CrewAI `BaseEventListener` integration
- [ ] AG-UI ingest; OpenTelemetry GenAI ingest (OTLP/HTTP in `serve`)
- [ ] CAMEL `WorkforceCallback`, Google ADK `BasePlugin`, Microsoft Agent Framework workflow events
- [ ] JS integrations: OpenAI Agents SDK (TS), Mastra, Claude Agent SDK (TS)
- [ ] `graph` topology layout; instances vs definitions; replay scrubber; `export --otlp`
- [ ] Publish the Python SDK to PyPI
