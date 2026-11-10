"""Comparison tables over several runs' metrics (``run_metrics`` dicts), as Markdown."""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional, Tuple

Getter = Callable[[Dict[str, Any]], Optional[float]]

MIN_N_FOR_TESTS = 5


def _get(*path: str) -> Getter:
    def get(run: Dict[str, Any]) -> Optional[float]:
        value: Any = run
        for key in path:
            if not isinstance(value, dict):
                return None
            value = value.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        return float(value)
    return get


def _done(run: Dict[str, Any]) -> Optional[float]:
    outcome = (run.get("cost_time") or {}).get("outcome")
    return None if outcome is None else float(outcome == "done")


def _tokens(run: Dict[str, Any]) -> Optional[float]:
    ct = run.get("cost_time") or {}
    parts = [ct.get("tokens_in"), ct.get("tokens_out")]
    return None if all(p is None for p in parts) else sum(p for p in parts if p is not None) / 1000


def _minutes(*path: str) -> Getter:
    get = _get(*path)
    return lambda run: None if get(run) is None else get(run) / 60


def _rubric(run: Dict[str, Any]) -> Optional[float]:
    return _get("rubric", "score")(run)


# (column, getter, decimals). Shares are shown as 0–1.
COLUMNS: List[Tuple[str, Getter, int]] = [
    ("done", _done, 2),
    ("claims", _get("verification", "checkworthy"), 1),
    ("support rate", _get("verification", "support_rate"), 2),
    ("cited", _get("verification", "citation_coverage"), 2),
    ("dead/invented links", _get("verification", "dead_or_invented_rate"), 2),
    ("contradicted", _get("verification", "contradicted"), 1),
    ("caught in review", _get("errors_caught", "caught_by_review"), 1),
    ("checker disagreements", _get("errors_caught", "checker_disagreements"), 1),
    ("requests to you", _get("supervision", "requests_reaching_person"), 1),
    ("your answer time, median s", _get("supervision", "time_to_resolve_s", "median"), 0),
    ("blocked agent-min", _minutes("supervision", "blocked_agent_seconds"), 1),
    ("tokens (k)", _tokens, 0),
    ("cost USD", _get("cost_time", "cost_usd"), 2),
    ("wall min", _minutes("cost_time", "wall_seconds"), 1),
    ("rubric", _rubric, 2),
]


def _cell(runs: List[Dict[str, Any]], get: Getter, decimals: int) -> str:
    values = [v for v in (get(r) for r in runs) if v is not None]
    if not values:
        return "—"
    text = f"{sum(values) / len(values):.{decimals}f}"
    return text if len(values) == len(runs) else f"{text} ({len(values)}/{len(runs)})"


def _table(groups: Dict[str, List[Dict[str, Any]]]) -> List[str]:
    header = ["condition", "n"] + [c[0] for c in COLUMNS]
    lines = ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
    for condition, runs in groups.items():
        lines.append("| " + " | ".join([condition, str(len(runs))] + [_cell(runs, g, d) for _, g, d in COLUMNS]) + " |")
    return lines


def _group(runs: List[Dict[str, Any]], key: str) -> Dict[str, List[Dict[str, Any]]]:
    out: Dict[str, List[Dict[str, Any]]] = {}
    for run in runs:
        out.setdefault(run.get(key) or "(unknown)", []).append(run)
    return out


def compare(runs: List[Dict[str, Any]]) -> str:
    """One table per task (a row per condition: mean over that condition's runs) and an aggregate
    table per condition over all tasks. A cell shows the mean over the runs that have the value;
    ``(k/n)`` means only k of the n runs had it; ``—`` means none did."""
    if not runs:
        return "No runs to compare.\n"
    out = [
        "# Evaluation results",
        "",
        "Cells are means over runs. `(k/n)`: only k of n runs had the value. `—`: no run had it. "
        "Rates are 0–1. `done` is the share of runs that finished. `cost USD` is a lower bound when an "
        "agent's backend reports no cost (see `cost_missing_agents` in each run's metrics).",
        "",
    ]
    for task, task_runs in sorted(_group(runs, "task").items()):
        out += [f"## Task: {task}", ""] + _table(dict(sorted(_group(task_runs, "condition").items()))) + [""]
    by_condition = dict(sorted(_group(runs, "condition").items()))
    out += ["## All tasks", ""] + _table(by_condition) + [""]
    small = sorted(c for c, rs in by_condition.items() if len(rs) < MIN_N_FOR_TESTS)
    out.append("No significance tests are computed here; these are descriptive means.")
    if small:
        out.append(f"n < {MIN_N_FOR_TESTS} for {', '.join(small)}: differences between conditions may be noise, "
                   "and no claim of one condition being better should rest on these numbers.")
    return "\n".join(out) + "\n"
