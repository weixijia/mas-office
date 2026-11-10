"""MAS Office evaluation harness: metrics from a run's event log, comparison reports,
rubric sheets for human (or external) raters, and workspace preparation for eval runs.

Standard library only. The protocol reducer comes from ``mas_office`` (packages/python/src).
"""

from pathlib import Path

EVAL_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = EVAL_DIR.parent
TASKS_DIR = EVAL_DIR / "tasks"
TEAMS_DIR = EVAL_DIR / "teams"

__all__ = ["EVAL_DIR", "REPO_DIR", "TASKS_DIR", "TEAMS_DIR"]
