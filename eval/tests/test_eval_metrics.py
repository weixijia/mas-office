import pytest

from conftest import STRUCTURE, at, ev, write_log
from mas_eval.metrics import distribution, parse_ts, run_metrics, seconds_between


def full_run():
    return [
        ev(0, "run.started", title="Test", structure=STRUCTURE),
        ev(1, "agent.registered", "checker", backend="codex", reviewerOf=["finder-a", "finder-b"]),
        # req-1: approval the person answers after 60 s
        ev(10, "request.opened", "finder-a", requestId="req-1", kind="approval", title="Open a page?"),
        ev(70, "request.resolved", "finder-a", requestId="req-1", outcome="selected", optionId="ok", by={"kind": "human"}),
        ev(75, "request.resolved", "finder-a", requestId="req-1", outcome="declined", by={"kind": "policy"}),  # late: ignored
        # req-2 routed to the Lead, which passes it on (superseded) as req-3 to the person
        ev(20, "request.opened", "finder-b", requestId="req-2", kind="question", title="Which shop?", routeTo="lead"),
        ev(30, "request.resolved", "finder-b", requestId="req-2", outcome="superseded", by={"kind": "agent", "id": "lead"}),
        ev(30, "request.opened", "finder-b", requestId="req-3", kind="question", title="Which shop?"),
        ev(150, "request.resolved", "finder-b", requestId="req-3", outcome="submitted", payload={"text": "Any"}, by={"kind": "human"}),
        # delegated approvals: a policy rule and the Lead
        ev(40, "request.opened", "finder-a", requestId="req-4", kind="approval", title="Search?", routeTo="lead"),
        ev(40, "request.resolved", "finder-a", requestId="req-4", outcome="selected", by={"kind": "policy", "rule": "r1"}),
        ev(50, "request.opened", "finder-a", requestId="req-5", kind="approval", title="Fetch?", routeTo="lead"),
        ev(55, "request.resolved", "finder-a", requestId="req-5", outcome="selected", by={"kind": "agent", "id": "lead"}),
        ev(60, "request.opened", "finder-a", requestId="req-5", kind="approval", title="duplicate id"),  # ignored
        # req-6: a flag nobody answers; req-7: a non-blocking decision that expires
        ev(200, "request.opened", "checker", requestId="req-6", kind="flag", title="Claims did not check out"),
        ev(300, "request.opened", "lead", requestId="req-7", kind="decision", title="More budget?", blocking=False),
        ev(400, "request.resolved", "lead", requestId="req-7", outcome="expired", by={"kind": "system"}),
        # commands
        ev(80, "command.message", "finder-a", cmdId="cmd-1", text="Try Currys", delivery="queue", origin={"kind": "human"}),
        ev(81, "command.ack", "finder-a", cmdId="cmd-1", status="accepted"),
        ev(82, "command.ack", "finder-a", cmdId="cmd-1", status="applied"),
        ev(83, "command.ack", "finder-a", cmdId="cmd-1", status="rejected"),  # after a final ack: ignored
        ev(90, "command.message", "finder-a", cmdId="cmd-2", text="Try Currys", origin={"kind": "human"}),
        ev(91, "command.ack", "finder-a", cmdId="cmd-2", status="rejected", reason="no_session"),
        ev(92, "command.interrupt", "finder-b", cmdId="cmd-3"),  # from the Lead by default: not the person's
        ev(93, "command.respond", "checker", cmdId="cmd-4", requestId="req-6", outcome="declined", origin={"kind": "human"}),
        # usage: running totals; finder-a's session restarts (values drop)
        ev(100, "usage", "finder-a", inputTokens=100, outputTokens=10, turns=1, costUsd=0.1),
        ev(110, "usage", "finder-a", inputTokens=200, outputTokens=20, turns=2, costUsd=0.2),
        ev(120, "usage", "finder-a", inputTokens=50, outputTokens=5, turns=1, costUsd=0.05),
        ev(130, "usage", "checker", inputTokens=300, outputTokens=30),
        ev(140, "usage", "lead", limit={"status": "allowed_warning"}),
        # reviews, flags, ledger, recoveries
        ev(160, "review.verdict", "checker", target="finder-a", verdict="revise", round=1, note="No date"),
        ev(170, "review.verdict", "checker", target="finder-a", verdict="accept", round=2),
        ev(171, "review.verdict", "checker", target="finder-b", verdict="escalate"),
        ev(172, "flag.raised", "checker", text="finder-b: cannot settle"),
        ev(180, "lead.ledger", "lead", progressing=False, stalls=1, next="finder-b"),
        ev(181, "lead.ledger", "lead", progressing=True, stalls=0),
        ev(182, "recovery.chosen", "lead", strategy="retry", target="finder-b"),
        ev(183, "recovery.chosen", "lead", strategy="ask-human", target="finder-b"),
        # claims, evidence, verdicts
        ev(500, "claim.added", claimId="c1", text="The iPad Air costs 599 GBP at Apple in 2026.", sources=["s1"]),
        ev(500, "claim.added", claimId="c2", text="Delivery is free.", sources=[]),
        ev(500, "claim.added", claimId="c3", text="Currys sells it for 549 GBP.", sources=["s2", "s9"]),
        ev(500, "claim.added", claimId="c4", text="We looked hard.", checkworthy=False),
        ev(510, "evidence.checked", sourceId="s1", url="https://a.example/1", urlHealth="live", grade="A"),
        ev(510, "evidence.checked", sourceId="s2", url="https://b.example/2", urlHealth="hallucinated"),
        ev(510, "evidence.checked", sourceId="s3", url="https://c.example/3", urlHealth="stale"),
        ev(510, "evidence.checked", sourceId="s4", url="https://d.example/4", urlHealth="blocked"),
        ev(520, "verdict.recorded", "checker", claimId="c1", status="supported"),
        ev(521, "verdict.recorded", "checker2", claimId="c1", status="supported"),
        ev(522, "verdict.recorded", "checker", claimId="c2", status="supported"),
        ev(523, "verdict.recorded", "checker2", claimId="c2", status="unknown"),
        ev(524, "verdict.recorded", "checker", claimId="c3", status="supported"),
        ev(525, "verdict.recorded", "checker", claimId="c3", status="contradicted"),
        ev(526, "verdict.recorded", "lead", claimId="c3", status="supported"),  # the author: not a checker
        ev(590, "result", markdown="## Answer"),
        ev(600, "run.finished"),
    ]


