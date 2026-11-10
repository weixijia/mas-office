import json
import sys

import pytest

from conftest import STRUCTURE, ev, write_log
from mas_eval.hci import hci_metrics
from mas_eval.judge import make_sheet, parse_sheet, run_judge
from mas_eval.metrics import run_metrics
from mas_eval.report import compare


def finished_run(project, condition, tokens=None, support=True, end=600):
    events = [
        ev(0, "run.started", structure=STRUCTURE),
        ev(10, "claim.added", claimId="c1", text="The iPad Air costs 599 GBP at Apple, seen 2026-11-10.", sources=["s1"]),
        ev(11, "claim.added", claimId="c2", text="Delivery from Currys takes two days.", sources=[]),
        ev(12, "evidence.checked", sourceId="s1", url="https://www.apple.com/uk/x", urlHealth="live", grade="A"),
        ev(13, "verdict.recorded", "checker", claimId="c1", status="supported" if support else "contradicted"),
        ev(20, "result", markdown='## Offers\n\n<claim id="c1" src="s1">The iPad Air costs 599 GBP at Apple, seen 2026-11-10.</claim>\n\n'
                                  '<claim id="c2">Delivery from Currys takes two days.</claim>'),
    ]
    if tokens is not None:
        events.append(ev(30, "usage", "finder-a", inputTokens=tokens, outputTokens=0))
    events.append(ev(end, "run.finished"))
    return write_log(project, events, meta={"task": "price-tablet-uk", "condition": condition})


def test_compare_tables(tmp_path):
    runs = [
        run_metrics(finished_run(tmp_path / "a" / "price-tablet-uk", "team", tokens=2000)),
        run_metrics(finished_run(tmp_path / "b" / "price-tablet-uk", "team", support=False)),
        run_metrics(finished_run(tmp_path / "c" / "price-tablet-uk", "single", end=1200)),
    ]
    text = compare(runs)
    assert "## Task: price-tablet-uk" in text and "## All tasks" in text
    rows = [line for line in text.splitlines() if line.startswith("| team ")]
    assert len(rows) == 2  # one in the task table, one in the aggregate
    cells = [c.strip() for c in rows[0].strip("|").split("|")]
    header = [c.strip() for c in next(l for l in text.splitlines() if l.startswith("| condition")).strip("|").split("|")]
    row = dict(zip(header, cells))
    assert row["n"] == "2"
    assert row["support rate"] == "0.25"  # (1/2 + 0/2) / 2
    assert row["tokens (k)"] == "2 (1/2)"  # only one run reported usage
    assert row["cost USD"] == "—"
    assert row["wall min"] == "10.0"
    single = dict(zip(header, [c.strip() for c in next(l for l in text.splitlines() if l.startswith("| single ")).strip("|").split("|")]))
    assert single["wall min"] == "20.0" and single["done"] == "1.00"
    assert "No significance tests" in text and "n < 5 for single, team" in text
    assert compare([]) == "No runs to compare.\n"


def test_sheet_round_trip(tmp_path):
    project = finished_run(tmp_path / "ws" / "price-tablet-uk", "team")
    sheet = make_sheet(project)
    assert "item:R1 kind:requirement" in sheet and "item:C5 kind:must-cite" in sheet
    assert "The iPad Air costs 599 GBP at Apple, seen 2026-11-10. [c1]" in sheet  # tags shown as ids
    assert "`c2` [unchecked] Delivery from Currys takes two days. — sources: none" in sheet
    assert "https://www.apple.com/uk/x — live, grade A" in sheet
    filled = (sheet.replace("[ ] **R1**", "[x] **R1**").replace("[ ] **C1**", "[X] **C1**")
              .replace("[ ] **C3**", "[-] **C3**"))
    scores = parse_sheet(filled)
    assert scores["task"] == "price-tablet-uk" and scores["condition"] == "team"
    assert scores["items"]["R1"] == {"kind": "requirement", "met": True}
    assert scores["items"]["C3"]["met"] is None
    assert scores["requirements"] == {"met": 1, "total": 3}
    assert scores["checks"] == {"met": 1, "total": 4}
    assert scores["by_kind"]["must-cite"] == {"met": 1, "total": 2}
    assert scores["score"] == pytest.approx(2 / 7)

    dropped = "\n".join(line for line in filled.splitlines() if "item:C2" not in line)
    with pytest.raises(ValueError, match="missing item"):
        parse_sheet(dropped)
    doubled = filled + "\n- [x] again <!-- item:R1 kind:requirement -->\n"
    with pytest.raises(ValueError, match="twice"):
        parse_sheet(doubled)


