import json
import threading
from datetime import datetime

import pytest

from mas_office import Office, reduce, slugify
from mas_office.__main__ import main
from mas_office.files import write_document

STRUCTURE = {
    "title": "Deals",
    "lead": {"id": "lead", "name": "Boss", "emoji": "🧭"},
    "groups": [{"id": "A", "label": "Search", "after": None}],
    "roles": [{"id": "finder", "name": "Finder", "group": "A", "handsTo": "lead"}],
}


def read_js(path, prefix):
    """Parse a .js twin: strip the assignment, the rest must be valid JSON."""
    text = path.read_text(encoding="utf-8")
    assert text.startswith(prefix), text[:80]
    body = text[len(prefix):].strip()
    assert body.endswith(";")
    return json.loads(body[:-1])


def read_log(project_dir):
    text = (project_dir / "mas" / "events.jsonl").read_bytes().decode("utf-8")
    return [json.loads(line) for line in text.split("\n") if line]


def test_file_transport_end_to_end(tmp_path):
    task = {"summary": "Find deals", "requirements": [{"id": "R1", "text": "Under £300"}]}
    with Office(workspace=tmp_path) as office:
        project = office.project("deals", title="Deals", task=task)
        run = project.run(STRUCTURE)
        finder = run.agent("finder")
        finder.working("Searching", progress=20)
        with finder.tool("web_search"):
            pass
        finder.source("s1", title="Shop", url="https://example.com/s1", evidence="A")
        helper = run.agent("helper", name="Helper", emoji="🧾", parent=finder)
        helper.say("Checking")
        finder.flag("Refurbished — breaks R2")
        finder.resolve()
        finder.handoff("lead")
        finder.done("Handed over")
        helper.done()
        run.result(markdown="## Shortlist", work=[{"by": "finder", "summary": "Searched."}])
        run.finish()

    pdir = tmp_path / "deals"
    log = read_log(pdir)
    assert [e["seq"] for e in log] == list(range(1, len(log) + 1))
    types = [e["type"] for e in log]
    assert types[0] == "run.started" and types[-1] == "run.finished"
    assert types.index("agent.registered") < types.index("message")  # helper registered lazily, once
    assert types.count("agent.registered") == 1
    assert "tool.started" in types and "tool.finished" in types

    snap = reduce(json.dumps(e, ensure_ascii=False) for e in log)
    structure = json.loads((pdir / "mas" / "structure.json").read_text(encoding="utf-8"))
    assert structure == snap["structure"]
    assert read_js(pdir / "mas" / "structure.js", "window.MAS_STRUCTURE = ") == structure
    assert [r["id"] for r in structure["roles"]] == ["finder", "helper"]
    assert structure["roles"][1]["parent"] == "finder" and structure["roles"][1]["emoji"] == "🧾"

    state = read_js(pdir / "mas" / "state.js", "window.MAS_STATE = ")
    assert state["phase"] == "done" and state["run"] == 1 and state["runId"] == "r1"

    for agent_id in ("lead", "finder", "helper"):
        status = json.loads((pdir / "mas" / "status" / f"{agent_id}.json").read_text(encoding="utf-8"))
        prefix = f'window.MAS_STATUS = window.MAS_STATUS || {{}}; window.MAS_STATUS["{agent_id}"] = '
        assert read_js(pdir / "mas" / "status" / f"{agent_id}.js", prefix) == status == snap["statuses"][agent_id]
        assert status["state"] == "done"

    result = read_js(pdir / "outputs" / "result.js", "window.MAS_RESULT = ")
    assert result["title"] == "Deals — run 1"
    assert result["sources"][0]["foundBy"] == "finder"
    assert result["flags"] == [{"by": "finder", "kind": "concern", "text": "Refurbished — breaks R2"}]

    task_doc = read_js(pdir / "me" / "task.js", "window.MAS_TASK = ")
    assert task_doc["title"] == "Deals" and task_doc["requirements"][0]["text"] == "Under £300"

    home = read_js(tmp_path / "home" / "projects.js", "window.MAS_HOME = ")
    assert home == json.loads((tmp_path / "home" / "projects.json").read_text(encoding="utf-8"))
    assert home["current"] == "deals"
    assert home["projects"] == [{"folder": "deals", "title": "Deals", "step": 4, "phase": "done", "agents": 3, "runs": 1}]
    assert "£" in (pdir / "me" / "task.json").read_text(encoding="utf-8")  # ensure_ascii=False


def test_home_keeps_other_projects(tmp_path):
    write_document(tmp_path / "home" / "projects", {"current": "old", "projects": [{"folder": "old", "title": "Old"}]}, "MAS_HOME")
    (tmp_path / "home" / "projects.json").unlink()  # kit workspaces may only have the .js twin
    with Office(workspace=tmp_path) as office:
        office.project("new-one").run().finish()
    home = json.loads((tmp_path / "home" / "projects.json").read_text(encoding="utf-8"))
    assert home["current"] == "new-one"
    assert [p["folder"] for p in home["projects"]] == ["old", "new-one"]


