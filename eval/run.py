#!/usr/bin/env python3
"""MAS Office evaluation CLI. See eval/README.md.

  python eval/run.py list
  python eval/run.py prepare <task> <condition> [--out DIR]
  python eval/run.py run <task> <condition> [--yes] [--yes-spend] [--open] [--port N] [--mas-office CMD]
  python eval/run.py import <task> <condition-name> --answer FILE.md [--sources FILE.json] [--wall-minutes N] [--cost-usd X]
  python eval/run.py metrics <project-or-workspace>
  python eval/run.py report <dir> [<dir> ...]
  python eval/run.py sheet <project-or-workspace> [--task ID] [--blind] [--out FILE] [--judge-cmd CMD]
  python eval/run.py score <sheet.md> [--save] [--project DIR]
  python eval/run.py hci <project-or-workspace>
"""

from __future__ import annotations

import argparse
import json
import shlex
import subprocess
import sys
from pathlib import Path
from typing import List, Optional

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent / "packages" / "python" / "src")]

from mas_eval import REPO_DIR  # noqa: E402
from mas_eval.hci import hci_metrics  # noqa: E402
from mas_eval.judge import make_sheet, parse_sheet, run_judge  # noqa: E402
from mas_eval.metrics import run_metrics  # noqa: E402
from mas_eval.report import compare  # noqa: E402
from mas_eval.tasks import EXTERNAL_CONDITIONS, internal_conditions, load_tasks  # noqa: E402
from mas_eval.workspace import import_answer, instruction_files_above, prepare, sessions_of  # noqa: E402

DEFAULT_MAS_OFFICE = f"node {shlex.quote(str(REPO_DIR / 'packages' / 'node' / 'bin' / 'mas-office.js'))}"


def project_of(path: str) -> Path:
    """A project folder from a project or workspace path (a workspace names its project in eval-run.json)."""
    p = Path(path).expanduser().resolve()
    if (p / "mas" / "events.jsonl").is_file():
        return p
    meta = p / "eval-run.json"
    if meta.is_file():
        return p / json.loads(meta.read_text(encoding="utf-8"))["project"]
    raise SystemExit(f"✗ {p} has no mas/events.jsonl and no eval-run.json")


def selection(value: str, known: List[str], what: str) -> List[str]:
    picked = known if value == "all" else [v for v in value.split(",") if v]
    unknown = [v for v in picked if v not in known]
    if unknown:
        raise SystemExit(f"✗ unknown {what}: {', '.join(unknown)}. Known: {', '.join(known)}")
    return picked


def cmd_list(_: argparse.Namespace) -> int:
    print("Tasks:")
    for task in load_tasks().values():
        print(f"  {task['id']:28} {task.get('category', ''):18} {task['title']}")
    print("\nConditions run here (eval/teams/<name>/structure.json):")
    for name, path in internal_conditions().items():
        title = json.loads(path.read_text(encoding="utf-8")).get("title", "")
        print(f"  {name:28} {title}")
    print("\nExternal conditions (bring the answer in with `import`; any name works):")
    for name, text in EXTERNAL_CONDITIONS.items():
        print(f"  {name:28} {text}")
    return 0


def _warn_instructions(workspace: Path) -> None:
    for file in instruction_files_above(workspace):
        print(f"! {file} is above the workspace; agent sessions may load it. Prefer a folder without one.")


