# Protocol: supervising 4, 8 and 12 agents

The plan below makes the sketch in `docs/research/landscape/05-protocols-hci.md` §B.4 concrete. Each hypothesis maps to a design principle (P1–P10 in §B.3).

## Questions and hypotheses

- **H1 (P1, P2):** With the office (B) or the office plus a Lead (C), participants notice a blocked agent sooner than with plain terminals (A). They also answer sooner and switch context less.
- **H2 (P5):** Situation awareness at levels 2 and 3 (SAGAT) is higher in B and C than in A.
- **H3 (P7):** In C, fewer requests reach the person than in B, and no more than 5% of the Lead's delegated approvals are wrong (judged against the injected ground truth).
- **H4 (fan-out interaction):** The gap between A and B/C grows from 4 to 12 agents.
- **H5 (P6):** Trust is better calibrated in B and C: confidence tracks the actual correctness of agent output, and fewer approvals are given without being read.

## Design

- **Within subjects:** 3 conditions (A, B, C) × 3 fan-out levels (4, 8, 12 agents) = 9 blocks per participant.
  - The order of conditions is counterbalanced with a Latin square over the 6 orders. With N = 24, each order is used 4 times.
  - Fan-out is ordered 4 → 8 → 12 within a condition. Ramping up keeps 12 agents from being the first block anyone sees.
- **Participants:** 24 developers or researchers who have used Claude Code or Codex. With N = 16 there are not enough people to cover all 6 orders equally.
- **Session:** about 2 h 30 min, with breaks after the 3rd and 6th block:
  - 15 min consent and training (one practice block in each condition, 2 agents);
  - 9 blocks of 12 min;
  - 15 min interview.

## Stimuli: scripted replay

Agents are driven by replaying recorded sessions, so every participant sees the same events at the same times.