def test_seq_continues_across_offices(tmp_path):
    with Office(workspace=tmp_path) as office:
        run = office.project("p").run()
        run.lead.say("one")
        run.finish()
    with Office(workspace=tmp_path) as office:
        run = office.project("p").run()
        assert run.id == "r2"
        run.lead.say("two")
        run.finish()
    log = read_log(tmp_path / "p")
    assert [e["seq"] for e in log] == list(range(1, 7))
    state = json.loads((tmp_path / "p" / "mas" / "state.json").read_text(encoding="utf-8"))
    assert state["run"] == 2 and state["runId"] == "r2"


def test_reopen_repairs_missing_trailing_newline(tmp_path):
    with Office(workspace=tmp_path) as office:
        office.project("p").run()
    log_path = tmp_path / "p" / "mas" / "events.jsonl"
    log_path.write_text(log_path.read_text(encoding="utf-8").rstrip("\n"), encoding="utf-8")
    with Office(workspace=tmp_path) as office:
        office.project("p").run().finish()
    assert [e["seq"] for e in read_log(tmp_path / "p")] == [1, 2, 3]


def test_thread_safety(tmp_path):
    threads_n, per_thread = 8, 50
    with Office(workspace=tmp_path) as office:
        run = office.project("busy").run()

        def work(i):
            agent = run.agent(f"worker-{i}", name=f"Worker {i}")
            for j in range(per_thread):
                agent.working(f"step {j}", progress=j * 2)

        threads = [threading.Thread(target=work, args=(i,)) for i in range(threads_n)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        run.finish()

    log = read_log(tmp_path / "busy")
    total = 1 + threads_n * (per_thread + 1) + 1  # run.started, per thread (registered + statuses), run.finished
    assert [e["seq"] for e in log] == list(range(1, total + 1))
    snap = reduce(json.dumps(e) for e in log)
    assert len(snap["structure"]["roles"]) == threads_n
    for i in range(threads_n):
        assert snap["statuses"][f"worker-{i}"]["say"] == f"step {per_thread - 1}"
        on_disk = json.loads((tmp_path / "busy" / "mas" / "status" / f"worker-{i}.json").read_text(encoding="utf-8"))
        assert on_disk == snap["statuses"][f"worker-{i}"]


@pytest.mark.parametrize("folder", ["", "Caps", "-lead", "a" * 41, "../x", "a_b", "a b", "ab\n"])
def test_invalid_folders(tmp_path, folder):
    with pytest.raises(ValueError):
        Office(workspace=tmp_path).project(folder)


def test_valid_folder_edges(tmp_path):
    office = Office(workspace=tmp_path)
    office.project("a" * 40)
    office.project("0-x")


def test_agent_ids_are_validated_and_slugify_helps(tmp_path):
    run = Office(workspace=tmp_path).project("p").run()
    for bad in ("Retail Finder", "a\n", "a" * 65, "-a", "", None):
        with pytest.raises(ValueError):
            run.agent(bad)
    run.agent("a" * 64)
    assert slugify("Retail Finder #2") == "retail-finder-2"
    assert slugify("???") == "agent"
    assert slugify("Lead") == "lead-agent" and slugify(" LEAD! ") == "lead-agent"
    assert slugify("Lead Writer") == "lead-writer"
    assert run.agent("lead") is run.lead


def test_tool_failure_reraises_and_logs(tmp_path):
    with Office(workspace=tmp_path) as office:
        run = office.project("p").run()
        agent = run.agent("a")
        with pytest.raises(RuntimeError, match="boom"):
            with agent.tool("web_search", call_id="c1"):
                raise RuntimeError("boom")
    failed = [e for e in read_log(tmp_path / "p") if e["type"] == "tool.failed"]
    assert failed[0]["data"] == {"name": "web_search", "callId": "c1", "error": "boom"}


def test_run_context_manager_fails_on_exception(tmp_path):
    office = Office(workspace=tmp_path)
    with pytest.raises(KeyError):
        with office.project("p").run():
            raise KeyError("missing")
    state = json.loads((tmp_path / "p" / "mas" / "state.json").read_text(encoding="utf-8"))
    assert state["phase"] == "failed"


def test_handoff_to_dynamic_handle_registers_target_first(tmp_path):
    with Office(workspace=tmp_path) as office:
        run = office.project("p").run()
        a = run.agent("a", name="Alpha")
        b = run.agent("b", name="Beta")
        a.handoff(b)
    snap = reduce(json.dumps(e) for e in read_log(tmp_path / "p"))
    assert {r["id"]: r["name"] for r in snap["structure"]["roles"]} == {"a": "Alpha", "b": "Beta"}
    assert snap["statuses"]["a"]["say"] == "Handing over to Beta"


def test_invalid_office_arguments_raise(tmp_path):
    with pytest.raises(ValueError):
        Office(workspace=tmp_path, url="http://127.0.0.1:1")


def test_invalid_emits_warn_once_per_problem_and_never_raise(tmp_path):
    with Office(workspace=tmp_path) as office:
        run = office.project("p").run()
        agent = run.agent("a")
        with pytest.warns(RuntimeWarning) as record:
            agent.say(None)
            agent.say(None)  # same problem: no second warning
            agent.status("sleeping")
            agent.handoff("Checker Bot")
            agent.handoff(5)
            agent.source("s1", when=datetime(2026, 1, 1))
            agent.source("s2", evidence="Z")
            agent.working("nan", progress=float("nan"))
            run.emit("custom.x", {"key": object()})
            run.emit("custom.y", ["not", "an", "object"])
        agent.working("still fine")
    messages = [str(w.message) for w in record]
    assert all(w.category is RuntimeWarning for w in record)
    assert all(w.filename == __file__ for w in record)  # points at the caller, not at mas_office
    assert len(messages) == 6, messages  # one per kind: text, state, handoff, json, evidence, data
    assert sum('"message" needs a string "data.text"' in m for m in messages) == 1
    assert any('"data.to" must match' in m for m in messages)
    assert any("not JSON-serialisable" in m for m in messages)
    assert any("evidence must be one of" in m for m in messages)

    log = read_log(tmp_path / "p")
    assert [e["type"] for e in log] == ["run.started", "agent.registered", "agent.status"]
    assert [e["seq"] for e in log] == [1, 2, 3]
    snap = reduce(json.dumps(e) for e in log)
    assert [r["id"] for r in snap["structure"]["roles"]] == ["a"]  # no "Checker Bot" role


def test_emit_low_level_cannot_override_seq(tmp_path):
    with Office(workspace=tmp_path) as office:
        project = office.project("p")
        project.run()
        project.emit({"type": "custom.x", "seq": 99, "agentId": "lead"})
    assert [e["seq"] for e in read_log(tmp_path / "p")] == [1, 2]


@pytest.mark.parametrize("separator", ["\u2028", "\u2029", "\x0c", "\x85", "\x1c", "\r"])
def test_unicode_line_separators_survive_reopening(tmp_path, separator):
    text = f"a{separator}b"
    with Office(workspace=tmp_path) as office:
        run = office.project("p").run()
        run.lead.say(text)
    with Office(workspace=tmp_path) as office:
        run = office.project("p").run()
        run.lead.say("second")
        run.finish()
    log = read_log(tmp_path / "p")
    assert [e["seq"] for e in log] == [1, 2, 3, 4, 5]
    assert log[1]["data"]["text"] == text
    pdir = tmp_path / "p"
    (pdir / "mas" / "state.json").unlink()
    assert main(["reduce", str(pdir)]) == 0
    state = json.loads((pdir / "mas" / "state.json").read_text(encoding="utf-8"))
    assert state["run"] == 2 and state["phase"] == "done"


def test_integration_agent_called_lead_does_not_merge_into_lead(tmp_path):
    with Office(workspace=tmp_path) as office:
        run = office.project("p").run()
        framework_lead = run.agent(slugify("Lead"), name="Lead")
        framework_lead.done("did my part")
    snap = reduce(json.dumps(e) for e in read_log(tmp_path / "p"))
    assert snap["statuses"]["lead-agent"]["state"] == "done"
    assert snap["statuses"]["lead"]["state"] == "working"


def test_cli_demo_and_reduce(tmp_path, capsys):
    assert main(["demo", "--workspace", str(tmp_path), "--speed", "200"]) == 0
    pdir = tmp_path / "headphone-deals"
    state = json.loads((pdir / "mas" / "state.json").read_text(encoding="utf-8"))
    assert state["phase"] == "done"
    structure = json.loads((pdir / "mas" / "structure.json").read_text(encoding="utf-8"))
    assert [r["id"] for r in structure["roles"]] == ["finder-a", "finder-b", "checker", "planner", "price-verifier"]
    assert structure["roles"][-1]["dynamic"] is True and structure["roles"][-1]["parent"] == "checker"
    result = json.loads((pdir / "outputs" / "result.json").read_text(encoding="utf-8"))
    assert {s["id"] for s in result["sources"]} == {"currys-xm6", "ebay-xm6"}
    assert result["flags"][0]["by"] == "checker"
    assert len(result["work"]) == 5
    statuses = {p.stem for p in (pdir / "mas" / "status").glob("*.json")}
    assert statuses == {"lead", "finder-a", "finder-b", "checker", "planner", "price-verifier"}

    (pdir / "mas" / "state.json").unlink()
    assert main(["reduce", str(pdir)]) == 0
    assert json.loads((pdir / "mas" / "state.json").read_text(encoding="utf-8")) == state
    out = capsys.readouterr().out
    assert f"npx mas-office serve {tmp_path.resolve()} --open" in out
    assert main(["reduce", str(tmp_path / "nope")]) == 1


def test_new_run_removes_previous_result(tmp_path):
    """Spec §4.5: a run without a result must not leave the previous run's result in place."""
    with Office(workspace=tmp_path) as office:
        project = office.project("twice", title="Twice")
        first = project.run()
        first.result(markdown="first")
        first.finish()
        result = tmp_path / "twice" / "outputs"
        assert (result / "result.json").exists() and (result / "result.js").exists()
        project.run()
        assert not (result / "result.json").exists() and not (result / "result.js").exists()


def test_protocol_0_2_helpers_reach_inbox_board_and_verification(tmp_path):
    with Office(workspace=tmp_path) as office:
        run = office.project("deals").run(STRUCTURE)
        finder = run.agent("finder")
        ask = finder.request("Open currys.co.uk?", kind="approval", options=[{"optionId": "ok", "name": "Allow"}])
        question = finder.request("Refurbished too?", request_id="q-1", urgency="high")
        assert ask.startswith("req-") and len(ask) == 12 and question == "q-1"
        finder.resolve(ask, option_id="ok", by={"kind": "human"})
        finder.usage(input_tokens=100, turns=1)
        claim = run.claim("Currys has it for £279", sources=["currys"])
        checker = run.agent("checker")
        checker.evidence("currys", url="https://currys.example", url_health="live", grade="A")
        checker.verdict(claim, "supported", source_id="currys", relationship="supports")
        checker.stopped("Stopped by you", scope="agent", by={"kind": "human"})
        checker.resolve()

    pdir = tmp_path / "deals"
    types = [e["type"] for e in read_log(pdir)]
    assert types[1:] == ["request.opened", "request.opened", "request.resolved", "usage", "claim.added",
                         "agent.registered", "evidence.checked", "verdict.recorded", "agent.stopped", "flag.resolved"]
    inbox = json.loads((pdir / "mas" / "inbox.json").read_text(encoding="utf-8"))
    assert [(r["requestId"], r["urgency"]) for r in inbox["pending"]] == [("q-1", "high")]
    assert (inbox["recent"][0]["requestId"], inbox["recent"][0]["outcome"], inbox["recent"][0]["optionId"]) == (ask, "selected", "ok")
    assert read_js(pdir / "mas" / "inbox.js", "window.MAS_INBOX = ") == inbox
    assert json.loads((pdir / "mas" / "status" / "finder.json").read_text(encoding="utf-8"))["waitingOn"] == ["q-1"]
    stopped = json.loads((pdir / "mas" / "status" / "checker.json").read_text(encoding="utf-8"))
    assert (stopped["state"], stopped["say"], stopped["stopReason"]) == ("done", "Stopped by you", "cancelled")
    board = json.loads((pdir / "mas" / "board.json").read_text(encoding="utf-8"))
    assert board["usage"]["finder"]["inputTokens"] == 100
    verification = json.loads((pdir / "outputs" / "verification.json").read_text(encoding="utf-8"))
    assert (verification["claims"][0]["claimId"], verification["claims"][0]["author"]) == (claim, "lead")
    assert verification["claims"][0]["status"] == "supported" and verification["summary"]["live"] == 1
    assert read_js(pdir / "outputs" / "verification.js", "window.MAS_VERIFICATION = ") == verification


def test_new_run_removes_previous_verification(tmp_path):
    with Office(workspace=tmp_path) as office:
        project = office.project("twice")
        project.run().claim("A claim")
        outputs = tmp_path / "twice" / "outputs"
        assert (outputs / "verification.json").exists() and (outputs / "verification.js").exists()
        project.run()
        assert not (outputs / "verification.json").exists() and not (outputs / "verification.js").exists()


def test_follow_up_opens_a_round_and_the_next_result_is_that_round(tmp_path):
    with Office(workspace=tmp_path) as office:
        with office.project("deals").run() as run:
            run.result("one")
            run.finish()
            run.follow_up("Open-box too?", round=2)
            run.result("two")
    pdir = tmp_path / "deals"
    assert [e["type"] for e in read_log(pdir)][-3:] == ["round.started", "result", "run.finished"]
    result = json.loads((pdir / "outputs" / "result.json").read_text(encoding="utf-8"))
    assert result["round"] == 2 and [p["markdown"] for p in result["previous"]] == ["one"]
