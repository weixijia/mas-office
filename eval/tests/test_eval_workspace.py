import json
import os
import shutil
import stat
import subprocess
import sys

import pytest

from conftest import EVAL_DIR, REPO_DIR
from mas_eval.metrics import run_metrics
from mas_eval.tasks import load_task
from mas_eval.workspace import import_answer, prepare

CLI = REPO_DIR / "packages" / "node" / "bin" / "mas-office.js"
RUN = EVAL_DIR / "run.py"


def node():
    found = shutil.which("node")
    if found is None:
        pytest.fail("node is required for this test (workspaces are checked with `mas-office validate`); install Node.js >= 18")
    return found


def mas_office(*args):
    return subprocess.run([node(), str(CLI), *args], cwd=REPO_DIR, capture_output=True, text=True, timeout=120)


@pytest.mark.parametrize("condition", ["team", "single", "team-same-vendor"])
def test_prepare_makes_a_valid_workspace(tmp_path, condition):
    workspace = prepare("price-tablet-uk", condition, tmp_path / "ws")
    project = workspace / "price-tablet-uk"
    done = mas_office("validate", str(workspace))
    assert done.returncode == 0, done.stdout + done.stderr
    assert "all valid" in done.stdout
    assert (project / "mas" / "structure.json").read_bytes() == (EVAL_DIR / "teams" / condition / "structure.json").read_bytes()
    task = json.loads((project / "me" / "task.json").read_text(encoding="utf-8"))
    assert task["requirements"] == load_task("price-tablet-uk")["requirements"]
    meta = json.loads((workspace / "eval-run.json").read_text(encoding="utf-8"))
    assert meta["project"] == "price-tablet-uk" and meta["condition"] == condition and meta["imported"] is False
    # The rubric must not be readable by the sessions, which work inside the project folder.
    rubric = [c["text"] for c in load_task("price-tablet-uk")["checks"]]
    for file in project.rglob("*"):
        if file.is_file():
            assert not any(text in file.read_text(encoding="utf-8") for text in rubric), file


def test_prepare_refuses_bad_places(tmp_path):
    with pytest.raises(ValueError, match="inside the repository"):
        prepare("price-tablet-uk", "team", REPO_DIR / "eval" / "tmp-ws")
    (tmp_path / "full").mkdir()
    (tmp_path / "full" / "x").write_text("x")
    with pytest.raises(ValueError, match="not empty"):
        prepare("price-tablet-uk", "team", tmp_path / "full")
    with pytest.raises(KeyError):
        prepare("price-tablet-uk", "no-such-condition", tmp_path / "a")
    with pytest.raises(KeyError):
        prepare("no-such-task", "team", tmp_path / "b")


def test_import_then_verify(tmp_path):
    answer = tmp_path / "answer.md"
    answer.write_text(
        "## Offers\n\n<claim id=\"c1\" src=\"apple\">Apple sells it for 599 GBP.</claim>\n"
        "Also seen at https://shop.example/ipad.\n", encoding="utf-8")
    sources = tmp_path / "sources.json"
    sources.write_text(json.dumps([{"id": "apple", "url": "https://www.apple.com/uk/shop/buy-ipad/ipad-air", "evidence": "A"}]))
    workspace = import_answer("price-tablet-uk", "dr-product", answer, sources, tmp_path / "ws", wall_minutes=10)
    project = workspace / "price-tablet-uk"
    done = mas_office("validate", str(workspace))
    assert done.returncode == 0, done.stdout
    done = mas_office("verify", "--no-network", str(project))
    assert done.returncode == 0, done.stdout + done.stderr
    m = run_metrics(project)
    assert m["condition"] == "dr-product"
    assert m["verification"]["claims"] == 1 and m["verification"]["citation_coverage"] == 1.0
    assert m["verification"]["sources"] == 1
    assert m["cost_time"]["wall_seconds"] == 600 and m["cost_time"]["outcome"] == "done"
    assert mas_office("validate", str(workspace)).returncode == 0

    # Without a sources file every URL in the answer becomes a source.
    workspace = import_answer("price-tablet-uk", "claude-deep-research", answer, None, tmp_path / "ws2")
    result = json.loads((workspace / "price-tablet-uk" / "outputs" / "result.json").read_text(encoding="utf-8"))
    assert [s["url"] for s in result["sources"]] == ["https://shop.example/ipad"]
    with pytest.raises(ValueError, match="team designs"):
        import_answer("price-tablet-uk", "team", answer, None, tmp_path / "ws3")