def test_full_run(project):
    write_log(project, full_run(), meta={"task": "price-tablet-uk", "condition": "team"})
    m = run_metrics(project)
    assert (m["task"], m["condition"]) == ("price-tablet-uk", "team")

    v = m["verification"]
    assert v["verified"] is True
    assert (v["claims"], v["checkworthy"], v["supported"], v["partial"], v["contradicted"], v["unknown"], v["unchecked"]) == (4, 3, 1, 0, 1, 1, 0)
    assert v["support_rate"] == pytest.approx(1 / 3)
    assert v["citation_coverage"] == pytest.approx(2 / 3)
    assert v["citations_without_card"] == 1
    assert v["links"] == {"live": 1, "stale": 1, "hallucinated": 1, "blocked": 1, "unknown": 0}
    assert v["dead_or_invented_rate"] == pytest.approx(2 / 3)
    assert v["uncited_sources"] == 2

    e = m["errors_caught"]
    assert e["review_verdicts"] == {"accept": 1, "revise": 1, "escalate": 1}
    assert e["caught_by_review"] == 2
    assert e["review_rounds"] == {"finder-a": 2, "finder-b": 1}
    assert e["flags_raised"] == 1
    assert e["claims_checked"] == 3
    assert e["contradicted_by_checker"] == 1
    assert e["checker_disagreements"] == 1

    s = m["supervision"]
    assert s["requests"] == 7
    assert s["requests_by_kind"] == {"approval": 3, "question": 2, "flag": 1, "decision": 1}
    assert s["requests_by_resolver"] == {"human": 2, "superseded": 1, "policy": 1, "lead": 1, "unresolved": 1, "expired": 1}
    assert s["requests_reaching_person"] == 4
    assert s["requests_reaching_person_per_hour"] == pytest.approx(24.0)
    assert s["time_to_resolve_s"] == {"n": 2, "median": 90.0, "p90": 120.0, "max": 120.0}
    # 60 + 10 + 120 + 0 + 5 + (600 - 200, the open flag censored at the last event); req-7 is not blocking
    assert s["blocked_agent_seconds"] == pytest.approx(595.0)
    assert s["blocked_censored"] == 1
    assert s["unresolved"] == 1
    assert s["questions_per_role"] == {"finder-b": 2}
    assert s["delegated_approvals"] == 2
    assert s["person_commands"] == {
        "total": 3, "by_type": {"message": 2, "respond": 1}, "by_delivery": {"queue": 1, "steer": 1},
        "by_status": {"applied": 1, "rejected": 1, "sent": 1}, "applied": 1, "rejected": 1,
    }

    c = m["cost_time"]
    assert c["wall_seconds"] == 600.0
    assert c["outcome"] == "done"
    assert c["rounds"] == 1
    assert c["agents"] == 4  # finder-a, finder-b, checker, checker2
    assert c["usage"]["finder-a"] == {"inputTokens": 250, "outputTokens": 25, "costUsd": pytest.approx(0.25), "turns": 3}
    assert c["usage"]["checker"] == {"inputTokens": 300, "outputTokens": 30, "costUsd": None, "turns": None}
    assert c["usage"]["lead"] == {"inputTokens": None, "outputTokens": None, "costUsd": None, "turns": None}
    assert (c["tokens_in"], c["tokens_out"], c["turns"]) == (550, 55, 3)
    assert c["cost_usd"] == pytest.approx(0.25)
    assert c["cost_missing_agents"] == ["checker"]
    assert c["stalls"] == 1
    assert c["recoveries"] == {"retry": 1, "ask-human": 1}
    assert m["rubric"] is None


