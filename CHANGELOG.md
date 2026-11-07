# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); packages use [Semantic Versioning](https://semver.org/), the protocol uses `Major.Minor`.

## [Unreleased]

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
