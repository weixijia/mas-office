"""Log-derived measures for the supervision study (``eval/hci/protocol.md``).

Two measures need marks that only the panel can write, as ``custom.*`` events in the same log:

- ``custom.ui.seen`` with ``data.requestId``: the first time the request was on screen for the
  participant (inbox row or drawer visible). Needed for time-to-notice.
- ``custom.ui.focus`` with ``data.target`` (an agent id, ``inbox``, ``result``, or a terminal pane
  name in the baseline condition): what the participant switched to. Needed for context switches.

The panel writes neither today; a study build must start it with study logging (see
``eval/hci/README.md``). Without these events the two measures are None, and everything else
still comes from the normal log.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional

from .metrics import (
    agent_of, data_of, distribution, load_events, ratio, run_scope, seconds_between, supervision_metrics,
    cost_time_metrics, track_requests,
)
from mas_office.reducer import reduce

SEEN = "custom.ui.seen"
FOCUS = "custom.ui.focus"


def request_rows(scoped: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """One row per request, for survival analysis of time-to-notice and time-to-resolve:
    ``opened``, ``firstSeen``, ``resolved`` (ISO strings or None), ``resolvedBy``,
    ``time_to_notice_s`` (opened → first seen), ``time_seen_to_resolve_s`` (first seen → resolved,
    the person's handling time), ``time_to_resolve_s`` (opened → resolved), and ``censored`` (True
    when the request was still open at the end of the log)."""
    first_seen: Dict[str, str] = {}
    for e in scoped:
        rid = data_of(e).get("requestId")
        if e["type"] == SEEN and isinstance(rid, str) and rid not in first_seen:
            first_seen[rid] = e["ts"]
    rows = []
    for r in track_requests(scoped):
        seen = first_seen.get(r["requestId"])
        # A "seen" mark from before the request was opened (clock or logging bug) is not a notice.
        notice = seconds_between(r["openedAt"], seen) if seen else None
        rows.append({
            "requestId": r["requestId"], "agentId": r["agentId"], "kind": r["kind"], "routeTo": r["routeTo"],
            "blocking": r["blocking"], "opened": r["openedAt"], "firstSeen": seen if notice is not None else None,
            "resolved": r["resolvedAt"], "resolvedBy": r["resolvedBy"],
            "time_to_notice_s": notice,
            "time_seen_to_resolve_s": seconds_between(seen, r["resolvedAt"]) if notice is not None and r["resolvedAt"] else None,
            "time_to_resolve_s": seconds_between(r["openedAt"], r["resolvedAt"]) if r["resolvedAt"] else None,
            "censored": r["resolvedAt"] is None,
        })
    return rows


def hci_metrics(project_dir: Any) -> Dict[str, Any]:
    """Study measures for one session log (last run in the log).

    - ``study_logging``: the log has ``custom.ui.seen`` or ``custom.ui.focus`` events.
    - ``fan_out``: agents other than the Lead that sent events.
    - ``time_to_notice_s``: opened → first ``custom.ui.seen``, over requests routed to the person
      (n, median, p90, max); ``unnoticed``: such requests never seen. None without study logging.
    - ``handling_time_s``: first seen → resolved, for requests the person resolved (P4).
    - ``time_to_resolve_s``, ``blocked_agent_seconds``, ``requests_reaching_person``,
      ``requests_reaching_person_per_hour``: as in ``metrics.supervision_metrics``.
    - ``context_switches``: ``custom.ui.focus`` events whose target differs from the previous one.
      None without focus events.
    - ``commands_rejected``: the person's commands acknowledged ``rejected`` (P8).
    - ``message_resends``: the person's ``command.message`` with the same text to the same agent as
      their previous message to it (P8).
    - ``requests``: the per-request rows of ``request_rows``.
    """
    project = Path(project_dir).resolve()
    events = load_events(project)
    scoped = run_scope(events)
    rows = request_rows(scoped)
    logged = any(e["type"] in (SEEN, FOCUS) for e in scoped)
    to_person = [r for r in rows if r["routeTo"] == "human"]

    focus = [data_of(e).get("target") for e in scoped if e["type"] == FOCUS and isinstance(data_of(e).get("target"), str)]
    switches: Optional[int] = sum(1 for a, b in zip(focus, focus[1:]) if a != b) if focus else None

    resends = 0
    last_text: Dict[str, str] = {}
    for e in scoped:
        data = data_of(e)
        origin = data.get("origin") if isinstance(data.get("origin"), dict) else {}
        if e["type"] == "command.message" and origin.get("kind") == "human":
            agent = agent_of(e)
            if last_text.get(agent) == data["text"]:
                resends += 1
            last_text[agent] = data["text"]

    cost_time = cost_time_metrics(reduce(events), scoped)
    supervision = supervision_metrics(scoped, cost_time["wall_seconds"])
    return {
        "project": str(project),
        "study_logging": logged,
        "fan_out": cost_time["agents"],
        "time_to_notice_s": distribution(r["time_to_notice_s"] for r in to_person) if logged else None,
        "unnoticed": sum(1 for r in to_person if r["firstSeen"] is None) if logged else None,
        "handling_time_s": distribution(r["time_seen_to_resolve_s"] for r in rows if r["resolvedBy"] == "human") if logged else None,
        "time_to_resolve_s": supervision["time_to_resolve_s"],
        "blocked_agent_seconds": supervision["blocked_agent_seconds"],
        "requests_reaching_person": supervision["requests_reaching_person"],
        "requests_reaching_person_per_hour": supervision["requests_reaching_person_per_hour"],
        "wall_seconds": cost_time["wall_seconds"],
        "context_switches": switches,
        "context_switches_per_min": ratio(switches, cost_time["wall_seconds"] / 60) if switches is not None and cost_time["wall_seconds"] else None,
        "commands_rejected": supervision["person_commands"]["rejected"],
        "message_resends": resends,
        "requests": rows,
    }