def cmd_prepare(args: argparse.Namespace) -> int:
    workspace = prepare(args.task, args.condition, Path(args.out) if args.out else None)
    print(f"✓ Workspace: {workspace}\n  Project:   {workspace / args.task}")
    _warn_instructions(workspace)
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    tasks = selection(args.task, list(load_tasks()), "task")
    conditions = selection(args.condition, list(internal_conditions()), "condition")
    runs = [(t, c) for t in tasks for c in conditions]
    if len(runs) > 1 and not args.yes_spend:
        print(f"✗ That is {len(runs)} runs. Each one uses your own subscription for every session in it.\n"
              "  Run one task first and look at the result. To run them all anyway, add --yes-spend.")
        return 2
    mas_office = shlex.split(args.mas_office)
    task_texts = load_tasks()
    code = 0
    for task_id, condition in runs:
        workspace = prepare(task_id, condition, Path(args.out) if args.out and len(runs) == 1 else None)
        print(f"Run: task {task_id}, condition {condition}\n  Workspace: {workspace}\n"
              "  These sessions will start, each on the account named (nobody else's, and never ours):")
        rows = sessions_of(workspace)
        for row in rows:
            print(f"    {row['id']:12} {row['backend']:12} {row['account']}"
                  + ("" if row["installed"] else "   ✗ not installed"))
        _warn_instructions(workspace)
        missing = sorted({r["backend"] for r in rows if not r["installed"]})
        if missing:
            hint = " Try condition team-same-vendor." if "codex" in missing and condition == "team" else ""
            print(f"✗ Not installed here: {', '.join(missing)}.{hint}")
            return 1
        print("  Requests that need you (checker flags, stuck roles) wait in the panel: use --open or the URL printed below.")
        if not args.yes:
            if not sys.stdin.isatty():
                print("✗ Not starting without confirmation: add --yes.")
                return 2
            if input("  Start? Type yes: ").strip().lower() != "yes":
                print("  Not started.")
                return 1
        argv = mas_office + ["up", str(workspace), "--project", task_id, "--task", task_texts[task_id]["task"], "--exit"]
        if args.open:
            argv.append("--open")
        if args.port:
            argv += ["--port", str(args.port)]
        status = subprocess.run(argv).returncode  # inherits stdout/stderr, so its output streams through
        project = workspace / task_id
        if (project / "mas" / "events.jsonl").is_file():
            metrics = run_metrics(project)
            (workspace / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
            print(f"  Metrics: {workspace / 'metrics.json'}")
        code = code or status
    return code


def cmd_import(args: argparse.Namespace) -> int:
    workspace = import_answer(args.task, args.condition, Path(args.answer), Path(args.sources) if args.sources else None,
                              Path(args.out) if args.out else None, args.wall_minutes, args.cost_usd)
    project = workspace / args.task
    print(f"✓ Imported into {project}\n  Next: check its links (network) with\n"
          f"    {DEFAULT_MAS_OFFICE} verify {shlex.quote(str(project))}\n"
          f"  then make the rubric sheet with\n    python {shlex.quote(str(HERE / 'run.py'))} sheet {shlex.quote(str(project))}")
    return 0


def cmd_metrics(args: argparse.Namespace) -> int:
    print(json.dumps(run_metrics(project_of(args.path)), indent=2))
    return 0


def cmd_report(args: argparse.Namespace) -> int:
    print(compare([run_metrics(project_of(p)) for p in args.paths]), end="")
    return 0


def cmd_sheet(args: argparse.Namespace) -> int:
    sheet = make_sheet(project_of(args.path), args.task, blind=args.blind)
    if args.judge_cmd:
        filled = run_judge(sheet, args.judge_cmd)
        scores = parse_sheet(filled)  # fails loudly if the judge dropped or duplicated item lines
        sheet = filled
        print(f"Judge score: {scores['score']}", file=sys.stderr)
    if args.out:
        Path(args.out).write_text(sheet, encoding="utf-8")
        print(f"✓ Sheet: {args.out}", file=sys.stderr)
    else:
        print(sheet, end="")
    return 0


def cmd_score(args: argparse.Namespace) -> int:
    scores = parse_sheet(Path(args.sheet).read_text(encoding="utf-8"))
    print(json.dumps(scores, indent=2))
    if args.save:
        project = Path(args.project).resolve() if args.project else Path(scores["project"]) if scores.get("project") else None
        if project is None:
            print("✗ A blind sheet does not name its project: add --project DIR", file=sys.stderr)
            return 2
        target = project.parent / "rubric.json"
        target.write_text(json.dumps(scores, indent=2) + "\n", encoding="utf-8")
        print(f"✓ Saved {target}", file=sys.stderr)
    return 0


def cmd_hci(args: argparse.Namespace) -> int:
    print(json.dumps(hci_metrics(project_of(args.path)), indent=2))
    return 0


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python eval/run.py", description="MAS Office evaluation harness")
    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("list", help="tasks and conditions").set_defaults(fn=cmd_list)

    s = sub.add_parser("prepare", help="create a workspace for one task and condition")
    s.add_argument("task")
    s.add_argument("condition")
    s.add_argument("--out", help="workspace folder (default ~/mas-office-eval/<task>-<condition>-<time>)")
    s.set_defaults(fn=cmd_prepare)

    s = sub.add_parser("run", help="prepare and run with `mas-office up` (uses your subscription)")
    s.add_argument("task", help="a task id, a comma-separated list, or 'all'")
    s.add_argument("condition", help="a condition, a comma-separated list, or 'all'")
    s.add_argument("--yes", action="store_true", help="do not ask before starting")
    s.add_argument("--yes-spend", action="store_true", help="allow more than one run")
    s.add_argument("--open", action="store_true", help="open the panel in the browser")
    s.add_argument("--port", type=int)
    s.add_argument("--out", help="workspace folder (single run only)")
    s.add_argument("--mas-office", default=DEFAULT_MAS_OFFICE, help=f"the CLI to run (default: {DEFAULT_MAS_OFFICE})")
    s.set_defaults(fn=cmd_run)

    s = sub.add_parser("import", help="bring in an external system's answer")
    s.add_argument("task")
    s.add_argument("condition", help="a name for the system, e.g. claude-deep-research")
    s.add_argument("--answer", required=True, help="the answer as Markdown")
    s.add_argument("--sources", help="JSON list of {id, url, title?, evidence?}; default: every URL in the answer")
    s.add_argument("--wall-minutes", type=float, help="how long the system took")
    s.add_argument("--cost-usd", type=float, help="what the run cost, if known")
    s.add_argument("--out", help="workspace folder")
    s.set_defaults(fn=cmd_import)

    s = sub.add_parser("metrics", help="metrics of one run as JSON")
    s.add_argument("path")
    s.set_defaults(fn=cmd_metrics)

    s = sub.add_parser("report", help="comparison tables over runs")
    s.add_argument("paths", nargs="+")
    s.set_defaults(fn=cmd_report)

    s = sub.add_parser("sheet", help="rubric sheet for a finished run")
    s.add_argument("path")
    s.add_argument("--task", help="task id (default: from eval-run.json)")
    s.add_argument("--blind", action="store_true", help="leave the project path and condition out")
    s.add_argument("--out", help="write the sheet here instead of standard output")
    s.add_argument("--judge-cmd", help="command that reads the sheet on stdin and prints it filled in")
    s.set_defaults(fn=cmd_sheet)

    s = sub.add_parser("score", help="read a filled sheet back into scores")
    s.add_argument("sheet")
    s.add_argument("--save", action="store_true", help="write rubric.json into the run's workspace")
    s.add_argument("--project", help="the project folder (needed with --save for a blind sheet)")
    s.set_defaults(fn=cmd_score)

    s = sub.add_parser("hci", help="supervision-study measures of one session log")
    s.add_argument("path")
    s.set_defaults(fn=cmd_hci)
    return p


def main(argv: Optional[List[str]] = None) -> int:
    args = parser().parse_args(argv)
    try:
        return args.fn(args)
    except (KeyError, ValueError, FileNotFoundError, RuntimeError) as err:
        message = err.args[0] if isinstance(err, KeyError) and err.args else err
        print(f"✗ {message}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
