# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); packages use [Semantic Versioning](https://semver.org/), the protocol uses `Major.Minor`.

## [Unreleased]

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
