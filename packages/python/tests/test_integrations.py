"""Integrations driven by fake objects that mimic each framework's payloads (no framework installed)."""

import asyncio
import importlib
import json
import sys
import types
from dataclasses import dataclass, field
from typing import Any, List, Optional

import pytest

from mas_office import Office, reduce


@pytest.fixture
def run(tmp_path):
    office = Office(workspace=tmp_path)
    run = office.project("p").run()
    yield run
    office.close()


def events_of(run):
    log = run.project.office.workspace / "p" / "mas" / "events.jsonl"
    return [json.loads(line) for line in log.read_bytes().decode("utf-8").split("\n") if line]


def snapshot_of(run):
    return reduce(json.dumps(e) for e in events_of(run))


# ----------------------------------------------------------------- OpenAI Agents SDK


class AgentSpanData:
    type = "agent"

    def __init__(self, name):
        self.name = name


class FunctionSpanData:
    type = "function"

    def __init__(self, name):
        self.name = name


class HandoffSpanData:
    type = "handoff"

    def __init__(self, from_agent, to_agent=None):
        self.from_agent, self.to_agent = from_agent, to_agent


@dataclass
class FakeSpan:
    span_id: str
    span_data: Any
    trace_id: str = "trace_1"
    parent_id: Optional[str] = None
    error: Optional[dict] = None


def test_openai_agents_processor(run):
    from mas_office.integrations.openai_agents import OfficeTracingProcessor

    p = OfficeTracingProcessor(run)
    p.on_trace_start(object())
    triage = FakeSpan("span_a", AgentSpanData("Triage Agent"))
    p.on_span_start(triage)
    tool = FakeSpan("span_t", FunctionSpanData("lookup_order"), parent_id="span_a")
    p.on_span_start(tool)
    p.on_span_end(tool)
    bad_tool = FakeSpan("span_t2", FunctionSpanData("refund"), parent_id="span_a", error={"message": "denied", "data": None})
    p.on_span_start(bad_tool)
    p.on_span_end(bad_tool)
    handoff = FakeSpan("span_h", HandoffSpanData("Triage Agent"), parent_id="span_a")
    p.on_span_start(handoff)
    handoff.span_data.to_agent = "Refund Agent"  # the SDK fills to_agent after the handoff runs
    p.on_span_end(handoff)
    p.on_span_end(triage)
    refund = FakeSpan("span_b", AgentSpanData("Refund Agent"))
    p.on_span_start(refund)
    refund.error = {"message": "Max turns exceeded", "data": None}
    p.on_span_end(refund)
    p.on_trace_end(object())
    p.force_flush()
    p.shutdown()

    events = events_of(run)
    tools = [(e["type"], e["agentId"], e["data"].get("name")) for e in events if e["type"].startswith("tool.")]
    assert tools == [("tool.started", "triage-agent", "lookup_order"), ("tool.finished", "triage-agent", "lookup_order"),
                     ("tool.started", "triage-agent", "refund"), ("tool.failed", "triage-agent", "refund")]
    handoffs = [e for e in events if e["type"] == "handoff"]
    assert handoffs[0]["agentId"] == "triage-agent" and handoffs[0]["data"]["to"] == "refund-agent"
    snap = snapshot_of(run)
    assert {r["id"]: r["name"] for r in snap["structure"]["roles"]} == {"triage-agent": "Triage Agent", "refund-agent": "Refund Agent"}
    assert snap["statuses"]["triage-agent"]["state"] == "done"
    assert snap["statuses"]["refund-agent"]["state"] == "failed"
    assert snap["statuses"]["refund-agent"]["flag"] == "Max turns exceeded"


def test_openai_agents_subclasses_real_interface_and_installs(run, monkeypatch):
    added = []

    class TracingProcessor:  # stands in for agents.tracing.TracingProcessor
        pass

    agents_mod = types.ModuleType("agents")
    tracing_mod = types.ModuleType("agents.tracing")
    tracing_mod.TracingProcessor = TracingProcessor
    agents_mod.tracing = tracing_mod
    agents_mod.add_trace_processor = added.append
    monkeypatch.setitem(sys.modules, "agents", agents_mod)
    monkeypatch.setitem(sys.modules, "agents.tracing", tracing_mod)

    import mas_office.integrations.openai_agents as integration

    integration = importlib.reload(integration)
    try:
        processor = integration.install(run)
        assert isinstance(processor, TracingProcessor)
        assert added == [processor]
    finally:
        monkeypatch.undo()
        importlib.reload(integration)


