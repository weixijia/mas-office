"""Command line: ``mas-office-py demo`` and ``mas-office-py reduce`` (also ``python -m mas_office``)."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import List, Optional

from .files import write_snapshots
from .reducer import reduce, split_lines


def _viewer_hint(workspace: Path) -> str:
    """The command that opens the panel (the `mas-office` npm package, Node >= 18)."""
    return f"npx mas-office serve {workspace.resolve()} --open"


def _demo(args: argparse.Namespace) -> int:
    from .demo import run_demo

    workspace = Path(args.workspace)
    print(f"Simulating a 5-agent team in {workspace / 'headphone-deals'} (about {30 / args.speed:.0f} s)…")
    print(f"Watch it live:  {_viewer_hint(workspace)}")
    project = run_demo(str(workspace), speed=args.speed)
    print(f"Done. Event log: {project / 'mas' / 'events.jsonl'}")
    print(f"View it:        {_viewer_hint(workspace)}")
    return 0


def _reduce(args: argparse.Namespace) -> int:
    project = Path(args.project_dir)
    log = project / "mas" / "events.jsonl"
    if not log.is_file():
        print(f"error: no event log at {log}", file=sys.stderr)
        return 1
    # Bytes, not read_text(): text mode would also turn a lone "\r" into a line break.
    snapshot = reduce(split_lines(log.read_bytes().decode("utf-8", errors="replace")))
    if args.print:
        print(json.dumps(snapshot, ensure_ascii=False, indent=2))
        return 0
    write_snapshots(project, snapshot)
    state = snapshot["state"]
    print(f"Wrote snapshots for {len(snapshot['statuses'])} agents in {project} "
          f"(run {state['run']}, phase {state['phase']}).")
    print(f"View it: {_viewer_hint(project.parent)}")
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="mas-office-py", description="MAS Office tools for Python.")
    commands = parser.add_subparsers(dest="command", required=True)

    demo = commands.add_parser("demo", help="simulate a staged team so you can watch the panel")
    demo.add_argument("--workspace", default="./runs", help="workspace folder to write into (default: ./runs)")
    demo.add_argument("--speed", type=float, default=1.0, help="time multiplier, e.g. 10 for a 3 s run")
    demo.set_defaults(func=_demo)

    red = commands.add_parser("reduce", help="rebuild a project's snapshots from mas/events.jsonl")
    red.add_argument("project_dir", help="the project folder (holds mas/events.jsonl)")
    red.add_argument("--print", action="store_true", help="print the snapshots as JSON instead of writing them")
    red.set_defaults(func=_reduce)

    args = parser.parse_args(argv)
    if getattr(args, "speed", 1.0) <= 0:
        parser.error("--speed must be greater than 0")
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
