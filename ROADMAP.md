# Roadmap

This is a direction, not a promise. Items link to issues once someone picks them up; comment there if you want to help.

## Where we are going

> **An AI team you design, can watch, can steer, and that checks its own work.**

Since v0.3.0 MAS Office runs the team, not only shows it:

- Every worker is a real Claude Code or Codex session, signed in with your own account.
- The Lead plans the work for a design you locked; plain code schedules it.
- Checkers verify the answer claim by claim.
- Everything that needs you lands in one inbox.

What is left: a raw terminal you can take over, attaching the official Codex TUI, moving the team kit onto the same engine, the evaluation runs, the user study and a desktop app.

Many tools already run many agents:

- **Single-agent harnesses with subagents** (Claude Code, Codex, pi, OpenCode).
- **Parallel orchestrators** (Orca, Conductor, Gas Town, Claude Squad).
- **Agent office views** (pixel-agents and others).

MAS Office is about the **team**, and we put our effort into five things those tools leave open:

1. **One inbox for everything that needs you**: tool approvals, decisions, checker flags and stage gates from every session. You answer them in place and can see how long each has waited.
2. **A Lead that reads structured events**, not raw terminal output, and escalates only exceptions.
3. **A designed, locked organisation**, compiled into enforced per-role tools and permissions.
4. **Claim-level verification**: claim → source → link check → checker verdict, with sources graded A–D. Checkers have a clean context and can come from another vendor.
5. **Cheap steering**: talk to any agent from its desk, redirect it, or take over its terminal. The design follows research on supervising many automated agents: attention, interruptions and trust calibration.

## Principles

- **We orchestrate; we don't build another single-agent harness.** Each role runs in an official agent you already have.
- **Your own login, untouched.** We run only the unmodified `claude` and `codex` programs that you sign in to yourself. We never offer our own login, and never read, store or forward credentials. Rules: [`CLAUDE.md`](CLAUDE.md) §3.
- **Reuse before we build.** We integrate good open-source work. [`docs/design/reuse-map.md`](docs/design/reuse-map.md) lists, per component, which project's files to read and whether we depend on them, adapt them or only take the idea.
- **Research and decision tasks first**: price comparison, planning, literature and feasibility checks, product selection, policy and visa checks.
- **Prove it.** We measure the team against a single agent with the same budget, and the interface against plain terminals, before claiming it is better.
- **TypeScript** for the daemon and every view; Python for SDK integrations and evaluation.

## Shipped

- [x] **v0.1**:
  - Protocol 0.1: workspace layout, snapshots, event log, deterministic reducer, JSON Schemas, conformance cases.
  - `mas-office` on npm: JS SDK + CLI with `serve`, `validate`, `init --kit`, `reduce`, `export --ag-ui`, `hook claude-code` and `demo`.
  - The live panel.
  - Experimental integrations: OpenAI Agents SDK, LangGraph, Claude Agent SDK, Claude Code hooks.
  - The project website.
- [x] **v0.1.1**: the office keeps its size while agents work.
- [x] **v0.2.0**: a result drawer over the office; follow-up rounds in the kit, where the Lead sends back only the roles a question needs.
- [x] **v0.2.1**: in the kit, a real browser for roles (`mas-browser`, confined to public addresses), the team in Claude Code's status line, and security hardening.
- [x] **v0.2.2**: the result drawer opens reliably on live runs; README and website refreshed.
- [x] **v0.3.0**: MAS Office drives the team.
  - `mas-office-runtime` with Claude Code (Agent SDK) and Codex (`codex app-server`) adapters, and `mas-office up`.
  - Protocol 0.2: requests, commands with acknowledgements, tasks, ledger, reviews, claims, evidence and verdicts; 16 conformance cases.
  - The "Needs you" inbox and the agent drawer (transcript, outputs, chat, Stop) in the panel.
  - Team design v2 compiled into per-role permissions; `mas-office team check|lock|show`.
  - The engine: Lead plan, parallel stages, review rounds, gates, stall recovery, delegated approvals, follow-up rounds, restart.
  - Claim-level verification and `mas-office verify`.
  - The evaluation harness in `eval/` (no runs yet).

