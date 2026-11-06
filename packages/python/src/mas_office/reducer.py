"""The MAS Office reducer (spec section 4).

``reduce(lines)`` turns an event log into the four snapshots the panel reads:
``{"structure", "statuses", "state", "result"}``. It is a pure function and must
produce exactly the same output as the JavaScript reference implementation for
every case in ``spec/conformance/``.

JSON field names stay camelCase, as in the spec.
"""

from __future__ import annotations

import copy
import json
import math
from typing import Any, Dict, Iterable, List, Optional, Union

SPEC_VERSION = "0.1"

STATES = ("idle", "waiting", "working", "handoff", "flagged", "done", "failed")

# Required ``data`` field (always a string) per event type: the bold fields of spec 3.2.
REQUIRED_DATA: Dict[str, str] = {
    "agent.status": "state",
    "handoff": "to",
    "message": "text",
    "tool.started": "name",
    "flag.raised": "text",
}

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
    """A fresh status with exactly the seven spec fields."""
    return {"state": state, "say": say, "to": None, "flag": None, "flagKind": None, "progress": 0, "t": ts}


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
        field = REQUIRED_DATA.get(etype)
        if field is not None and not isinstance(data.get(field), str):
            errors.append(f'"{etype}" needs a string "data.{field}"')
        elif etype == "agent.status" and data["state"] not in STATES:
            errors.append(f'"data.state" must be one of {", ".join(STATES)}')
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


def _coalesce(*values: Any) -> Any:
    """JavaScript ``a ?? b ?? c``: the first value that is not None."""
    for value in values:
        if value is not None:
            return value
    return None


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
        """Return a deep copy of ``{"structure", "statuses", "state", "result"}`` (spec 4.5)."""
        # The phase is "locked" until the first run event; run.finished / run.failed apply
        # even without a run.started (spec 4.4), so run may be 0 with phase "done".
        next_line = {"locked": NEXT_BEFORE_RUN, "done": NEXT_DONE, "failed": NEXT_FAILED}.get(self.phase, NEXT_RUNNING)
        state = {
            "mode": "sdk",
            "step": 4,
            "phase": self.phase,
            "locked": True,
            "version": _coalesce(self.structure.get("version"), 1),
            "run": self.run,
            "runId": self.run_id,
            "updated": self.updated,
            "next": next_line,
        }
        return copy.deepcopy(
            {"structure": self.structure, "statuses": self.statuses, "state": state, "result": self._result}
        )

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
        if agent_id not in self.statuses or any(updated[k] != current[k] for k in changes):
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
        for aid in ["lead"] + [i for i in self._role_ids() if i != "lead"]:
            if aid in previous:
                self.statuses[aid] = previous[aid]
            if aid == "lead":
                self._set(aid, ts, state="working", say="Planning the run", progress=0, to=None, flag=None, flagKind=None)
            else:
                self._set(aid, ts, state="waiting", say="Waiting for my turn", progress=0, to=None, flag=None, flagKind=None)
        self._sources = []
        self._flags = []
        self._result = None
        self.phase = "running"

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
        self._set(agent_id, ts, **changes)

    def _agent_finished(self, agent_id: str, data: Dict[str, Any], event: Event, ts: str) -> None:
        self._set(agent_id, ts, state="done", say=_coalesce(_str(data.get("say")), "Done"), progress=100,
                  to=None, flag=None, flagKind=None)

    def _agent_failed(self, agent_id: str, data: Dict[str, Any], event: Event, ts: str) -> None:
        reason = _str(data.get("reason"))
        self._set(agent_id, ts, state="failed", say=_coalesce(reason, "Failed"), flag=reason,
                  flagKind="error", to=None)

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
        self._result = copy.deepcopy({
            "title": title,
            "run": self.run,
            "updated": ts,
            "markdown": _coalesce(_str(data.get("markdown")), ""),
            "sources": sources,
            "flags": flags,
            "work": [w for w in work if isinstance(w, dict)] if isinstance(work, list) else [],
        })

    def _run_finished(self, agent_id: str, data: Dict[str, Any], event: Event, ts: str) -> None:
        self._set("lead", ts, state="done", say=_coalesce(_str(data.get("say")), "Result ready"), progress=100,
                  to=None, flag=None, flagKind=None)
        self.phase = "done"

    def _run_failed(self, agent_id: str, data: Dict[str, Any], event: Event, ts: str) -> None:
        reason = _str(data.get("reason"))
        self._set("lead", ts, state="failed", say=_coalesce(reason, "Run failed"), flag=reason, flagKind="error")
        self.phase = "failed"


_HANDLERS = {
    "run.started": Reducer._run_started,
    "agent.status": Reducer._agent_status,
    "agent.finished": Reducer._agent_finished,
    "agent.failed": Reducer._agent_failed,
    "handoff": Reducer._handoff,
    "message": Reducer._message,
    "tool.started": Reducer._tool_started,
    "flag.raised": Reducer._flag_raised,
    "flag.resolved": Reducer._flag_resolved,
    "artifact": Reducer._artifact,
    "result": Reducer._result_event,
    "run.finished": Reducer._run_finished,
    "run.failed": Reducer._run_failed,
}


def reduce(lines: Iterable[Union[str, Event]]) -> Snapshot:
    """Reduce a whole log (lines of JSON, or parsed events) to snapshots."""
    reducer = Reducer()
    for event in parse_log(lines):
        reducer.apply(event)
    return reducer.snapshot()
