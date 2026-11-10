# Contributing to MAS Office

Thanks for helping! MAS Office is small on purpose: a protocol, two reference SDKs, a CLI and a panel with no build step. Most contributions fit in one of the lanes below, and each lane has its own checklist.

- Questions and early ideas → [Discussions](https://github.com/weixijia/mas-office/discussions).
- Bugs → an issue with a minimal reproduction (`mas-office validate` output helps).
- Anything larger than a bug fix → open an issue first so we can agree on the shape before you write code.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Repository map

| Path | What | Language / tests |
|---|---|---|
| `spec/` | The protocol (`README.md`), JSON Schemas, conformance cases, RFCs | Markdown + JSON |
| `packages/node/` | `mas-office` on npm, zero dependencies — SDK (`src/sdk/`: reducer, file + HTTP transports), team design v2 and its compiler (`src/team/`), delegated approvals (`src/policy/`), verification (`src/verify/`), CLI and server (`src/cli/`: `demo`, `up`, `serve`, `init`, `team`, `verify`, `validate`, `reduce`, `export`, `hook`) | Node ≥ 18, `node:test` |
| `packages/runtime/` | `mas-office-runtime` on npm — Claude Code and Codex adapters (`src/backends/`) and the engine behind `mas-office up` (`src/engine/`) | Node ≥ 18.14, `node:test` |
| `packages/python/` | `mas-office` on PyPI — reducer, transports, framework integrations | Python ≥ 3.10, `pytest` |
| `panel/` | The office panel (vanilla JS, no build): office, inbox, agent drawer, result | `node panel/tests/model.test.js`, `node panel/tests/inbox.test.js` |
| `kit/` | No-code mode: `AGENTS.md` + `harness/` for AI coding assistants | Markdown |
| `examples/` | Finished example workspaces (must pass `mas-office validate`) | data |
| `eval/` | Evaluation harness: tasks, locked team designs, metrics from the event log | Python ≥ 3.10, `pytest` |
| `docs/` | Architecture, integration guides, research notes | Markdown |

## Development setup

```bash
git clone https://github.com/weixijia/mas-office && cd mas-office
npm install                                   # links mas-office and mas-office-runtime
node packages/node/bin/mas-office.js demo     # see it working
```

Before you open a pull request, run the checks from the repository root:

```bash
npm test                                                             # SDK, CLI, runtime, panel
PYTHONPATH=packages/python/src python -m pytest packages/python -q   # Python SDK
node packages/node/bin/mas-office.js validate examples               # example workspaces
git diff --check                                                     # whitespace
PYTHONPATH=packages/python/src:eval python -m pytest eval -q         # evaluation harness, if you touched eval/
```

The tests never start real Claude Code or Codex sessions. The adapters' smoke tests against the real programs (`packages/runtime/scripts/smoke-*.mjs`) are run by hand in a temporary folder outside the repository, with your own sign-in.

## Lanes

### 1. Protocol changes (`spec/`)

The spec is the contract between producers and the panel, so it moves carefully.

- **Additive** (a new optional field, a new event type the reducer ignores): one pull request that updates `spec/README.md`, the JSON Schemas, **both** reducers, and adds a conformance case.
- **Changing meaning** (an event rule, a required field, the file layout): write an RFC first — see [`spec/rfcs/README.md`](spec/rfcs/README.md).
- Every reducer rule must be covered by a case in `spec/conformance/`: an `events.jsonl` and the `expected.json` snapshot. The JS and Python test suites both run every case, so the two implementations cannot drift.
- Write the `expected.json` **by hand from the spec text**, not by running a reducer — the point is an independent oracle.

### 2. Framework integrations

New integrations are very welcome. Each one should:

- live in `packages/python/src/mas_office/integrations/<framework>.py` (or `packages/node/src/sdk/integrations/`), import the framework **lazily**, and add an optional extra in `pyproject.toml`;
- attach to the framework's **public** hook API (callbacks, tracing processors, event streams) and cite the docs URL in the module docstring;
- never raise into the user's code and never block the agent: drop events rather than fail;
- map to the event types in `spec/README.md` §3.2 and put the framework's original payload in `raw` when it is small and serialisable;
- ship tests that drive it with **fake objects** shaped like the framework's payloads (CI does not install frameworks), plus a short usage snippet in `docs/integrations.md`;
- start as **experimental** in the docs; it graduates once someone has used it on a real run and the hook API has been stable for a release.

Use the "New framework integration" issue template to claim one so two people don't build the same thing.

### 3. Panel

- No build step and no runtime dependencies: plain browser JS that works from `file://` and from `mas-office serve`.
- Pure logic goes in `panel/model.js` with tests in `panel/tests/model.test.js`; DOM code goes in `app.js` / `office.js`.
- All agent-written text is untrusted: render it only through `esc()` / `renderMarkdown()`. Never assign agent text to `innerHTML` directly.
- Keep `kit` mode (an assistant guiding a person) and `sdk` mode working; check both with the fixtures in `panel/tests/fixtures/`.
- For visual changes, attach before/after screenshots at 1440 px and 390 px widths.

### 4. SDKs and CLI

- Zero runtime dependencies in `mas-office` (npm) and `mas-office` (PyPI). Dev dependencies are fine.
- Keep the JS and Python public APIs in step (same method names, camelCase vs snake_case). If you add a method to one, open a follow-up issue for the other.
- `serve` is a local dev server: keep it read-only for workspace files and impossible to traverse out of the workspace. Security-sensitive changes need a test.

## Pull requests

- One topic per pull request; keep it small enough to review in one sitting.
- Tests for changed behaviour; the checks above green.
- Update `CHANGELOG.md` under **Unreleased** for anything a user would notice.
- Code, comments, docs and commit messages in English. Commit messages: a short imperative subject (≤ 72 characters), then a body explaining *why*.

### Developer Certificate of Origin

We use the [DCO](https://developercertificate.org/) instead of a CLA. Sign off every commit:

```bash
git commit -s -m "Add CrewAI event listener integration"
```

This adds a `Signed-off-by: Your Name <you@example.com>` line, which certifies that you wrote the change or have the right to submit it under the project's MIT licence.

## Releases

Maintainers release from `main`. Packages use semver; the spec uses `Major.Minor`. A release bumps package versions together, moves **Unreleased** in `CHANGELOG.md` under the new version and tags `vX.Y.Z`.
