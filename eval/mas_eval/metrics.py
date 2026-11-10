"""Run metrics computed from a project's event log (``<project>/mas/events.jsonl``).

``run_metrics(project_dir)`` reduces the log with ``mas_office.reduce`` (protocol 0.2) and makes one
extra pass over the raw events for timings, because the reducer's snapshots keep only the newest
50 resolved requests and 100 commands and do not keep per-event timestamps.

Scope: the **last run** in the log, i.e. every event from the last ``run.started`` on (the whole
log when there is none). Follow-up rounds belong to the same run, so they are included.

Missing data is ``None``, never a made-up zero: a rate with a zero denominator, a duration with a
missing or unparseable timestamp, token counts an agent never reported. Counts of events are real
counts, so a run without any ``request.opened`` has 0 requests.
"""

from __future__ import annotations

import json
import math
import statistics
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from mas_office.reducer import parse_log, reduce

USAGE_FIELDS = ("inputTokens", "outputTokens", "costUsd", "turns")
COMMAND_TYPES = ("command.message", "command.respond", "command.assign", "command.interrupt")
FINAL_ACKS = ("applied", "rejected", "unsupported", "expired")
DELIVERIES = ("steer", "queue", "interrupt")
IMPORT_MARKER = "custom.eval.imported"

Event = Dict[str, Any]


# ---- small helpers -----------------------------------------------------------------------------

def parse_ts(value: Any) -> Optional[datetime]:
    """An ISO 8601 timestamp as an aware datetime (naive = UTC), or None when it does not parse."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text[-1] in "Zz":
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def seconds_between(start: Any, end: Any) -> Optional[float]:
    """``end - start`` in seconds from two ISO strings; None if either is bad or the span is negative."""
    a, b = parse_ts(start), parse_ts(end)
    if a is None or b is None:
        return None
    span = (b - a).total_seconds()
    return span if span >= 0 else None


def ratio(numerator: Optional[float], denominator: Optional[float]) -> Optional[float]:
    if numerator is None or not denominator:
        return None
    return numerator / denominator


def number(value: Any) -> Optional[float]:
    """A finite JSON number (not a bool), else None."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value if math.isfinite(value) else None


def distribution(values: Iterable[Optional[float]]) -> Dict[str, Any]:
    """``{n, median, p90, max}`` over the non-None values. p90 is the nearest-rank 90th percentile
    (the smallest value with at least 90% of the values at or below it). Empty → None statistics."""
    xs = sorted(v for v in values if v is not None)
    if not xs:
        return {"n": 0, "median": None, "p90": None, "max": None}
    return {"n": len(xs), "median": statistics.median(xs), "p90": xs[math.ceil(0.9 * len(xs)) - 1], "max": xs[-1]}


def agent_of(event: Event) -> str:
    agent = event.get("agentId")
    return agent if isinstance(agent, str) and agent else "lead"


def data_of(event: Event) -> Dict[str, Any]:
    data = event.get("data")
    return data if isinstance(data, dict) else {}


def count(items: Iterable[str]) -> Dict[str, int]:
    out: Dict[str, int] = {}
    for item in items:
        out[item] = out.get(item, 0) + 1
    return out


# ---- loading -----------------------------------------------------------------------------------

def load_events(project_dir: Path) -> List[Event]:
    """Valid events of the project's log, sorted and de-duplicated by ``seq`` (spec 4.1)."""
    log = Path(project_dir) / "mas" / "events.jsonl"
    if not log.is_file():
        raise FileNotFoundError(f"no event log at {log}")
    return parse_log(log.read_text(encoding="utf-8").split("\n"))


def run_scope(events: List[Event]) -> List[Event]:
    """Events from the last ``run.started`` on (all events when there is none)."""
    starts = [i for i, e in enumerate(events) if e["type"] == "run.started"]
    return events[starts[-1]:] if starts else list(events)


