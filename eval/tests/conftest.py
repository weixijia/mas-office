"""Helpers for building event logs by hand."""

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

EVAL_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = EVAL_DIR.parent
for path in (EVAL_DIR, REPO_DIR / "packages" / "python" / "src"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

T0 = datetime(2026, 11, 10, 10, 0, 0, tzinfo=timezone.utc)


def at(seconds: float) -> str:
    """ISO timestamp ``seconds`` after T0."""
    return (T0 + timedelta(seconds=seconds)).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def ev(t, etype, agent="lead", ts=None, **data):
    """One event without seq; ``t`` is seconds after T0 (ignored when ``ts`` is given)."""
    return {"type": etype, "agentId": agent, "ts": ts if ts is not None else at(t), "data": data}


def write_log(project: Path, events, meta=None) -> Path:
    """Write ``events`` (stamped with v and seq) to ``project/mas/events.jsonl``. With ``meta``, also
    write the workspace's ``eval-run.json`` naming this project."""
    (project / "mas").mkdir(parents=True, exist_ok=True)
    lines = [json.dumps({"v": "0.2", "seq": i, **e}) for i, e in enumerate(events, 1)]
    (project / "mas" / "events.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")
    if meta is not None:
        (project.parent / "eval-run.json").write_text(json.dumps({"project": project.name, **meta}), encoding="utf-8")
    return project


STRUCTURE = {
    "title": "Test team", "version": 2, "locked": True,
    "lead": {"id": "lead", "name": "Lead"},
    "groups": [{"id": "A", "after": None}, {"id": "B", "after": "A"}],
    "roles": [
        {"id": "finder-a", "name": "Finder A", "group": "A", "handsTo": "checker"},
        {"id": "finder-b", "name": "Finder B", "group": "A", "handsTo": "checker"},
        {"id": "checker", "name": "Checker", "group": "B", "reviewerOf": ["finder-a", "finder-b"]},
    ],
}


@pytest.fixture
def project(tmp_path):
    return tmp_path / "ws" / "price-tablet-uk"
