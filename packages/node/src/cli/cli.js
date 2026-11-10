// The `mas-office` command line: parse the command, run it, return an exit code.
// Exit codes: 0 success, 1 the command failed (e.g. validation errors), 2 wrong usage.

import { UsageError } from './args.js';
import { packageJson, selfCommand } from './paths.js';

const HELP = {
  main: `mas-office ${packageJson.version} — the MAS Office panel and protocol tools

Usage: mas-office <command> [options]

Commands:
  demo                      Watch a simulated team in the panel (start here)
  up [workspace]            Run your locked team on real Claude Code and Codex sessions
  serve [workspace]         Serve the panel, the workspace files, the event and command API
  init [dir]                Create a workspace (with --kit: the no-code AGENTS.md kit)
  team check|lock|show <d>  Check a team design, lock it, or print it as Markdown
  verify <project-dir>      Check an answer's claims and source links
  validate [path]           Check snapshots and event logs against the spec
  reduce <project-dir>      Rebuild snapshots from mas/events.jsonl
  export --ag-ui <dir>      Print a project's log as AG-UI events (experimental)
  hook claude-code          Turn Claude Code hook input into events (experimental)

Options:
  -h, --help                Show help (also: mas-office <command> --help)
  -v, --version             Show the version

Spec and docs: https://github.com/weixijia/mas-office`,
  demo: `Usage: mas-office demo [--port 4747] [--no-open] [--exit] [--speed 1]

Creates a temporary workspace, serves it and plays a simulated 5-agent team
(plus one helper spawned at runtime) for about 40 seconds.

  --port <n>     Port to listen on (default 4747, or any free port if taken)
  --no-open      Do not open the browser
  --exit         Stop the server when the run finishes
  --speed <x>    Playback speed multiplier (default 1)`,
  up: `Usage: mas-office up [workspace=.] [--project <folder>] [--task "<text>"] [--exit]
                     [--port 4747] [--host 127.0.0.1] [--max-parallel 3] [--open]

Runs the team you designed and locked. Every role is a real Claude Code or Codex
session on this computer, signed in by you (claude auth login / codex login).
MAS Office starts the unmodified programs and never sees your sign-in.

The panel shows the office, the inbox of everything that needs you, and each
agent's transcript and chat box. Needs the runtime: npm install mas-office-runtime

  --project <f>       Project folder (default: the workspace's current project)
  --task "<text>"     Start a run with this task right away
  --exit              With --task: stop when the run ends (exit 1 if it failed)
  --max-parallel <n>  Sessions working at once, 1-12 (default 3; each uses your plan)
  --port, --host      As for serve
  --open              Open the panel in the browser`,
  serve: `Usage: mas-office serve [workspace=.] [--port 4747] [--host 127.0.0.1] [--open]

Serves the panel at /office/, the workspace files read-only, and the API:
  POST /v0/events?project=<folder>   one event, a JSON array or NDJSON (max 1 MB)
  POST /v0/commands?project=<folder> one command for an agent (needs the panel token)
  GET  /v0/stream                    Server-Sent Events: "change" and "mas"
                                     (?project=<folder>&since=<seq> replays the log)
  GET  /v0/health                    {"ok": true, "spec": "0.2"}

The printed panel link carries a token: only a browser opened from that link may
answer requests or message agents. Without a runtime (mas-office up), commands
are logged and left in <project>/mas/commands/ for a file-only assistant.

  --port <n>     Port to listen on (default 4747; 0 = any free port)
  --host <h>     Interface to listen on (default 127.0.0.1)
  --open         Open the panel in the browser`,
  init: `Usage: mas-office init [dir=.] [--kit] [--force]

Creates home/projects.json (+ .js) and copies the panel into <dir>/office/.

  --kit          Also copy the no-code kit: AGENTS.md, CLAUDE.md, GEMINI.md,
                 SETUP.md, harness/ and .claude/settings.json
  --force        Overwrite files that already exist`,
  validate: `Usage: mas-office validate [path=.]

Checks a workspace, a project folder or a single file: every snapshot (.json, and
.js twins, read as data and never run) against the JSON Schemas, every line of
mas/events.jsonl, that roles[].handsTo exist, and that .json and .js twins agree.
Exits with 1 when anything is invalid.`,
  team: `Usage: mas-office team check|lock|show <project-dir> [--workspace <dir>]

  check   Report every problem in mas/structure.json (exit 1 on errors)
  lock    Check, then set "locked" and the design's signature. A run refuses a
          design that changed after it was locked.
  show    Print the design as Markdown: roles, tools and who may approve what`,
  verify: `Usage: mas-office verify <project-dir> [--no-network] [--json]

Reads the project's answer and source cards. Lists every <claim> tag, checks each
source link (live, archived, dead or blocked; private addresses are never
fetched) and points at statements that carry no source. When the project has an
event log, the findings are appended to it and the panel shows them.

  --no-network   Do not fetch anything; only parse and count
  --json         Print the findings as JSON`,
  reduce: `Usage: mas-office reduce <project-dir>

Replays mas/events.jsonl and rewrites mas/structure, mas/state, mas/status/* and
outputs/result (JSON + .js twins). Updates home/projects when the project is in a workspace.`,
  export: `Usage: mas-office export --ag-ui <project-dir>

Experimental. Prints the project's events as AG-UI-shaped events, one JSON object
per line, using the mapping table in the spec (§3.2). Each event has "timestamp"
(ms) and the original event as "rawEvent"; unmapped types become CUSTOM.`,
  hook: `Usage: mas-office hook claude-code [--workspace dir] [--project claude-code]

Experimental. Reads one Claude Code hook input (JSON) from stdin and appends the
matching events to <workspace>/<project>/mas/events.jsonl. Always exits 0 and prints
nothing; errors go to <workspace>/home/hook-errors.log.

  --workspace <dir>   Workspace folder (default: <cwd from the hook>/.mas-office)
  --project <name>    Project folder (default: claude-code)`,
};

