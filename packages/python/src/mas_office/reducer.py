"""The MAS Office reducer (spec section 4).

``reduce(lines)`` turns an event log into the snapshots the panel reads:
``{"structure", "statuses", "state", "result", "inbox", "board", "verification"}``.
It is a pure function and must
produce exactly the same output as the JavaScript reference implementation for
every case in ``spec/conformance/``.

JSON field names stay camelCase, as in the spec.
"""

from __future__ import annotations

import copy
import json
import math
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple, Union

SPEC_VERSION = "0.2"

STATES = ("idle", "waiting", "working", "handoff", "flagged", "done", "failed")

# Required ``data`` fields (always strings) per event type: the bold fields of spec 3.2.
REQUIRED_DATA: Dict[str, Tuple[str, ...]] = {
    "agent.status": ("state",),
    "handoff": ("to",),
    "message": ("text",),
    "tool.started": ("name",),
    "flag.raised": ("text",),
    "request.opened": ("requestId", "kind", "title"),
    "request.resolved": ("requestId", "outcome"),
    "command.message": ("cmdId", "text"),
    "command.respond": ("cmdId", "requestId", "outcome"),
    "command.assign": ("cmdId", "title"),
    "command.interrupt": ("cmdId",),
    "command.ack": ("cmdId", "status"),
    "task.assigned": ("taskId", "title"),
    "task.updated": ("taskId",),
    "task.finished": ("taskId",),
    "review.verdict": ("target", "verdict"),
    "recovery.chosen": ("strategy",),
    "claim.added": ("claimId", "text"),
    "evidence.checked": ("sourceId",),
    "verdict.recorded": ("claimId", "status"),
}

OUTCOMES = ("selected", "submitted", "declined", "cancelled", "expired", "superseded", "stale")
ACK_STATUSES = ("accepted", "applied", "rejected", "unsupported", "expired")
FINAL_ACKS = ("applied", "rejected", "unsupported", "expired")
CLAIM_STATUSES = ("supported", "partial", "contradicted", "unknown", "not-checkworthy")

# Required fields that must also be one of a fixed list (spec 4.1).
ENUM_DATA: Dict[str, Tuple[str, Tuple[str, ...]]] = {
    "agent.status": ("state", STATES),
    "request.resolved": ("outcome", OUTCOMES),
    "command.ack": ("status", ACK_STATUSES),
    "review.verdict": ("verdict", ("accept", "revise", "escalate")),
    "recovery.chosen": ("strategy", ("retry", "reassign", "replan", "split", "ask-human")),
    "verdict.recorded": ("status", CLAIM_STATUSES),
}

URGENCIES = ("high", "normal", "low")  # also the inbox sort order
DELIVERIES = ("steer", "queue", "interrupt")
TASK_STATES = ("working", "blocked", "review")
TASK_OUTCOMES = ("success", "failed", "cancelled")
URL_HEALTH = ("live", "stale", "hallucinated", "blocked", "unknown")
GRADES = ("A", "B", "C", "D")
RELATIONSHIPS = ("supports", "refutes", "irrelevant")
WAIT_FLAGS = ("needs_approval", "needs_input")
RESUMED = ("working", "waiting", "handoff")  # entering one of these clears stopReason
RECENT_LIMIT = 50
COMMAND_LIMIT = 100
COMMAND_TYPES = ("command.message", "command.respond", "command.assign", "command.interrupt")

RUN_TYPES = ("run.started", "run.finished", "run.failed")

# Largest seq a JavaScript reader can hold exactly (spec 4.1: 1 <= seq <= 2^53 - 1).
MAX_SEQ = 2**53 - 1

NEXT_RUNNING = "Watch the office panel — the team is working."
NEXT_DONE = "Run finished — open the result."
NEXT_FAILED = "Run failed — see the Lead's desk."
NEXT_BEFORE_RUN = "Waiting for the first run."

Event = Dict[str, Any]
Snapshot = Dict[str, Any]


def default_structure() -> Dict[str, Any]:
    """The structure used before any ``run.started`` provides one (spec 4.2)."""
    return {
        "title": "Untitled MAS",
        "version": 1,
        "locked": True,
        "topology": "dynamic",
        "lead": {"id": "lead", "name": "Lead", "emoji": "🧭", "job": "", "serves": []},
        "groups": [],
        "roles": [],
    }


def new_status(ts: Optional[str], state: str = "idle", say: str = "Ready") -> Dict[str, Any]:
    """A fresh status with exactly the spec fields."""
    return {"state": state, "say": say, "to": None, "flag": None, "flagKind": None, "progress": 0, "t": ts,
            "waitingOn": [], "stopReason": None}


def _is_integral(value: Any) -> bool:
    # JSON has one number type, so 3.0 is the integer 3 (as in JavaScript). bool is not a number here.
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, float) and value.is_integer()


