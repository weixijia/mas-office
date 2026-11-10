# Evaluation

This folder holds the evaluation for roadmap item **S3**. It compares a MAS Office team with a single agent given the same budget, and with external deep-research systems. It measures claim support, broken or invented links, errors caught, the load on the person supervising, cost and time.

Everything here is Python 3.10+ using only the standard library, plus the repo's own `mas_office` package (`packages/python/src`) for the protocol reducer. Nothing here calls a model API. Agent sessions are started only by `run`, through `mas-office up`, and they use **your own** Claude Code and Codex sign-ins.

> **Cost.** A run starts real sessions on your own subscription or API key. `run` does one task at a time. It refuses to do more unless you add `--yes-spend`, and it asks before starting unless you add `--yes`. Run one task, look at the result, then decide whether to run the set.

## What we measure and why

The positioning notes (`docs/research/positioning.zh-CN.md` §6.2) list what we must prove: answers are better supported, have fewer dead or invented links, and the checker catches errors that a single agent lets through, at a cost and time we can state. The HCI notes (`docs/research/landscape/05-protocols-hci.md` §B.3) add supervision load: how many requests reach the person, how long agents wait for them, and how many approvals are delegated.

All numbers come from the project's event log, `mas/events.jsonl`. It is reduced with `mas_office.reduce` (protocol 0.2, `spec/rfcs/0001-protocol-0.2.md`), plus one pass over the raw events for timings. Scope is the **last run** in the log, including its follow-up rounds. When data is missing the value is `null`, never a zero we made up. The exact definitions are in the docstrings of `mas_eval/metrics.py`. In short:

| Group | Metric | Definition |
|---|---|---|
| verification | `claims`, `checkworthy` | Tagged claims; those marked checkworthy |
| | `supported` … `unchecked` | Checkworthy claims by status. The last verdict of each distinct checker decides, as the RFC specifies |
| | `support_rate` | supported / checkworthy |
| | `citation_coverage` | checkworthy claims citing ≥ 1 source / checkworthy |
| | `citations_without_card` | (claim, source id) pairs whose source has no evidence entry |
| | `links` | evidence by URL health: live, stale (dead but archived), hallucinated (no such host, or dead and never archived), blocked, unknown |
| | `dead_or_invented_rate` | (stale + hallucinated) / (live + stale + hallucinated) |
| | `uncited_sources` | evidence that no claim cites |
| errors caught | `review_verdicts`, `caught_by_review` | `review.verdict` counts; revise + escalate |
| | `review_rounds` | highest review round per target |
| | `flags_raised` | `flag.raised` events |
| | `contradicted_by_checker` | claims where some checker (not the author) last said `contradicted` |
| | `checker_disagreements` | claims whose distinct checkers' last verdicts differ |
| supervision | `requests_by_kind`, `requests_by_resolver` | requests opened; who ended them: human, policy, lead, agent, terminal, system, expired, superseded or unresolved |
| | `requests_reaching_person` (+ `_per_hour`) | requests opened with `routeTo: human` |
| | `time_to_resolve_s` | opened → resolved for requests the person resolved: n, median, p90 (nearest rank), max |
| | `blocked_agent_seconds` | Σ over blocking requests of resolved − opened. Still-open requests are censored at the log's last timestamp (`blocked_censored`) |
| | `questions_per_role`, `delegated_approvals` | question requests per agent; approvals resolved by a policy rule or by the Lead |
| | `person_commands` | your commands by type, by delivery, and by final ack status (`applied`, `rejected`, `sent` = never acknowledged) |
| cost and time | `wall_seconds`, `outcome`, `rounds` | `run.started` → last `run.finished`/`run.failed`; done or failed; the result's round |
| | `usage`, `tokens_in/out`, `turns`, `cost_usd` | per agent, from `usage` running totals. A drop in a value means a fresh session, and the earlier total is added. Sums cover only agents that reported a field. `cost_missing_agents` lists agents that reported tokens but no cost, so `cost_usd` is then a lower bound |
| | `stalls`, `recoveries` | `lead.ledger` with `progressing: false, stalls ≥ 1`; `recovery.chosen` by strategy |

## Conditions

| Condition | How it runs | Design | What the comparison isolates |
|---|---|---|---|
| `single` | `run` | Lead + one researcher, `web search`, no reviewer, `verify` on | Baseline: one agent with the same budget |
| `team` | `run` | Lead + two finders (stage A, in parallel) + a checker on **Codex** reviewing both (stage B), `verify` on | The team, with a checker from another vendor |
| `team-same-vendor` | `run` | As `team`, but the checker is on Claude Code | `team` vs this: what the cross-vendor checker adds |
| `claude-deep-research` | `import` | Claude Code `/deep-research`, answer saved as Markdown | An existing single-harness research mode |
| `dr-product` (any name) | `import` | A Deep Research product, answer saved as Markdown | Commercial deep research |

