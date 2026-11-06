# Roadmap

This is a direction, not a promise. Items link to issues once someone picks them up — comment there if you want to help.

## v0.1 — the protocol works end to end (this release)

- [x] Protocol 0.1: workspace layout, snapshots, event log, deterministic reducer, JSON Schemas, conformance cases
- [x] JS SDK (in the `mas-office` npm package) and `mas-office` (Python): reducer, file transport, HTTP transport
- [x] `mas-office` CLI: `serve` (live SSE), `validate`, `init` (`--kit`), `reduce`, `export --ag-ui`, `hook claude-code`, `demo`
- [x] Panel: SDK mode, `failed` state, dynamic agents, live updates over HTTP
- [x] Integrations (experimental): OpenAI Agents SDK, LangGraph, Claude Agent SDK, Claude Code hooks
- [ ] First tagged release published to npm and PyPI

## v0.2 — more producers

- [ ] CrewAI `BaseEventListener` integration
- [ ] AG-UI ingest (one adapter for frameworks that already speak AG-UI)
- [ ] OpenTelemetry GenAI ingest: OTLP/HTTP receiver in `serve` mapping `invoke_agent` / `execute_tool` spans
- [ ] CAMEL `WorkforceCallback`, Google ADK `BasePlugin`, Microsoft Agent Framework workflow events
- [ ] JS integrations: OpenAI Agents SDK (TS), Mastra, Claude Agent SDK (TS)

## v0.3 — richer pictures

- [ ] `graph` topology layout (layered DAG) and dashed "observed" handoff edges
- [ ] Instances vs definitions: several running instances of one role share a pod
- [ ] Replay: scrub through a run from `events.jsonl`
- [ ] Token / cost per agent (optional `usage` on events, mapped to `gen_ai.usage.*`)
- [ ] `mas-office export --otlp`

## Later

- Multi-workspace view, run comparison, embeddable panel component, themes
- Two-way control (pause, approve a `needs_approval` flag) — needs an RFC: the panel is read-only today by design