1. **Record.** Record real runs of the eval tasks (`eval/run.py run`) for 4, 8 and 12 agents. Keep each `mas/events.jsonl` and `mas/transcript/*.jsonl`.
2. **Make three isomorphic task sets.** Each set uses different tasks (price, planning, policy) with the same event timeline, so a participant never sees the same content twice.
3. **Inject events at fixed times.** Each block has 6 injections, placed in a random but pre-registered order:
   1. a blocking approval (reversible, e.g. open a web page);
   2. a blocking approval (irreversible, e.g. write outside the role's files). The correct answer is "deny";
   3. an input request that needs information only the participant has (given on a card);
   4. a silent stall: an agent stops sending events for 3 min;
   5. a quality problem: a checker flag, or a planted factual error in an agent's output;
   6. a failed agent whose task must be reassigned.
4. **Delegated approvals (C only).** The Lead auto-resolves some injected approvals through `lead.delegate` rules. One of them is wrong on purpose, which measures whether participants catch bad delegations.
5. **Answering.** A replay waits at a blocking request until the participant answers, then continues, so blocking time is real. A replay driver appends the events through `POST /v0/events` and holds each blocked agent until a `command.respond` arrives.

The driver is part of the study build, not this repository. Only the manipulation check uses real agents: 2 pilot participants in condition B with live sessions.

## Conditions

| | A: plain terminals | B: office | C: office + Lead |
|---|---|---|---|
| Display | tmux, one pane per agent, an OMC-style status line | MAS Office panel: office, inbox, drawers | B, plus the Lead's digest and delegated approvals |
| Answering | type in the pane | in place, in the inbox or drawer | same as B. Delegated items show in the inbox history |
| Study logging | screen recording + tmux focus hook → `custom.ui.focus` / `custom.ui.seen`, or hand coding | study build of the panel | same as B |

## Measures

| Measure | How | Tool |
|---|---|---|
| Time to notice (TTN) | `request.opened` → first `custom.ui.seen`. For the silent stall: injection → first focus on that agent | `run.py hci` |
| Time to resolve (TTR), handling time | `request.opened` → `request.resolved`; seen → resolved | `run.py hci` |
| Blocked agent-seconds | Σ over blocking requests | `run.py hci` |
| Context switches | changes of `custom.ui.focus` target, per minute | `run.py hci` |
| Requests reaching the person, per hour | `routeTo: human` | `run.py hci` |
| Missed exceptions | injections not handled by the end of the block (censored rows) | `run.py hci` |
| Wrong decisions | answer ≠ pre-registered correct answer (irreversible approval, wrong delegation not overturned) | hand-scored from the log |
| Approvals without reading | approval answered with handling time < 2 s and no drawer opened | `run.py hci` rows + focus events |
| Command errors | `command.ack` rejected; identical messages re-sent | `run.py hci` |
| SAGAT | 3 freezes per block (see below) | answer sheet |
| NASA-TLX (raw, 6 items, 0–100) | after each block | form |
| Trust and perceived control | after each condition: 5 items, 7-point scale (below) | form |
| Calibration | correlation between per-output confidence ratings and actual correctness | form + ground truth |
| SUS, preference | end of session | form + interview |

**SAGAT freezes.** At three pre-registered moments per block, the screen is blanked and the replay paused. The participant answers three questions, scored against the log at the freeze time:

- L1: "What is agent X doing right now?"
- L2: "Which agents are blocked, and on what?"
- L3: "If nobody acts, which agents will be stopped in 5 minutes?"

**Trust and perceived control items** (7-point scale, strongly disagree → strongly agree):

1. I could tell which agents needed me.
2. I trusted the agents' outputs that I approved.
3. I could redirect an agent when I wanted to.
4. I knew what the team as a whole was doing.
5. (C only) I trusted the Lead's decisions on my behalf.

Validated scales (Jian et al. trust in automation; a perceived-control scale) may replace these items once they have been checked against the original papers. §B.5 of the research notes lists them as unverified.

**Calibration.** At the end of each block the participant rates their confidence (0–100) in 4 agent outputs, 1 of which contains the planted error. Calibration is the point-biserial correlation between confidence and correctness, per participant and condition.

## Files per session

```
study/<participant>/<block>/            one MAS Office workspace per block (the replayed project)
study/<participant>/<block>/hci.json    python eval/run.py hci <workspace>/<project> > hci.json
study/<participant>/sagat.csv           participant, block, freeze, level, correct (0/1)
study/<participant>/tlx.csv             participant, block, mental, physical, temporal, performance, effort, frustration
study/<participant>/trust.csv           participant, condition, item, rating
study/<participant>/confidence.csv      participant, block, output, confidence, correct (0/1)
```

Study data stays out of this repository. Pseudonymise participant ids.

## Analysis

- **Times** (TTN, TTR, handling): linear mixed models on log-time, with condition × fan-out as fixed effects and participant and task set as random intercepts. Because some injections are never noticed or never answered within the block, also fit a Cox model (or a mixed-effects survival model) using the censored rows from `hci.json`. Report both.
- **Counts** (context switches, requests to the person, misses, wrong decisions): Poisson or negative-binomial GLMMs with block length as offset.
- **SAGAT:** a binomial GLMM per level.
- **NASA-TLX, trust items:** cumulative-link mixed models (ordinal).
- **Planned contrasts:** A vs B, B vs C, and the condition × fan-out interaction at 12 agents. Holm correction across the primary measures (TTN, TTR, SAGAT L2, requests to the person).
- **Pre-registration:** pre-register the hypotheses, injections, correct answers and exclusion rules before the first real participant. Exclude a block if the replay driver failed (detected from gaps in the log).

## Validity notes

- Replay makes the conditions comparable but feels less real. The 2-person live pilot checks whether the injections feel plausible.
- In A, the logging comes from a different instrument (screen recording, a tmux hook). Use the same event definitions and hand-code a 20% sample in B as well, to check agreement.
- Learning effects across 9 blocks: counterbalancing spreads them, and the block index enters the model as a covariate.
- The person answering the replay is part of what is measured. TTR is a property of person + interface, not of the agents.
