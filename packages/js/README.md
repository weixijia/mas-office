# @mas-office/sdk

Show your multi-agent system's team **live** in the [MAS Office](https://github.com/weixijia/mas-office) panel — an animated office where every agent has a desk, a status and a speech bubble.

The SDK emits [MAS Office protocol](https://github.com/weixijia/mas-office/blob/main/spec/README.md) events, runs the reference reducer and writes the snapshot files the panel reads. Zero dependencies, Node 18+.

## Install (from source)

```sh
git clone https://github.com/weixijia/mas-office
cd mas-office && npm install
```

The SDK is the npm workspace `packages/js`. Inside the repo (or a project added to its workspaces), `import { Office } from '@mas-office/sdk'` resolves to it. From a project elsewhere, import the entry file directly:

```js
import { Office } from '/path/to/mas-office/packages/js/src/index.js';
```

or add it as a local dependency: `npm install /path/to/mas-office/packages/js`.

npm packages: coming with the first release.

## Example

```js
import { Office } from '@mas-office/sdk';

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

Then show it with the [CLI](../cli/README.md): `node /path/to/mas-office/packages/cli/bin/mas-office.js serve ./runs --open`. Or run the CLI's `init ./runs` once and open `runs/office/index.html` directly.

## API

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

## Transports

**File** — `new Office({ workspace: './runs' })`. Each event is appended to `<project>/mas/events.jsonl`, applied to an in-memory reducer, and the snapshots (`mas/structure`, `mas/state`, `mas/status/<id>`, `outputs/result`, `home/projects`, as JSON plus the `.js` twins the `file://` panel loads) are rewritten atomically. Reopening a project continues the log's `seq` numbering and rebuilds the state from it.

Use **one writer process per project**. Two processes appending to the same log at once can assign the same `seq`. For several processes (or other languages), run `mas-office serve` and use HTTP.

**HTTP** — `new Office({ url: 'http://127.0.0.1:4747' })`. Events are queued and POSTed in batches to `mas-office serve` (`POST /v0/events?project=<folder>`), which assigns `seq`, writes the log and the snapshots. A batch never exceeds the server's 1 MB body limit; a single event larger than that is dropped with one warning. Call `await office.close()` before exiting so the queue is flushed.

## Lower-level helpers

`createReducer()`, `reduce(lines)`, `parseLog(lines)`, `validateEvent(event)`, `writeSnapshots(projectDir, snapshot)`, `jsTwin(globalName, value, statusId?)`, `parseJsTwin(code)` / `splitJsTwin(code)` (read a twin without running it), `ProjectLog`, `updateProjectsIndex`, `SPEC_VERSION` — the same pieces the CLI uses. `reduce` is the reference implementation of [spec §4](https://github.com/weixijia/mas-office/blob/main/spec/README.md#4-the-reducer) and passes every case in `spec/conformance/`.

## License

MIT
