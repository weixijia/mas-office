"""Task definitions (``eval/tasks/*.json``), conditions, and a small JSON Schema checker.

The checker covers the subset of JSON Schema that ``eval/tasks/schema.json`` uses (``type``,
``required``, ``properties``, ``additionalProperties: false``, ``items``, ``enum``, ``pattern``,
``minLength``, ``minItems``), so the harness needs no third-party package.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import TASKS_DIR, TEAMS_DIR

_TYPES = {
    "object": dict,
    "array": list,
    "string": str,
    "boolean": bool,
    "null": type(None),
}

# Conditions that `run.py run` drives through `mas-office up` (a locked design in eval/teams/<name>/).
# Anything else is an external system brought in with `run.py import`.
EXTERNAL_CONDITIONS = {
    "claude-deep-research": "Claude Code /deep-research, answer pasted in with `import`",
    "dr-product": "A Deep Research product (ChatGPT, Gemini, Perplexity ...), answer pasted in with `import`",
}


def schema_errors(schema: Dict[str, Any], value: Any, path: str = "") -> List[str]:
    """Errors of ``value`` against ``schema`` (the subset described in the module docstring)."""
    errors: List[str] = []
    at = path or "(root)"
    expected = schema.get("type")
    if expected is not None:
        names = expected if isinstance(expected, list) else [expected]
        ok = False
        for name in names:
            if name == "integer":
                ok = ok or (isinstance(value, int) and not isinstance(value, bool))
            elif name == "number":
                ok = ok or (isinstance(value, (int, float)) and not isinstance(value, bool))
            else:
                ok = ok or isinstance(value, _TYPES[name])
        if not ok:
            return [f"{at}: must be {' or '.join(names)}"]
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{at}: must be one of {', '.join(map(str, schema['enum']))}")
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0):
            errors.append(f"{at}: must have at least {schema['minLength']} characters")
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errors.append(f"{at}: must match {schema['pattern']}")
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0):
            errors.append(f"{at}: needs at least {schema['minItems']} items")
        if "items" in schema:
            for i, item in enumerate(value):
                errors.extend(schema_errors(schema["items"], item, f"{path}/{i}"))
    if isinstance(value, dict):
        for name in schema.get("required", []):
            if name not in value:
                errors.append(f"{at}: missing {name!r}")
        props = schema.get("properties", {})
        for name, item in value.items():
            if name in props:
                errors.extend(schema_errors(props[name], item, f"{path}/{name}"))
            elif schema.get("additionalProperties") is False:
                errors.append(f"{at}: unknown field {name!r}")
    return errors


def task_errors(task: Any, file_stem: Optional[str] = None) -> List[str]:
    """Schema errors plus the rules a schema cannot say: unique ids, id matches the file name."""
    schema = json.loads((TASKS_DIR / "schema.json").read_text(encoding="utf-8"))
    errors = schema_errors(schema, task)
    if errors:
        return errors
    if file_stem is not None and task["id"] != file_stem:
        errors.append(f"id {task['id']!r} must equal the file name {file_stem!r}")
    for key in ("requirements", "checks"):
        ids = [item["id"] for item in task[key]]
        dupes = sorted({i for i in ids if ids.count(i) > 1})
        if dupes:
            errors.append(f"{key}: ids used twice: {', '.join(dupes)}")
    return errors


def load_tasks(directory: Path = TASKS_DIR) -> Dict[str, Dict[str, Any]]:
    """All tasks by id, in file-name order. Raises ValueError naming every invalid file."""
    tasks: Dict[str, Dict[str, Any]] = {}
    problems: List[str] = []
    for file in sorted(directory.glob("*.json")):
        if file.name == "schema.json":
            continue
        try:
            task = json.loads(file.read_text(encoding="utf-8"))
        except ValueError as err:
            problems.append(f"{file.name}: not valid JSON ({err})")
            continue
        errors = task_errors(task, file.stem)
        if errors:
            problems.extend(f"{file.name}: {e}" for e in errors)
        else:
            tasks[task["id"]] = task
    if problems:
        raise ValueError("invalid task files:\n  " + "\n  ".join(problems))
    return tasks


def load_task(task_id: str) -> Dict[str, Any]:
    tasks = load_tasks()
    if task_id not in tasks:
        raise KeyError(f"no task {task_id!r}; known: {', '.join(tasks)}")
    return tasks[task_id]


def internal_conditions(directory: Path = TEAMS_DIR) -> Dict[str, Path]:
    """Condition name → its locked ``structure.json`` (one folder per condition under eval/teams/)."""
    return {d.name: d / "structure.json" for d in sorted(directory.iterdir()) if (d / "structure.json").is_file()}
