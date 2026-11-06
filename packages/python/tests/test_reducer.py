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