# ------------------------------------------------------------------------- LangGraph


def test_langgraph_stream(run):
    from mas_office.integrations.langgraph import stream_to_office

    chunks = [
        ((), "tasks", {"id": "t0", "name": "__start__", "input": {}, "triggers": ["__start__"]}),
        ((), "tasks", {"id": "t1", "name": "researcher", "input": {}, "triggers": ["branch:to:researcher"]}),
        (("researcher:t1",), "tasks", {"id": "t2", "name": "search", "input": {}, "triggers": ["x"]}),
        (("researcher:t1",), "custom", {"say": "Reading 3 papers", "progress": 40}),
        (("researcher:t1",), "tasks", {"id": "t2", "name": "search", "error": None, "result": {}, "interrupts": []}),
        ((), "custom", {"say": "Summarising", "agent": "researcher"}),
        ((), "updates", {"researcher": {"notes": "…"}}),
        ((), "tasks", {"id": "t1", "name": "researcher", "error": None, "result": {"notes": "…"}, "interrupts": []}),
        ("tasks", {"id": "t3", "name": "writer", "input": {}, "triggers": ["x"]}),
        ("tasks", {"id": "t3", "name": "writer", "error": "ValueError('bad')", "result": {}, "interrupts": []}),
        {"type": "tasks", "ns": (), "data": {"id": "t4", "name": "approver", "input": {}, "triggers": ["x"]}},
        {"type": "tasks", "ns": (), "data": {"id": "t4", "name": "approver", "error": None, "result": {},
                                              "interrupts": [{"value": "Approve the plan?", "id": "i1"}]}},
        "something else entirely",
    ]
    out = list(stream_to_office(iter(chunks), run))
    assert out == chunks  # yielded unchanged

    snap = snapshot_of(run)
    roles = {r["id"]: r for r in snap["structure"]["roles"]}
    assert set(roles) == {"researcher", "search", "writer", "approver"}
    assert roles["search"]["parent"] == "researcher"
    st = snap["statuses"]
    assert st["search"]["state"] == "done" and st["search"]["progress"] == 100
    assert st["researcher"]["state"] == "done"
    assert st["writer"]["state"] == "failed" and st["writer"]["flag"] == "ValueError('bad')"
    assert st["approver"]["state"] == "flagged" and st["approver"]["flagKind"] == "needs_input"
    assert st["approver"]["flag"] == "Approve the plan?"
    custom = [e for e in events_of(run) if e["data"].get("say") == "Reading 3 papers"]
    assert custom[0]["agentId"] == "search" and custom[0]["data"]["progress"] == 40
    messages = [e for e in events_of(run) if e["type"] == "message"]
    assert messages[0]["agentId"] == "researcher" and messages[0]["data"]["text"] == "Summarising"


def test_langgraph_async_stream(run):
    from mas_office.integrations.langgraph import astream_to_office

    async def source():
        yield ("tasks", {"id": "t1", "name": "node", "input": {}, "triggers": []})
        yield ("tasks", {"id": "t1", "name": "node", "error": None, "result": {}, "interrupts": []})

    async def collect():
        return [c async for c in astream_to_office(source(), run)]

    assert len(asyncio.run(collect())) == 2
    assert snapshot_of(run)["statuses"]["node"]["state"] == "done"


# ------------------------------------------------------------------ Claude Agent SDK


@dataclass
class HookMatcher:  # mimics claude_agent_sdk.HookMatcher
    matcher: Optional[str] = None
    hooks: List[Any] = field(default_factory=list)
    timeout: Optional[float] = None