def event_errors(e: Any) -> List[str]:
    """Why ``e`` is not a valid event under spec 4.1 step 2 (an empty list when it is valid)."""
    if not isinstance(e, dict):
        return ["event must be a JSON object"]
    errors: List[str] = []
    if e.get("v") is None:
        errors.append('missing "v"')
    seq: Any = e.get("seq")
    if not _is_integral(seq) or not 1 <= seq <= MAX_SEQ:
        errors.append('"seq" must be an integer from 1 to 2^53 - 1')
    if not isinstance(e.get("ts"), str):
        errors.append('"ts" must be a string')
    etype = e.get("type")
    if not isinstance(etype, str):
        errors.append('"type" must be a string')
    if "data" in e and not isinstance(e["data"], dict):
        errors.append('"data" must be an object')
    elif isinstance(etype, str):
        data = e.get("data") or {}
        missing = [name for name in REQUIRED_DATA.get(etype, ()) if not isinstance(data.get(name), str)]
        for name in missing:
            errors.append(f'"{etype}" needs a string "data.{name}"')
        if not missing and etype in ENUM_DATA:
            name, values = ENUM_DATA[etype]
            if data[name] not in values:
                errors.append(f'"data.{name}" must be one of {", ".join(values)}')
    return errors


def validate_event(e: Any) -> bool:
    """Return True when ``e`` is a valid event under spec 4.1 step 2."""
    return not event_errors(e)


_JSON_WHITESPACE = " \t\r\n"


def split_lines(text: str) -> List[str]:
    """Split a log on ``"\\n"`` only (spec 4.1). ``str.splitlines`` would also split on
    U+2028, U+2029, ``\\x0c``, ``\\x85`` …, which may appear unescaped inside JSON strings."""
    return text.split("\n")


def _reject_constant(name: str) -> Any:
    # JSON.parse rejects NaN / Infinity; so do we, to stay identical to the JS reducer.
    raise ValueError(f"invalid JSON constant {name}")


def parse_log(lines: Iterable[Union[str, Event]]) -> List[Event]:
    """Parse, validate, sort (stable, by ``seq``) and de-duplicate a log (spec 4.1 steps 1-3).

    ``lines`` may hold raw JSON lines (split on ``"\\n"`` only, see ``split_lines``) or
    already-parsed objects. A line is parsed exactly as written: only JSON whitespace
    (space, tab, CR, LF) may surround the object.
    """
    events: List[Event] = []
    for line in lines:
        if isinstance(line, dict):
            obj: Any = line
        else:
            if not line.strip(_JSON_WHITESPACE):
                continue
            try:
                obj = json.loads(line, parse_constant=_reject_constant)
            except ValueError:
                continue
        if validate_event(obj):
            events.append(obj)
    events.sort(key=lambda ev: ev["seq"])
    unique: List[Event] = []
    seen = set()
    for ev in events:
        if ev["seq"] not in seen:
            seen.add(ev["seq"])
            unique.append(ev)
    return unique


def _progress(value: Any) -> Optional[int]:
    """Round exactly like JavaScript ``Math.round`` and clamp to 0-100; None if not a finite number."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        x = float(value)  # an int too large for a double is Infinity in JavaScript
    except OverflowError:
        return None
    if not math.isfinite(x):
        return None
    n = math.floor(x)
    if x - n >= 0.5:
        n += 1
    return max(0, min(100, n))


def _str(value: Any) -> Optional[str]:
    """A field that must be a string: anything else counts as not given (spec 4.2)."""
    return value if isinstance(value, str) else None


def _num(value: Any) -> Any:
    """A finite number (not a bool), or None. Matches the JS reducer's ``Number.isFinite`` check."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        return value if math.isfinite(float(value)) else None
    except OverflowError:  # an int too large for a double is Infinity in JavaScript
        return None


def _bool(value: Any) -> Optional[bool]:
    return value if isinstance(value, bool) else None


def _obj(value: Any) -> Optional[Dict[str, Any]]:
    """A copy of ``value`` when it is a JSON object, else None."""
    return copy.deepcopy(value) if isinstance(value, dict) else None


def _strings(value: Any) -> Optional[List[str]]:
    """The strings of a list (other items dropped), or None when ``value`` is not a list."""
    return [x for x in value if isinstance(x, str)] if isinstance(value, list) else None


def _one_of(values: Tuple[str, ...], value: Any) -> Optional[str]:
    return value if isinstance(value, str) and value in values else None


def _coalesce(*values: Any) -> Any:
    """JavaScript ``a ?? b ?? c``: the first value that is not None."""
    for value in values:
        if value is not None:
            return value
    return None


def _system() -> Dict[str, Any]:
    return {"kind": "system"}


def _flag_kind_of(kind: str) -> str:
    return "needs_approval" if kind == "approval" else "needs_input"


def _claim_status(claim: Dict[str, Any]) -> str:
    """Claim status from its verdicts (spec 4.3, "Claim status")."""
    if not claim["checkworthy"]:
        return "not-checkworthy"
    if not claim["verdicts"]:
        return "unchecked"
    last: Dict[str, str] = {}  # the last verdict of each distinct ``by``
    for verdict in claim["verdicts"]:
        last[verdict["by"]] = verdict["status"]
    statuses = list(last.values())
    if "contradicted" in statuses:
        return "contradicted"
    return statuses[0] if all(s == statuses[0] for s in statuses) else "unknown"


STATUS_FIELDS = ("state", "say", "to", "flag", "flagKind", "progress", "waitingOn", "stopReason")


