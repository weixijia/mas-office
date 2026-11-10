# Supervision study

This is roadmap item **S4**: a user study of supervising 4, 8 and 12 agents. It compares plain terminals, the office, and the office with a Lead. The plan is in [`protocol.md`](protocol.md). It turns the sketch in `docs/research/landscape/05-protocols-hci.md` §B.4 into a runnable procedure.

## What the log gives, and what it needs from the panel

Each session leaves one MAS Office event log. `python eval/run.py hci <project>` computes the log-derived measures (`mas_eval/hci.py`; definitions are in its docstring):

| Measure | From | Needs study logging |
|---|---|---|
| Time to notice a blocked agent (opened → first on screen) | `request.opened` + `custom.ui.seen` | **yes** |
| Handling time (first on screen → answered) | `custom.ui.seen` + `request.resolved` | **yes** |
| Context switches (and per minute) | `custom.ui.focus` | **yes** |
| Time to resolve, blocked agent-seconds, requests reaching the person (and per hour) | `request.*`, run events | no |
| Commands rejected, messages re-sent | `command.*`, `command.ack` | no |
| Fan-out | agents with events | no |
| Per-request rows for survival analysis (censored = never answered) | all of the above | partly |

**Study logging.** The panel does not write `custom.ui.seen` or `custom.ui.focus` today. A study build of the panel must append them to the same log through `POST /v0/events`:

- `{"type": "custom.ui.seen", "agentId": "<the request's agent>", "data": {"requestId": "…"}}`, the first time a request's inbox row or drawer is visible on screen;
- `{"type": "custom.ui.focus", "data": {"target": "<agent id | inbox | result | pane name>"}}`, each time the participant moves to another agent, the inbox or the result.

The baseline condition (plain terminals) has no panel. There, a screen recorder or a tmux hook has to produce the same two events. Otherwise time to notice and context switches are coded by hand from the recording, using the same definitions. Without these events the measures are `null`, not zero.

Questionnaires (SAGAT probes, NASA-TLX, trust and perceived control) are not in the log. `protocol.md` gives the items and the files to record them in.
