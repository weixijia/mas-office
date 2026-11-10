import json
from pathlib import Path

import pytest

from mas_office import Reducer, reduce, validate_event
from mas_office.reducer import MAX_SEQ, parse_log, split_lines

CONFORMANCE = Path(__file__).resolve().parents[3] / "spec" / "conformance"
CASES = sorted(p for p in CONFORMANCE.iterdir() if p.is_dir())


def log_lines(case):
    return split_lines((case / "events.jsonl").read_bytes().decode("utf-8"))


def ev(seq, type, agent="lead", ts=None, **data):
    return {"v": "0.1", "seq": seq, "ts": ts or f"t{seq}", "type": type, "agentId": agent, "data": data}


def test_conformance_cases_exist():
    assert len(CASES) >= 4


@pytest.mark.parametrize("case", CASES, ids=[c.name for c in CASES])
def test_conformance(case):
    lines = log_lines(case)
    expected = json.loads((case / "expected.json").read_text(encoding="utf-8"))
    got = reduce(lines)
    assert got == expected
    assert list(got["statuses"]) == list(expected["statuses"])  # lead first, then registration order


@pytest.mark.parametrize("case", CASES, ids=[c.name for c in CASES])
def test_incremental_apply_matches_reduce_for_ordered_logs(case):
    lines = log_lines(case)
    events = []
    for line in lines:
        try:
            events.append(json.loads(line))
        except ValueError:
            pass
    reducer = Reducer()
    for event in sorted((e for e in events if validate_event(e)), key=lambda e: e["seq"]):
        reducer.apply(event)
    assert reducer.snapshot() == reduce(lines)


def test_empty_log():
    snap = reduce([])
    assert snap["state"]["phase"] == "locked"
    assert snap["state"]["run"] == 0
    assert snap["state"]["next"] == "Waiting for the first run."
    assert list(snap["statuses"]) == ["lead"]
    assert snap["result"] is None


@pytest.mark.parametrize(
    "event",
    [
        {"seq": 1, "ts": "t", "type": "message", "data": {"text": "x"}},  # no v
        {"v": "0.1", "seq": 0, "ts": "t", "type": "run.started"},
        {"v": "0.1", "seq": True, "ts": "t", "type": "run.started"},
        {"v": "0.1", "seq": 1.5, "ts": "t", "type": "run.started"},
        {"v": "0.1", "seq": 1, "ts": 5, "type": "run.started"},
        {"v": "0.1", "seq": 1, "ts": "t", "type": "run.started", "data": []},
        {"v": "0.1", "seq": 1, "ts": "t", "type": "handoff", "data": {}},
        {"v": "0.1", "seq": 1, "ts": "t", "type": "message", "data": {"text": 3}},
        {"v": "0.1", "seq": 1, "ts": "t", "type": "agent.status", "data": {"state": "sleeping"}},
    ],
)
def test_invalid_events_are_dropped(event):
    assert not validate_event(event)
    assert not Reducer().apply(event)


def test_integral_float_seq_is_valid_like_json():
    assert validate_event({"v": "0.1", "seq": 2.0, "ts": "t", "type": "run.started"})


def test_progress_rounds_half_up_and_clamps():
    lines = [
        {"v": "0.1", "seq": 1, "ts": "t1", "type": "agent.status", "agentId": "a", "data": {"state": "working", "progress": 2.5}},
        {"v": "0.1", "seq": 2, "ts": "t2", "type": "agent.status", "agentId": "b", "data": {"state": "working", "progress": -7}},
    ]
    statuses = reduce(lines)["statuses"]
    assert statuses["a"]["progress"] == 3
    assert statuses["b"]["progress"] == 0


def test_status_time_changes_only_when_status_changes():
    lines = [
        {"v": "0.1", "seq": 1, "ts": "t1", "type": "run.started", "data": {}},
        {"v": "0.1", "seq": 2, "ts": "t2", "type": "flag.resolved", "agentId": "lead"},
    ]
    assert reduce(lines)["statuses"]["lead"]["t"] == "t1"


def test_registered_group_is_appended_after_last_group():
    lines = [
        {"v": "0.1", "seq": 1, "ts": "t1", "type": "agent.registered", "agentId": "x", "data": {"group": "Z", "role": "helper"}},
    ]
    snap = reduce(lines)
    assert snap["structure"]["groups"] == [{"id": "Z", "label": "Group Z", "after": None}]
    assert snap["structure"]["roles"][0]["role"] == "helper"
    assert snap["statuses"]["x"]["state"] == "idle"  # not running yet