## S0: drive real sessions (v0.3.0, one item open)

- [x] Claude adapter on the Agent SDK. It covers start, stream events, detect `requires_action`, answer permission requests from the UI, steer with `priority`, and resume.
- [x] Codex adapter on `codex app-server`. It covers threads, approval requests, `turn/steer` and resume.
  - [ ] Attaching the official Codex TUI to the same thread.
- [x] One closed loop in the browser: see a session blocked, click it, approve or reply, watch it continue.
- [ ] Settle the open risks:
  - [ ] handing a Claude session over to its terminal and back;
  - [x] concurrency and usage limits: 3 sessions at once by default, usage shown as the programs report it;
  - [x] crash recovery: a restart continues an unfinished run. A pending approval is not re-attached; it expires and the agent asks again.

## S1: protocol 0.2, inbox and drawer (v0.3.0, one item open)

- [x] Protocol 0.2, all additive:
  - `request.*` for things waiting on a person, with ids, options and who may answer.
  - `command.*` for messages, answers, assignments and interrupts, with acknowledgements.
  - An inbox snapshot.
  - JS and Python reducers updated, with new conformance cases.
- [x] The inbox in the panel: wait timers, `N` to jump to the next agent that needs you, and edge pointers.
- [ ] An agent drawer:
  - [x] a structured transcript;
  - [x] a chat box into the real session;
  - [x] an outputs tab;
  - [ ] a raw terminal tab you can take over (`xterm.js` + `node-pty`, shipped as a separate optional package, `mas-office-terminal`).

## S2: the Lead runs the team (v0.3.0, one item open)

- [x] Team design v2, compiled into each backend's per-role tools and permissions:
  - stages;
  - who hands to whom, and with what context;
  - backend per role;
  - allow / ask / deny per tool;
  - `reviewerOf`;
  - review rounds with escalation to you;
  - gates.
- [x] A Lead that wakes on events. It keeps a progress ledger, detects stalls and replans, and approves only from an allow-list you set. (In v0.3.0 the Lead is woken for the plan, for requests routed to it, for a stall, for the write-up and for follow-ups; the scheduler counts stalls and the Lead picks the recovery. It does not yet get a digest after every finished role.)
- [ ] Move the `AGENTS.md` kit onto the same engine.

## S3: verification and evaluation (verification in v0.3.0; evaluation open)

- [x] A claim, evidence and verdict model:
  - inline citations;
  - link health checks;
  - checker verdicts of supported, partial, contradicted or unknown;
  - optional cross-vendor review.
- [ ] Evaluation on 8–10 research tasks. Compare a single agent with the same budget, a MAS Office team, Claude Code `/deep-research`, and a Deep Research product. Measure claim support, broken or invented links, errors caught, cost and time.
  - [x] The harness: 9 tasks, three locked designs, metrics from the event log, rubric sheets, import of other systems' answers (`eval/`).
  - [ ] The runs and the results.

## S4: people and packaging

- [ ] A user study of supervising 4, 8 and 12 agents:
  - compared conditions: plain terminals, the office, and the office with a Lead;
  - measures: time to notice a blocked agent, context switches, situation awareness, trust calibration.
- [x] A desktop app: a native Mac app (`apps/mac`). Not yet signed with a Developer ID or notarised.
- [ ] Publish the evaluation set and the results.

## Producers and protocol (any time, contributions welcome)

- [ ] CrewAI `BaseEventListener` integration
- [ ] AG-UI ingest; OpenTelemetry GenAI ingest (OTLP/HTTP in `serve`)
- [ ] CAMEL `WorkforceCallback`, Google ADK `BasePlugin`, Microsoft Agent Framework workflow events
- [ ] JS integrations: OpenAI Agents SDK (TS), Mastra, Claude Agent SDK (TS)
- [ ] `graph` topology layout; replay scrubber; `export --otlp`
- [x] Conformance cases for result rounds (`round`, `question`, `previous`) (v0.3.0, case 15)
- [ ] Publish the Python SDK to PyPI

Background for these choices: [`docs/research/landscape/SYNTHESIS.md`](docs/research/landscape/SYNTHESIS.md).
