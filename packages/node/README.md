# mas-office

Show your multi-agent system's team **live** in the [MAS Office](https://github.com/weixijia/mas-office) panel — an animated office where every agent has a desk, a status and a speech bubble.

One npm package, two halves:

- **SDK** (`import … from 'mas-office'`): emits [MAS Office protocol](https://github.com/weixijia/mas-office/blob/main/spec/README.md) events, runs the reference reducer and writes the snapshot files the panel reads.
- **CLI** (`mas-office …`): serves the panel, validates snapshots, replays event logs and plays a demo. The panel, the JSON Schemas and the no-code kit ship inside the package.

Zero dependencies, Node 18+.

## Install

```sh
npx mas-office demo          # try it: opens the panel and plays a simulated team
npm install mas-office       # the SDK for your project (and the `mas-office` command)
npm install -g mas-office    # or the command everywhere
```

`demo` opens the panel and plays a simulated five-agent team (plus a helper spawned at runtime) for about 40 seconds.

### From source

```sh
git clone https://github.com/weixijia/mas-office
cd mas-office && npm install
node packages/node/bin/mas-office.js demo
```

In a clone, `mas-office` below means `node packages/node/bin/mas-office.js` (run from the repo folder), or `node /path/to/mas-office/packages/node/bin/mas-office.js` from anywhere else. The CLI's own hints print the command the way you ran it. To use the SDK from a clone, add it as a local dependency (`npm install /path/to/mas-office/packages/node`) or import the entry file directly (`/path/to/mas-office/packages/node/src/sdk/index.js`).

## SDK

```js
import { Office } from 'mas-office';

const office = new Office({ workspace: './runs' });
const project = office.project('headphone-deals', { title: 'Headphone deals' });
const run = project.run(); // no structure: agents appear as they act

const finder = run.agent('finder', { name: 'Retail finder', emoji: '🔎' });
finder.working('Searching Currys', { progress: 20 });
const offers = await finder.tool('web_search', () => search('Sony XM6'));
finder.source({ id: 'currys-xm6', title: 'Sony XM6 — Currys', url: 'https://…', evidence: 'A' });
finder.handoff('lead', { say: `Found ${offers.length} offers` });
finder.done();

run.result({ markdown: '## Shortlist\n- Currys £279' });
run.finish();
await office.close();
```

Then show it: `mas-office serve ./runs --open`. Or run `mas-office init ./runs` once and open `runs/office/index.html` directly.

### API

| Call | Event |
|---|---|
| `new Office({ workspace })` / `new Office({ url })` | choose a transport (below) |
| `office.project(folder, { title?, task? })` | opens `<workspace>/<folder>/`; `task` (`{summary, requirements: [{id, text}]}`) is written to `me/task.json` |
| `project.run({ structure?, title?, runId? })` | `run.started` — pass a [structure](https://github.com/weixijia/mas-office/blob/main/spec/README.md#21-structure) for a declared team |
| `run.agent(id, { name, emoji, job, group, handsTo, parent, role })` | an agent handle; `agent.registered` is sent the first time an agent that is not in the structure acts |
| `run.lead` | the lead's handle (id `lead`) |
| `agent.working(say, { progress })`, `agent.status(state, {...})` | `agent.status` |
| `agent.say(text, { to })` | `message` |
| `await agent.tool(name, fn, { say })` | `tool.started` → `tool.finished` / `tool.failed` (the error is re-thrown) |
| `agent.source({ id, title, url, evidence })` | `artifact` (an evidence card) |
| `agent.handoff(to, { say, reason })` | `handoff` |
| `agent.flag(text, { kind })`, `agent.resolve()` | `flag.raised`, `flag.resolved` |
| `agent.done(say)`, `agent.fail(reason)` | `agent.finished`, `agent.failed` |
| `run.result({ markdown, work, sources, flags, title })` | `result` |
| `run.finish(say)`, `run.fail(reason)` | `run.finished`, `run.failed` |
| `project.emit(event)` | any event (low level) |
| `await office.close()` | flush the HTTP queue |

Ids are lowercase letters, digits and dashes (`[a-z0-9-]`). Invalid project folders or agent ids throw a `TypeError` when you create the handle. **Emitting never throws**: if an event is invalid or cannot be delivered, it is dropped with one `console.warn`, so the panel can never break your agents.

### Transports

**File** — `new Office({ workspace: './runs' })`. Each event is appended to `<project>/mas/events.jsonl`, applied to an in-memory reducer, and the snapshots (`mas/structure`, `mas/state`, `mas/status/<id>`, `outputs/result`, `home/projects`, as JSON plus the `.js` twins the `file://` panel loads) are rewritten atomically. Reopening a project continues the log's `seq` numbering and rebuilds the state from it.

Use **one writer process per project**. Two processes appending to the same log at once can assign the same `seq`. For several processes (or other languages), run `mas-office serve` and use HTTP.

**HTTP** — `new Office({ url: 'http://127.0.0.1:4747' })`. Events are queued and POSTed in batches to `mas-office serve` (`POST /v0/events?project=<folder>`), which assigns `seq`, writes the log and the snapshots. A batch never exceeds the server's 1 MB body limit; a single event larger than that is dropped with one warning. Call `await office.close()` before exiting so the queue is flushed.

### Lower-level helpers

`createReducer()`, `reduce(lines)`, `parseLog(lines)`, `validateEvent(event)`, `writeSnapshots(projectDir, snapshot)`, `jsTwin(globalName, value, statusId?)`, `parseJsTwin(code)` / `splitJsTwin(code)` (read a twin without running it), `ProjectLog`, `updateProjectsIndex`, `SPEC_VERSION` — the same pieces the CLI uses. `reduce` is the reference implementation of [spec §4](https://github.com/weixijia/mas-office/blob/main/spec/README.md#4-the-reducer) and passes every case in `spec/conformance/`.

The server and the CLI are importable too: `import { startServer } from 'mas-office/server'` (resolves to `{url, port, close()}`), `import { main } from 'mas-office/cli'` (`await main(['validate', './runs'])` returns the exit code).

## CLI

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

### The event API (`serve`)

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

### Claude Code

Add the hook to `.claude/settings.json` (experimental). This assumes a global install (`npm install -g mas-office`); from a clone, use `node /path/to/mas-office/packages/node/bin/mas-office.js hook claude-code` instead (an absolute path, so the hook works from any directory). Don't use `npx mas-office` here: hooks run on every tool call.

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "mas-office hook claude-code" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "mas-office hook claude-code" }] }],
    "PreToolUse": [{ "hooks": [{ "type": "command", "command": "mas-office hook claude-code" }] }],
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "mas-office hook claude-code" }] }],
    "PostToolUseFailure": [{ "hooks": [{ "type": "command", "command": "mas-office hook claude-code" }] }],
    "SubagentStart": [{ "hooks": [{ "type": "command", "command": "mas-office hook claude-code" }] }],
    "SubagentStop": [{ "hooks": [{ "type": "command", "command": "mas-office hook claude-code" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "mas-office hook claude-code" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "mas-office hook claude-code" }] }]
  }
}
```

Events go to `.mas-office/claude-code/` in your project; watch them with `mas-office serve .mas-office --open`. The hook always exits 0 and prints nothing; problems are logged to `.mas-office/home/hook-errors.log`. Tool `say` lines name the tool and file, never command arguments or file contents.

## License

MIT
