"""Rubric sheets: a Markdown checklist a person (or an external judge command) fills in.

``make_sheet`` puts each requirement and check of the task next to the answer's claims that look
relevant (by kind and by shared words; no model involved), followed by every claim with its
verification status and the full answer. ``parse_sheet`` reads a filled sheet back:

- ``[x]`` (or ``[X]``): the answer meets the item;
- ``[ ]``: it does not;
- ``[-]``: not applicable (left out of the score).

``run_judge`` pipes a sheet to a command the user chooses (``--judge-cmd``) and returns its
standard output, which must be the same sheet with the boxes marked. Use a judge from a different
vendor than the system under test; this module never calls a model itself.
"""

from __future__ import annotations

import hashlib
import json
import re
import shlex
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

from mas_office.reducer import reduce

from .metrics import load_events, read_eval_meta
from .tasks import load_task

HEADER = "mas-eval-sheet"
ITEM = re.compile(r"^\s*[-*]\s+\[([ xX-])\].*?<!--\s*item:([A-Za-z0-9_-]+)\s+kind:([a-z-]+)\s*-->\s*$")
META = re.compile(r"<!--\s*" + HEADER + r"\s+(\{.*\})\s*-->")
CLAIM_TAG = re.compile(r"<claim\b([^<>]*)>(.*?)</claim\s*>", re.IGNORECASE | re.DOTALL)
CLAIM_ID = re.compile(r"""\bid\s*=\s*["']?([A-Za-z0-9][A-Za-z0-9_.:-]*)""", re.IGNORECASE)
DATE = re.compile(r"\b(19|20)\d{2}\b|\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)", re.IGNORECASE)
WORD = re.compile(r"[a-z][a-z0-9-]{3,}")
STOP = set("""that this with from have each they their there which where when what than then into only
also must should would could does answer every price prices source sources page pages states state
says said item items claim claims more most other same such about least given""".split())
MAX_RELEVANT = 6


def _words(text: str) -> set:
    return {w for w in WORD.findall(text.lower()) if w not in STOP}


def answer_markdown(project: Path, snapshot: Dict[str, Any]) -> Optional[str]:
    result = snapshot.get("result")
    if result and result.get("markdown"):
        return result["markdown"]
    try:
        return (project / "outputs" / "result.md").read_text(encoding="utf-8")
    except OSError:
        return None


def show_claim_ids(markdown: str) -> str:
    """Replace ``<claim id="c3" …>text</claim>`` with ``text [c3]`` for reading."""
    def sub(m: re.Match) -> str:
        cid = CLAIM_ID.search(m.group(1))
        return f"{m.group(2)} [{cid.group(1)}]" if cid else m.group(2)
    return CLAIM_TAG.sub(sub, markdown)


def _claim_line(claim: Dict[str, Any], evidence: Dict[str, Dict[str, Any]]) -> str:
    srcs = []
    for sid in claim["sources"]:
        e = evidence.get(sid)
        if e is None:
            srcs.append(f"{sid} (no card)")
        else:
            detail = ", ".join(x for x in (e.get("urlHealth"), e.get("grade")) if x)
            srcs.append(f"{sid} ({detail})" if detail else sid)
    text = " ".join(claim["text"].split())
    return f"`{claim['claimId']}` [{claim['status']}] {text} — sources: {', '.join(srcs) if srcs else 'none'}"