const COMMANDS = {
  demo: () => import('./commands/demo.js').then((m) => m.demoCommand),
  up: () => import('./commands/up.js').then((m) => m.upCommand),
  serve: () => import('./commands/serve.js').then((m) => m.serveCommand),
  team: () => import('./commands/team.js').then((m) => m.teamCommand),
  verify: () => import('./commands/verify.js').then((m) => m.verifyCommand),
  init: () => import('./commands/init.js').then((m) => m.initCommand),
  validate: () => import('./commands/validate.js').then((m) => m.validateCommand),
  reduce: () => import('./commands/reduce.js').then((m) => m.reduceCommand),
  export: () => import('./commands/export.js').then((m) => m.exportCommand),
  hook: () => import('./commands/hook.js').then((m) => m.hookCommand),
};

/**
 * @param {string[]} argv arguments after `mas-office`
 * @returns {Promise<number>} the exit code
 */
export async function main(argv) {
  const [command, ...rest] = argv;
  const out = (text) => process.stdout.write(`${text}\n`);
  const err = (text) => process.stderr.write(`${text}\n`);

  if (!command || command === '-h' || command === '--help' || command === 'help') {
    out(Object.hasOwn(HELP, rest[0] ?? '') ? HELP[rest[0]] : HELP.main);
    return 0;
  }
  if (command === '-v' || command === '--version') {
    out(packageJson.version);
    return 0;
  }
  if (!Object.hasOwn(COMMANDS, command)) {
    err(`Unknown command "${command}". To see the commands, run: ${selfCommand()} --help`);
    return 2;
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    out(HELP[command]);
    return 0;
  }
  const run = await COMMANDS[command]();
  if (command === 'hook') return run(rest); // never prints, never fails
  try {
    return await run(rest);
  } catch (e) {
    if (e instanceof UsageError) {
      err(`${e.message}\n\n${HELP[command]}`);
      return 2;
    }
    err(`✗ ${e.message}`);
    return 1;
  }
}
