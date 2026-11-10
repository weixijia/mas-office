# mas-office-runtime

Drives a MAS Office team of real Claude Code and Codex sessions. The contract between the adapters and the engine is [`docs/design/runtime.md`](../../docs/design/runtime.md).

## What it is

`mas-office` (the core package) holds the protocol, the panel, the server, the team compiler, the approval policy and the verification code, and has no dependencies. This package adds what needs a running session: one adapter per backend and the engine that runs a locked team. It depends on `mas-office` and on `@anthropic-ai/claude-agent-sdk`. You normally use it through `mas-office up`, which loads it when it is installed and prints the install command when it is not.

## Install

```sh
npm install mas-office mas-office-runtime
```

You also need:

- Node.js ≥ 18.14.
- Claude Code (`claude`) installed and signed in by you: `claude auth login`.
- Codex (`codex`) installed and signed in by you (`codex login`), if any role has `"backend": "codex"`.

Version 0.3.0 is not on npm yet. From a clone of the repository, `npm install` at the root links `mas-office` and `mas-office-runtime`, and `node packages/node/bin/mas-office.js` stands for `mas-office`. Keep workspaces outside the clone: Claude Code loads parent `CLAUDE.md` files, so the repository's developer instructions would reach the sessions.

This package never signs you in and never sees your sign-in. At start it asks each program only whether you are signed in (`claude auth status`, Codex `account/read`) and prints the result.

## Run a team

```sh
npx mas-office team lock <workspace>/<project>      # check and sign mas/structure.json
npx mas-office up <workspace> --project <project> --task "…" [--max-parallel 3] [--open] [--exit]
```

`up` reports whether each program is installed and signed in, starts the panel server, attaches the runtime and prints a panel link with an access token. Only a browser opened from that link can answer requests, message agents or start runs. `up` listens on this computer only: a `--host` other than `127.0.0.1`, `localhost` or `::1` is refused (use an SSH tunnel or your own private network to reach it from another device). Without `--task`, start a run from the panel. With `--exit`, `up` stops when the run ends and exits 1 if it did not finish. A run refuses a design that is not locked or that changed after it was locked, and a role whose backend is not installed or not signed in.