def test_no_claims_no_usage_no_end(project):
    write_log(project, [ev(0, "run.started", structure=STRUCTURE), ev(5, "agent.status", "finder-a", state="working")])
    m = run_metrics(project)
    v = m["verification"]
    assert v["verified"] is False and v["claims"] == 0
    assert v["support_rate"] is None and v["citation_coverage"] is None and v["dead_or_invented_rate"] is None
    c = m["cost_time"]
    assert c["wall_seconds"] is None and c["outcome"] is None and c["rounds"] is None
    assert c["tokens_in"] is None and c["cost_usd"] is None and c["usage"] == {}
    s = m["supervision"]
    assert s["requests"] == 0 and s["blocked_agent_seconds"] == 0.0
    assert s["time_to_resolve_s"] == {"n": 0, "median": None, "p90": None, "max": None}
    assert s["requests_reaching_person_per_hour"] is None
    assert m["task"] is None and m["condition"] is None


def test_bad_timestamps(project):
    write_log(project, [
        ev(0, "run.started", ts="yesterday", structure=STRUCTURE),
        ev(0, "request.opened", "finder-a", ts="not a time", requestId="r1", kind="approval", title="x"),
        ev(60, "request.resolved", "finder-a", requestId="r1", outcome="selected", by={"kind": "human"}),
        ev(70, "request.opened", "finder-a", requestId="r2", kind="question", title="y"),
        ev(65, "request.resolved", "finder-a", requestId="r2", outcome="submitted", by={"kind": "human"}),  # before it opened
        ev(100, "run.failed", reason="boom"),
    ])
    m = run_metrics(project)
    assert m["cost_time"]["wall_seconds"] is None
    assert m["cost_time"]["outcome"] == "failed"
    s = m["supervision"]
    assert s["requests_by_resolver"] == {"human": 2}
    assert s["time_to_resolve_s"]["n"] == 0
    assert s["blocked_agent_seconds"] is None  # blocking requests exist, but no usable span


