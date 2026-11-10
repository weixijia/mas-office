import json
import shutil
import subprocess

import pytest

from conftest import EVAL_DIR, REPO_DIR
from mas_eval.tasks import internal_conditions, load_tasks, schema_errors, task_errors

SCHEMA = json.loads((EVAL_DIR / "tasks" / "schema.json").read_text(encoding="utf-8"))


def test_every_task_file_is_valid():
    tasks = load_tasks()
    assert len(tasks) == 9
    categories = [t["category"] for t in tasks.values()]
    assert categories.count("price-comparison") == 2
    assert categories.count("planning") == 2
    assert categories.count("literature") + categories.count("feasibility") == 2
    assert categories.count("product-selection") == 1
    assert categories.count("policy") == 2
    for task in tasks.values():
        kinds = {c["kind"] for c in task["checks"]}
        assert "must-cite" in kinds, task["id"]
        assert "must-state-uncertainty" in kinds, task["id"]


def test_schema_catches_bad_tasks():
    good = next(iter(load_tasks().values()))
    assert schema_errors(SCHEMA, good) == []
    bad = {**good, "checks": [{"id": "C1", "kind": "vibes", "text": "x"}]}
    assert any("must be one of" in e for e in schema_errors(SCHEMA, bad))
    missing = {k: v for k, v in good.items() if k != "requirements"}
    assert any("missing 'requirements'" in e for e in schema_errors(SCHEMA, missing))
    extra = {**good, "answer": "the ground truth"}
    assert any("unknown field 'answer'" in e for e in schema_errors(SCHEMA, extra))
    assert any("pattern" in e or "match" in e for e in schema_errors(SCHEMA, {**good, "id": "Bad Id"}))
    dup = {**good, "requirements": [{"id": "R1", "text": "a"}, {"id": "R1", "text": "b"}]}
    assert any("used twice" in e for e in task_errors(dup))
    assert any("file name" in e for e in task_errors(good, "other-name"))


def node_team_check(structure_file):
    node = shutil.which("node")
    if node is None:
        pytest.fail("node is required for this test (team designs are checked with the real JS normaliser); install Node.js >= 18")
    script = """
const fs = await import('node:fs');
const m = await import('mas-office/team');
const s = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const { team, problems } = m.normalizeTeam(s);
console.log(JSON.stringify({ ok: !!team, signed: m.verifySignature(s), problems }));
"""
    done = subprocess.run([node, "--input-type=module", "-e", script, str(structure_file)],
                          cwd=REPO_DIR, capture_output=True, text=True, timeout=60)
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout)


def test_team_designs_normalise_and_are_locked():
    conditions = internal_conditions()
    assert set(conditions) == {"team", "single", "team-same-vendor"}
    designs = {}
    for name, file in conditions.items():
        result = node_team_check(file)
        assert result["ok"], name
        assert [p for p in result["problems"] if p["level"] == "error"] == [], name
        assert result["signed"], f"{name}: signature does not match; lock it again (eval/README.md)"
        designs[name] = json.loads(file.read_text(encoding="utf-8"))
        assert designs[name]["locked"] is True
        assert designs[name]["verify"]["claims"] is True and designs[name]["verify"]["urlHealth"] is True

    budgets = {name: d["budget"] for name, d in designs.items()}
    assert len({json.dumps(b, sort_keys=True) for b in budgets.values()}) == 1, "all conditions share one budget"

    team = {r["id"]: r for r in designs["team"]["roles"]}
    assert team["checker"]["backend"] == "codex"
    assert sorted(team["checker"]["reviewerOf"]) == ["finder-a", "finder-b"]
    assert team["checker"]["group"] != team["finder-a"]["group"]
    same = {r["id"]: r for r in designs["team-same-vendor"]["roles"]}
    assert same["checker"]["backend"] == "claude-code"

    single = designs["single"]["roles"]
    assert len(single) == 1 and not single[0].get("reviewerOf")
    assert single[0]["tools"] == team["finder-a"]["tools"]
