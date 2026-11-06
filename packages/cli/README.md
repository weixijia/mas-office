# mas-office

The command line for [MAS Office](https://github.com/weixijia/mas-office): an animated office panel that shows any multi-agent system's team live.

## Run it from source

```sh
git clone https://github.com/weixijia/mas-office
cd mas-office && npm install
node packages/cli/bin/mas-office.js demo
```

`demo` opens the panel and plays a simulated five-agent team (plus a helper spawned at runtime) for about 40 seconds. Node 18 or later; no other dependencies.

npm packages: coming with the first release.

## Commands

Below, `mas-office` stands for `node packages/cli/bin/mas-office.js` (run from the repo folder), or `node /path/to/mas-office/packages/cli/bin/mas-office.js` from anywhere else. The CLI's own hints print the command the way you ran it.

| Command | What it does |
|---|---|
| `mas-office demo [--port 4747] [--no-open] [--exit] [--speed 1]` | Serve a temporary workspace and play the demo team |
| `mas-office serve [workspace] [--port 4747] [--host 127.0.0.1] [--open]` | Serve the panel at `/office/`, the workspace files (read-only) and the event API |
| `mas-office init [dir] [--kit] [--force]` | Create a workspace with the panel in `office/`; `--kit` adds the no-code AGENTS.md kit |
| `mas-office validate [path]` | Check a workspace, project or file against the JSON Schemas; exit 1 on errors. `.js` twins are read as data, never run: each must be one of the two shapes in spec §1.1 |
| `mas-office reduce <project-dir>` | Rebuild every snapshot from `mas/events.jsonl` |
| `mas-office export --ag-ui <project-dir>` | Print the log as AG-UI events, NDJSON (experimental) |
| `mas-office hook claude-code [--workspace dir] [--project claude-code]` | Turn Claude Code hook input into events (experimental) |

Exit codes: `0` success, `1` the command failed, `2` wrong usage.

## The event API (`serve`)

| Endpoint | |
|---|---|
| `POST /v0/events?project=<folder>` | One event, a JSON array or NDJSON (`Content-Type: application/json` or `application/x-ndjson`, max 1 MB). The server assigns `seq`, fills `v`/`ts`, appends to the log and rewrites the snapshots. A batch with any invalid event is rejected as a whole (`400`, with the reasons). Responds `{"accepted": n, "lastSeq": n}`. |
| `GET /v0/stream` | Server-Sent Events: `event: change` with `data: {"path": "<changed file>"}` when a workspace file changes; `event: mas` with `id: <seq>` and `data: {"project": "<folder>", "event": {…}}` for every posted event (`seq` is per project). |
| `GET /v0/health` | `{"ok": true, "spec": "0.1"}` |

The server listens on `127.0.0.1` by default, never serves files outside the workspace or hidden (dot) files, and refuses non-loopback `Host` headers while bound to loopback. A body over 1 MB gets `413`.

Workspace files are written by agents, so they are served as data, never as pages of this origin:

- The panel (`/office/`) is sent with `Content-Security-Policy: script-src 'self'; object-src 'none'; base-uri 'none'`.
- Every response has `X-Content-Type-Options: nosniff`.
- Workspace files are sent with `Content-Security-Policy: sandbox; default-src 'none'`, except the `.js` twins and `.json` documents the panel loads (`text/javascript` / `application/json`).
- Workspace `.html`, `.htm`, `.xhtml`, `.svg`, `.xml` and `.mjs` files are sent as `text/plain` (and sandboxed), so they display as text and never run.

## Claude Code

Add the hook to `.claude/settings.json` (experimental). Replace `/path/to/mas-office` with the folder you cloned (an absolute path, so the hook works from any directory):

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node /path/to/mas-office/packages/cli/bin/mas-office.js hook claude-code" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node /path/to/mas-office/packages/cli/bin/mas-office.js hook claude-code" }] }],
    "PreToolUse": [{ "hooks": [{ "type": "command", "command": "node /path/to/mas-office/packages/cli/bin/mas-office.js hook claude-code" }] }],
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "node /path/to/mas-office/packages/cli/bin/mas-office.js hook claude-code" }] }],
    "PostToolUseFailure": [{ "hooks": [{ "type": "command", "command": "node /path/to/mas-office/packages/cli/bin/mas-office.js hook claude-code" }] }],
    "SubagentStart": [{ "hooks": [{ "type": "command", "command": "node /path/to/mas-office/packages/cli/bin/mas-office.js hook claude-code" }] }],
    "SubagentStop": [{ "hooks": [{ "type": "command", "command": "node /path/to/mas-office/packages/cli/bin/mas-office.js hook claude-code" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "node /path/to/mas-office/packages/cli/bin/mas-office.js hook claude-code" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node /path/to/mas-office/packages/cli/bin/mas-office.js hook claude-code" }] }]
  }
}
```

Events go to `.mas-office/claude-code/` in your project; watch them with `node /path/to/mas-office/packages/cli/bin/mas-office.js serve .mas-office --open`. The hook always exits 0 and prints nothing; problems are logged to `.mas-office/home/hook-errors.log`. Tool `say` lines name the tool and file, never command arguments or file contents.

## License

MIT