The designs are in `teams/<condition>/structure.json` (team design v2, `docs/design/runtime.md` §5). They are locked and signed. There are no gates, so a run does not stop for a stage review. Requests that need you still reach you: checker flags (when `verify.flagWhen` thresholds are crossed), escalated reviews, and stuck roles.

**Same budget.** All three designs share one `budget` block: `maxRunMinutes` 60, `maxTurnMinutes` 20, `maxParallel` 3, `maxQuestionsPerRole` 2, `stallMinutes` 5. They also have the same tool (`web search`) and the same `verify` settings. A test checks this. We cannot cap tokens: the backends do not accept a token budget from us. So "same budget" means the same time limit and the same tools. Tokens and cost are measured after the fact from the `usage` events and reported next to quality. Read a quality difference together with its cost difference. `model` is `null` in every design, so each backend uses its own default model. Write down which models those were when you run, because the log does not record it.

To change a design, edit it, then lock it again from the repo root:

```sh
node --input-type=module -e "import fs from 'node:fs'; const m = await import('mas-office/team');
for (const n of ['team','team-same-vendor','single']) { const f = 'eval/teams/'+n+'/structure.json';
fs.writeFileSync(f, JSON.stringify(m.lockTeam(JSON.parse(fs.readFileSync(f,'utf8'))), null, 2)+'\n'); }"
```

## Tasks

There are nine research and decision tasks in `tasks/`:

- 2 price comparisons
- 2 planning tasks
- 1 literature check and 1 feasibility check
- 1 product selection
- 2 policy, visa or regulation checks

`tasks/schema.json` is the format, and a test validates every file against it.

Each task has `requirements` (what the answer must contain) and `checks`. Checks are rubric items of four kinds: `must-cite`, `must-state-uncertainty`, `must-compare` and `freshness`. The checks describe **verifiable properties of a good answer**, for example "every price has a dated source" or "states which nationality the rule applies to". They hold no ground-truth facts such as prices or visa rules, because those go stale and we could not verify them. The rubric is never copied into a run's project folder, so the sessions cannot read it.

## How to run

Prerequisites:

- Node.js ≥ 18 and Python ≥ 3.10.
- `mas-office-runtime` installed next to `mas-office`. In this repo it resolves through the workspace.
- `claude` signed in by you (`claude auth login`). For `team`, also `codex` signed in by you (`codex login`).

```sh
python eval/run.py list                                   # tasks and conditions
python eval/run.py prepare price-tablet-uk team           # just the workspace, no sessions
python eval/run.py run price-tablet-uk single --open      # one real run (asks first)
```

`prepare` creates a workspace **outside the repo**, by default `~/mas-office-eval/<task>-<condition>-<UTC time>/`. It contains:

- `home/projects.json`;
- the project folder, holding `me/task.json` (title, task text, requirements) and the locked `mas/structure.json`;
- `eval-run.json` at the workspace root.

It refuses folders inside this repository, because Claude Code loads parent `CLAUDE.md` files. It also warns when a `CLAUDE.md` or `AGENTS.md` sits in a folder above the workspace.

`run` does a `prepare`, prints every session that will start with the backend and account it uses, and then starts:

```
node packages/node/bin/mas-office.js up <workspace> --project <task> --task "<task text>" --exit
```

The command's output streams through. If a flag or a stuck role needs you, answer it in the panel: use `--open` or the URL it prints. When the run ends, `metrics.json` is written into the workspace. Use `--mas-office "<command>"` to point at a different CLI.

Then:

```sh
python eval/run.py metrics ~/mas-office-eval/<workspace>           # JSON
python eval/run.py sheet   ~/mas-office-eval/<workspace> --blind --out sheet.md
#   … a person fills in sheet.md …
python eval/run.py score sheet.md --save --project ~/mas-office-eval/<workspace>/<task>
python eval/run.py report  ~/mas-office-eval/*                       # comparison tables
```

`report` prints one Markdown table per task, with a row per condition, and an aggregate table per condition. Cells are means over runs. `(k/n)` marks a metric only k of n runs had. The output says that no significance test is computed, and it names every condition with n < 5.

### Rubric sheets and the judge hook

