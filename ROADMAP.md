# Roadmap

This is a direction, not a promise. Items link to issues once someone picks them up; comment there if you want to help.

## Where we are going

> **An AI team you design, can watch, can steer, and that checks its own work.**

Today MAS Office shows a team at work. Next, it runs the team:

- Every worker is a real Claude Code or Codex session, signed in with your own account.
- The Lead schedules the team from a design you locked.
- Checkers verify the answer claim by claim.
- Everything that needs you lands in one inbox.

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

## S0: drive real sessions (next)

- [ ] Claude adapter on the Agent SDK. It covers start, stream events, detect `requires_action`, answer permission requests from the UI, steer with `priority`, and resume.
- [ ] Codex adapter on `codex app-server`. It covers threads, approval requests, `turn/steer`, resume, and attaching the official TUI to the same thread.
- [ ] One closed loop in the browser: see a session blocked, click it, approve or reply, watch it continue.
- [ ] Settle the open risks: handing a Claude session over to its terminal and back, concurrency and usage limits, and crash recovery.

## S1: protocol 0.2, inbox and drawer

- [ ] Protocol 0.2, all additive:
  - `request.*` for things waiting on a person, with ids, options and who may answer.
  - `command.*` for messages, answers, assignments and interrupts, with acknowledgements.
  - An inbox snapshot.
  - JS and Python reducers updated, with new conformance cases.
- [ ] The inbox in the panel: wait timers, `N` to jump to the next agent that needs you, and edge pointers.
- [ ] An agent drawer:
  - a structured transcript;
  - a chat box into the real session;
  - an outputs tab;
  - a raw terminal tab you can take over (`xterm.js` + `node-pty`, shipped as a separate optional package).

## S2: the Lead runs the team

- [ ] Team design v2, compiled into each backend's per-role tools and permissions:
  - stages;
  - who hands to whom, and with what context;
  - backend per role;
  - allow / ask / deny per tool;
  - `reviewerOf`;
  - review rounds with escalation to you;
  - gates.
- [ ] A Lead that wakes on events. It keeps a progress ledger, detects stalls and replans, and approves only from an allow-list you set.
- [ ] Move the `AGENTS.md` kit onto the same engine.

## S3: verification and evaluation

- [ ] A claim, evidence and verdict model:
  - inline citations;
  - link health checks;
  - checker verdicts of supported, refuted or unknown;
  - optional cross-vendor review.
- [ ] Evaluation on 8–10 research tasks. Compare a single agent with the same budget, a MAS Office team, Claude Code `/deep-research`, and a Deep Research product. Measure claim support, broken or invented links, errors caught, cost and time.

## S4: people and packaging

- [ ] A user study of supervising 4, 8 and 12 agents:
  - compared conditions: plain terminals, the office, and the office with a Lead;
  - measures: time to notice a blocked agent, context switches, situation awareness, trust calibration.
- [ ] A desktop app around the panel and the daemon.
- [ ] Publish the evaluation set and the results.

## Producers and protocol (any time, contributions welcome)

- [ ] CrewAI `BaseEventListener` integration
- [ ] AG-UI ingest; OpenTelemetry GenAI ingest (OTLP/HTTP in `serve`)
- [ ] CAMEL `WorkforceCallback`, Google ADK `BasePlugin`, Microsoft Agent Framework workflow events
- [ ] JS integrations: OpenAI Agents SDK (TS), Mastra, Claude Agent SDK (TS)
- [ ] `graph` topology layout; replay scrubber; `export --otlp`
- [ ] Conformance cases for result rounds (`round`, `question`, `previous`)
- [ ] Publish the Python SDK to PyPI

Background for these choices: [`docs/research/landscape/SYNTHESIS.md`](docs/research/landscape/SYNTHESIS.md).