@pytest.mark.parametrize("value, expected", [
    (0.49999999999999994, 0),  # floor(x + 0.5) would give 1; JavaScript Math.round gives 0
    (0.5, 1), (2.5, 3), (-0.5, 0), (99.5, 100), (100.4, 100), (1e300, 100), (-1e300, 0),
])
def test_progress_rounds_like_javascript_math_round(value, expected):
    snap = reduce([ev(1, "agent.status", "a", state="working", progress=value)])
    assert snap["statuses"]["a"]["progress"] == expected


def test_progress_that_is_infinite_in_javascript_is_not_given():
    line = '{"v": "0.1", "seq": 1, "ts": "t", "type": "agent.status", "agentId": "a", "data": {"state": "working", "progress": 1%s}}'
    assert reduce([line % ("0" * 400)])["statuses"]["a"]["progress"] == 0  # an int beyond a double
    assert reduce([line % "e400"])["statuses"]["a"]["progress"] == 0  # parses to inf
    assert reduce([ev(1, "agent.status", "a", state="working", progress=True)])["statuses"]["a"]["progress"] == 0


def test_seq_upper_bound_is_two_to_the_53_minus_one():
    assert validate_event(ev(MAX_SEQ, "run.started"))
    assert not validate_event(ev(MAX_SEQ + 1, "run.started"))
    assert not validate_event(ev(float(2**53), "run.started"))


def test_lines_are_parsed_exactly_as_json():
    good = json.dumps(ev(1, "message", text="a"))
    assert len(parse_log([" \t" + good + "\r"])) == 1  # JSON whitespace is fine
    for junk in ("\x0c", "\u00a0", "\u2028", "\ufeff"):
        assert parse_log([junk + good]) == [] and parse_log([good + junk]) == []
    assert parse_log(["", "   ", "\r"]) == []


def test_split_lines_only_splits_on_newline():
    text = json.dumps(ev(1, "message", text="a\u2028b\u2029c\x0cd\x85e\x1ce\x1de\x1ef"), ensure_ascii=False)
    assert "\n" not in text and len(text.splitlines()) == 4  # json.dumps leaves U+0085/2028/2029 raw
    lines = split_lines(text + "\n" + text.replace('"seq": 1', '"seq": 2').replace('"t1"', '"t2"') + "\n")
    assert len(lines) == 3 and lines[-1] == ""
    assert reduce(lines)["statuses"]["lead"]["say"] == "a\u2028b\u2029c\x0cd\x85e\x1ce\x1de\x1ef"
    assert reduce(lines)["state"]["updated"] == "t2"


def test_wrong_type_fields_count_as_not_given():
    structure = {"title": 7, "lead": {"id": "lead", "name": None}, "groups": "nope", "roles": [{"id": "b", "name": None}]}
    snap = reduce([
        ev(1, "run.started", title=["x"], structure=structure),
        ev(2, "agent.registered", "g", name=5, emoji=None, job=1, group=1.0, handsTo={}, role=3),
        ev(3, "handoff", "g", to="b"),
        ev(4, "handoff", "b", to="lead"),
        ev(5, "agent.status", "b", state="handoff", to={"x": 1}, say=None, progress="50"),
        ev(6, "agent.status", "g", state="flagged", flag=1, flagKind=2),
        ev(7, "flag.raised", "lead", text="t", kind=9),
        ev(8, "agent.failed", "g", reason=False),
        ev(9, "result", title=1, markdown=2, work=["x", {"by": "g"}], flags=[None, {"text": "f"}],
           sources=[{"id": 1}, {"title": "no id"}, {"id": "s"}]),
    ])
    assert snap["structure"]["title"] == "Untitled MAS"
    assert snap["structure"]["groups"] == [{"id": "dyn", "label": "Spawned at runtime", "after": None}]
    g = snap["structure"]["roles"][1]
    assert g == {"id": "g", "name": "g", "emoji": "🤖", "job": "", "serves": [], "tools": [], "group": "dyn",
                 "handsTo": "lead", "dynamic": True, "parent": "lead"}
    st = snap["statuses"]
    assert st["g"]["state"] == "failed" and st["g"]["say"] == "Failed" and st["g"]["flag"] is None
    assert st["b"]["say"] == "Handing over to Lead" and st["b"]["to"] == "lead" and st["b"]["progress"] == 0
    assert st["lead"]["flagKind"] == "concern"
    result = snap["result"]
    assert result["title"] == "Untitled MAS — run 1" and result["markdown"] == ""
    assert result["work"] == [{"by": "g"}]
    assert result["flags"] == [{"by": "lead", "kind": "concern", "text": "t"}, {"text": "f"}]
    assert result["sources"] == [{"id": "s"}]


