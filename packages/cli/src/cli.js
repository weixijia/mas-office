// The `mas-office` command line: parse the command, run it, return an exit code.
// Exit codes: 0 success, 1 the command failed (e.g. validation errors), 2 wrong usage.

import { UsageError } from './args.js';
import { packageJson, selfCommand } from './paths.js';

const HELP = {
  main: `mas-office ${packageJson.version} — the MAS Office panel and protocol tools

Usage: mas-office <command> [options]

Commands:
  demo                      Watch a simulated team in the panel (start here)
  serve [workspace]         Serve the panel, the workspace files and the event API
  init [dir]                Create a workspace (with --kit: the no-code AGENTS.md kit)
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
  serve: `Usage: mas-office serve [workspace=.] [--port 4747] [--host 127.0.0.1] [--open]

Serves the panel at /office/, the workspace files read-only, and the event API:
  POST /v0/events?project=<folder>   one event, a JSON array or NDJSON (max 1 MB)
  GET  /v0/stream                    Server-Sent Events: "change" and "mas"
  GET  /v0/health                    {"ok": true, "spec": "0.1"}

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
  serve: () => import('./commands/serve.js').then((m) => m.serveCommand),
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