def _relevant(check: Dict[str, Any], claims: List[Dict[str, Any]], evidence: Dict[str, Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Claims worth looking at for one item: first those the item's kind points at, then by shared words."""
    kind = check.get("kind")
    if kind == "must-cite":
        flagged = [c for c in claims if not c["sources"]
                   or any(evidence.get(s, {}).get("urlHealth") not in ("live", None) or s not in evidence for s in c["sources"])]
    elif kind == "must-state-uncertainty":
        flagged = [c for c in claims if c["status"] in ("unknown", "partial", "contradicted", "unchecked")]
    elif kind == "freshness":
        flagged = [c for c in claims if DATE.search(c["text"])]
    else:
        flagged = []
    words = _words(check["text"])
    ranked = sorted((c for c in claims if c not in flagged), key=lambda c: -len(words & _words(c["text"])))
    ranked = [c for c in ranked if words & _words(c["text"])]
    return (flagged + ranked)[:MAX_RELEVANT]


def sheet_key(project: Path) -> str:
    """A short stable id for a project that does not reveal its condition."""
    return hashlib.sha256(str(project).encode("utf-8")).hexdigest()[:12]


def make_sheet(project_dir: Any, task_id: Optional[str] = None, blind: bool = False) -> str:
    """The rubric sheet for a finished run. ``task_id`` defaults to the workspace's ``eval-run.json``.
    ``blind`` leaves the project path and condition out of the sheet (the path names the condition);
    the header then carries only the task and an opaque ``key``."""
    project = Path(project_dir).resolve()
    meta = read_eval_meta(project)
    task_id = task_id or meta.get("task")
    if not task_id:
        raise ValueError(f"no task given and no eval-run.json next to {project}; pass the task id")
    task = load_task(task_id)
    snapshot = reduce(load_events(project))
    ver = snapshot.get("verification") or {"claims": [], "evidence": []}
    claims = ver["claims"]
    evidence = {e["sourceId"]: e for e in ver["evidence"]}
    markdown = answer_markdown(project, snapshot)
    fields: Dict[str, Any] = {"v": 1, "task": task_id, "key": sheet_key(project)}
    if not blind:
        fields.update(condition=meta.get("condition"), project=str(project))
    header = json.dumps(fields)

    out = [
        f"<!-- {HEADER} {header} -->",
        f"# Rubric sheet: {task['title']}",
        "",
        f"- Task id: `{task_id}`",
        f"- Sheet key: `{sheet_key(project)}`",
        "- Rater: ",
        "",
        "## How to fill this in",
        "",
        "Read the answer at the end. For each item, mark `[x]` if the answer meets it, leave `[ ]` if it",
        "does not, or write `[-]` if it does not apply. Change nothing else on the item lines. Open the",
        "cited links when an item is about sources. The claim lists under each item are hints chosen",
        "without a model; they can miss things.",
        "",
        "## The task given",
        "",
        *[f"> {line}" for line in task["task"].splitlines()],
        "",
        "## Requirements",
        "",
    ]
    for r in task["requirements"]:
        out.append(f"- [ ] **{r['id']}** {r['text']} <!-- item:{r['id']} kind:requirement -->")
    out += ["", "## Checks", ""]
    for c in task["checks"]:
        out.append(f"- [ ] **{c['id']}** ({c['kind']}) {c['text']} <!-- item:{c['id']} kind:{c['kind']} -->")
        hints = _relevant(c, claims, evidence)
        if hints:
            out += ["  Claims to look at:"] + [f"  - {_claim_line(h, evidence)}" for h in hints]
    out += ["", "## Claims in the answer", ""]
    if claims:
        out += [f"- {_claim_line(c, evidence)}" for c in claims]
    else:
        out.append("The answer has no tagged claims; judge from the answer text below.")
    out += ["", "## Sources and link checks", ""]
    if evidence:
        for e in evidence.values():
            detail = ", ".join(x for x in (e.get("urlHealth"), e.get("grade") and f"grade {e['grade']}") if x)
            out.append(f"- `{e['sourceId']}` {e.get('url') or '(no URL)'}{f' — {detail}' if detail else ''}")
    else:
        out.append("No source was checked (run `mas-office verify` on the project first).")
    out += ["", "## Answer", ""]
    out += [f"> {line}" if line else ">" for line in show_claim_ids(markdown).splitlines()] if markdown else ["(no answer in this run)"]
    return "\n".join(out) + "\n"


def parse_sheet(text: str, expected: Optional[List[str]] = None) -> Dict[str, Any]:
    """Scores from a filled sheet. ``expected`` (default: the task's item ids, when the header names a
    task) makes a missing or duplicated item an error, so a judge that drops lines is caught.

    Returns ``{task, condition, project, items: {id: {kind, met}}, requirements: {met, total},
    checks: {met, total}, by_kind: {kind: {met, total}}, score}`` where ``met`` is True / False /
    None (not applicable), totals count applicable items only, and ``score`` = met / applicable
    (None when nothing applies).
    """
    meta_match = META.search(text)
    meta = json.loads(meta_match.group(1)) if meta_match else {}
    items: Dict[str, Dict[str, Any]] = {}
    for line in text.splitlines():
        m = ITEM.match(line)
        if not m:
            continue
        mark, item_id, kind = m.groups()
        if item_id in items:
            raise ValueError(f"item {item_id} appears twice")
        items[item_id] = {"kind": kind, "met": None if mark == "-" else mark in "xX"}
    if expected is None and meta.get("task"):
        task = load_task(meta["task"])
        expected = [r["id"] for r in task["requirements"]] + [c["id"] for c in task["checks"]]
    if expected is not None:
        missing = [i for i in expected if i not in items]
        if missing:
            raise ValueError(f"the sheet is missing item(s) {', '.join(missing)}; keep every item line intact")

    def tally(selected: List[Dict[str, Any]]) -> Dict[str, int]:
        applicable = [i for i in selected if i["met"] is not None]
        return {"met": sum(1 for i in applicable if i["met"]), "total": len(applicable)}

    all_items = list(items.values())
    by_kind: Dict[str, Dict[str, int]] = {}
    for kind in sorted({i["kind"] for i in all_items}):
        by_kind[kind] = tally([i for i in all_items if i["kind"] == kind])
    overall = tally(all_items)
    return {
        "task": meta.get("task"),
        "key": meta.get("key"),
        "condition": meta.get("condition"),
        "project": meta.get("project"),
        "items": items,
        "requirements": tally([i for i in all_items if i["kind"] == "requirement"]),
        "checks": tally([i for i in all_items if i["kind"] != "requirement"]),
        "by_kind": by_kind,
        "score": overall["met"] / overall["total"] if overall["total"] else None,
    }


def run_judge(sheet: str, command: str, timeout: float = 900) -> str:
    """Run ``command`` (split like a shell would, but not run through one) with the sheet on standard
    input; return its standard output. Raises RuntimeError when the command fails."""
    argv = shlex.split(command)
    if not argv:
        raise ValueError("--judge-cmd is empty")
    done = subprocess.run(argv, input=sheet, capture_output=True, text=True, timeout=timeout)
    if done.returncode != 0:
        raise RuntimeError(f"judge command exited with {done.returncode}: {done.stderr.strip()[:500]}")
    return done.stdout