def test_handoff_to_role_with_null_name_uses_its_id():
    structure = {"roles": [{"id": "b", "name": None}]}
    snap = reduce([ev(1, "run.started", structure=structure), ev(2, "handoff", "lead", to="b")])
    assert snap["statuses"]["lead"]["say"] == "Handing over to b"


def test_flagged_status_keeps_previous_values_for_wrong_types():
    snap = reduce([
        ev(1, "agent.status", "a", state="flagged", flag="real", flagKind="needs_input"),
        ev(2, "agent.status", "a", ts="t2", state="flagged", flag=None, flagKind=3),
    ])
    assert snap["statuses"]["a"]["flag"] == "real" and snap["statuses"]["a"]["flagKind"] == "needs_input"
    assert snap["statuses"]["a"]["t"] == "t1"  # nothing changed, so t did not move


def test_run_end_without_start_applies():
    snap = reduce([ev(1, "agent.status", "a", state="working"), ev(2, "run.failed", reason="boom")])
    assert snap["state"]["phase"] == "failed" and snap["state"]["run"] == 0
    assert snap["state"]["next"] == "Run failed — see the Lead's desk."
    assert snap["statuses"]["lead"]["state"] == "failed" and snap["statuses"]["lead"]["flag"] == "boom"
    assert snap["statuses"]["a"]["state"] == "working"
    later = reduce([ev(1, "run.finished"), ev(2, "message", "late", text="hi")])
    assert later["state"]["phase"] == "done"
    assert later["statuses"]["late"]["state"] == "working"  # registered idle (not running), then woken


def test_non_string_agent_name_and_parent_are_not_given():
    """Spec §4.2: envelope agentName / parentId of the wrong type count as not given."""
    snap = reduce([
        {"v": "0.1", "seq": 1, "ts": "t1", "type": "run.started"},
        {"v": "0.1", "seq": 2, "ts": "t2", "type": "agent.status", "agentId": "a",
         "agentName": 42, "parentId": 7, "data": {"state": "working"}},
    ])
    role = snap["structure"]["roles"][0]
    assert (role["name"], role["parent"]) == ("a", "lead")


@pytest.mark.parametrize(
    "type, data",
    [
        ("request.opened", {"requestId": "r", "kind": "question"}),
        ("request.opened", {"requestId": 1, "kind": "question", "title": "T"}),
        ("request.resolved", {"requestId": "r", "outcome": "maybe"}),
        ("command.message", {"cmdId": "c"}),
        ("command.respond", {"cmdId": "c", "outcome": "selected"}),
        ("command.ack", {"cmdId": "c", "status": "done"}),
        ("command.ack", {"cmdId": "c", "status": True}),
        ("task.assigned", {"taskId": "t"}),
        ("task.updated", {"taskId": None}),
        ("review.verdict", {"target": "a", "verdict": "maybe"}),
        ("recovery.chosen", {"strategy": "pray"}),
        ("claim.added", {"claimId": "c"}),
        ("evidence.checked", {}),
        ("verdict.recorded", {"claimId": "c", "status": "true"}),
    ],
)
def test_0_2_invalid_events_are_dropped(type, data):
    event = ev(1, type, **data)
    assert not validate_event(event)
    assert not Reducer().apply(event)


def test_0_2_valid_events_with_open_kinds_and_outcomes():
    assert validate_event(ev(1, "request.opened", requestId="r", kind="anything", title="T"))
    assert validate_event(ev(1, "command.respond", cmdId="c", requestId="r", outcome="free text"))
    for type in ("agent.stopped", "usage", "lead.ledger"):
        assert validate_event(ev(1, type))


def test_empty_log_has_empty_0_2_snapshots():
    snap = reduce([])
    assert snap["statuses"]["lead"]["waitingOn"] == [] and snap["statuses"]["lead"]["stopReason"] is None
    assert snap["inbox"] == {"pending": [], "recent": [], "commands": []}
    assert snap["board"] == {"tasks": [], "ledger": None, "reviews": [], "recoveries": [], "usage": {}, "agents": {}}
    assert snap["verification"] is None
    assert list(snap) == ["structure", "statuses", "state", "result", "inbox", "board", "verification"]


