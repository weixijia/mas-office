# Integrations

Every integration turns a framework's own hooks into [MAS Office events](../spec/README.md#3-events) on a `Run`. They are **experimental**: they are tested against fake payloads shaped like each framework's, and were checked once against the real packages (versions below). Hook APIs in this space change often — if one breaks, please [open an issue](https://github.com/weixijia/mas-office/issues/new/choose).

All Python integrations import their framework lazily, so the SDK itself stays dependency-free. Install the framework yourself, or use the extras from a clone: `pip install -e "packages/python[openai-agents]"`, `"packages/python[langgraph]"`, `"packages/python[claude-agent-sdk]"` (PyPI package: coming with the first release).

Agent ids are derived from framework names with `mas_office.slugify` (`"Triage Agent"` → `triage-agent`).

## OpenAI Agents SDK (Python)

Checked with `openai-agents` 0.24. Hooks into [tracing](https://openai.github.io/openai-agents-python/tracing/) via a `TracingProcessor`; the default OpenAI exporter keeps working.

```python
from agents import Agent, Runner
from mas_office import Office
from mas_office.integrations.openai_agents import install

office = Office(workspace="./runs")
run = office.project("support-desk", title="Support desk").run()
install(run)                                   # agents.add_trace_processor(OfficeTracingProcessor(run))

result = Runner.run_sync(triage_agent, "My order never arrived")
run.result(markdown=str(result.final_output))
run.finish()
office.close()
```

| SDK span | MAS Office event |
|---|---|
| `agent` start / end (error) | `agent.status working` / `agent.finished` (`agent.failed`) |
| `function` start / end (error) | `tool.started` / `tool.finished` (`tool.failed`), on the enclosing agent's desk |
| `handoff` end | `handoff` from `from_agent` to `to_agent` |

## LangGraph (Python)

Checked with `langgraph` 1.2. Wraps a [stream](https://docs.langchain.com/oss/python/langgraph/streaming); chunks pass through unchanged.

```python
from mas_office import Office
from mas_office.integrations.langgraph import stream_to_office   # astream_to_office for async

office = Office(workspace="./runs")
run = office.project("research", title="Research").run()
stream = graph.stream(inputs, stream_mode=["tasks", "updates", "custom"], subgraphs=True)
for chunk in stream_to_office(stream, run):
    ...
run.finish()
office.close()
```

Inside a node, say what it is doing:

```python
from langgraph.config import get_stream_writer
get_stream_writer()({"say": "Reading 3 papers", "progress": 40})
```

| Stream part | MAS Office event |
|---|---|
| `tasks` start | `agent.status working` (node name → agent id; subgraph nodes get their parent) |
| `tasks` result: ok / `error` / `interrupts` | `agent.finished` / `agent.failed` / `flag.raised needs_input` |
| `custom` with `say` (+ `progress`) | `message` (or `agent.status working`) |

`tasks` mode needs a checkpointer only for `checkpoints`; without `subgraphs=True` LangGraph does not stream subgraph `custom` chunks.

## Claude Agent SDK (Python)

Checked with `claude-agent-sdk` 0.2. Uses [hooks](https://code.claude.com/docs/en/agent-sdk/hooks).

```python
from claude_agent_sdk import ClaudeAgentOptions, query
from mas_office import Office
from mas_office.integrations.claude_agent_sdk import office_hooks

office = Office(workspace="./runs")
run = office.project("code-review", title="Code review").run()
options = ClaudeAgentOptions(agents={...}, hooks=office_hooks(run))
async for message in query(prompt="Review this repo", options=options):
    ...
office.close()
```

| Hook | MAS Office event |
|---|---|
| `SubagentStart` / `SubagentStop` | `agent.registered` + `working` / `agent.finished` (id = `agent_id`, name = `agent_type`) |
| `PreToolUse` / `PostToolUse` / `PostToolUseFailure` | `tool.started` / `tool.finished` / `tool.failed` (spawning `Agent` / `Task` calls are skipped) |
| `Notification` | `flag.raised` on the lead (`needs_approval` for permission prompts, else `needs_input`) |
| `Stop` | `run.finished` — note: once per turn in a multi-turn `ClaudeSDKClient` session |

## Claude Code (hooks, no code)

`mas-office hook claude-code` (from a clone: `node packages/node/bin/mas-office.js hook claude-code`) reads one hook payload from stdin and appends events to a workspace. It always exits 0 and prints nothing, so it can never block Claude Code; errors go to `<workspace>/home/hook-errors.log`. Add it to your project's `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "mas-office hook claude-code --workspace ./.mas" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "mas-office hook claude-code --workspace ./.mas" }] }],
    "SubagentStart": [{ "hooks": [{ "type": "command", "command": "mas-office hook claude-code --workspace ./.mas" }] }],
    "SubagentStop": [{ "hooks": [{ "type": "command", "command": "mas-office hook claude-code --workspace ./.mas" }] }],
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "mas-office hook claude-code --workspace ./.mas" }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "mas-office hook claude-code --workspace ./.mas" }] }],
    "PostToolUseFailure": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "mas-office hook claude-code --workspace ./.mas" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "mas-office hook claude-code --workspace ./.mas" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "mas-office hook claude-code --workspace ./.mas" }] }]
  }
}
```

This assumes a global install (`npm install -g mas-office`). From a clone, use `node /path/to/mas-office/packages/node/bin/mas-office.js hook claude-code --workspace ./.mas` instead, with an absolute path to a clone you trust. Then watch it with `mas-office serve ./.mas --open`.

> Don't put `npx mas-office` in a hook: hooks run on every tool call, and `npx` may resolve or download the package each time. Install it once.

## AI coding assistants (kit mode)

`npx mas-office init --kit <dir>` (from a clone: `node packages/node/bin/mas-office.js init --kit <dir>`) copies `AGENTS.md`, `harness/` and the panel. Any assistant that reads `AGENTS.md` (Claude Code, Codex, Antigravity, Gemini CLI, Cursor, …) then designs and runs the team by writing snapshots directly — no package needed. See [`kit/AGENTS.md`](../kit/AGENTS.md).

## Write your own

1. Find the framework's public hook (callbacks, tracing processor, event stream). Prefer the most stable one.
2. Map its events to the table in [spec §3.2](../spec/README.md#32-event-types). Use `agent.status` for "now doing X", `handoff` for edges, `flag.raised` for anything a human should see.
3. Never raise into user code; drop events instead.
4. Test with fake payloads; add a usage block here. See [CONTRIBUTING.md → Framework integrations](../CONTRIBUTING.md#2-framework-integrations).