class Reducer:
    """Incremental reducer: ``apply`` events in ``seq`` order, read ``snapshot()`` at any time.

    ``apply`` ignores invalid events and events whose ``seq`` is not greater than the last
    applied one, so feeding it a live, ordered stream gives the same result as ``reduce``.
    """

    def __init__(self) -> None:
        self.structure: Dict[str, Any] = default_structure()
        self.statuses: Dict[str, Dict[str, Any]] = {"lead": new_status(None)}
        self.run = 0
        self.run_id: Optional[str] = None
        self.phase = "locked"
        self.updated: Optional[str] = None
        self.last_seq = 0
        self._structure_given = False
        self._sources: List[Dict[str, Any]] = []
        self._flags: List[Dict[str, Any]] = []
        self._result: Optional[Dict[str, Any]] = None
        # Protocol 0.2: inbox, board and verification (spec 4.3).
        self._pending: Dict[str, Dict[str, Any]] = {}
        self._recent: List[Dict[str, Any]] = []  # closed requests, newest first
        self._commands: Dict[str, Dict[str, Any]] = {}
        self._usage: Dict[str, Dict[str, Any]] = {}
        self._agents: Dict[str, Dict[str, Any]] = {}
        self._tasks: Dict[str, Dict[str, Any]] = {}
        self._ledger: Optional[Dict[str, Any]] = None
        self._reviews: List[Dict[str, Any]] = []
        self._recoveries: List[Dict[str, Any]] = []
        self._claims: Dict[str, Dict[str, Any]] = {}
        self._evidence: Dict[str, Dict[str, Any]] = {}

    # ----------------------------------------------------------------- public

    def apply(self, event: Event) -> bool:
        """Apply one event. Returns False (and changes nothing) when it is dropped."""
        if not validate_event(event) or event["seq"] <= self.last_seq:
            return False
        self.last_seq = int(event["seq"])
        etype: str = event["type"]
        ts: str = event["ts"]
        data: Dict[str, Any] = event.get("data") or {}
        agent_id = event.get("agentId")
        if not isinstance(agent_id, str) or not agent_id:
            agent_id = "lead"

        if not (etype in RUN_TYPES and agent_id == "lead"):
            self._auto_register(agent_id, event, data if etype == "agent.registered" else {}, ts)
        if etype == "handoff":
            target = data["to"]
            if target != "lead" and target not in self._role_ids():
                self._register(target, target, agent_id, {}, ts)

        handler = _HANDLERS.get(etype)
        if handler is not None:
            handler(self, agent_id, data, event, ts)
        self.updated = ts
        return True

    def snapshot(self) -> Snapshot:
        """Return a deep copy of every snapshot (spec 4.4): structure, statuses, state, result, inbox, board, verification."""
        state = {
            "mode": "sdk",
            "step": 4,
            "phase": self.phase,
            "locked": True,
            "version": _coalesce(self.structure.get("version"), 1),
            "run": self.run,
            "runId": self.run_id,
            "updated": self.updated,
            "next": self._next_line(),
        }
        pending = sorted(self._pending.values(), key=lambda r: (URGENCIES.index(r["urgency"]), r["seq"]))
        return copy.deepcopy({
            "structure": self.structure,
            "statuses": self.statuses,
            "state": state,
            "result": self._result,
            "inbox": {"pending": pending, "recent": self._recent, "commands": list(self._commands.values())},
            "board": {
                "tasks": list(self._tasks.values()),
                "ledger": self._ledger,
                "reviews": self._reviews,
                "recoveries": self._recoveries,
                "usage": self._usage,
                "agents": self._agents,
            },
            "verification": self._verification(),
        })

    def _next_line(self) -> str:
        # The phase is "locked" until the first run event; run.finished / run.failed apply
        # even without a run.started (spec 4.4), so run may be 0 with phase "done".
        if self.phase == "running":
            waiting = sum(1 for r in self._pending.values() if r["routeTo"] == "human")
            if waiting == 1:
                return "1 thing needs you — open the inbox."
            if waiting > 1:
                return f"{waiting} things need you — open the inbox."
        return {"locked": NEXT_BEFORE_RUN, "done": NEXT_DONE, "failed": NEXT_FAILED}.get(self.phase, NEXT_RUNNING)

    def _verification(self) -> Optional[Dict[str, Any]]:
        if not self._claims and not self._evidence:
            return None
        claims = list(self._claims.values())
        checkworthy = [c for c in claims if c["checkworthy"]]
        evidence = list(self._evidence.values())
        cited = {s for c in claims for s in c["sources"]}

        def by_status(status: str) -> int:
            return sum(1 for c in checkworthy if c["status"] == status)

        def by_health(health: str) -> int:
            return sum(1 for e in evidence if e["urlHealth"] == health)

        return {
            "claims": claims,
            "evidence": evidence,
            "summary": {
                "claims": len(claims),
                "checkworthy": len(checkworthy),
                "supported": by_status("supported"),
                "partial": by_status("partial"),
                "contradicted": by_status("contradicted"),
                "unknown": by_status("unknown"),
                "unchecked": by_status("unchecked"),
                "sources": len(evidence),
                "live": by_health("live"),
                "stale": by_health("stale"),
                "hallucinated": by_health("hallucinated"),
                "blocked": by_health("blocked"),
                "uncited": sum(1 for e in evidence if e["sourceId"] not in cited),
            },
        }

    # ------------------------------------------------------------ registration

    def _roles(self) -> List[Dict[str, Any]]:
        roles = self.structure.get("roles")
        if not isinstance(roles, list):
            roles = self.structure["roles"] = []
        return roles

    def _role_ids(self) -> List[str]:
        return [r["id"] for r in self._roles() if isinstance(r, dict) and isinstance(r.get("id"), str)]

    def _auto_register(self, agent_id: str, event: Event, data: Dict[str, Any], ts: str) -> None:
        if agent_id == "lead" or agent_id in self._role_ids():
            return
        name = _coalesce(_str(data.get("name")), _str(event.get("agentName")), agent_id)
        parent = _coalesce(_str(event.get("parentId")), "lead")
        self._register(agent_id, name, parent, data, ts)

    def _register(self, agent_id: str, name: Any, parent: Any, data: Dict[str, Any], ts: str) -> None:
        group = _coalesce(_str(data.get("group")), "dyn")
        role: Dict[str, Any] = {
            "id": agent_id,
            "name": name,
            "emoji": _coalesce(_str(data.get("emoji")), "🤖"),
            "job": _coalesce(_str(data.get("job")), ""),
            "serves": [],
            "tools": [],
            "group": group,
            "handsTo": _coalesce(_str(data.get("handsTo")), "lead"),
            "dynamic": True,
            "parent": parent,
        }
        if isinstance(data.get("role"), str):
            role["role"] = data["role"]
        self._roles().append(role)

        groups = self.structure.get("groups")
        if not isinstance(groups, list):
            groups = self.structure["groups"] = []
        if not any(isinstance(g, dict) and g.get("id") == group for g in groups):
            last = groups[-1].get("id") if groups and isinstance(groups[-1], dict) else None
            label = "Spawned at runtime" if group == "dyn" else f"Group {group}"
            groups.append({"id": group, "label": label, "after": last})

        if self.phase == "running":
            self.statuses[agent_id] = new_status(ts, "waiting", "Waiting for my turn")
        else:
            self.statuses[agent_id] = new_status(ts)

    # ----------------------------------------------------------------- helpers

    def _set(self, agent_id: str, ts: str, **changes: Any) -> Dict[str, Any]:
        """Update a status; its ``t`` becomes ``ts`` only if a field actually changed."""
        current = self.statuses.get(agent_id) or new_status(ts)
        updated = dict(current)
        updated.update(changes)
        # Entering working/waiting/handoff clears the last stop reason, unless this event sets one.
        if "stopReason" not in changes and updated["state"] != current["state"] and updated["state"] in RESUMED:
            updated["stopReason"] = None
        if agent_id not in self.statuses or any(updated[k] != current[k] for k in STATUS_FIELDS):
            updated["t"] = ts
        self.statuses[agent_id] = updated
        return updated

    def _name_of(self, agent_id: str) -> str:
        """Display name: a name that is not a string (e.g. ``null``) counts as not given."""
        if agent_id == "lead":
            lead = self.structure.get("lead")
            name = _str(lead.get("name")) if isinstance(lead, dict) else None
            return "Lead" if name is None else name
        for role in self._roles():
            if isinstance(role, dict) and role.get("id") == agent_id:
                name = _str(role.get("name"))
                return agent_id if name is None else name
        return agent_id

    def _wake(self, agent_id: str) -> Optional[str]:
        """``idle``/``waiting`` become ``working``; any other state is kept."""
        state = self.statuses.get(agent_id, {}).get("state")
        return "working" if state in ("idle", "waiting", None) else state

    def _close(self, request: Dict[str, Any], resolution: Dict[str, Any]) -> None:
        """Move a pending request to the front of ``recent`` with its resolution."""
        del self._pending[request["requestId"]]
        closed = dict(request)
        closed.update(resolution)
        self._recent.insert(0, closed)
        del self._recent[RECENT_LIMIT:]

    def _cancel_pending(self, match: Callable[[Dict[str, Any]], bool], by: Dict[str, Any], ts: str) -> None:
        """Cancel every pending request that matches, in the order they were opened."""
        for request in list(self._pending.values()):
            if match(request):
                self._close(request, {"outcome": "cancelled", "optionId": None, "payload": None, "note": None,
                                      "by": copy.deepcopy(by), "cmdId": None, "resolvedAt": ts})

    # ----------------------------------------------------------------- handlers

    def _run_started(self, agent_id: str, data: Dict[str, Any], event: Event, ts: str) -> None:
        self.run += 1
        self.run_id = event.get("runId")
        title = _str(data.get("title"))
        given = data.get("structure")
        if isinstance(given, dict):
            structure = copy.deepcopy(given)
            if not isinstance(structure.get("title"), str):
                structure["title"] = _coalesce(title, "Untitled MAS")
            if structure.get("version") is None:
                structure["version"] = 1
            structure["locked"] = True
            if structure.get("topology") is None:
                structure["topology"] = "staged"
            if not isinstance(structure.get("lead"), dict):
                structure["lead"] = default_structure()["lead"]
            if not isinstance(structure.get("groups"), list):
                structure["groups"] = []
            if not isinstance(structure.get("roles"), list):
                structure["roles"] = []
            self.structure = structure
            self._structure_given = True
        elif title is not None and not self._structure_given:
            self.structure["title"] = title

        previous = self.statuses
        self.statuses = {}
        reset = {"progress": 0, "to": None, "flag": None, "flagKind": None, "waitingOn": [], "stopReason": None}
        for aid in ["lead"] + [i for i in self._role_ids() if i != "lead"]:
            if aid in previous:
                self.statuses[aid] = previous[aid]
            if aid == "lead":
                self._set(aid, ts, state="working", say="Planning the run", **reset)
            else:
                self._set(aid, ts, state="waiting", say="Waiting for my turn", **reset)
        self._cancel_pending(lambda r: True, _system(), ts)
        self._sources = []
        self._flags = []
        self._result = None
        self._tasks = {}
        self._ledger = None
        self._reviews = []
        self._recoveries = []
        self._claims = {}
        self._evidence = {}
        self.phase = "running"

    def _agent_registered(self, agent_id: str, data: Dict[str, Any], event: Event, ts: str) -> None:
        info = {
            "backend": _str(data.get("backend")),
            "model": _str(data.get("model")),
            "session": _obj(data.get("session")),
            "accepts": _strings(data.get("accepts")),
            "reviewerOf": _strings(data.get("reviewerOf")),
        }
        if all(v is None for v in info.values()):
            return
        old = self._agents.get(agent_id) or {"backend": None, "model": None, "session": None, "accepts": [], "reviewerOf": []}
        self._agents[agent_id] = {k: _coalesce(info[k], v) for k, v in old.items()}

    def _agent_status(self, agent_id: str, data: Dict[str, Any], event: Event, ts: str) -> None:
        prev = self.statuses.get(agent_id) or new_status(ts)
        state = data["state"]
        changes: Dict[str, Any] = {"state": state}
        say = _str(data.get("say"))
        if say is not None:
            changes["say"] = say
        progress = _progress(data.get("progress"))
        if progress is not None:
            changes["progress"] = progress
        changes["to"] = _coalesce(_str(data.get("to")), prev["to"]) if state == "handoff" else None
        changes["flag"] = _coalesce(_str(data.get("flag")), prev["flag"]) if state == "flagged" else None
        changes["flagKind"] = (
            _coalesce(_str(data.get("flagKind")), prev["flagKind"], "concern") if state == "flagged" else None
        )
        stop_reason = _str(data.get("stopReason"))
        if stop_reason is not None:
            changes["stopReason"] = stop_reason
        self._set(agent_id, ts, **changes)

    def _agent_finished(self, agent_id: str, data: Dict[str, Any], event: Event, ts: str) -> None:
        self._set(agent_id, ts, state="done", say=_coalesce(_str(data.get("say")), "Done"), progress=100,
                  to=None, flag=None, flagKind=None)

    def _agent_failed(self, agent_id: str, data: Dict[str, Any], event: Event, ts: str) -> None:
        reason = _str(data.get("reason"))
        self._set(agent_id, ts, state="failed", say=_coalesce(reason, "Failed"), flag=reason,
                  flagKind="error", to=None)

    def _agent_stopped(self, agent_id: str, data: Dict[str, Any], event: Event, ts: str) -> None:
        by = _coalesce(_obj(data.get("by")), _system())
        self._cancel_pending(lambda r: r["agentId"] == agent_id, by, ts)
        self._set(agent_id, ts, state="done" if data.get("scope") == "agent" else "idle",
                  say=_coalesce(_str(data.get("reason")), "Stopped"), to=None, flag=None, flagKind=None,
                  stopReason="cancelled", waitingOn=[])

    def _handoff(self, agent_id: str, data: Dict[str, Any], event: Event, ts: str) -> None:
        target = data["to"]
        say = _coalesce(_str(data.get("say")), f"Handing over to {self._name_of(target)}")
        self._set(agent_id, ts, state="handoff", to=target, say=say, flag=None, flagKind=None)

    def _message(self, agent_id: str, data: Dict[str, Any], event: Event, ts: str) -> None:
        self._set(agent_id, ts, say=data["text"], state=self._wake(agent_id))

    def _tool_started(self, agent_id: str, data: Dict[str, Any], event: Event, ts: str) -> None:
        say = _coalesce(_str(data.get("say")), f"Using {data['name']}")
        self._set(agent_id, ts, say=say, state=self._wake(agent_id))

    def _flag_raised(self, agent_id: str, data: Dict[str, Any], event: Event, ts: str) -> None:
        kind = _coalesce(_str(data.get("kind")), "concern")
        self._set(agent_id, ts, state="flagged", flag=data["text"], flagKind=kind, to=None)
        self._flags.append({"by": agent_id, "kind": kind, "text": data["text"]})

    def _flag_resolved(self, agent_id: str, data: Dict[str, Any], event: Event, ts: str) -> None:
        if self.statuses.get(agent_id, {}).get("state") == "flagged":
            self._set(agent_id, ts, state="working", flag=None, flagKind=None)

    def _artifact(self, agent_id: str, data: Dict[str, Any], event: Event, ts: str) -> None:
        source = data.get("source")
        if data.get("kind") != "source" or not isinstance(source, dict) or not isinstance(source.get("id"), str):
            return
        if any(s["id"] == source["id"] for s in self._sources):
            return
        collected = copy.deepcopy(source)
        if collected.get("foundBy") is None:
            collected["foundBy"] = agent_id
        self._sources.append(collected)

    def _result_event(self, agent_id: str, data: Dict[str, Any], event: Event, ts: str) -> None:
        sources = list(self._sources)
        seen = {s["id"] for s in sources}
        extra_sources = data.get("sources")
        for source in extra_sources if isinstance(extra_sources, list) else []:
            if isinstance(source, dict) and isinstance(source.get("id"), str) and source["id"] not in seen:
                seen.add(source["id"])
                sources.append(source)
        extra_flags = data.get("flags")
        flags = list(self._flags) + [f for f in (extra_flags if isinstance(extra_flags, list) else []) if isinstance(f, dict)]
        work = data.get("work")
        structure_title = _coalesce(_str(self.structure.get("title")), "Untitled MAS")
        title = _coalesce(_str(data.get("title")), f"{structure_title} — run {self.run}")
        result: Dict[str, Any] = {
            "title": title,
            "run": self.run,
            "updated": ts,
            "markdown": _coalesce(_str(data.get("markdown")), ""),
            "sources": sources,
            "flags": flags,
            "work": [w for w in work if isinstance(w, dict)] if isinstance(work, list) else [],
        }
        # Result rounds: a run's first result keeps the 0.1 shape unless it names a round or question.
        question = _str(data.get("question"))
        previous = self._result
        if previous is not None or _num(data.get("round")) is not None or question is not None:
            p = 0 if previous is None else _coalesce(previous.get("round"), 1)
            given_round = data.get("round")
            result["round"] = int(given_round) if _is_integral(given_round) and given_round > p else p + 1
            if question is not None:
                result["question"] = question
            rounds: List[Dict[str, Any]] = []
            if previous is not None:
                rounds = list(previous.get("previous") or [])
                entry: Dict[str, Any] = {"round": p}
                if "question" in previous:
                    entry["question"] = previous["question"]
                entry.update(title=previous["title"], markdown=previous["markdown"], updated=previous["updated"])
                rounds.append(entry)
            result["previous"] = rounds
        self._result = copy.deepcopy(result)

    def _run_finished(self, agent_id: str, data: Dict[str, Any], event: Event, ts: str) -> None:
        self._set("lead", ts, state="done", say=_coalesce(_str(data.get("say")), "Result ready"), progress=100,
                  to=None, flag=None, flagKind=None)
        self.phase = "done"

    def _run_failed(self, agent_id: str, data: Dict[str, Any], event: Event, ts: str) -> None:
        reason = _str(data.get("reason"))
        self._set("lead", ts, state="failed", say=_coalesce(reason, "Run failed"), flag=reason, flagKind="error")
        self.phase = "failed"

    def _round_started(self, agent_id: str, data: Dict[str, Any], event: Event, ts: str) -> None:
        # A follow-up round continues the current run: only the phase and the lead change.
        if self.run == 0:
            return
        self._set("lead", ts, state="working", say="Working on your follow-up", progress=0, to=None, flag=None,
                  flagKind=None, stopReason=None)
        self.phase = "running"

    # ---------------------------------------------------------- requests (0.2)

    def _request_opened(self, agent_id: str, data: Dict[str, Any], event: Event, ts: str) -> None:
        request_id = data["requestId"]
        if request_id in self._pending or any(r["requestId"] == request_id for r in self._recent):
            return
        options = data.get("options")
        request = {
            "requestId": request_id,
            "agentId": agent_id,
            "kind": data["kind"],
            "title": data["title"],
            "description": _str(data.get("description")),
            "subject": _obj(data.get("subject")),
            "toolCallId": _str(data.get("toolCallId")),
            "options": [copy.deepcopy(o) for o in (options if isinstance(options, list) else [])
                        if isinstance(o, dict) and isinstance(o.get("optionId"), str)],
            "responseSchema": _obj(data.get("responseSchema")),
            "blocking": _coalesce(_bool(data.get("blocking")), True),
            "routeTo": _coalesce(_str(data.get("routeTo")), "human"),
            "resolver": _coalesce(_str(data.get("resolver")), "anyone"),
            "urgency": _coalesce(_one_of(URGENCIES, data.get("urgency")), "normal"),
            "expiresAt": _str(data.get("expiresAt")),
            "onExpire": _str(data.get("onExpire")),
            "source": _obj(data.get("source")),
            "openedAt": ts,
            "seq": int(event["seq"]),
            "run": self.run,
        }
        self._pending[request_id] = request
        if not request["blocking"]:
            return
        prev = self.statuses[agent_id]
        waiting_on = prev["waitingOn"] + [request_id]
        if prev["state"] in ("done", "failed"):
            self._set(agent_id, ts, waitingOn=waiting_on)
        else:
            self._set(agent_id, ts, state="flagged", flag=request["title"], flagKind=_flag_kind_of(request["kind"]),
                      to=None, waitingOn=waiting_on)

    def _request_resolved(self, agent_id: str, data: Dict[str, Any], event: Event, ts: str) -> None:
        request = self._pending.get(data["requestId"])
        if request is None:  # unknown, or already answered: the first answer wins
            return
        payload = data.get("payload")
        self._close(request, {
            "outcome": data["outcome"],
            "optionId": _str(data.get("optionId")),
            "payload": copy.deepcopy(payload),
            "note": _str(data.get("note")),
            "by": _coalesce(_obj(data.get("by")), _system()),
            "cmdId": _str(data.get("cmdId")),
            "resolvedAt": ts,
        })
        opener_id = request["agentId"]
        opener = self.statuses.get(opener_id)
        if opener is None or request["requestId"] not in opener["waitingOn"]:
            return
        waiting_on = [r for r in opener["waitingOn"] if r != request["requestId"]]
        changes: Dict[str, Any] = {"waitingOn": waiting_on}
        if opener["state"] == "flagged" and opener["flagKind"] in WAIT_FLAGS:
            oldest = self._pending.get(waiting_on[0]) if waiting_on else None
            if oldest is not None:
                changes.update(flag=oldest["title"], flagKind=_flag_kind_of(oldest["kind"]))
            else:
                changes.update(state="working", flag=None, flagKind=None)
        self._set(opener_id, ts, **changes)

    # ---------------------------------------------------------- commands (0.2)

    def _command(self, agent_id: str, data: Dict[str, Any], event: Event, ts: str) -> None:
        cmd_id = data["cmdId"]
        if cmd_id in self._commands:
            return
        etype = event["type"]
        text = data["text"] if etype == "command.message" else data["title"] if etype == "command.assign" else None
        self._commands[cmd_id] = {
            "cmdId": cmd_id,
            "type": etype,
            "agentId": agent_id,
            "origin": _coalesce(_obj(data.get("origin")), {"kind": "agent", "id": "lead"}),
            "text": text,
            "delivery": _coalesce(_one_of(DELIVERIES, data.get("delivery")), "steer") if etype == "command.message" else None,
            "requestId": data["requestId"] if etype == "command.respond" else None,
            "status": "sent",
            "reason": None,
            "sentAt": ts,
            "ackAt": None,
            "seq": int(event["seq"]),
        }
        if len(self._commands) > COMMAND_LIMIT:
            del self._commands[next(iter(self._commands))]

    def _command_ack(self, agent_id: str, data: Dict[str, Any], event: Event, ts: str) -> None:
        cmd = self._commands.get(data["cmdId"])
        if cmd is not None and cmd["status"] not in FINAL_ACKS:
            cmd.update(status=data["status"], reason=_str(data.get("reason")), ackAt=ts)

    # ------------------------------------------------- usage, tasks, reviews (0.2)

    def _usage_event(self, agent_id: str, data: Dict[str, Any], event: Event, ts: str) -> None:
        old = self._usage.get(agent_id) or {"inputTokens": 0, "outputTokens": 0, "costUsd": 0, "turns": 0, "limit": None}
        self._usage[agent_id] = {
            "inputTokens": _coalesce(_num(data.get("inputTokens")), old["inputTokens"]),
            "outputTokens": _coalesce(_num(data.get("outputTokens")), old["outputTokens"]),
            "costUsd": _coalesce(_num(data.get("costUsd")), old["costUsd"]),
            "turns": _coalesce(_num(data.get("turns")), old["turns"]),
            "limit": _coalesce(_obj(data.get("limit")), old["limit"]),
            "updated": ts,
        }

    def _task_assigned(self, agent_id: str, data: Dict[str, Any], event: Event, ts: str) -> None:
        task = self._tasks.get(data["taskId"])
        if task is None:
            self._tasks[data["taskId"]] = {
                "taskId": data["taskId"], "agentId": agent_id, "title": data["title"],
                "brief": _str(data.get("brief")), "from": _coalesce(_str(data.get("from")), "lead"),
                "round": _coalesce(_num(data.get("round")), 1), "attempt": _coalesce(_num(data.get("attempt")), 1),
                "state": "assigned", "say": None, "outcome": None, "summary": None, "assignedAt": ts, "finishedAt": None,
            }
        else:
            task.update(
                title=data["title"], brief=_coalesce(_str(data.get("brief")), task["brief"]),
                round=_coalesce(_num(data.get("round")), task["round"]),
                attempt=_coalesce(_num(data.get("attempt")), task["attempt"]),
                state="assigned", outcome=None, summary=None, finishedAt=None,
            )

    def _task_updated(self, agent_id: str, data: Dict[str, Any], event: Event, ts: str) -> None:
        task = self._tasks.get(data["taskId"])
        state = _one_of(TASK_STATES, data.get("state"))
        if task is not None and state is not None:
            task["state"] = state
        say = _str(data.get("say"))
        if say is not None:
            if task is not None:
                task["say"] = say
            self._set(agent_id, ts, say=say, state=self._wake(agent_id))

    def _task_finished(self, agent_id: str, data: Dict[str, Any], event: Event, ts: str) -> None:
        task = self._tasks.get(data["taskId"])
        if task is not None:
            task.update(state="done", outcome=_coalesce(_one_of(TASK_OUTCOMES, data.get("outcome")), "success"),
                        summary=_str(data.get("summary")), finishedAt=ts)

    def _lead_ledger(self, agent_id: str, data: Dict[str, Any], event: Event, ts: str) -> None:
        plan = data.get("plan")
        self._ledger = {
            "satisfied": _bool(data.get("satisfied")),
            "looping": _bool(data.get("looping")),
            "progressing": _bool(data.get("progressing")),
            "next": _str(data.get("next")),
            "instruction": _str(data.get("instruction")),
            "reason": _str(data.get("reason")),
            "plan": list(plan) if isinstance(plan, list) and all(isinstance(p, str) for p in plan) else None,
            "stalls": _num(data.get("stalls")),
            "updated": ts,
        }

    def _review_verdict(self, agent_id: str, data: Dict[str, Any], event: Event, ts: str) -> None:
        self._reviews.append({"reviewer": agent_id, "target": data["target"], "verdict": data["verdict"],
                              "round": _coalesce(_num(data.get("round")), 1), "note": _str(data.get("note")), "at": ts})

    def _recovery_chosen(self, agent_id: str, data: Dict[str, Any], event: Event, ts: str) -> None:
        self._recoveries.append({"by": agent_id, "strategy": data["strategy"], "target": _str(data.get("target")),
                                 "note": _str(data.get("note")), "at": ts})

    # ------------------------------------------------------ verification (0.2)

    def _claim_added(self, agent_id: str, data: Dict[str, Any], event: Event, ts: str) -> None:
        claim = self._claims.get(data["claimId"]) or {
            "claimId": data["claimId"], "text": data["text"], "sources": [], "serves": None, "checkworthy": True,
            "author": agent_id, "status": None, "verdicts": [],
        }
        claim.update(
            text=data["text"],
            sources=_coalesce(_strings(data.get("sources")), claim["sources"]),
            serves=_coalesce(_str(data.get("serves")), claim["serves"]),
            checkworthy=_coalesce(_bool(data.get("checkworthy")), claim["checkworthy"]),
        )
        claim["status"] = _claim_status(claim)
        self._claims[data["claimId"]] = claim

    def _evidence_checked(self, agent_id: str, data: Dict[str, Any], event: Event, ts: str) -> None:
        old = self._evidence.get(data["sourceId"]) or {}
        self._evidence[data["sourceId"]] = {
            "sourceId": data["sourceId"],
            "url": _coalesce(_str(data.get("url")), old.get("url")),
            "urlHealth": _coalesce(_one_of(URL_HEALTH, data.get("urlHealth")), old.get("urlHealth")),
            "httpStatus": _coalesce(_num(data.get("httpStatus")), old.get("httpStatus")),
            "archivedUrl": _coalesce(_str(data.get("archivedUrl")), old.get("archivedUrl")),
            "grade": _coalesce(_one_of(GRADES, data.get("grade")), old.get("grade")),
            "quote": _coalesce(_str(data.get("quote")), old.get("quote")),
            "note": _coalesce(_str(data.get("note")), old.get("note")),
            "checkedBy": agent_id,
            "at": ts,
        }

    def _verdict_recorded(self, agent_id: str, data: Dict[str, Any], event: Event, ts: str) -> None:
        claim = self._claims.get(data["claimId"])
        if claim is None:
            return
        claim["verdicts"].append({
            "by": agent_id,
            "status": data["status"],
            "sourceId": _str(data.get("sourceId")),
            "relationship": _one_of(RELATIONSHIPS, data.get("relationship")),
            "method": _str(data.get("method")),
            "note": _str(data.get("note")),
            "backend": _str(data.get("backend")),
            "at": ts,
        })
        claim["status"] = _claim_status(claim)