def test_agent_stopped_cancels_and_superseded_by_terminal(project):
    write_log(project, [
        ev(0, "run.started", structure=STRUCTURE),
        ev(10, "request.opened", "finder-a", requestId="r1", kind="approval", title="x"),
        ev(20, "request.opened", "finder-b", requestId="r2", kind="approval", title="y"),
        ev(30, "agent.stopped", "finder-a", scope="agent"),
        ev(40, "request.resolved", "finder-a", requestId="r1", outcome="selected", by={"kind": "human"}),  # too late
        ev(50, "request.resolved", "finder-b", requestId="r2", outcome="superseded", by={"kind": "terminal"}),
        ev(60, "run.finished"),
    ])
    s = run_metrics(project)["supervision"]
    assert s["requests_by_resolver"] == {"system": 1, "superseded": 1}
    assert s["time_to_resolve_s"]["n"] == 0
    assert s["blocked_agent_seconds"] == pytest.approx(20 + 30)


def test_only_the_last_run_counts(project):
    write_log(project, [
        ev(0, "run.started", structure=STRUCTURE),
        ev(5, "request.opened", "finder-a", requestId="old", kind="approval", title="x"),
        ev(6, "usage", "finder-a", inputTokens=999),
        ev(7, "claim.added", claimId="c1", text="Old claim"),
        ev(8, "run.finished"),
        ev(100, "run.started", structure=STRUCTURE),
        ev(110, "request.resolved", "finder-a", requestId="old", outcome="selected", by={"kind": "human"}),
        ev(120, "usage", "finder-a", inputTokens=10),
        ev(160, "run.finished"),
    ])
    m = run_metrics(project)
    assert m["supervision"]["requests"] == 0
    assert m["cost_time"]["tokens_in"] == 10
    assert m["cost_time"]["wall_seconds"] == 60.0
    assert m["verification"]["claims"] == 0


def test_follow_up_round(project):
    write_log(project, [
        ev(0, "run.started", structure=STRUCTURE),
        ev(50, "result", markdown="First"),
        ev(60, "run.finished"),
        ev(100, "round.started", round=2, question="And refurbished?"),
        ev(150, "result", markdown="Second", round=2, question="And refurbished?"),
        ev(160, "run.finished"),
    ])
    c = run_metrics(project)["cost_time"]
    assert c["rounds"] == 2
    assert c["wall_seconds"] == 160.0  # run.started to the last end event, follow-ups included


def test_imported_answer_uses_marker(project):
    events = [ev(0, "run.started", structure=STRUCTURE), ev(0, "custom.eval.imported", system="dr-product"),
              ev(0, "result", markdown="x"), ev(0, "run.finished")]
    write_log(project, events)
    assert run_metrics(project)["cost_time"]["wall_seconds"] is None
    events[1] = ev(0, "custom.eval.imported", system="dr-product", wallSeconds=300, costUsd=1.5)
    write_log(project, events)
    c = run_metrics(project)["cost_time"]
    assert (c["wall_seconds"], c["cost_usd"]) == (300, 1.5)


def test_rubric_is_attached(project):
    write_log(project, [ev(0, "run.started", structure=STRUCTURE)], meta={"task": "price-tablet-uk", "condition": "single"})
    (project.parent / "rubric.json").write_text('{"score": 0.5}', encoding="utf-8")
    assert run_metrics(project)["rubric"] == {"score": 0.5}


def test_missing_log(tmp_path):
    with pytest.raises(FileNotFoundError):
        run_metrics(tmp_path)


def test_helpers():
    assert parse_ts("2026-11-10T10:00:00Z") == parse_ts("2026-11-10T10:00:00+00:00")
    assert parse_ts("2026-11-10T10:00:00") is not None  # naive = UTC
    assert parse_ts("garbage") is None and parse_ts(None) is None and parse_ts("") is None
    assert seconds_between(at(0), at(30)) == 30.0
    assert seconds_between(at(30), at(0)) is None
    assert distribution([None, 3, 1, 2]) == {"n": 3, "median": 2, "p90": 3, "max": 3}
    assert distribution(range(1, 11))["p90"] == 9