def test_recent_keeps_50_and_commands_keep_100():
    events = [ev(1, "run.started")]
    for i in range(60):
        events.append(ev(len(events) + 1, "request.opened", requestId=f"r{i}", kind="question", title=f"Q{i}", blocking=False))
        events.append(ev(len(events) + 1, "request.resolved", requestId=f"r{i}", outcome="declined"))
    for i in range(105):
        events.append(ev(len(events) + 1, "command.message", "w", cmdId=f"c{i}", text="x"))
    events.append(ev(len(events) + 1, "request.opened", requestId="r0", kind="question", title="Reused id", blocking=False))
    events.append(ev(len(events) + 1, "command.ack", cmdId="c0", status="applied"))
    snap = reduce(events)
    recent = snap["inbox"]["recent"]
    assert len(recent) == 50 and (recent[0]["requestId"], recent[-1]["requestId"]) == ("r59", "r10")
    assert [r["title"] for r in snap["inbox"]["pending"]] == ["Reused id"]
    commands = snap["inbox"]["commands"]
    assert len(commands) == 100 and (commands[0]["cmdId"], commands[-1]["cmdId"]) == ("c5", "c104")
    assert all(c["status"] == "sent" for c in commands)


def test_stop_reason_is_cleared_only_when_entering_working_waiting_or_handoff():
    reducer = Reducer()
    for event in [
        ev(1, "run.started"),
        ev(2, "agent.status", "a", state="working"),
        ev(3, "agent.stopped", "a"),
        ev(4, "agent.status", "a", state="idle", stopReason="cancelled"),
    ]:
        reducer.apply(event)
    a = reducer.snapshot()["statuses"]["a"]
    assert (a["state"], a["stopReason"], a["t"]) == ("idle", "cancelled", "t3")
    reducer.apply(ev(5, "handoff", "a", to="lead"))
    assert reducer.snapshot()["statuses"]["a"]["stopReason"] is None
    reducer.apply(ev(6, "agent.status", "a", state="handoff", stopReason="odd"))
    reducer.apply(ev(7, "agent.status", "a", state="handoff"))
    assert reducer.snapshot()["statuses"]["a"]["stopReason"] == "odd"


def test_0_2_numbers_reject_bools_and_round_must_be_integral():
    snap = reduce([
        ev(1, "run.started"),
        ev(2, "usage", "a", inputTokens=True, turns=2.0, costUsd=float("inf")),
        ev(3, "task.assigned", "a", taskId="t", title="T", round=False, attempt=2),
        ev(4, "result", markdown="one", round=True),
        ev(5, "result", markdown="two", round=3.0),
    ])
    usage = snap["board"]["usage"]["a"]
    assert (usage["inputTokens"], usage["turns"], usage["costUsd"]) == (0, 2, 0)
    assert (snap["board"]["tasks"][0]["round"], snap["board"]["tasks"][0]["attempt"]) == (1, 2)
    result = snap["result"]
    assert result["round"] == 3 and type(result["round"]) is int
    assert result["previous"] == [{"round": 1, "title": "Untitled MAS — run 1", "markdown": "one", "updated": "t4"}]


def test_snapshots_of_0_2_state_are_copies():
    reducer = Reducer()
    for event in [
        ev(1, "run.started"),
        ev(2, "request.opened", "a", requestId="r1", kind="approval", title="T", options=[{"optionId": "o"}]),
        ev(3, "claim.added", claimId="c1", text="x", sources=["s"]),
    ]:
        reducer.apply(event)
    snap = reducer.snapshot()
    snap["statuses"]["a"]["waitingOn"].append("x")
    snap["inbox"]["pending"][0]["options"][0]["optionId"] = "changed"
    snap["verification"]["claims"][0]["sources"].append("y")
    again = reducer.snapshot()
    assert again["statuses"]["a"]["waitingOn"] == ["r1"]
    assert again["inbox"]["pending"][0]["options"][0]["optionId"] == "o"
    assert again["verification"]["claims"][0]["sources"] == ["s"]


def test_round_started_keeps_the_run_and_is_ignored_before_any_run():
    assert reduce([ev(1, "round.started", round=2)])["state"]["phase"] == "locked"
    assert reduce([ev(1, "round.started")])["statuses"]["lead"]["state"] == "idle"
    snap = reduce([
        ev(1, "run.started"),
        ev(2, "request.opened", "a", requestId="r1", kind="gate", title="G", routeTo="lead"),
        ev(3, "task.assigned", "a", taskId="t1", title="T"),
        ev(4, "claim.added", claimId="c1", text="x"),
        ev(5, "result", markdown="one"),
        ev(6, "run.finished"),
        ev(7, "round.started", round=2, question="More?"),
    ])
    assert (snap["state"]["phase"], snap["state"]["run"]) == ("running", 1)
    lead = snap["statuses"]["lead"]
    assert (lead["state"], lead["say"], lead["progress"]) == ("working", "Working on your follow-up", 0)
    assert snap["statuses"]["a"]["state"] == "flagged" and snap["result"]["markdown"] == "one"
    assert (len(snap["inbox"]["pending"]), len(snap["board"]["tasks"]), len(snap["verification"]["claims"])) == (1, 1, 1)
