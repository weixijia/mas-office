"""Experimental framework integrations. Each module imports its framework lazily.

* ``mas_office.integrations.openai_agents`` - OpenAI Agents SDK tracing processor
* ``mas_office.integrations.langgraph`` - wrap a LangGraph ``stream()`` iterator
* ``mas_office.integrations.claude_agent_sdk`` - hooks for ``ClaudeAgentOptions``
"""

from __future__ import annotations

import warnings

_reported: set[str] = set()


def _report(where: str, exc: BaseException) -> None:
    """Integrations never raise into the framework: warn once per integration, then stay quiet."""
    if where not in _reported:
        _reported.add(where)
        warnings.warn(f"mas-office {where}: ignored an error while mapping an event: {exc!r}", RuntimeWarning, stacklevel=3)
