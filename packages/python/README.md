# mas-office (Python)

Show any multi-agent system's team live in the **MAS Office** panel — an animated office
where every agent has a desk. This package emits [MAS Office protocol](../../spec/README.md)
events, runs the reference reducer and writes the snapshots the panel reads.

- Python ≥ 3.10, **zero runtime dependencies**
- Two transports: files (works with the `file://` panel) or HTTP (`mas-office serve`)
- Thread-safe: agents in threads can share one `Office`
- Experimental integrations for the OpenAI Agents SDK, LangGraph and the Claude Agent SDK

## Install

From source (the viewer, `mas-office serve`, lives in the same repository):

```bash
git clone https://github.com/weixijia/mas-office
pip install -e mas-office/packages/python
# with an integration: pip install -e 'mas-office/packages/python[openai-agents]'
#                      (or [langgraph], [claude-agent-sdk])
```

PyPI package: coming with the first release.

The viewer needs Node.js 18+. Commands below that start with `node packages/cli/...` are run
from the root of your `mas-office` clone.

## Example

```python
from mas_office import Office

with Office(workspace="./runs") as office:
    project = office.project("headphone-deals", title="Headphone deals",
                             task={"summary": "Best price for XM6", "requirements": [{"id": "R1", "text": "Under £300"}]})
    run = project.run()                                    # run.started
    finder = run.agent("finder-a", name="Retail finder", emoji="🔎")
    finder.working("Searching Currys", progress=20)
    with finder.tool("web_search"):                        # tool.started → tool.finished / tool.failed
        offers = search("Sony XM6")
    finder.source("currys-xm6", title="XM6 at Currys", url="https://…", evidence="A")
    finder.handoff("lead")
    finder.done("Found 3 offers")
    run.result(markdown="## Shortlist\n- Currys £279", work=[{"by": "finder-a", "summary": "Searched 3 shops."}])
    run.finish()
```

Then view it with the Node CLI: `node packages/cli/bin/mas-office.js serve ./runs --open`.

Try it without writing any code — a simulated 5-agent team over about 30 seconds:

```bash
cd mas-office
python -m mas_office demo --workspace ./runs     # or: mas-office-py demo
node packages/cli/bin/mas-office.js serve ./runs --open
```

## API

| Call | Event |
|---|---|
| `Office(workspace=...)` / `Office(url=...)` | — (file / HTTP transport; also a context manager) |
| `office.project(folder, title=, task=)` | — (writes `me/task` with the file transport) |
| `project.run(structure=None, run_id=None)` | `run.started` (also a context manager: finishes, or fails on exception) |
| `run.agent(id, name=, emoji=, job=, group=, hands_to=, parent=, role=)` | `agent.registered` on first use, if not in `structure` |
| `run.lead` | the lead's handle |
| `a.working(say, progress=)`, `a.waiting(say)`, `a.status(state, say=, progress=, to=, flag=, flag_kind=)` | `agent.status` |
| `a.say(text, to=)` | `message` |
| `with a.tool(name, say=, call_id=):` (also `async with`) | `tool.started` → `tool.finished` / `tool.failed` (re-raises) |
| `a.tool_started(name, ...)`, `a.tool_finished(name, call_id=, error=)` | the same, without a context manager |
| `a.source(id, title=, url=, evidence=, **extra)` | `artifact` (kind `source`) |
| `a.handoff(to, say=, reason=)` | `handoff` |
| `a.flag(text, kind="concern")`, `a.resolve()` | `flag.raised`, `flag.resolved` |
| `a.done(say)`, `a.fail(reason)` | `agent.finished`, `agent.failed` |
| `a.emit(type, data, raw=, trace=)` | any type, e.g. `custom.my-thing` |
| `run.result(markdown, title=, sources=, flags=, work=)`, `run.finish(say)`, `run.fail(reason)` | `result`, `run.finished`, `run.failed` |
| `office.flush()`, `office.close()` | deliver queued events |

Agent ids match `^[a-z0-9][a-z0-9-]{0,63}$`; `mas_office.slugify("Retail Finder")` gives `retail-finder`.
`slugify` never returns `lead`: a framework agent called "Lead" becomes `lead-agent`, so it gets
its own desk instead of merging into the MAS Office lead. Project folders match `^[a-z0-9][a-z0-9-]{0,39}$`.

**Emitting never raises.** `office.project(...)` and `run.agent(id)` raise `ValueError` for an
invalid folder or id (a programming error, caught on the first run). Every event method instead
checks its event before sending it, with the same rules as the JavaScript SDK: an event that is
invalid (e.g. `a.say(None)`, an unknown state, `a.handoff("Checker Bot")` — ids are not slugified
for you) or not JSON-serialisable (e.g. a `datetime`, `NaN`) is dropped with one
`RuntimeWarning` per kind of problem. Pass ids through `slugify` yourself if they come from
elsewhere.

The reducer is available on its own: `mas_office.reduce(lines)` returns
`{"structure", "statuses", "state", "result"}`; `mas_office.write_snapshots(project_dir, snapshot)`
writes them. From the shell: `mas-office-py reduce runs/headphone-deals`.

## Transports

**Files** (`Office(workspace="./runs")`). Each event is appended to
`<workspace>/<project>/mas/events.jsonl`; the reducer runs in-process and rewrites the changed
snapshots (`mas/structure`, `mas/status/<id>`, `mas/state`, `outputs/result`, each as `.json`
plus a `.js` twin) and the project's entry in `home/projects`. Files are replaced atomically.
Re-opening a project continues the log from its last `seq`.

**HTTP** (`Office(url="http://127.0.0.1:4747")`). Events are serialised when you emit them and
posted in batches (at most 100 events, and under 1 MB per request) to
`POST /v0/events?project=<folder>` from a background thread; the server assigns `seq` and writes
the snapshots. A single event over 1 MB is dropped with a warning. Delivery failures never raise
into your code: the batch is dropped and one `RuntimeWarning` is issued. Call `office.close()`
(or use `with`) to flush before exit.

## Integrations (experimental)

Install the framework yourself, or use an extra: `pip install -e 'mas-office/packages/python[openai-agents]'`,
`[langgraph]`, `[claude-agent-sdk]`.

**OpenAI Agents SDK** — a tracing processor (agent spans → desks, function spans → tools,
handoff spans → handoffs):

```python
from mas_office.integrations.openai_agents import install
install(run)                      # agents.add_trace_processor(OfficeTracingProcessor(run))
Runner.run_sync(triage_agent, "My order never arrived")
```

**LangGraph** — wrap the stream; chunks pass through unchanged:

```python
from mas_office.integrations.langgraph import stream_to_office
stream = graph.stream(inputs, stream_mode=["tasks", "updates", "custom"], subgraphs=True)
for chunk in stream_to_office(stream, run):
    ...
# in a node: get_stream_writer()({"say": "Reading 3 papers", "progress": 40})
```

**Claude Agent SDK** — hooks for subagents, tools, notifications and stop:

```python
from mas_office.integrations.claude_agent_sdk import office_hooks
options = ClaudeAgentOptions(agents={...}, hooks=office_hooks(run))
```

## Development

```bash
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'
.venv/bin/pytest
```

The reducer must pass every case in [`spec/conformance/`](../../spec/conformance/) with output
identical to the JavaScript implementation. License: MIT.
