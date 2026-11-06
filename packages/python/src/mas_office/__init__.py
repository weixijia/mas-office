"""MAS Office: show a multi-agent system's team live in the MAS Office panel.

Protocol: https://github.com/weixijia/mas-office/tree/main/spec
"""

from .files import write_snapshots
from .office import Agent, Office, Project, Run, ToolCall, slugify
from .reducer import SPEC_VERSION, STATES, Reducer, reduce, validate_event

__version__ = "0.1.1"

__all__ = [
    "Agent",
    "Office",
    "Project",
    "Reducer",
    "Run",
    "SPEC_VERSION",
    "STATES",
    "ToolCall",
    "reduce",
    "slugify",
    "validate_event",
    "write_snapshots",
    "__version__",
]