def read_eval_meta(project_dir: Path) -> Dict[str, Any]:
    """``<workspace>/eval-run.json`` written by ``run.py prepare`` / ``import``, when it names this project."""
    project_dir = Path(project_dir)
    try:
        meta = json.loads((project_dir.parent / "eval-run.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return meta if isinstance(meta, dict) and meta.get("project") == project_dir.name else {}


# ---- requests ----------------------------------------------------------------------------------

def track_requests(scoped: List[Event]) -> List[Dict[str, Any]]:
    """Every request opened in scope, with how and when it ended, following the reducer's rules:
    the first ``request.opened`` per id counts; the first ``request.resolved`` of a pending request
    wins; ``agent.stopped`` cancels that agent's pending requests (``by`` = ``data.by`` or system).
    """
    requests: Dict[str, Dict[str, Any]] = {}
    for e in scoped:
        etype, data = e["type"], data_of(e)
        if etype == "request.opened":
            rid = data["requestId"]
            if rid in requests:
                continue
            requests[rid] = {
                "requestId": rid,
                "agentId": agent_of(e),
                "kind": data["kind"],
                "routeTo": data["routeTo"] if isinstance(data.get("routeTo"), str) else "human",
                "blocking": data["blocking"] if isinstance(data.get("blocking"), bool) else True,
                "openedAt": e["ts"],
                "outcome": None,
                "by": None,
                "resolvedAt": None,
            }
        elif etype == "request.resolved":
            req = requests.get(data["requestId"])
            if req is None or req["outcome"] is not None:
                continue
            req.update(outcome=data["outcome"], resolvedAt=e["ts"],
                       by=data["by"] if isinstance(data.get("by"), dict) else {"kind": "system"})
        elif etype == "agent.stopped":
            agent = agent_of(e)
            for req in requests.values():
                if req["agentId"] == agent and req["outcome"] is None:
                    req.update(outcome="cancelled", resolvedAt=e["ts"],
                               by=data["by"] if isinstance(data.get("by"), dict) else {"kind": "system"})
    for req in requests.values():
        req["resolvedBy"] = resolver_class(req)
    return list(requests.values())


def resolver_class(req: Dict[str, Any]) -> str:
    """Who ended a request: ``expired`` / ``superseded`` (by outcome, whoever wrote it), else by
    ``by.kind``: ``human``, ``policy``, ``lead`` (an agent with id ``lead``), ``agent`` (another agent),
    ``terminal``, ``system`` (e.g. cancelled by a new run or a stopped agent); ``unresolved`` if open."""
    if req["outcome"] is None:
        return "unresolved"
    if req["outcome"] in ("expired", "superseded"):
        return req["outcome"]
    by = req["by"] or {}
    kind = by.get("kind")
    if kind == "agent":
        return "lead" if by.get("id") == "lead" else "agent"
    return kind if kind in ("human", "policy", "terminal") else "system"


def last_ts(scoped: List[Event]) -> Optional[str]:
    """The latest parseable timestamp in scope (the censoring point for open requests)."""
    best: Optional[str] = None
    for e in scoped:
        t = parse_ts(e.get("ts"))
        if t is not None and (best is None or t > parse_ts(best)):
            best = e["ts"]
    return best


# ---- metric groups -----------------------------------------------------------------------------

def verification_metrics(snapshot: Dict[str, Any]) -> Dict[str, Any]:
    """Claim and link metrics from the ``verification`` snapshot (RFC 0001 §4.4).

    - ``verified``: the run has a verification snapshot (at least one claim or checked source).
    - ``claims``, ``checkworthy``: tagged claims; those with ``checkworthy`` true.
    - ``supported`` / ``partial`` / ``contradicted`` / ``unknown`` / ``unchecked``: checkworthy claims by
      status (the last verdict of each distinct checker decides; see the RFC).
    - ``support_rate`` = supported / checkworthy.
    - ``citation_coverage`` = checkworthy claims citing at least one source id / checkworthy.
    - ``citations_without_card``: (claim, source id) pairs whose source id has no evidence entry.
    - ``links``: evidence entries by ``urlHealth``: live / stale (dead, archived copy exists) /
      hallucinated (no such host, or dead and never archived) / blocked / unknown (not checked or
      undecidable, including entries without a URL).
    - ``dead_or_invented_rate`` = (stale + hallucinated) / (live + stale + hallucinated): among links
      whose fate is known; blocked and unknown links are left out of the denominator.
    - ``uncited_sources``: evidence entries that no claim cites.
    """
    ver = snapshot.get("verification")
    if not ver:
        return {
            "verified": False, "claims": 0, "checkworthy": 0, "supported": 0, "partial": 0, "contradicted": 0,
            "unknown": 0, "unchecked": 0, "support_rate": None, "citation_coverage": None,
            "citations_without_card": 0, "sources": 0,
            "links": {"live": 0, "stale": 0, "hallucinated": 0, "blocked": 0, "unknown": 0},
            "dead_or_invented_rate": None, "uncited_sources": 0,
        }
    s = ver["summary"]
    claims = ver["claims"]
    evidence_ids = {e["sourceId"] for e in ver["evidence"]}
    cited = sum(1 for c in claims if c["checkworthy"] and c["sources"])
    links = {k: s[k] for k in ("live", "stale", "hallucinated", "blocked")}
    links["unknown"] = s["sources"] - sum(links.values())
    known = links["live"] + links["stale"] + links["hallucinated"]
    return {
        "verified": True,
        **{k: s[k] for k in ("claims", "checkworthy", "supported", "partial", "contradicted", "unknown", "unchecked")},
        "support_rate": ratio(s["supported"], s["checkworthy"]),
        "citation_coverage": ratio(cited, s["checkworthy"]),
        "citations_without_card": sum(1 for c in claims for sid in c["sources"] if sid not in evidence_ids),
        "sources": s["sources"],
        "links": links,
        "dead_or_invented_rate": ratio(links["stale"] + links["hallucinated"], known),
        "uncited_sources": s["uncited"],
    }


def errors_caught_metrics(snapshot: Dict[str, Any], scoped: List[Event]) -> Dict[str, Any]:
    """What the team's own checking caught.

    - ``review_verdicts``: ``review.verdict`` events by verdict (accept / revise / escalate).
    - ``caught_by_review`` = revise + escalate verdicts.
    - ``review_rounds``: per reviewed target, the highest review round recorded.
    - ``flags_raised``: ``flag.raised`` events in scope.
    - ``claims_checked``: claims with at least one verdict from someone other than their author.
    - ``contradicted_by_checker``: claims where at least one checker (a verdict ``by`` other than the
      claim's author) has ``contradicted`` as its last verdict.
    - ``checker_disagreements``: claims with two or more checkers whose last verdicts differ in status.
    """
    board = snapshot.get("board") or {}
    reviews = board.get("reviews") or []
    verdicts = {"accept": 0, "revise": 0, "escalate": 0, **count(r["verdict"] for r in reviews)}
    rounds: Dict[str, int] = {}
    for r in reviews:
        rnd = number(r.get("round"))
        rounds[r["target"]] = max(rounds.get(r["target"], 0), int(rnd) if rnd is not None else 1)
    checked = contradicted = disagreements = 0
    for claim in (snapshot.get("verification") or {}).get("claims", []):
        last: Dict[str, str] = {}
        for v in claim["verdicts"]:
            if v["by"] != claim["author"]:
                last[v["by"]] = v["status"]
        if last:
            checked += 1
        if "contradicted" in last.values():
            contradicted += 1
        if len(set(last.values())) > 1:
            disagreements += 1
    return {
        "review_verdicts": verdicts,
        "caught_by_review": verdicts["revise"] + verdicts["escalate"],
        "review_rounds": rounds,
        "flags_raised": sum(1 for e in scoped if e["type"] == "flag.raised"),
        "claims_checked": checked,
        "contradicted_by_checker": contradicted,
        "checker_disagreements": disagreements,
    }


def supervision_metrics(scoped: List[Event], wall_seconds: Optional[float]) -> Dict[str, Any]:
    """How much the run asked of the person.

    - ``requests``: requests opened in scope; ``requests_by_kind``: by ``kind``.
    - ``requests_by_resolver``: by who ended them (see ``resolver_class``).
    - ``requests_reaching_person``: requests opened with ``routeTo`` ``human`` (a request the Lead
      passes on shows as a superseded one plus a new one routed to the person, so it counts once).
    - ``requests_reaching_person_per_hour`` = that / wall hours.
    - ``time_to_resolve_s``: seconds from ``request.opened`` to ``request.resolved`` for requests the
      person resolved (``by.kind`` human, outcome not expired/superseded): n, median, p90, max.
    - ``blocked_agent_seconds``: sum over blocking requests of resolved − opened. A request still open
      at the end of the log is counted up to the log's last timestamp (``blocked_censored`` says how
      many). 0 when no blocking request was opened; None when none of them has usable timestamps.
    - ``unresolved``: requests still open at the end of the log.
    - ``questions_per_role``: ``question`` requests per asking agent.
    - ``delegated_approvals``: ``approval`` requests resolved by a policy rule or by the Lead.
    - ``person_commands``: commands with ``origin.kind`` human: ``total``, ``by_type`` (message /
      respond / assign / interrupt), ``by_delivery`` (messages only; default steer), ``by_status``
      (last ack status, ``sent`` when never acknowledged), ``applied``, ``rejected``.
    """
    requests = track_requests(scoped)
    end = last_ts(scoped)
    ttr = [seconds_between(r["openedAt"], r["resolvedAt"]) for r in requests if r["resolvedBy"] == "human"]
    blocking = [r for r in requests if r["blocking"]]
    spans = [seconds_between(r["openedAt"], r["resolvedAt"] or end) for r in blocking]
    usable = [s for s in spans if s is not None]
    to_person = sum(1 for r in requests if r["routeTo"] == "human")

    commands: Dict[str, Dict[str, Any]] = {}
    for e in scoped:
        etype, data = e["type"], data_of(e)
        if etype in COMMAND_TYPES and data["cmdId"] not in commands:
            origin = data["origin"] if isinstance(data.get("origin"), dict) else {"kind": "agent", "id": "lead"}
            delivery = data.get("delivery") if data.get("delivery") in DELIVERIES else "steer"
            commands[data["cmdId"]] = {"type": etype.split(".", 1)[1], "origin": origin.get("kind"),
                                       "delivery": delivery if etype == "command.message" else None, "status": "sent"}
        elif etype == "command.ack":
            cmd = commands.get(data["cmdId"])
            if cmd is not None and cmd["status"] not in FINAL_ACKS:
                cmd["status"] = data["status"]
    mine = [c for c in commands.values() if c["origin"] == "human"]
    by_status = count(c["status"] for c in mine)
    return {
        "requests": len(requests),
        "requests_by_kind": count(r["kind"] for r in requests),
        "requests_by_resolver": count(r["resolvedBy"] for r in requests),
        "requests_reaching_person": to_person,
        "requests_reaching_person_per_hour": ratio(to_person, wall_seconds / 3600) if wall_seconds else None,
        "time_to_resolve_s": distribution(ttr),
        "blocked_agent_seconds": (sum(usable) if usable else None) if blocking else 0.0,
        "blocked_censored": sum(1 for r in blocking if r["resolvedAt"] is None),
        "unresolved": sum(1 for r in requests if r["resolvedAt"] is None),
        "questions_per_role": count(r["agentId"] for r in requests if r["kind"] == "question"),
        "delegated_approvals": sum(1 for r in requests if r["kind"] == "approval" and r["resolvedBy"] in ("policy", "lead")),
        "person_commands": {
            "total": len(mine),
            "by_type": count(c["type"] for c in mine),
            "by_delivery": count(c["delivery"] for c in mine if c["delivery"]),
            "by_status": by_status,
            "applied": by_status.get("applied", 0),
            "rejected": by_status.get("rejected", 0),
        },
    }


def usage_by_agent(scoped: List[Event]) -> Dict[str, Dict[str, Optional[float]]]:
    """Per agent and field, the total from ``usage`` events. Usage values are running totals per
    backend session, so the last value is the total; when a value drops (the engine started a fresh
    session for that agent: a retry, a follow-up round) the earlier session's last value is added.
    A field the agent never reported is None."""
    state: Dict[str, Dict[str, Dict[str, float]]] = {}
    for e in scoped:
        if e["type"] != "usage":
            continue
        data = data_of(e)
        fields = state.setdefault(agent_of(e), {})
        for name in USAGE_FIELDS:
            value = number(data.get(name))
            if value is None:
                continue
            st = fields.setdefault(name, {"closed": 0.0, "last": None})
            if st["last"] is not None and value < st["last"]:
                st["closed"] += st["last"]
            st["last"] = value
    return {agent: {name: (fields[name]["closed"] + fields[name]["last"]) if name in fields else None for name in USAGE_FIELDS}
            for agent, fields in state.items()}


def cost_time_metrics(snapshot: Dict[str, Any], scoped: List[Event]) -> Dict[str, Any]:
    """Cost, time and outcome.

    - ``wall_seconds``: ``run.started`` → the last ``run.finished`` / ``run.failed`` in scope. For an
      imported external answer: the ``wallSeconds`` given at import, else None.
    - ``outcome``: ``done`` (last end event is ``run.finished``), ``failed`` (``run.failed``), None
      (the run never ended in the log).
    - ``rounds``: the result's round (1 for a first result without one); None without a result.
    - ``agents``: agents other than the Lead that sent at least one event in scope.
    - ``usage``: per agent (see ``usage_by_agent``); ``tokens_in`` / ``tokens_out`` / ``turns`` /
      ``cost_usd``: sums over agents that reported the field (None if no agent did);
      ``cost_missing_agents``: agents with token counts but no cost (e.g. Codex reports none), so
      ``cost_usd`` is then a lower bound. An imported answer's ``costUsd`` replaces the sum.
    - ``stalls``: ``lead.ledger`` events with ``progressing`` false and ``stalls`` ≥ 1 (the engine
      writes one each time it detects a quiet working role).
    - ``recoveries``: ``recovery.chosen`` by strategy.
    """
    start = next((e for e in scoped if e["type"] == "run.started"), None)
    ends = [e for e in scoped if e["type"] in ("run.finished", "run.failed")]
    end = ends[-1] if ends else None
    imported = next((data_of(e) for e in scoped if e["type"] == IMPORT_MARKER), None)
    if imported is not None:
        wall = number(imported.get("wallSeconds"))
    else:
        wall = seconds_between(start["ts"], end["ts"]) if start and end else None
    usage = usage_by_agent(scoped)

    def total(name: str) -> Optional[float]:
        values = [u[name] for u in usage.values() if u[name] is not None]
        return sum(values) if values else None

    cost = total("costUsd")
    if imported is not None and number(imported.get("costUsd")) is not None:
        cost = number(imported["costUsd"])
    result = snapshot.get("result")
    board = snapshot.get("board") or {}
    stalls = sum(1 for e in scoped if e["type"] == "lead.ledger" and data_of(e).get("progressing") is False
                 and (number(data_of(e).get("stalls")) or 0) >= 1)
    return {
        "wall_seconds": wall,
        "outcome": None if end is None else ("done" if end["type"] == "run.finished" else "failed"),
        "rounds": (result.get("round", 1) if result else None),
        "agents": len({agent_of(e) for e in scoped} - {"lead"}),
        "usage": usage,
        "tokens_in": total("inputTokens"),
        "tokens_out": total("outputTokens"),
        "turns": total("turns"),
        "cost_usd": cost,
        "cost_missing_agents": sorted(a for a, u in usage.items()
                                      if u["costUsd"] is None and (u["inputTokens"] is not None or u["outputTokens"] is not None)),
        "stalls": stalls,
        "recoveries": count(r["strategy"] for r in board.get("recoveries") or []),
    }


def run_metrics(project_dir: Any) -> Dict[str, Any]:
    """All metrics for the last run of one project folder. See each group's docstring for the exact
    definitions. ``task`` / ``condition`` come from the workspace's ``eval-run.json`` when present;
    ``rubric`` from its ``rubric.json`` (written by ``run.py score --save``)."""
    project = Path(project_dir).resolve()
    events = load_events(project)
    scoped = run_scope(events)
    snapshot = reduce(events)
    meta = read_eval_meta(project)
    cost_time = cost_time_metrics(snapshot, scoped)
    rubric = None
    if meta:
        try:
            rubric = json.loads((project.parent / "rubric.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            rubric = None
    return {
        "project": str(project),
        "task": meta.get("task"),
        "condition": meta.get("condition"),
        "events": len(scoped),
        "verification": verification_metrics(snapshot),
        "errors_caught": errors_caught_metrics(snapshot, scoped),
        "supervision": supervision_metrics(scoped, cost_time["wall_seconds"]),
        "cost_time": cost_time,
        "rubric": rubric,
    }
