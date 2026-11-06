# MAS Office: prior-art research for the v0.1 protocol and SDKs

Status: design input, not a spec. Research date: 2026-11-06.
Method: official docs, specs, and GitHub source were fetched for each item. Every factual claim has a link. Anything I could not confirm from a primary source is marked **unverified**.

MAS Office today has five parts, inherited from awesome-mas: `structure` (lead plus roles, with groups A/B/C ordered by `after`), per-agent `status` (`idle|waiting|working|handoff|flagged|done` plus `say/to/flag/progress/t`), `result`, `sources/`, and `state`. This document asks three questions. What do frameworks expose that an emitter can hook into? Which standards should the event model map to? What should v0.1 copy, and what should it avoid?

---

## 1. Frameworks: abstractions and hook points

### 1.1 Summary table

| Framework | Multi-agent primitives | Hook an external emitter attaches to | Built-in event kinds |
|---|---|---|---|
| **OpenAI Agents SDK** (Py) | `Agent(handoffs=[...])`, `handoff()`, `Agent.as_tool()` ([handoffs](https://openai.github.io/openai-agents-python/handoffs/)) | `TracingProcessor` via `add_trace_processor()` ([tracing](https://openai.github.io/openai-agents-python/tracing/)); `RunHooks`/`AgentHooks` ([lifecycle](https://openai.github.io/openai-agents-python/ref/lifecycle/)); `Runner.run_streamed().stream_events()` ([streaming](https://openai.github.io/openai-agents-python/streaming/)) | agent, generation, function (tool), handoff, guardrail, custom spans; `handoff_requested`, `handoff_occured`, `tool_called`, `tool_output`, `message_output_created` |
| **Claude Agent SDK** (Py/TS) | `agents={name: AgentDefinition(...)}`, invoked through the `Agent` tool ([subagents](https://code.claude.com/docs/en/agent-sdk/subagents)) | `ClaudeAgentOptions(hooks={"PreToolUse": [HookMatcher(...)]})` ([hooks](https://code.claude.com/docs/en/agent-sdk/hooks)) | `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SubagentStart`, `SubagentStop`, `Stop`, `Notification`, `PermissionRequest` (+ TS-only `SessionStart`, `TeammateIdle`, `TaskCreated`, `TaskCompleted` …) |
| **LangGraph** | `StateGraph` nodes and edges; `Command(goto=..., graph=Command.PARENT)` and `Send` for handoffs; `create_supervisor`, swarm ([handoffs](https://docs.langchain.com/oss/python/langchain/multi-agent/handoffs)) | `graph.stream(..., stream_mode=[...], subgraphs=True)` ([streaming](https://docs.langchain.com/oss/python/langgraph/streaming)); `graph.stream_events(..., version="v3")` ([event streaming](https://docs.langchain.com/oss/python/langgraph/event-streaming)) | modes `values`, `updates`, `messages`, `custom`, `checkpoints`, `tasks`, `debug`; v3 channels: lifecycle `started/running/completed/failed/interrupted`, tools `tool-started/tool-finished/tool-error` |
| **CrewAI** | `Crew` + `Process.sequential` / `Process.hierarchical` ([source](https://github.com/crewAIInc/crewAI/blob/main/lib/crewai/src/crewai/process.py)); Flows with `@start`/`@listen`/`@router` ([flows](https://docs.crewai.com/en/concepts/flows)) | subclass `BaseEventListener`, implement `setup_listeners(self, crewai_event_bus)`, decorate with `@crewai_event_bus.on(EventType)` ([docs](https://docs.crewai.com/en/concepts/event-listener)) | 106 event classes, e.g. `CrewKickoffStartedEvent`, `AgentExecutionStartedEvent`, `TaskStartedEvent`, `ToolUsageStartedEvent`, `FlowStartedEvent`, `MethodExecutionStartedEvent` ([exports](https://github.com/crewAIInc/crewAI/blob/main/lib/crewai/src/crewai/events/__init__.py)) |
| **AutoGen AgentChat** (maintenance) | `RoundRobinGroupChat`, `SelectorGroupChat`, `Swarm`, `MagenticOneGroupChat` ([teams](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/teams.html)); `GraphFlow` + `DiGraphBuilder` (experimental) ([graph-flow](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/graph-flow.html)) | iterate `team.run_stream(task=...)` | `TextMessage`, `ToolCallRequestEvent`, `ToolCallExecutionEvent`, `ToolCallSummaryMessage`, `HandoffMessage`, final `TaskResult` |
| **Microsoft Agent Framework** (AutoGen successor) | workflows of executors and edges, supersteps | `async for event in workflow.run(msg, stream=True)` ([events](https://learn.microsoft.com/en-us/agent-framework/workflows/events)) | Py `event.type`: `started`, `status`, `executor_invoked`, `executor_completed`, `executor_failed`, `superstep_started`, `superstep_completed`, `output`, `intermediate`, `request_info`, `failed`; custom via `ctx.add_event(WorkflowEvent(type=..., data=...))` |
| **AG2** | classic: `AutoPattern` + `run_group_chat(...)`, swarm; new "AgentOS" docs speak of networks and subagents ([docs](https://docs.ag2.ai)) | `RunResponse` wrapping an `IOStream`, ending with `RunCompletionEvent` / `ErrorEvent` ([run_swarm ref](https://docs.ag2.ai/latest/docs/api-reference/autogen/run_swarm/)) | partially verified (see §6) |
| **Google ADK** | `LlmAgent(sub_agents=[...])`, `transfer_to_agent`, `AgentTool`, `SequentialAgent`/`ParallelAgent`/`LoopAgent` (deprecated in favour of `Workflow`) ([patterns](https://adk.dev/workflows/patterns/), [deprecation](https://github.com/google/adk-python/blob/main/.agents/skills/adk-agent-builder/references/multi-agent.md)) | `BasePlugin` registered as `App(..., plugins=[...])` ([plugins](https://adk.dev/plugins/)) | `before/after_run`, `before/after_agent`, `before/after_model`, `before/after_tool`, `on_*_error`, `on_event_callback`; `Event.author`, `Event.branch`, `actions.transfer_to_agent`, `actions.escalate` ([events](https://adk.dev/events/)) |
| **MetaGPT** | `Team().hire([...])`, `Role` with `set_actions`/`_watch`, `Action`, `Environment` pub/sub with `Message(cause_by=...)` ([tutorial](https://docs.deepwisdom.ai/main/en/guide/tutorials/multi_agent_101.html)) | no documented callback API ([README](https://github.com/FoundationAgents/MetaGPT)) | none documented |
| **ChatDev** | 1.0: ChatChain, phases, roles (`ChatChainConfig.json`); 2.0 "DevAll": YAML workflows ([repo](https://github.com/OpenBMB/ChatDev)) | Web Console "Launch" tab with real-time logs; log format undocumented | undocumented |
| **CAMEL** | `ChatAgent`, RolePlaying, `Workforce` ([repo](https://github.com/camel-ai/camel)) | `Workforce(callbacks=[WorkforceCallback])` ([ref](https://docs.camel-ai.org/reference/camel.societies.workforce.workforce)) | `log_task_created`, `log_task_decomposed`, `log_task_assigned`, `log_task_started`, `log_task_completed`, `log_task_failed`, `log_worker_created`, `log_worker_deleted`, `log_all_tasks_completed` ([ref](https://docs.camel-ai.org/reference/camel.societies.workforce.workforce_callback)) |
| **smolagents** | `MultiStepAgent` with `managed_agents=[...]` ([ref](https://huggingface.co/docs/smolagents/main/en/reference/agents)) | `step_callbacks` (list, or a dict keyed by `MemoryStep` type); `run(stream=True)` yields steps | memory steps `TaskStep`, `ActionStep`, `PlanningStep` |
| **Mastra** (TS) | workflows `createWorkflow/createStep` with `.then/.parallel/.branch/.foreach/.dowhile/.dountil/.commit` ([control flow](https://mastra.ai/docs/workflows/control-flow)); supervisor agents via `agents: {...}` (since `@mastra/core@1.8.0`); `.network()` deprecated ([subagents](https://mastra.ai/docs/subagents), [networks](https://mastra.ai/docs/agents/networks)) | `run.stream()` ([ref](https://mastra.ai/reference/streaming/workflows/stream)); delegation hooks `onDelegationStart`/`onDelegationComplete` | `workflow-start`, `workflow-step-start`, `workflow-step-output`, `workflow-step-progress`, `workflow-step-result`, `workflow-finish`; agent chunks `tool-call`, `tool-result` ([events](https://mastra.ai/docs/streaming/events)) |
| **Pydantic AI** | delegation via tools or `SubAgents`, programmatic hand-off, graph control flow, "deep agents" ([multi-agent](https://pydantic.dev/docs/ai/guides/multi-agent-applications/)) | `run(event_stream_handler=...)`, `run_stream_events()`, `agent.iter()` ([agent docs](https://ai.pydantic.dev/agent/)); Logfire/OTel | `PartStartEvent`, `PartDeltaEvent`, `FunctionToolCallEvent`, `FunctionToolResultEvent`, `FinalResultEvent`, `AgentRunResultEvent`; custom events added by [PR #6258](https://github.com/pydantic/pydantic-ai/pull/6258) |

### 1.2 Notes that matter for adapter design

- **OpenAI Agents SDK has the cleanest emitter seam.** `TracingProcessor` has six abstract methods: `on_trace_start`, `on_trace_end`, `on_span_start`, `on_span_end`, `shutdown`, `force_flush` ([interface](https://openai.github.io/openai-agents-python/ref/tracing/processor_interface/)). `add_trace_processor()` keeps the default exporter, while `set_trace_processors()` replaces it. If one processor raises, the others still run ([tracing](https://openai.github.io/openai-agents-python/tracing/)). `RunHooks.on_handoff(context, from_agent, to_agent)` hands you our `handsTo` edge directly ([lifecycle](https://openai.github.io/openai-agents-python/ref/lifecycle/)). One trap: the stream event name `handoff_occured` is misspelled on purpose, for backward compatibility ([streaming](https://openai.github.io/openai-agents-python/streaming/)).
- **Claude Agent SDK hooks are the natural fit for the "coding assistant follows AGENTS.md" use case.** All hook inputs share `session_id`, `cwd`, and `hook_event_name`. Inside a subagent, `agent_id` and `agent_type` are also populated, and `SubagentStart` and `SubagentStop` require them in Python. The tool-use ID links `PreToolUse` to `PostToolUse`. Hooks can return `{"async_": True}` so a logging hook never blocks the agent ([hooks](https://code.claude.com/docs/en/agent-sdk/hooks)). Messages from inside a subagent carry `parent_tool_use_id`. The tool name is `"Agent"` in `tool_use` blocks but `"Task"` in older versions, so adapters must match both ([subagents](https://code.claude.com/docs/en/agent-sdk/subagents)). Many hooks are TypeScript-only. The Python SDK, for example, has no `SessionStart` or `SessionEnd` ([hooks](https://code.claude.com/docs/en/agent-sdk/hooks)).
- **LangGraph's streaming surface has churned three times.** v1 tuple shapes change depending on the options passed. `version="v2"` produces `{"type","ns","data"}` parts. The recommended v1.2 API is `stream_events(version="v3")`, with a `ProtocolEvent` of `seq`, `method`, and `params.namespace/timestamp/data` ([streaming](https://docs.langchain.com/oss/python/langgraph/streaming), [event streaming](https://docs.langchain.com/oss/python/langgraph/event-streaming)). Its rule that `seq` is "strictly increasing within a run", while timestamps "can drift", is worth copying. `tasks` and `checkpoints` modes need a checkpointer ([streaming](https://docs.langchain.com/oss/python/langgraph/streaming)).
- **CrewAI is rich but unstable.** It exports 106 event classes ([exports](https://github.com/crewAIInc/crewAI/blob/main/lib/crewai/src/crewai/events/__init__.py)). The import path moved: listeners that import from `crewai.utilities.events` silently do nothing ([third-party issue](https://github.com/rajfirke/provena/issues/193)). `crew.replay()` emits `CrewKickoffCompletedEvent` with no matching start event ([#8365](https://github.com/crewAIInc/crewAI/issues/8365)). Lesson for us: reducers must tolerate an unmatched end event.
- **AutoGen is in maintenance mode.** Its README says "New users should start with Microsoft Agent Framework" and calls MAF "the enterprise‑ready successor to AutoGen" ([repo](https://github.com/microsoft/autogen)). MAF's superstep events (`superstep_started` and `superstep_completed`) correspond directly to our parallel "groups" ([events](https://learn.microsoft.com/en-us/agent-framework/workflows/events)).
- **ADK is mid-migration.** The repo deprecates `SequentialAgent`, `ParallelAgent`, and `LoopAgent` in favour of `Workflow` graphs ([adk-python](https://github.com/google/adk-python/blob/main/.agents/skills/adk-agent-builder/references/multi-agent.md)). `Runner(plugins=...)` is deprecated in favour of `App(plugins=...)` ([plugins](https://adk.dev/plugins/)). `Event.branch` (the hierarchy path) and `Event.author` are enough to place an event at a desk ([events](https://adk.dev/events/)).

---

## 2. Standards and protocols

### 2.1 OpenTelemetry GenAI semantic conventions

- **Location and status.** The GenAI conventions moved out of core semconv into [`open-telemetry/semantic-conventions-genai`](https://github.com/open-telemetry/semantic-conventions-genai) ([moved notice](https://opentelemetry.io/docs/specs/semconv/gen-ai/)). Every agent span there is **Development**. Only shared attributes such as `error.type` and `server.*` are Stable ([agent spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md)).
- **Agent spans** ([agent spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md)):
  - `create_agent {gen_ai.agent.name}`: kind CLIENT.
  - Internal invoke span: kind INTERNAL. `gen_ai.operation.name` is `invoke_agent` (LLM-driven), `invoke_workflow` (control flow defined by the application), or `invoke_{framework_entrypoint}`. The span is named `{gen_ai.operation.name} {gen_ai.agent.name}`.
  - `plan {gen_ai.agent.name}`.
  - Event `gen_ai.invoke_agent.exception`.
- **Remote invoke** is a CLIENT span named `invoke_agent {gen_ai.agent.name}`. It requires `gen_ai.operation.name` and `gen_ai.provider.name`, and has conditional attributes `gen_ai.agent.id/name/description/version` and `gen_ai.conversation.id` ([client invoke](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/client-invoke-agent.md)).
- **Tools** use an INTERNAL span named `execute_tool {gen_ai.tool.name}`. Attributes: `gen_ai.tool.name` (required), `gen_ai.tool.call.id`, `gen_ai.tool.type` (`function|extension|datastore`), and `gen_ai.agent.name`. Arguments and results are opt-in ([execute-tool](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/execute-tool.md)).
- **A2A conventions** add the attributes `a2a.method.name`, `a2a.task.id`, and `a2a.task.state`, and set `gen_ai.conversation.id` from the A2A `contextId` ([a2a.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/a2a.md)).
- **What to take for MAS Office:** give events `agent_name` (low cardinality, per the spec) separate from `agent_id`, plus `conversation_id` and `tool_call_id`. Export each agent run as an `invoke_agent` span, each tool as `execute_tool`, and the whole run as `invoke_workflow`. We have no "handoff" span; OTel defines none. Emit one as a span event or link, and keep that choice documented.

### 2.2 A2A (Agent2Agent, Linux Foundation)

- **Version and states.** The latest release is **1.0.0**. Compatibility is identified by `Major.Minor`, and the patch number does not affect it ([spec](https://a2a-protocol.org/latest/specification/)). `TaskState` values are `TASK_STATE_SUBMITTED`, `WORKING`, `COMPLETED`, `FAILED`, `CANCELED`, `REJECTED` (the last four are terminal), plus the interrupted states `INPUT_REQUIRED` and `AUTH_REQUIRED` ([spec](https://a2a-protocol.org/latest/specification/)).
- **Agent Card.** Required fields are `name`, `description`, `supportedInterfaces`, `version`, `capabilities`, `defaultInputModes`, `defaultOutputModes`, and `skills`. `iconUrl` and `provider` are optional. `AgentSkill` has `id`, `name`, `description`, and `tags` ([spec](https://a2a-protocol.org/latest/specification/)).
- **Streaming.** A `StreamResponse` carries exactly one of `task`, `message`, `statusUpdate`, or `artifactUpdate`. `TaskArtifactUpdateEvent` has `artifact`, `append`, and `lastChunk`. `Artifact` has `artifactId` and `parts` ([spec](https://a2a-protocol.org/latest/specification/)).
- **Governance.** A Technical Steering Committee with eight company seats ([GOVERNANCE.md](https://github.com/a2aproject/A2A/blob/main/GOVERNANCE.md)).
- **What to take:** our role definitions (`name/emoji/job/tools`) map onto an Agent Card subset: `name`, `description` ← `job`, `skills` ← `tools`, `iconUrl` ← emoji or avatar. The `sources/` evidence cards and `result` map onto A2A **Artifacts**. Our status vocabulary should map onto `TaskState` (see §5.2).

### 2.3 AG-UI

- **Event families** ([concepts](https://docs.ag-ui.com/concepts/events), [spec 1.0](https://docs.ag-ui.com/spec/1.0/events)):
  - Lifecycle: `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`, `STEP_STARTED`, `STEP_FINISHED`.
  - Text: `TEXT_MESSAGE_START/CONTENT/END/CHUNK`.
  - Tools: `TOOL_CALL_START/ARGS/END/RESULT/CHUNK`.
  - State: `STATE_SNAPSHOT`, `STATE_DELTA`, `MESSAGES_SNAPSHOT`.
  - Activity: `ACTIVITY_SNAPSHOT`, `ACTIVITY_DELTA`.
  - Reasoning: `REASONING_*`.
  - Subagents: `SUBAGENT_STARTED`, `SUBAGENT_FINISHED`, `SUBAGENT_ERROR`.
  - Passthrough: `RAW`, `CUSTOM`.
- **Base fields:** `type`, `timestamp`, `rawEvent`, `metadata`. Most events also take an optional `subagentRunId` ([concepts](https://docs.ag-ui.com/concepts/events)).
- **Subagent semantics.** `SubagentStarted` carries `subagentRunId` (one per invocation), `name`, `parentSubagentRunId`, and `parentToolCallId`. `SubagentFinished.outcome` is `success` or `suspended`. An event without `subagentRunId` belongs to the parent ([concepts](https://docs.ag-ui.com/concepts/events)). This is the closest existing model for **dynamic agents spawned at runtime**.
- **Conformance rule.** "Only the run lifecycle is mandatory for a producer", but "a consumer MUST accept all of them" ([spec 1.0](https://docs.ag-ui.com/spec/1.0/events)). Copy this rule.
- **Ecosystem.** AG-UI is already built into MAF, ADK, Mastra, Pydantic AI, AG2, LlamaIndex, and Agno (1st party), plus LangGraph and CrewAI (partnerships) ([repo](https://github.com/ag-ui-protocol/ag-ui)). An AG-UI ingest adapter would therefore cover many frameworks at once.

### 2.4 MCP (relevant parts only)

- **Versioning.** Versions are dates in `YYYY-MM-DD` form, marking the last backwards-incompatible change. Compatible changes do not bump the version. The current version is **2026-07-28** ([versioning](https://modelcontextprotocol.io/specification/versioning)).
- **Mapping.** For us, MCP tool calls are ordinary `tool.*` events. OTel has an MCP convention doc in the same repo ([docs/gen-ai](https://github.com/open-telemetry/semantic-conventions-genai/tree/main/docs/gen-ai)). The useful prior art is MCP's governance process, covered in §4.

### 2.5 Other conventions

- **OpenInference** (Arize Phoenix) uses `openinference.span.kind` values: `LLM`, `CHAIN`, `AGENT`, `TOOL`, `RETRIEVER`, `EMBEDDING`, `RERANKER`, `GUARDRAIL`, `EVALUATOR`, and others. It uses `agent.name` and `graph.node.id` for multi-agent graphs ([spec](https://arize-ai.github.io/openinference/spec/), [Phoenix best practices](https://arize.com/docs/phoenix/cookbook/tracing/openinference-best-practices)).
- **Langfuse observation types** are `agent`, `tool`, `chain`, `retriever`, `evaluator`, `embedding`, `guardrail`, `span`, `event`, and `generation` ([observation types](https://langfuse.com/docs/observability/features/observation-types)).

Both show that "agent vs tool vs glue" is the minimum shared taxonomy.

---

## 3. Existing visualizers and dashboards

| Tool | What it shows | Data it consumes | Gap MAS Office can fill |
|---|---|---|---|
| **LangGraph / LangSmith Studio** | graph structure, nodes visited, intermediate state, threads, time travel ([studio](https://docs.langchain.com/langsmith/studio)) | the Agent Server API protocol (from `langgraph dev`) | Works only with LangGraph or the Agent Server. It is a developer IDE, not a view that non-programmers can read. |
| **AutoGen Studio** | no-code GUI for building and running multi-agent workflows. "Not meant to be a production-ready app" ([repo](https://github.com/microsoft/autogen)) | AutoGen AgentChat teams | Framework-locked, and the framework itself is in maintenance mode. |
| **CrewAI `flow.plot()`** | static interactive HTML of the flow's method graph ([flows](https://docs.crewai.com/en/concepts/flows)) | flow definition only | Not live. Shows topology without status. |
| **Langfuse agent graphs** | graph inferred "from the observations' timings and nesting". Aggregated and expanded modes ([agent graphs](https://langfuse.com/docs/observability/features/agent-graphs)) | OTel or SDK traces with typed observations | After-the-fact trace analytics. No per-agent persona or desk metaphor. Needs a server. |
| **Arize Phoenix** | trace tree, plus an agent graph view built from AGENT/TOOL spans ([best practices](https://arize.com/docs/phoenix/cookbook/tracing/openinference-best-practices)) | OTel + OpenInference | Same as Langfuse. |
| **AgentOps** | session drilldown and waterfall of LLM, tool, and error events ([docs](https://docs.agentops.ai/v2/introduction)) | SaaS SDK, `agentops.init()` | Hosted and cost-focused. One session at a time. |
| **pixel-agents** | pixel-art office with one character per Claude Code agent. Sub-agents get their own characters, speech bubbles show activity, a visual cue marks agents waiting for permission ([repo](https://github.com/pixel-agents-hq/pixel-agents)) | Claude Code hooks (default) or JSONL transcripts under `~/.claude/projects/` (fallback), normalized into an `AgentEvent` model; `core/` holds AsyncAPI message contracts; MIT | **The closest prior art.** It is Claude Code-centric and has no team topology (roles, stages, handoffs), results, or evidence cards. Its open `HookProvider` seam is a model for our adapters. |
| **a16z AI Town** | 2D town sim with chatting characters ([repo](https://github.com/a16z-infra/ai-town)) | Convex DB state + PixiJS | A simulation engine, not a monitor for external MAS. |
| **Stanford Generative Agents** | live map, replay, and demo modes over saved simulation storage ([repo](https://github.com/joonspk-research/generative_agents)) | its own backend's storage | Replay is the useful idea; the format is bespoke. |
| **ChatDev** | 1.0: online log and replay modes; 2.0: Vue Web Console with real-time logs and artifacts ([repo](https://github.com/OpenBMB/ChatDev)) | ChatDev's own runtime | Framework-locked. |
| **shiwenxin123/Mavis** | **Not a visualizer.** A general AI-assistant core library "inspired by Tencent Marvis" (CLI/MCP/Codex Skill) ([repo](https://github.com/shiwenxin123/Mavis)) | — | No prior art for the office view. |

**The gap.** Tracing tools (Langfuse, Phoenix, AgentOps, Studio) are post-hoc, aimed at developers, and built around spans. Office-style tools (pixel-agents, AI Town) are tied to one runtime and have no team semantics. Nothing found is a framework-agnostic, file-first, local, live view of a team with declared roles, stages, handoffs, flags, and evidence-backed results that a non-programmer can follow.

---

## 4. Open-source practices in the big agent repos

| Repo | Layout | Community files | Process / CLA |
|---|---|---|---|
| LangGraph | monorepo: `libs/`, `docs/`, `examples/`, root `Makefile`, `AGENTS.md`; MIT ([repo](https://github.com/langchain-ai/langgraph)) | Contributing guide lives on docs.langchain.com; CoC points to the langchain repo | CLA status **unverified** |
| CrewAI | uv workspace: `lib/crewai`, `lib/devtools`, root `pyproject.toml` + `uv.lock`, `.pre-commit-config.yaml`, `AGENTS.md`; docs on Mintlify with frozen `docs/v<X.Y.Z>/` snapshots; MIT ([repo](https://github.com/crewAIInc/crewAI)) | `.github/CONTRIBUTING.md` | CLA **unverified** |
| OpenAI Agents SDK | `src/agents`, `tests`, `integration_tests`, `examples`, `docs` (MkDocs); uv, ruff, mypy, Pyright, `release-please`; `AGENTS.md`, `CLAUDE.md`, `PLANS.md`; MIT ([repo](https://github.com/openai/openai-agents-python)) | CONTRIBUTING, SECURITY | "Pull requests are limited to repository collaborators" ([repo](https://github.com/openai/openai-agents-python)) |
| AutoGen | — | — | Microsoft CLA via bot ([CONTRIBUTING](https://github.com/microsoft/autogen/blob/main/CONTRIBUTING.md)) |
| MCP | spec repo with `seps/`, separate conformance repo | — | **SEP process**: idea → awaiting sponsor → `draft` → `in-review` → `accepted` → `final`, also `dormant`/`withdrawn`/`superseded`. Needs a prototype; Standards-Track SEPs need a conformance scenario plus a `sep-NNNN.yaml` traceability file before `final` ([SEP guidelines](https://modelcontextprotocol.io/community/sep-guidelines)) |
| A2A | `specification/a2a.proto` is normative; `docs(spec):` vs `feat:`/`fix:` commit prefixes; editing the proto triggers a release ([CONTRIBUTING](https://github.com/a2aproject/A2A/blob/main/CONTRIBUTING.md)) | GOVERNANCE.md (TSC) | no CLA/DCO mentioned in CONTRIBUTING |
| AG-UI | pnpm + nx monorepo: `sdks/` (incl. `sdks/community/`), `integrations/` (incl. `integrations/community/`), `apps/dojo`, `spec/`, `DEPRECATIONS.md`; integrations tiered as 1st party / partnership / community ([repo](https://github.com/ag-ui-protocol/ag-ui)) | AGENTS.md, CONTRIBUTING, SECURITY | biweekly working group |
| OpenTelemetry semconv-genai | YAML `model/` is normative and `docs/` is generated by Weaver; `changelog.d/` fragments ([repo](https://github.com/open-telemetry/semantic-conventions-genai)) | CONTRIBUTING, RELEASING | CLA required ([guide](https://github.com/open-telemetry/community/blob/main/guides/contributor/README.md)) |

**What a small project should copy:**

1. **One monorepo**: `spec/` (JSON Schema is normative; Markdown generated or hand-synced), `packages/python`, `packages/js`, `panel/`, `integrations/<framework>/`, `integrations/community/`, `examples/`, `conformance/`. This combines the AG-UI and CrewAI layouts.
2. **A spec-change process scaled down from MCP.** "MOP" proposals as `proposals/NNNN-title.md` with the same section skeleton (Abstract, Motivation, Specification, Rationale, Backward Compatibility, Reference Implementation, Security). Status lives in the file. A proposal cannot reach `final` without a golden-file conformance fixture ([SEP guidelines](https://modelcontextprotocol.io/community/sep-guidelines)).
3. **Protocol versioning in the A2A style**: `Major.Minor` in every envelope, where the patch number never affects compatibility ([A2A spec](https://a2a-protocol.org/latest/specification/)). Keep a `DEPRECATIONS.md` like AG-UI. Date-based versions (MCP) suit a spec with many independent implementers, which we don't have yet.
4. **Tiered integration registry** (core / partner / community), as AG-UI does, with an adapter-contract test that every integration must pass.
5. **Tooling**: uv workspace for Python, pnpm for JS, `release-please` for versioned changelogs, and a root `AGENTS.md`. Every large repo surveyed has one, and our own users are coding agents.
6. **DCO rather than CLA.** This is a recommendation, not an observation. CLAs appear where a corporate or foundation owner needs them (Microsoft, OTel). For a small, unaffiliated MIT project, a DCO sign-off has less friction. Do not copy "PRs limited to collaborators".

---

## 5. Recommendations for MAS Office v0.1

### 5.1 Event model

Make an **append-only event log** the source of truth. Today's `status/*.js` files become **derived snapshots**, a reducer output, much like AG-UI's split between `STATE_SNAPSHOT` and `STATE_DELTA` ([concepts](https://docs.ag-ui.com/concepts/events)).

Envelope (JSON, one object per line):

```json
{"v":"0.1","seq":17,"ts":"2026-11-06T10:00:00.123Z","run_id":"r_1","type":"agent.status",
 "agent_id":"checker","agent_name":"Budget Checker","parent_id":"lead",
 "data":{"status":"working","say":"Comparing 3 prices","progress":0.4},
 "trace":{"trace_id":"…","span_id":"…"},"raw":null}
```

- `seq` is the ordering key and `ts` is informational. This follows LangGraph v3, where `seq` is "strictly increasing within a run" and timestamps "can drift" ([event streaming](https://docs.langchain.com/oss/python/langgraph/event-streaming)).
- `agent_name` is low-cardinality and `agent_id` identifies the instance, matching OTel `gen_ai.agent.name` / `gen_ai.agent.id` ([agent spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md)). `raw` mirrors AG-UI `rawEvent` and keeps the source framework's payload.

Event types (lowercase dot names; the right-hand columns are the mapping targets):

| MAS Office `type` | AG-UI | OTel GenAI | A2A |
|---|---|---|---|
| `run.started` / `run.finished` / `run.failed` | `RUN_STARTED` / `RUN_FINISHED` / `RUN_ERROR` | `invoke_workflow` span start/end | — |
| `stage.started` / `stage.finished` (a group) | `STEP_STARTED` / `STEP_FINISHED` (`stepName`) | child INTERNAL span | — |
| `agent.registered` (static or dynamic) | `SUBAGENT_STARTED` (`name`, `parentSubagentRunId`, `parentToolCallId`) | `create_agent` | Agent Card subset |
| `agent.status` (state change + `say` + `progress`) | `ACTIVITY_SNAPSHOT` | span status / attributes | `TaskStatusUpdateEvent` |
| `agent.finished` / `agent.failed` | `SUBAGENT_FINISHED` / `SUBAGENT_ERROR` | `invoke_agent` span end, `error.type` | `COMPLETED` / `FAILED` |
| `handoff` (`from`, `to`, `reason`) | (none; `CUSTOM`) | span link + event (none defined) | `referenceTaskIds` |
| `message` (`say`, optional `to`) | `TEXT_MESSAGE_*` | opt-in `gen_ai.output.messages` | `Message` |
| `tool.started` / `tool.finished` / `tool.failed` | `TOOL_CALL_START` / `TOOL_CALL_RESULT` | `execute_tool {gen_ai.tool.name}` | — |
| `flag.raised` / `flag.resolved` (`kind`: `needs_input`, `needs_approval`, `concern`) | interrupt / `outcome: suspended` | `gen_ai.invoke_agent.exception` (for errors only) | `INPUT_REQUIRED` / `AUTH_REQUIRED` |
| `artifact` (source card, partial result) | `CUSTOM` | — | `TaskArtifactUpdateEvent` |
| `result` (final markdown + sources + flags + per-role summaries) | `RUN_FINISHED.result` | — | final `Artifact` |
| `custom.<name>` | `CUSTOM` | — | `metadata` |

Adopt AG-UI's conformance rule: producers MUST emit only `run.*` plus `agent.status`, and consumers MUST accept, and may ignore, every type, including unknown `custom.*` ([spec 1.0](https://docs.ag-ui.com/spec/1.0/events)).

### 5.2 Agent status state machine

Keep the six user-facing states for backward compatibility, add one terminal state `failed`, and turn `flag` into a typed annotation rather than overloading a state:

| MAS Office status | Meaning | A2A `TaskState` | OTel |
|---|---|---|---|
| `idle` | declared, not scheduled this run | (no task) | no span |
| `waiting` | scheduled; its stage's `after` dependencies are not done | `SUBMITTED` | no span yet |
| `working` | running | `WORKING` | `invoke_agent` span open |
| `handoff` | transient: passing output to `to` | `WORKING` (+ `handoff` event) | span event/link, then span ends OK |
| `flagged` | blocked on a human or another agent (`flag.kind = needs_input`/`needs_approval`) | `INPUT_REQUIRED` / `AUTH_REQUIRED` | span stays open |
| `done` | finished | `COMPLETED` | span end, status OK |
| `failed` (new) | errored or canceled (`reason`) | `FAILED` / `CANCELED` / `REJECTED` | span end, `error.type` |

Allowed transitions: `idle→waiting→working`; `working↔flagged`; `working→handoff→done`; `working→done|failed`; `waiting→failed` (canceled).

Non-blocking quality concerns, such as a checker's "price unverified", become `flag.raised{kind:"concern"}` while the status stays `working` or `done`. This separation follows A2A, which distinguishes interrupted states from terminal ones ([spec](https://a2a-protocol.org/latest/specification/)). Reducers must tolerate unmatched or duplicate end events (see CrewAI [#8365](https://github.com/crewAIInc/crewAI/issues/8365)).

### 5.3 Topology

- **Store a DAG and treat stages as a view.** `structure.agents[]` with `hands_to[]` edges is canonical. `groups` with `after` remain sugar that compiles to edges between all members of consecutive groups, which is exactly MAF supersteps ([events](https://learn.microsoft.com/en-us/agent-framework/workflows/events)) and ADK `ParallelAgent` inside `SequentialAgent` ([patterns](https://adk.dev/workflows/patterns/)).
- Declare `topology.mode: "staged" | "graph" | "dynamic"` so the panel picks a layout: rows of desks for staged, a layered DAG for graph, and an auto-growing office for dynamic.
- **Observed edges.** The panel draws declared edges solid and edges first seen in `handoff` events dashed. Langfuse infers its graph from observations the same way ([agent graphs](https://langfuse.com/docs/observability/features/agent-graphs)). This covers swarm-style and LLM-routed handoffs (`transfer_to_agent`, `Command(goto=...)`, OpenAI handoffs), where the edge set is only known at runtime.

### 5.4 Dynamic agents

- **Instances vs definitions.** `agent.registered` carries `agent_id` (an instance; unique per invocation, like AG-UI `subagentRunId`), `role` (a definition/name, optional and possibly declared in `structure`), `parent_id`, and `spawned_by_tool_call_id`. AG-UI and the Claude Agent SDK both use this split ([AG-UI](https://docs.ag-ui.com/concepts/events), [Claude subagents](https://code.claude.com/docs/en/agent-sdk/subagents)).
- **Auto-register.** An event for an unknown `agent_id` implicitly registers it under `parent_id`, or under the lead if none is given. Producers then never need to pre-declare.
- **Desk assignment.** Several instances of one role share a "team pod". The panel caps visible desks (Claude Code allows 20 concurrent subagents by default ([subagents](https://code.claude.com/docs/en/agent-sdk/subagents))) and collapses the rest into a counter.

### 5.5 Transport

| Layer | v0.1 choice | Why |
|---|---|---|
| Canonical | `runs/<run_id>/events.jsonl`, append-only, one writer per file or `O_APPEND` line writes | Zero dependencies. Works for an AGENTS.md coding assistant that can only write files. Replayable, like Generative Agents' replay mode ([repo](https://github.com/joonspk-research/generative_agents)). |
| Snapshot | `snapshot.json`, plus an optional `snapshot.js` (a `window.__MAS__=` wrapper) for the static `file://` panel | Keeps the awesome-mas "open the HTML file" path. The reducer, not the agent, writes it. Hand-written status files are still accepted as `agent.status` events. |
| Live | `mas-office serve`: watches files, POST `/v0/events` (single or NDJSON batch) for in-process SDKs, GET `/v0/stream` as SSE with `id: <seq>` so browsers resume via `Last-Event-ID` | SSE is enough for one-way updates. Same envelope over every transport. |
| Interop | `mas-office export --otlp` and `--ag-ui`; later `import --otlp` | Uses the mappings in §5.1. |

Writers must never block the agent. SDK emitters buffer and drop on failure, the same way Claude async hooks ([hooks](https://code.claude.com/docs/en/agent-sdk/hooks)) and OpenAI's `BatchTraceProcessor` ([tracing](https://openai.github.io/openai-agents-python/tracing/)) behave.

### 5.6 First integrations (ranked by hook stability and fit)

1. **Claude Code / Claude Agent SDK hooks.** Covers the AGENTS.md coding-assistant case, which is our main user today. Events: `SubagentStart/Stop` → `agent.registered/finished`, `Pre/PostToolUse` → `tool.*`, `PermissionRequest`/`Notification` → `flag.raised`. pixel-agents shows the approach works at scale ([repo](https://github.com/pixel-agents-hq/pixel-agents)). Ship both a shell-hook script for Claude Code and a Python/TS callback.
2. **OpenAI Agents SDK.** One `TracingProcessor` subclass, a six-method ABC ([interface](https://openai.github.io/openai-agents-python/ref/tracing/processor_interface/)), plus `RunHooks.on_handoff` for edges. Small, typed, stable surface.
3. **LangGraph.** Largest user base. Build on `stream_mode=["tasks","updates","custom"], subgraphs=True`, with `get_stream_writer()` for `say` ([streaming](https://docs.langchain.com/oss/python/langgraph/streaming)). Add a `stream_events(version="v3")` path behind a flag, because the streaming API keeps changing.
4. **Generic OTel GenAI ingest** (an OTLP/HTTP receiver in `serve` that maps `invoke_agent`/`execute_tool` spans). This one adapter covers Pydantic AI (Logfire/OTel ([multi-agent](https://pydantic.dev/docs/ai/guides/multi-agent-applications/))), MAF, ADK, and anything OpenInference-instrumented, without per-framework code. Label it "Development-status conventions".

Second wave: CrewAI `BaseEventListener` (rich, but with a churning import path and missing start events), an **AG-UI ingest** adapter (one adapter for MAF/ADK/Mastra/AG2/Pydantic AI ([repo](https://github.com/ag-ui-protocol/ag-ui))), and CAMEL `WorkforceCallback` (whose task and worker events map cleanly). Skip AutoGen (in maintenance) and MetaGPT/ChatDev (no hook API).

---

## 6. Could not verify

- AG2's current event class names and fields (`TextEvent`, `ToolCallEvent`, …) and the status of the new `ag2` v1 package API. Only `RunResponse`/`IOStream`/`RunCompletionEvent`/`ErrorEvent` and `AutoPattern`/`run_group_chat` were confirmed ([run_swarm](https://docs.ag2.ai/latest/docs/api-reference/autogen/run_swarm/)).
- CLA/DCO policy for LangGraph and CrewAI.
- Field names inside LangGraph `tasks` stream parts.
- The fields of CAMEL's `TaskCreatedEvent` and related event classes.
- The exact date and version (reported as v1.42.0) when OTel GenAI conventions moved repos. Only the "moved" notice is primary.
- The AG-UI spec 1.0 release status (draft vs final) and `RUN_STARTED` field names.
- The A2A `TaskStatus` field table. `state`, `message`, and `timestamp` were seen only in examples.
- Any "agent office" visualizer associated with Tencent Marvis. None was found, and the named Mavis repo is not a visualizer.
- Phoenix's agent graph view fields beyond `agent.name` / `graph.node.id`.