def test_blind_sheet_hides_condition(tmp_path):
    project = finished_run(tmp_path / "ws" / "price-tablet-uk", "team")
    sheet = make_sheet(project, blind=True)
    assert "team" not in sheet.split("\n", 1)[0] and str(project) not in sheet
    assert parse_sheet(sheet)["project"] is None


def test_judge_command(tmp_path):
    project = finished_run(tmp_path / "ws" / "price-tablet-uk", "team")
    script = "import sys; sys.stdout.write(sys.stdin.read().replace('- [ ]', '- [x]'))"
    filled = run_judge(make_sheet(project), f'{sys.executable} -c "{script}"')
    assert parse_sheet(filled)["score"] == 1.0
    with pytest.raises(RuntimeError):
        run_judge("x", f'{sys.executable} -c "import sys; sys.exit(3)"')
    with pytest.raises(ValueError):
        run_judge("x", "  ")


def test_hci_with_and_without_study_logging(project):
    base = [
        ev(0, "run.started", structure=STRUCTURE),
        ev(10, "request.opened", "finder-a", requestId="r1", kind="approval", title="x"),
        ev(15, "request.opened", "finder-b", requestId="r2", kind="question", title="y", routeTo="lead"),
        ev(70, "request.resolved", "finder-a", requestId="r1", outcome="selected", by={"kind": "human"}),
        ev(80, "command.message", "finder-a", cmdId="m1", text="go on", origin={"kind": "human"}),
        ev(81, "command.message", "finder-a", cmdId="m2", text="go on", origin={"kind": "human"}),
        ev(82, "command.message", "finder-b", cmdId="m3", text="go on", origin={"kind": "human"}),
        ev(120, "run.finished"),
    ]
    write_log(project, base)
    h = hci_metrics(project)
    assert h["study_logging"] is False
    assert h["time_to_notice_s"] is None and h["context_switches"] is None and h["unnoticed"] is None
    assert h["message_resends"] == 1
    assert h["requests_reaching_person"] == 1
    assert h["fan_out"] == 2

    logged = base[:-1] + [
        ev(40, "custom.ui.seen", "finder-a", requestId="r1"),
        ev(41, "custom.ui.seen", "finder-a", requestId="r1"),  # only the first mark counts
        ev(42, "custom.ui.focus", target="inbox"),
        ev(43, "custom.ui.focus", target="finder-a"),
        ev(44, "custom.ui.focus", target="finder-a"),
        ev(45, "custom.ui.focus", target="inbox"),
        base[-1],
    ]
    write_log(project, logged)
    h = hci_metrics(project)
    assert h["study_logging"] is True
    assert h["time_to_notice_s"] == {"n": 1, "median": 30.0, "p90": 30.0, "max": 30.0}
    assert h["unnoticed"] == 0  # r2 went to the Lead, not the person
    assert h["handling_time_s"]["median"] == 30.0
    assert h["context_switches"] == 2
    assert h["context_switches_per_min"] == pytest.approx(1.0)
    rows = {r["requestId"]: r for r in h["requests"]}
    assert rows["r2"]["censored"] is True and rows["r1"]["censored"] is False
    json.dumps(h)  # serialisable
