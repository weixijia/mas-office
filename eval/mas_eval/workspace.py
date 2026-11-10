"""Eval workspaces: ``prepare`` one for a task and condition, ``import`` an external system's answer,
and the facts ``run.py run`` prints before it spends anyone's subscription.

A workspace is a normal MAS Office workspace with one project (named after the task) plus
``eval-run.json`` at the workspace root. The rubric never goes into the project folder: the
sessions run there and can read it.
"""

from __future__ import annotations

import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from mas_office import reduce, validate_event, write_snapshots

from . import REPO_DIR
from .metrics import IMPORT_MARKER
from .tasks import internal_conditions, load_task

DEFAULT_ROOT = Path.home() / "mas-office-eval"
CONDITION_NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
URL = re.compile(r"https?://[^\s<>()\[\]\"'`]+")
SOURCE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")

BACKEND_ACCOUNT = {
    "claude-code": "your own Claude Code sign-in (the `claude` program; your Claude plan or API key)",
    "codex": "your own Codex sign-in (the `codex` program; your ChatGPT plan or API key)",
}
BACKEND_BINARY = {"claude-code": "claude", "codex": "codex"}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(when: datetime) -> str:
    return when.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _inside(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def new_workspace(task_id: str, condition: str, out: Optional[Path], now: datetime) -> Path:
    """The folder for a new workspace: ``out`` or ``~/mas-office-eval/<task>-<condition>-<UTC time>``.
    Refuses a folder inside this repository (Claude Code loads parent ``CLAUDE.md`` files, which
    would leak developer instructions into the sessions) and a folder that is not empty."""
    workspace = Path(out).expanduser().resolve() if out else DEFAULT_ROOT / f"{task_id}-{condition}-{now.strftime('%Y%m%d-%H%M%S')}"
    if _inside(workspace, REPO_DIR):
        raise ValueError(f"{workspace} is inside the repository; eval workspaces must live outside it")
    if workspace.exists() and any(workspace.iterdir()):
        raise ValueError(f"{workspace} exists and is not empty")
    return workspace


def instruction_files_above(workspace: Path) -> List[Path]:
    """``CLAUDE.md`` / ``AGENTS.md`` files in folders above the workspace (a warning, not an error)."""
    found = []
    for folder in Path(workspace).resolve().parents:
        for name in ("CLAUDE.md", "AGENTS.md"):
            if (folder / name).is_file():
                found.append(folder / name)
    return found


def _base_workspace(workspace: Path, task: Dict[str, Any], meta: Dict[str, Any]) -> Path:
    project = workspace / task["id"]
    _write_json(workspace / "home" / "projects.json",
                {"current": task["id"], "projects": [{"folder": task["id"], "title": task["title"]}]})
    _write_json(project / "me" / "task.json",
                {"title": task["title"], "summary": task["task"], "requirements": task["requirements"]})
    _write_json(workspace / "eval-run.json", {"project": task["id"], "task": task["id"], **meta})
    return project


def prepare(task_id: str, condition: str, out: Optional[Path] = None, now: Optional[datetime] = None) -> Path:
    """Create a workspace for ``task_id`` run by the locked design of ``condition``. Returns the
    workspace folder; the project is ``<workspace>/<task_id>``."""
    conditions = internal_conditions()
    if condition not in conditions:
        raise KeyError(f"no team design for condition {condition!r}; known: {', '.join(conditions)}")
    task = load_task(task_id)
    now = now or _now()
    structure = json.loads(conditions[condition].read_text(encoding="utf-8"))
    if structure.get("locked") is not True or not structure.get("signature"):
        raise ValueError(f"{conditions[condition]} is not locked; lock it first (see eval/README.md)")
    workspace = new_workspace(task_id, condition, out, now)
    project = _base_workspace(workspace, task, {
        "condition": condition, "preparedAt": _iso(now), "signature": structure["signature"], "imported": False,
    })
    (project / "mas").mkdir(parents=True, exist_ok=True)
    shutil.copyfile(conditions[condition], project / "mas" / "structure.json")
    return workspace


def sessions_of(workspace: Path) -> List[Dict[str, str]]:
    """Who will run, on which backend, and whose account pays: one row per Lead / role."""
    meta = json.loads((workspace / "eval-run.json").read_text(encoding="utf-8"))
    structure = json.loads((workspace / meta["project"] / "mas" / "structure.json").read_text(encoding="utf-8"))
    rows = []
    for who in [structure["lead"], *structure["roles"]]:
        backend = who.get("backend") or "claude-code"
        rows.append({"id": who["id"], "name": who.get("name", who["id"]), "backend": backend,
                     "account": BACKEND_ACCOUNT.get(backend, backend),
                     "installed": shutil.which(BACKEND_BINARY.get(backend, backend)) is not None})
    return rows


def _sources_from(answer: str, sources_file: Optional[Path]) -> List[Dict[str, Any]]:
    if sources_file is not None:
        raw = json.loads(Path(sources_file).read_text(encoding="utf-8"))
        if not isinstance(raw, list):
            raise ValueError("--sources must be a JSON list of {id, url, title?, evidence?}")
        out = []
        for i, s in enumerate(raw):
            if not isinstance(s, dict) or not isinstance(s.get("id"), str) or not SOURCE_ID.match(s["id"]):
                raise ValueError(f"--sources item {i}: needs an id of letters, digits, '-' or '_'")
            out.append({k: s[k] for k in ("id", "title", "url", "evidence") if isinstance(s.get(k), str)})
        return out
    urls: List[str] = []
    for url in URL.findall(answer):
        url = url.rstrip(".,;:!?")
        if url not in urls:
            urls.append(url)
    return [{"id": f"s{i}", "title": url, "url": url} for i, url in enumerate(urls, 1)]


def import_answer(task_id: str, condition: str, answer_file: Path, sources_file: Optional[Path] = None,
                  out: Optional[Path] = None, wall_minutes: Optional[float] = None, cost_usd: Optional[float] = None,
                  now: Optional[datetime] = None) -> Path:
    """A workspace whose log holds an external system's answer as a ``result``, so ``mas-office
    verify`` (link health; claim tags when the answer has them) and the rubric sheet apply as for
    our own runs. Sources come from ``sources_file`` or, without it, from every URL in the answer."""
    if not CONDITION_NAME.match(condition):
        raise ValueError("the condition name uses lower-case letters, digits and '-' (at most 40)")
    if condition in internal_conditions():
        raise ValueError(f"{condition!r} is one of our team designs; use `run`, not `import`")
    task = load_task(task_id)
    now = now or _now()
    answer = Path(answer_file).read_text(encoding="utf-8")
    sources = _sources_from(answer, sources_file)
    workspace = new_workspace(task_id, condition, out, now)
    project = _base_workspace(workspace, task, {"condition": condition, "preparedAt": _iso(now), "imported": True})
    marker: Dict[str, Any] = {"system": condition}
    if wall_minutes is not None:
        marker["wallSeconds"] = wall_minutes * 60
    if cost_usd is not None:
        marker["costUsd"] = cost_usd
    structure = {"title": task["title"], "version": 1, "locked": True,
                 "lead": {"id": "lead", "name": condition, "job": "External system (imported answer)"}, "roles": []}
    ts = _iso(now)
    events = [
        {"type": "run.started", "data": {"title": task["title"], "structure": structure}},
        {"type": IMPORT_MARKER, "data": marker},
        {"type": "result", "data": {"title": task["title"], "markdown": answer, "sources": sources}},
        {"type": "run.finished", "data": {"say": "Imported"}},
    ]
    events = [{"v": "0.2", "seq": i, "ts": ts, "runId": "import-1", "agentId": "lead", **e} for i, e in enumerate(events, 1)]
    bad = [e["type"] for e in events if not validate_event(e)]
    if bad:
        raise ValueError(f"internal error: invalid events {bad}")
    lines = [json.dumps(e, ensure_ascii=False) for e in events]
    (project / "mas").mkdir(parents=True, exist_ok=True)
    (project / "mas" / "events.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")
    write_snapshots(project, reduce(lines))
    return workspace
