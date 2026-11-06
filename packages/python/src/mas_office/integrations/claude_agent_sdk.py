"""Claude Agent SDK integration (experimental).

``office_hooks(run)`` returns the ``hooks=`` mapping for ``ClaudeAgentOptions``:

* ``SubagentStart`` → ``agent.registered`` (id from ``agent_id``, name from ``agent_type``) + ``working``
* ``SubagentStop`` → ``agent.finished``
* ``PreToolUse`` / ``PostToolUse`` / ``PostToolUseFailure`` → ``tool.started`` / ``tool.finished`` /
  ``tool.failed`` on the subagent's desk (or the lead's, on the main thread). ``Agent`` and ``Task``
  tool calls are skipped: ``SubagentStart`` already covers spawns.
* ``Notification`` → ``flag.raised`` on the lead (``needs_approval`` for permission prompts,
  otherwise ``needs_input``), resolved at that agent's next tool call
* ``Stop`` → ``run.finished``

Usage::

    from claude_agent_sdk import ClaudeAgentOptions, query
    from mas_office import Office
    from mas_office.integrations.claude_agent_sdk import office_hooks

    office = Office(workspace="./runs")
    run = office.project("code-review", title="Code review").run()
    options = ClaudeAgentOptions(agents={...}, hooks=office_hooks(run))
    async for message in query(prompt="Review this repo", options=options):
        ...
    office.close()

Written against claude-agent-sdk 0.2 (``HookMatcher``, hook input fields ``agent_id``, ``agent_type``,
``tool_name``, ``tool_use_id``, ``error``, ``message``, ``notification_type``).
Docs: https://code.claude.com/docs/en/agent-sdk/hooks and https://code.claude.com/docs/en/agent-sdk/subagents
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable, Dict, List, Optional, Set

from ..office import Agent, Run, slugify
from . import _report

SPAWN_TOOLS = ("Agent", "Task")  # "Agent" in current versions, "Task" in older ones

HookCallback = Callable[[Dict[str, Any], Optional[str], Any], Awaitable[Dict[str, Any]]]


class OfficeHooks:
    """The hook callbacks; ``office_hooks`` wraps them in ``HookMatcher`` objects."""

    def __init__(self, run: Run) -> None:
        self.run = run
        self._flagged: Set[str] = set()

    def _agent(self, input_data: Dict[str, Any]) -> Agent:
        agent_id = input_data.get("agent_id")
        if not agent_id:
            return self.run.lead
        return self.run.agent(slugify(str(agent_id)), name=str(input_data.get("agent_type") or agent_id), parent="lead")

    def _resolve(self, agent: Agent) -> None:
        if agent.id in self._flagged:
            self._flagged.discard(agent.id)
            agent.resolve()

    def _tool(self, input_data: Dict[str, Any], tool_use_id: Optional[str], phase: str) -> None:
        name = str(input_data.get("tool_name") or "tool")
        if name in SPAWN_TOOLS:
            return
        agent = self._agent(input_data)
        self._resolve(agent)
        call_id = input_data.get("tool_use_id") or tool_use_id
        if phase == "start":
            agent.tool_started(name, call_id=call_id)
        elif phase == "finished":
            agent.tool_finished(name, call_id=call_id)
        else:
            agent.tool_finished(name, call_id=call_id, error=str(input_data.get("error") or "Tool failed"))

    # hook callbacks: async def (input_data, tool_use_id, context) -> dict ---------------

    async def subagent_start(self, input_data: Dict[str, Any], tool_use_id: Optional[str], context: Any) -> Dict[str, Any]:
        try:
            self._agent(input_data).working("Starting")
        except Exception as exc:
            _report("claude_agent_sdk", exc)
        return {}

    async def subagent_stop(self, input_data: Dict[str, Any], tool_use_id: Optional[str], context: Any) -> Dict[str, Any]:
        try:
            self._agent(input_data).done()
        except Exception as exc:
            _report("claude_agent_sdk", exc)
        return {}

    async def pre_tool_use(self, input_data: Dict[str, Any], tool_use_id: Optional[str], context: Any) -> Dict[str, Any]:
        try:
            self._tool(input_data, tool_use_id, "start")
        except Exception as exc:
            _report("claude_agent_sdk", exc)
        return {}

    async def post_tool_use(self, input_data: Dict[str, Any], tool_use_id: Optional[str], context: Any) -> Dict[str, Any]:
        try:
            self._tool(input_data, tool_use_id, "finished")
        except Exception as exc:
            _report("claude_agent_sdk", exc)
        return {}

    async def post_tool_use_failure(self, input_data: Dict[str, Any], tool_use_id: Optional[str], context: Any) -> Dict[str, Any]:
        try:
            self._tool(input_data, tool_use_id, "failed")
        except Exception as exc:
            _report("claude_agent_sdk", exc)
        return {}

    async def notification(self, input_data: Dict[str, Any], tool_use_id: Optional[str], context: Any) -> Dict[str, Any]:
        try:
            agent = self._agent(input_data)
            kind = "needs_approval" if "permission" in str(input_data.get("notification_type") or "") else "needs_input"
            agent.flag(str(input_data.get("message") or "Needs attention"), kind=kind)
            self._flagged.add(agent.id)
        except Exception as exc:
            _report("claude_agent_sdk", exc)
        return {}

    async def stop(self, input_data: Dict[str, Any], tool_use_id: Optional[str], context: Any) -> Dict[str, Any]:
        try:
            self.run.finish()
        except Exception as exc:
            _report("claude_agent_sdk", exc)
        return {}

    def callbacks(self) -> Dict[str, HookCallback]:
        return {
            "SubagentStart": self.subagent_start,
            "SubagentStop": self.subagent_stop,
            "PreToolUse": self.pre_tool_use,
            "PostToolUse": self.post_tool_use,
            "PostToolUseFailure": self.post_tool_use_failure,
            "Notification": self.notification,
            "Stop": self.stop,
        }


def office_hooks(run: Run) -> Dict[str, List[Any]]:
    """The ``hooks=`` mapping for ``ClaudeAgentOptions``, one ``HookMatcher`` per event."""
    from claude_agent_sdk import HookMatcher

    return {event: [HookMatcher(hooks=[callback])] for event, callback in OfficeHooks(run).callbacks().items()}