_HANDLERS = {
    "run.started": Reducer._run_started,
    "agent.registered": Reducer._agent_registered,
    "agent.status": Reducer._agent_status,
    "agent.finished": Reducer._agent_finished,
    "agent.failed": Reducer._agent_failed,
    "agent.stopped": Reducer._agent_stopped,
    "handoff": Reducer._handoff,
    "message": Reducer._message,
    "tool.started": Reducer._tool_started,
    "flag.raised": Reducer._flag_raised,
    "flag.resolved": Reducer._flag_resolved,
    "artifact": Reducer._artifact,
    "result": Reducer._result_event,
    "run.finished": Reducer._run_finished,
    "run.failed": Reducer._run_failed,
    "round.started": Reducer._round_started,
    "request.opened": Reducer._request_opened,
    "request.resolved": Reducer._request_resolved,
    **{t: Reducer._command for t in COMMAND_TYPES},
    "command.ack": Reducer._command_ack,
    "usage": Reducer._usage_event,
    "task.assigned": Reducer._task_assigned,
    "task.updated": Reducer._task_updated,
    "task.finished": Reducer._task_finished,
    "lead.ledger": Reducer._lead_ledger,
    "review.verdict": Reducer._review_verdict,
    "recovery.chosen": Reducer._recovery_chosen,
    "claim.added": Reducer._claim_added,
    "evidence.checked": Reducer._evidence_checked,
    "verdict.recorded": Reducer._verdict_recorded,
}


def reduce(lines: Iterable[Union[str, Event]]) -> Snapshot:
    """Reduce a whole log (lines of JSON, or parsed events) to snapshots."""
    reducer = Reducer()
    for event in parse_log(lines):
        reducer.apply(event)
    return reducer.snapshot()
