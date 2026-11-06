"""OpenAI Agents SDK integration (experimental).

A ``TracingProcessor`` that turns the SDK's spans into MAS Office events:

* agent span start → ``agent.status working``; end → ``agent.finished`` (``agent.failed`` on error)
* function span start/end → ``tool.started`` / ``tool.finished`` (``tool.failed`` on error),
  attributed to the agent span that contains it
* handoff span end → ``handoff`` from ``from_agent`` to ``to_agent``

Agent ids are ``slugify(agent.name)``. Usage::

    from agents import Agent, Runner
    from mas_office import Office
    from mas_office.integrations.openai_agents import install

    office = Office(workspace="./runs")
    run = office.project("support-desk", title="Support desk").run()
    install(run)                        # agents.add_trace_processor(OfficeTracingProcessor(run))
    result = Runner.run_sync(triage_agent, "My order never arrived")
    run.result(markdown=str(result.final_output))
    run.finish()
    office.close()

Written against openai-agents 0.24 (``agents.tracing.TracingProcessor``, ``agents.add_trace_processor``,
span data types ``agent`` / ``function`` / ``handoff``). Docs:
https://openai.github.io/openai-agents-python/tracing/ and
https://openai.github.io/openai-agents-python/ref/tracing/processor_interface/
"""

from __future__ import annotations

import threading
from typing import Any, Dict, Optional

from ..office import Agent, Run, slugify
from . import _report


def _base_class() -> Any:
    """The SDK's ``TracingProcessor`` when installed (it is an optional extra), else ``object``."""
    try:
        from agents.tracing import TracingProcessor

        return TracingProcessor
    except ImportError:
        return object


def _error_message(span: Any) -> Optional[str]:
    error = getattr(span, "error", None)
    if not error:
        return None
    if isinstance(error, dict):
        return str(error.get("message") or "Error")
    return str(error)


class OfficeTracingProcessor(_base_class()):  # type: ignore[misc]
    """Maps OpenAI Agents SDK spans to events on ``run``. Never raises into the SDK."""

    def __init__(self, run: Run) -> None:
        self.run = run
        self._lock = threading.Lock()
        self._span_agent: Dict[str, Agent] = {}  # agent span id -> agent
        self._trace_agent: Dict[str, Agent] = {}  # trace id -> agent whose span started last

    # TracingProcessor interface ------------------------------------------------

    def on_trace_start(self, trace: Any) -> None:
        return None

    def on_trace_end(self, trace: Any) -> None:
        return None

    def on_span_start(self, span: Any) -> None:
        try:
            data = span.span_data
            kind = getattr(data, "type", None)
            if kind == "agent":
                agent = self._agent(getattr(data, "name", None))
                with self._lock:
                    self._span_agent[span.span_id] = agent
                    self._trace_agent[span.trace_id] = agent
                agent.working("Working")
            elif kind == "function":
                self._owner(span).tool_started(str(getattr(data, "name", None) or "tool"), call_id=span.span_id)
        except Exception as exc:  # never break the user's run
            _report("openai_agents", exc)

    def on_span_end(self, span: Any) -> None:
        try:
            data = span.span_data
            kind = getattr(data, "type", None)
            error = _error_message(span)
            if kind == "agent":
                with self._lock:
                    agent = self._span_agent.pop(span.span_id, None)
                agent = agent or self._agent(getattr(data, "name", None))
                if error:
                    agent.fail(error)
                else:
                    agent.done()
            elif kind == "function":
                self._owner(span).tool_finished(str(getattr(data, "name", None) or "tool"),
                                                call_id=span.span_id, error=error)
            elif kind == "handoff":
                source, target = getattr(data, "from_agent", None), getattr(data, "to_agent", None)
                if source and target:
                    self._agent(source).handoff(self._agent(target))
        except Exception as exc:  # never break the user's run
            _report("openai_agents", exc)

    def shutdown(self) -> None:
        self.run.project.office.flush()

    def force_flush(self) -> None:
        self.run.project.office.flush()

    # helpers ------------------------------------------------------------------

    def _agent(self, name: Any) -> Agent:
        label = str(name or "agent")
        return self.run.agent(slugify(label), name=label)

    def _owner(self, span: Any) -> Agent:
        """The agent whose span encloses ``span`` (or the latest agent in the trace, or the lead)."""
        with self._lock:
            owner = self._span_agent.get(getattr(span, "parent_id", None) or "")
            return owner or self._trace_agent.get(getattr(span, "trace_id", None) or "") or self.run.lead


def install(run: Run) -> OfficeTracingProcessor:
    """Create a processor for ``run`` and register it with ``agents.add_trace_processor`` (keeps other exporters)."""
    from agents import add_trace_processor

    processor = OfficeTracingProcessor(run)
    add_trace_processor(processor)
    return processor