def run_cli(*args, env=None, stdin=subprocess.DEVNULL):
    return subprocess.run([sys.executable, str(RUN), *args], cwd=REPO_DIR, capture_output=True, text=True,
                          timeout=120, env=env, stdin=stdin)


def test_run_refuses_more_than_one_without_yes_spend(tmp_path):
    done = run_cli("run", "all", "single")
    assert done.returncode == 2
    assert "--yes-spend" in done.stdout


def fake_tools(tmp_path):
    """A fake `claude` on PATH and a fake `mas-office` that writes a tiny finished run."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    claude = bin_dir / "claude"
    claude.write_text("#!/bin/sh\nexit 0\n")
    claude.chmod(claude.stat().st_mode | stat.S_IEXEC)
    fake = tmp_path / "fake_mas_office.py"
    fake.write_text(
        "import json, sys, pathlib\n"
        "args = sys.argv[1:]\n"
        "assert args[0] == 'up' and '--exit' in args\n"
        "project = pathlib.Path(args[1]) / args[args.index('--project') + 1]\n"
        "(project / 'mas').mkdir(parents=True, exist_ok=True)\n"
        "ev = [{'type': 'run.started', 'data': {}}, {'type': 'run.finished', 'data': {}}]\n"
        "lines = [json.dumps({'v': '0.2', 'seq': i, 'ts': f'2026-11-10T10:0{i}:00Z', **e}) for i, e in enumerate(ev, 1)]\n"
        "(project / 'mas' / 'events.jsonl').write_text('\\n'.join(lines) + '\\n')\n"
        "(pathlib.Path(args[1]) / 'called.json').write_text(json.dumps(args))\n")
    env = {**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}"}
    return env, f"{sys.executable} {fake}"


def test_run_needs_confirmation_when_not_interactive(tmp_path):
    env, fake = fake_tools(tmp_path)
    done = run_cli("run", "price-tablet-uk", "single", "--out", str(tmp_path / "ws"), "--mas-office", fake, env=env)
    assert done.returncode == 2, done.stdout + done.stderr
    assert "claude-code" in done.stdout and "your own Claude Code sign-in" in done.stdout
    assert "add --yes" in done.stdout
    assert not (tmp_path / "ws" / "called.json").exists()


def test_run_spawns_up_and_writes_metrics(tmp_path):
    env, fake = fake_tools(tmp_path)
    done = run_cli("run", "price-tablet-uk", "single", "--yes", "--out", str(tmp_path / "ws"), "--mas-office", fake, env=env)
    assert done.returncode == 0, done.stdout + done.stderr
    called = json.loads((tmp_path / "ws" / "called.json").read_text())
    assert called[:4] == ["up", str(tmp_path / "ws"), "--project", "price-tablet-uk"]
    assert called[called.index("--task") + 1] == load_task("price-tablet-uk")["task"]
    metrics = json.loads((tmp_path / "ws" / "metrics.json").read_text())
    assert metrics["cost_time"]["wall_seconds"] == 60.0 and metrics["condition"] == "single"


def test_cli_list_metrics_report(tmp_path):
    done = run_cli("list")
    assert done.returncode == 0 and "visa-conference-germany" in done.stdout and "team-same-vendor" in done.stdout
    answer = tmp_path / "a.md"
    answer.write_text("Answer with https://x.example/a\n")
    workspace = import_answer("visa-conference-germany", "dr-product", answer, None, tmp_path / "ws")
    done = run_cli("metrics", str(workspace))
    assert done.returncode == 0 and json.loads(done.stdout)["task"] == "visa-conference-germany"
    done = run_cli("report", str(workspace), str(workspace / "visa-conference-germany"))
    assert done.returncode == 0 and "## Task: visa-conference-germany" in done.stdout
    done = run_cli("metrics", str(tmp_path))
    assert done.returncode != 0
