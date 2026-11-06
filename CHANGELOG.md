# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); packages use [Semantic Versioning](https://semver.org/), the protocol uses `Major.Minor`.

## [Unreleased]

### Changed
- npm: one package `mas-office` (SDK + CLI); `@mas-office/sdk` is not published.

## [0.1.0] — 2026-11-06

First public version. MAS Office grows out of [awesome-mas](https://github.com/weixijia/awesome-mas) (the classroom edition), whose workspaces remain valid.

### Added
- **Protocol 0.1** (`spec/`): workspace layout, snapshot documents with `.js` twins for `file://`, an append-only event log with 18 event types (plus `custom.*`) mapped to AG-UI, OpenTelemetry GenAI and A2A, a deterministic reducer, JSON Schemas and conformance cases.
- **`@mas-office/sdk`** (JS) and **`mas-office`** (Python): reducer, file and HTTP transports, one shared API shape.
- **`mas-office` CLI**: `serve` with live Server-Sent Events, `validate`, `init` (and `--kit`), `reduce`, `export --ag-ui`, `hook claude-code`, `demo`.
- **Panel**: SDK mode, `failed` state, typed flags, agents spawned at runtime, live updates over HTTP.
- **Experimental integrations**: OpenAI Agents SDK, LangGraph, Claude Agent SDK, Claude Code hooks.
- **Kit**: the AGENTS.md no-code mode from awesome-mas.
