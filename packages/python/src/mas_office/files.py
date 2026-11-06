"""Snapshot files: ``.json`` documents plus their ``.js`` twins (spec 1.1), written atomically."""

from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional, Union

PathLike = Union[str, "os.PathLike[str]"]

# Global assigned by each document's ``.js`` twin.
GLOBALS: Dict[str, str] = {
    "home/projects": "MAS_HOME",
    "home/env": "MAS_ENV",
    "mas/env": "MAS_ENV",
    "me/task": "MAS_TASK",
    "mas/structure": "MAS_STRUCTURE",
    "mas/state": "MAS_STATE",
    "outputs/result": "MAS_RESULT",
}

# Status files are only written for ids that are safe as file names (role ids, plus "lead").
SAFE_AGENT_ID = re.compile(r"[a-z0-9][a-z0-9-]*")


def dumps(value: Any) -> str:
    """JSON as MAS Office writes it: UTF-8 text, two-space indent."""
    return json.dumps(value, ensure_ascii=False, indent=2)


def write_text_atomic(path: PathLike, text: str) -> None:
    """Write ``text`` to a temp file in the same folder, then rename it over ``path``."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(target.parent), prefix=f".{target.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        os.replace(tmp, target)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def write_document(base: PathLike, value: Any, global_name: str) -> None:
    """Write ``<base>.json`` and its twin ``<base>.js`` (``window.<global_name> = …;``)."""
    text = dumps(value)
    base = Path(base)
    write_text_atomic(base.with_name(base.name + ".json"), text + "\n")
    write_text_atomic(base.with_name(base.name + ".js"), f"window.{global_name} = {text};\n")


def remove_document(base: PathLike) -> None:
    """Remove ``<base>.json`` and ``<base>.js`` if they exist."""
    base = Path(base)
    for suffix in (".json", ".js"):
        try:
            base.with_name(base.name + suffix).unlink()
        except FileNotFoundError:
            pass


def write_status(project_dir: PathLike, agent_id: str, status: Dict[str, Any]) -> None:
    """Write ``mas/status/<agent_id>.json`` and its ``.js`` twin."""
    if not SAFE_AGENT_ID.fullmatch(agent_id):
        raise ValueError(f"unsafe agent id for a status file: {agent_id!r}")
    text = dumps(status)
    base = Path(project_dir) / "mas" / "status" / agent_id
    key = json.dumps(agent_id)
    write_text_atomic(base.with_name(agent_id + ".json"), text + "\n")
    write_text_atomic(
        base.with_name(agent_id + ".js"),
        f"window.MAS_STATUS = window.MAS_STATUS || {{}}; window.MAS_STATUS[{key}] = {text};\n",
    )


def write_snapshots(project_dir: PathLike, snapshot: Dict[str, Any], previous: Optional[Dict[str, Any]] = None) -> None:
    """Write a reducer snapshot as ``mas/structure``, ``mas/status/*``, ``mas/state`` and ``outputs/result``.

    With ``previous`` (the snapshot written last time), unchanged documents are skipped.
    Status files are skipped for ids that are not safe file names (see ``SAFE_AGENT_ID``).
    """
    root = Path(project_dir)
    prev = previous or {}
    for key, rel in (("structure", "mas/structure"), ("state", "mas/state")):
        if key not in prev or prev[key] != snapshot[key]:
            write_document(root / rel, snapshot[key], GLOBALS[rel])
    if snapshot["result"] is None:
        # Spec §4.5: never leave the previous run's result looking current.
        remove_document(root / "outputs/result")
    elif "result" not in prev or prev["result"] != snapshot["result"]:
        write_document(root / "outputs/result", snapshot["result"], GLOBALS["outputs/result"])
    prev_statuses = prev.get("statuses") or {}
    for agent_id, status in snapshot["statuses"].items():
        if prev_statuses.get(agent_id) != status and SAFE_AGENT_ID.fullmatch(agent_id):
            write_status(root, agent_id, status)


def read_document(base: PathLike) -> Any:
    """Read ``<base>.json``, falling back to the ``.js`` twin. Returns None if missing or unreadable."""
    base = Path(base)
    try:
        return json.loads(base.with_name(base.name + ".json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    try:
        text = base.with_name(base.name + ".js").read_text(encoding="utf-8")
    except OSError:
        return None
    _, sep, rest = text.partition("=")
    if not sep:
        return None
    try:
        return json.loads(rest.strip().rstrip(";"))
    except ValueError:
        return None