While the runtime is attached, the server accepts the events the runtime owns (requests and their answers, runs and rounds, tasks, the Lead's ledger, reviews, recoveries, claims, evidence, verdicts, results, commands and `agent.stopped`) only from the runtime or from the panel with its token, so a role cannot post a verdict on its own work or answer its own request through `POST /v0/events`.

From code: `up(options)`, `createRuntime({workspace, server, backends})` and `createProjectRuntime(...)` are exported from `mas-office-runtime`, with `createClaudeBackend` and `createCodexBackend`.

## How a run flows

1. **Plan.** The Lead, itself a session, gets the task and the team and returns JSON: a plan and one brief per role. The engine validates it and emits `lead.ledger`. A `plan` gate, if designed, opens here.
2. **Stages** run in the design's order. Roles in a stage run in parallel: at most `--max-parallel` roles at once for the whole daemon, across projects (default 3; the Lead is not counted), and per project never more than the design's `budget.maxParallel` (default 3). Each role writes `outputs/work/<role>.md` and source cards in `sources/`.
3. **Review.** A role with `reviewerOf` runs after its targets with a clean context and returns a verdict per target: `accept`, `revise` (the target runs again with the note) or `escalate`. After `review.maxRounds`, or on `escalate`, a `flag` request goes to the person. Nothing is accepted silently.
4. **Gates.** After a stage with a blocking gate, a `gate` request waits for the person: continue, send the stage back with a note, or stop.
5. **Write-up.** The Lead writes `outputs/result.md` with `<claim id src>` tags. The engine records the claims, checks every source URL with deterministic code (private addresses are never fetched), asks the checkers for a verdict per claim, and opens a `flag` when `verify.flagWhen` thresholds are crossed. Then `result` and, if designed, a final gate.
6. **Follow-up.** A question after the result emits `round.started`; the Lead answers from the files or sends back only the roles needed, and the answer becomes the next round.

Along the way:

- **Every tool call** goes through `decideTool` (from `mas-office/team`): `allow` and `deny` are answered at once and logged as policy decisions; `ask` goes to `lead.delegate` rules, which approve by policy, ask the Lead within an allow-list (the Lead can pass it on to the person), or open an inbox request for the person. Hard rules come first and no design widens them: no credential reads, writes only to the role's own files, no local or private addresses, and no Grep or recursive search over the whole project folder (the role is told to pass a narrower folder such as `outputs/` or `sources/`).
- **"Always allow"** remembers exactly that call (same tool, same input) for that agent, in that run. The Lead never grants "always".
- **Stalls.** A working role with no progress for `budget.stallMinutes` (default 5) is nudged once; next the Lead picks `retry`, `replan` or `ask-human`; then the person decides. Waiting for a person is not a stall.
- **Restart.** Session ids are kept in `mas/sessions.json`. When `up` starts again it closes requests the old process left open as `expired` (the agent asks again), and for a run that was cut off it opens a decision in the inbox: continue the run or leave it stopped. Continuing resumes sessions by id; finished roles are not run again, and the run's time budget keeps counting from where it was.
- **Stop conditions**: `budget.maxRunMinutes` (default 90), a Stop from the panel, or Ctrl+C. With no panel open and nothing running for 30 minutes, sessions are closed; they resume by id when needed again.

## Limits

- No raw-terminal tab or terminal take-over yet; that is planned as the optional `mas-office-terminal` package.
- Codex 0.167.0 drops the sandbox's read limit (`access`), so the sandbox does not limit a Codex role's reads to the project folder. The adapter notes this in the transcript; commands Codex runs without asking are prechecked (see the Codex backend below), but a fast command can finish before a deny interrupts it.
- Codex reports tokens but no cost, so cost totals are a lower bound.
- Interrupting a Claude Code turn is covered by unit tests but has not yet been exercised against the real Claude Code CLI.
- A pending approval is not re-attached after a restart: it expires and the agent asks again.
- Attaching the official Codex TUI to a role's thread is not supported yet.

The adapters' smoke tests passed against Claude Code 2.1.322 and Codex 0.167.0 (approval allow and deny, steer, resume). One end-to-end run has been made (2026-11-10: the Lead and a finder on Claude Code, the checker on Codex; the checker sent the work back once and accepted it in round 2). No evaluation runs have been made.

## Claude Code backend

`createClaudeBackend()` from `mas-office-runtime/backends/claude` runs one long-lived, streaming-input Agent SDK `query()` per agent. Each session is the user's own installed `claude` (found on `PATH` and passed as `pathToClaudeCodeExecutable`), started in the project folder with the role's compiled tools, `permissionMode: 'default'`, `settingSources: []` and `strictMcpConfig`, so no user or project setting widens a role. The role contract is appended to the `claude_code` system prompt preset.

**Compliance.** The adapter runs only the unmodified official binary the user signed in to, through Anthropic's own SDK. It checks login with `claude auth status` and keeps only the `loggedIn` flag and the auth-method and plan labels; it never reads credential files or the keychain, and never passes or stores tokens. The child process gets a minimal environment (`PATH`, `HOME`, locale, terminal, proxy and config-dir variables) and no variable that changes how the client identifies itself. Usage shown to the user is what the CLI reports (`result` totals and `rate_limit_event`).

**Approvals.** A `PreToolUse` hook runs for every tool call, including calls Claude Code allows without asking (reads inside the project folder, read-only commands) and calls made by subagents. It passes the call's `subject` to the engine's optional `sink.precheck()`: `deny` (or a failing check) blocks the call, and `ask` sends it to `sink.ask()` through the same per-tool-use registry as `canUseTool`, so the person is asked once. The hook waits up to 24 hours and fails closed (`onFailure: 'block'`). A tool call that needs permission then reaches `canUseTool`: the compiled role leaves `allowedTools` empty, because the SDK would skip approval for anything listed there. The adapter turns it into an `AskRequest` (`kind: 'approval'`, a plain title such as "Run \`npm test\`?" or "Write outputs/work/finder-a.md?", a `subject`, the tool-use id and allow-once / allow-always / deny options) and awaits `sink.ask()`; the engine decides by policy, delegation or the inbox. The answer goes back as the SDK's permission result: allow (with any edited input), deny with a message, or cancel (deny and stop the turn). "Always allow" is answered as a plain allow: the engine remembers that exact call for that agent in that run, and Claude's own permission suggestions are never applied. `AskUserQuestion` becomes a `kind: 'question'` request whose answers are returned to Claude. A re-delivered request with the same tool-use id joins the pending one, and every pending request is denied when the session closes.

**Steering.** `send(text, 'steer')` delivers at the next break point in the running turn (`priority: 'next'`), `'queue'` runs after the turn (`'later'`), and `'interrupt'` stops the turn first. While an approval is pending a steer is queued instead, and the ack's `reason` says so.

Smoke test against the real CLI (four short turns on the `haiku` alias, in a temporary folder outside any repository):

```sh
node packages/runtime/scripts/smoke-claude.mjs --dir "$(mktemp -d)"
```

## Codex backend

`createCodexBackend()` from `mas-office-runtime/backends/codex` starts one shared `codex app-server` (the user's installed, unmodified `codex`, found on `PATH` without a shell) and talks newline-delimited JSON-RPC to it over stdio. Each agent is one Codex thread: `thread/start` with the project folder, the role's `approvalPolicy` and `sandbox`, the role contract as `developerInstructions`, the model and the compiled `config` overrides; the compiled `sandboxPolicy` goes out with every `turn/start`, reduced to the fields the installed Codex knows (a dropped field, such as `access` in 0.167.0, is named in a transcript note). Roles run in the `read-only` sandbox with `on-request` approvals, so every write arrives as a file-change approval that the policy decides; an allowed one (`accept`) is applied by Codex without a second prompt.

**MCP isolation.** Codex merges thread `config` over the user's own Codex config, so a thread would otherwise load every MCP server the user configured. The adapter lists the servers the app-server knows (`mcpServerStatus/list`: names and plugin ids only) and switches off, for that thread, every one the role was not given: `mcp_servers.<name>.enabled = false`, `plugins.<pluginId>.enabled = false` for plugin servers, and `features.apps = false` for ChatGPT apps. A built-in that cannot be switched off by name is retried without that override, and any server that still loads is named in a transcript note. `createCodexBackend({isolateMcp: false})` turns this off.

`start({resume})` uses `thread/resume` and falls back to a fresh thread (with a transcript note) when the thread cannot be resumed.

**Compliance.** Login state comes only from the app-server's `account/read`; `probe()` reports the sign-in type and plan label, never an email, workspace or account id. No credential file is read, and the `account/chatgptAuthTokens/refresh` request is refused. The child process gets the minimal `childEnv()`. Usage shown to the user is what Codex reports: `thread/tokenUsage/updated` totals and `account/rateLimits/read` (read after every turn).

**Approvals.** Every server request goes through `sink.ask()`: command (`item/commandExecution/requestApproval`), file change (`item/fileChange/requestApproval`, with the paths from the item), extra permissions (`item/permissions/requestApproval`), questions (`item/tool/requestUserInput`) and MCP elicitations (`mcpServer/elicitation/request`). Command and file-change options map to Codex's decisions: allow → `accept`, decline → `decline`, decline and stop the turn → `cancel`. `acceptForSession` is never sent (an engine "allow always" becomes `accept`; the engine remembers that exact call for that agent in that run), and no grant widens the sandbox past the role design: network approvals, file changes with a grant root, and permission requests for network or write access are declined without asking anyone (with a transcript note); read-only permission requests are asked and granted for the turn only.

**Precheck.** Codex runs some calls without an approval request (read-only commands such as `cat`, MCP tools that do not prompt, page opens). As each starts, the adapter calls `sink.precheck(subject)`. A plain read command (`cat`, `sed -n`, `rg`, `ls`, … joined only by `|`) whose paths stay inside the project folder is allowed without a command grant; a recursive search from the project root or a credential path is denied; any other command is decided by the role's own rules. On `deny` it interrupts the turn at once, reports `tool.failed`, and continues in a new turn that tells the model the command is not allowed and why; the pending `turn()` resolves with that continuation's result. Limits: the call has already started, so a fast command may finish (and its output reach the model) before the interrupt lands; only `deny` is acted on, because an `ask` cannot be honoured for a call that is already running. Any other server request gets an explicit JSON-RPC error and a transcript note, never silence. When Codex clears a request we are still asking about (`serverRequest/resolved`: answered elsewhere, or the turn ended), the adapter calls the optional `sink.resolvedElsewhere(toolCallId)` and sends no late answer.

**Steering.** `send(text, 'steer')` uses `turn/steer` with the running turn's id, and starts a new turn when there is none (or the turn ended in between); `'queue'` starts a turn after the running one; `'interrupt'` sends `turn/interrupt`, waits for Codex to confirm, then starts a turn. The ack's `reason` says which happened. If the app-server exits, every session's turn ends with `stopReason: 'error'` and `agent.failed`; the next `start()` restarts it (at most 3 restarts a minute).

**Versions.** `codex app-server` is experimental upstream. The adapter uses only the stable surface (`experimentalApi: false`) and was checked against the types `codex app-server generate-ts` produces for your installed version (0.167.0 at the time of writing); unknown notifications are ignored.

Smoke test against the real CLI (six short turns on the cheapest listed model, in an empty folder outside any repository; `--steps abcde` picks a subset):

```sh
node packages/runtime/scripts/smoke-codex.mjs --dir "$(mktemp -d)"
```