`sheet` writes a Markdown checklist: every requirement and check of the task, each with the answer's claims that look relevant, then all claims with their verification status, every checked source with its link health, and the answer. The claims next to each item are picked by the check's kind and by shared words, with no model. Raters mark `[x]` for met, `[ ]` for not met and `[-]` for not applicable. `score` reads the sheet back. It fails if an item line is missing or duplicated. `--blind` leaves the project path and condition out of the sheet. `score --save` writes `rubric.json` into the run's workspace, and `report` then shows the rubric score.

`--judge-cmd "<command>"` pipes the sheet to a command you choose on standard input and expects the filled sheet on standard output:

```sh
python eval/run.py sheet <workspace> --judge-cmd "my-judge --model other-vendor" --out judged.md
```

Use a judge from a **different vendor** than the system under test. The command is split like a shell command but is not run through a shell. This harness never calls a model itself.

### External systems

```sh
python eval/run.py import price-tablet-uk claude-deep-research --answer answer.md [--sources sources.json] \
    [--wall-minutes 14] [--cost-usd 0.80]
node packages/node/bin/mas-office.js verify ~/mas-office-eval/<workspace>/price-tablet-uk   # link health (network)
```

`import` creates the same kind of workspace. The project's log holds `run.started`, a `custom.eval.imported` marker (with the wall time and cost you give), a `result` built from the answer, and `run.finished`.

The sources come from `--sources` (a JSON list of `{id, url, title?, evidence?}`). Without it, every URL in the answer becomes a source. `mas-office verify` then checks every link and, if the answer has `<claim id src>` tags, adds the claims, so link metrics and the rubric sheet work the same as for our runs. Run `/deep-research` in a clean folder outside this repository.

**Untagged reports.** External answers have no claim tags, so claim-level support (`support_rate`, `citation_coverage`) is `null` for them. Only link health and the rubric apply. Measuring claim support needs an extraction step that splits the report into atomic claims and links each to its cited source, as FACT in DeepResearch Bench does. A checker then needs to judge each pair. That step is out of scope here. To plug one in, have it rewrite the answer with `<claim id="…" src="…">…</claim>` tags before `import`, and append `verdict.recorded` events from your checker to the project's log. The same metrics then apply unchanged.

## What the numbers do and do not show

- **A checker from the same vendor shares errors.** A model checking text written by its own vendor's model tends to miss the same mistakes. This is why `team-same-vendor` exists. Even a cross-vendor checker is still a model: `supported` means "a checker judged the cited page to support the claim", not "true".
- **Link health is not truth.** A `live` link can point to a page that does not say what the claim says. That is what checker verdicts and the rubric are for. A `blocked` link (bot walls) is undecided, and it is left out of `dead_or_invented_rate`.
- **The task set is small.** Nine tasks, usually one run each, is a pilot. The report never computes significance and says so whenever n < 5. Variance between repeated runs of one condition on one task can be as large as differences between conditions.
- **Costs depend on your plan.** Subscription plans show limits, not prices. Claude Code reports `costUsd` as list-price equivalents, and Codex reports tokens only, so `cost_usd` is a lower bound whenever `cost_missing_agents` is not empty. Tokens are the comparable unit.
- **Models are not pinned.** Backend defaults change over time. Compare runs made close together, and record the models.
- **The rubric is graded by people or a judge you choose.** Use blind sheets, and when you can, two raters on a subset.
- **Freshness.** Prices, fares and rules change daily. Runs of different conditions on the same task should happen on the same day, so they search the same web.
- **Supervision numbers depend on the person.** `time_to_resolve_s` measures how quickly you answered, not the system. For the interface study, see `hci/`.

## Layout

| Path | What |
|---|---|
| `run.py` | The CLI: `list`, `prepare`, `run`, `import`, `metrics`, `report`, `sheet`, `score`, `hci` |
| `mas_eval/metrics.py` | `run_metrics(project_dir)` |
| `mas_eval/report.py` | `compare(runs)` |
| `mas_eval/judge.py` | `make_sheet`, `parse_sheet`, `run_judge` |
| `mas_eval/hci.py` | Study measures from a session log (see `hci/README.md`) |
| `mas_eval/workspace.py`, `mas_eval/tasks.py` | Workspaces, `import`, task loading and schema checks |
| `tasks/`, `teams/` | The task set and the locked designs |
| `tests/` | `PYTHONPATH=packages/python/src:eval python -m pytest eval -q` (needs `node` for two tests) |

Workspaces under `~/mas-office-eval/` hold full transcripts of your sessions. They are yours: do not commit them to this repository.