def test_claude_agent_sdk_hooks(run, monkeypatch):
    fake = types.ModuleType("claude_agent_sdk")
    fake.HookMatcher = HookMatcher
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", fake)
    from mas_office.integrations.claude_agent_sdk import office_hooks

    hooks = office_hooks(run)
    assert set(hooks) == {"SubagentStart", "SubagentStop", "PreToolUse", "PostToolUse", "PostToolUseFailure",
                          "Notification", "Stop"}
    assert all(isinstance(m, HookMatcher) and len(m.hooks) == 1 for ms in hooks.values() for m in ms)

    def call(event, data, tool_use_id=None):
        base = {"session_id": "s", "transcript_path": "/t", "cwd": "/w", "hook_event_name": event}
        out = asyncio.run(hooks[event][0].hooks[0]({**base, **data}, tool_use_id, None))
        assert out == {}

    call("PreToolUse", {"tool_name": "Agent", "tool_input": {}, "tool_use_id": "tu0"}, "tu0")  # spawn: skipped
    call("SubagentStart", {"agent_id": "a1B2", "agent_type": "code-reviewer"})
    call("PreToolUse", {"tool_name": "Read", "tool_input": {}, "tool_use_id": "tu1", "agent_id": "a1B2",
                        "agent_type": "code-reviewer"}, "tu1")
    call("PostToolUse", {"tool_name": "Read", "tool_input": {}, "tool_response": "…", "tool_use_id": "tu1",
                         "agent_id": "a1B2", "agent_type": "code-reviewer"}, "tu1")
    call("PostToolUseFailure", {"tool_name": "Bash", "tool_input": {}, "tool_use_id": "tu2", "error": "exit 1",
                                "agent_id": "a1B2", "agent_type": "code-reviewer"}, "tu2")
    call("SubagentStop", {"agent_id": "a1B2", "agent_type": "code-reviewer", "stop_hook_active": False,
                          "agent_transcript_path": "/t2"})
    call("Notification", {"message": "Claude needs your permission to use Bash", "notification_type": "permission_prompt"})
    snap = snapshot_of(run)
    assert snap["statuses"]["lead"]["state"] == "flagged"
    assert snap["statuses"]["lead"]["flagKind"] == "needs_approval"
    call("PreToolUse", {"tool_name": "Bash", "tool_input": {}, "tool_use_id": "tu3"}, "tu3")  # resolves the flag
    call("PostToolUse", {"tool_name": "Bash", "tool_input": {}, "tool_response": "", "tool_use_id": "tu3"}, "tu3")
    call("Stop", {"stop_hook_active": False})

    events = events_of(run)
    assert not any(e["data"].get("name") in ("Agent", "Task") for e in events)
    tools = [(e["type"], e["agentId"], e["data"].get("callId")) for e in events if e["type"].startswith("tool.")]
    assert tools == [("tool.started", "a1b2", "tu1"), ("tool.finished", "a1b2", "tu1"), ("tool.failed", "a1b2", "tu2"),
                     ("tool.started", "lead", "tu3"), ("tool.finished", "lead", "tu3")]
    assert "flag.resolved" in [e["type"] for e in events]
    snap = snapshot_of(run)
    assert snap["structure"]["roles"][0]["name"] == "code-reviewer"
    assert snap["statuses"]["a1b2"]["state"] == "done"
    assert snap["state"]["phase"] == "done"


# ------------------------------------------- a framework agent called "Lead" stays separate


def assert_separate_lead(run):
    snap = snapshot_of(run)
    assert "lead-agent" in snap["statuses"]
    assert snap["statuses"]["lead-agent"]["state"] == "done"
    assert snap["statuses"]["lead"]["state"] == "working"  # the MAS Office lead is untouched
    assert {r["id"]: r["name"] for r in snap["structure"]["roles"]}["lead-agent"] == "Lead"


def test_openai_agents_agent_named_lead(run):
    from mas_office.integrations.openai_agents import OfficeTracingProcessor

    p = OfficeTracingProcessor(run)
    span = FakeSpan("span_l", AgentSpanData("Lead"))
    p.on_span_start(span)
    p.on_span_end(span)
    assert_separate_lead(run)


def test_langgraph_node_named_lead(run):
    from mas_office.integrations.langgraph import stream_to_office

    chunks = [
        ("tasks", {"id": "t1", "name": "Lead", "input": {}, "triggers": []}),
        ("tasks", {"id": "t1", "name": "Lead", "error": None, "result": {}, "interrupts": []}),
    ]
    list(stream_to_office(iter(chunks), run))
    assert_separate_lead(run)


def test_claude_agent_sdk_subagent_named_lead(run, monkeypatch):
    fake = types.ModuleType("claude_agent_sdk")
    fake.HookMatcher = HookMatcher
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", fake)
    from mas_office.integrations.claude_agent_sdk import office_hooks

    hooks = office_hooks(run)
    for event, extra in (("SubagentStart", {}), ("SubagentStop", {"stop_hook_active": False})):
        data = {"session_id": "s", "hook_event_name": event, "agent_id": "Lead", "agent_type": "Lead", **extra}
        asyncio.run(hooks[event][0].hooks[0](data, None, None))
    assert_separate_lead(run)
