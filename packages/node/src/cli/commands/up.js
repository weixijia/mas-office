// `mas-office up [workspace] [--project name] [--task "..."] [--port 4747] [--max-parallel 3] [--open] [--json]`
//
// Runs the team: the same server as `serve`, with the runtime attached. The runtime is a separate
// package (it depends on the Claude Agent SDK), so this package stays dependency-free.
//
// `--json` is the machine-readable mode for a parent process (the Mac app): stdout carries exactly one
// line, `{"url","port","token","backends","maxParallel"}`, once the server is ready; everything meant
// for people goes to stderr. The daemon shuts down when its stdin closes, so it never outlives the
// parent, even when the parent crashes.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, parsePort, UsageError } from '../args.js';
import { startServer, openBrowser } from '../server.js';
import { selfCommand } from '../paths.js';
import { readDocument, isValidFolder, updateProjectsIndex } from '../../sdk/index.js';

async function loadRuntime(out) {
  try {
    return await import('mas-office-runtime');
  } catch (err) {
    // Only "the runtime itself is missing" gets the install hint; a broken install must show its error.
    if (err.code !== 'ERR_MODULE_NOT_FOUND' || !String(err.message).includes("'mas-office-runtime'")) throw err;
    out('✗ Running a team needs the runtime package, which is not installed here.');
    out('  Install it next to mas-office:  npm install mas-office-runtime');
    out(`  To only watch a team that something else runs:  ${selfCommand()} serve`);
    return null;
  }
}

/** The one stdout line of `--json` mode. The token is for the parent only: it never goes to stderr. */
export function handshake(app, maxParallel) {
  const backends = app.runtime?.info?.().backends ?? app.probes ?? {};
  return { url: app.server.url, port: app.server.port, token: app.server.token, backends, maxParallel };
}

export async function upCommand(argv, {
  out = console.log, err = (line) => process.stderr.write(`${line}\n`), runtime: injected,
  stdin = process.stdin, exit = (code) => process.exit(code),
} = {}) {
  const { positionals, options } = parseArgs(argv, {
    port: 'string', host: 'string', open: 'boolean', project: 'string', task: 'string', 'max-parallel': 'string', exit: 'boolean',
    json: 'boolean',
  });
  const json = options.json === true;
  // In --json mode stdout is the handshake line only; text for people goes to stderr.
  const say = json ? err : out;
  const workspace = path.resolve(positionals[0] ?? '.');
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    say(`✗ Workspace folder not found: ${workspace}\n  Create one with: ${selfCommand()} init ${positionals[0] ?? '.'}`);
    return 1;
  }
  const maxParallel = options['max-parallel'] === undefined ? 3 : Number(options['max-parallel']);
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 12) throw new UsageError('--max-parallel must be a number from 1 to 12');
  const project = options.project ?? readDocument(path.join(workspace, 'home', 'projects'))?.current ?? null;
  if (options.task !== undefined) {
    if (!isValidFolder(project)) throw new UsageError('--task needs a project: pass --project <folder>');
    if (!options.task.trim()) throw new UsageError('--task must not be empty');
  }

  const host = options.host ?? '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    // Sessions here act with the person's own sign-in: the control room stays on this machine.
    throw new UsageError('up listens on this computer only (127.0.0.1). To reach it from another device, use an SSH tunnel or your own private network.');
  }
  // The panel and the app list projects from home/projects. A workspace whose project folders were
  // made by hand (or copied in) has none yet: index every folder that holds a team design.
  const known = new Set((readDocument(path.join(workspace, 'home', 'projects'))?.projects ?? []).map((p) => p?.folder));
  const found = fs.readdirSync(workspace, { withFileTypes: true })
    .filter((d) => d.isDirectory() && isValidFolder(d.name) && !known.has(d.name)
      && readDocument(path.join(workspace, d.name, 'mas', 'structure')))
    .map((d) => d.name);
  // The named project goes last so it ends up as the current one.
  for (const folder of [...found.filter((f) => f !== project), ...found.filter((f) => f === project)]) {
    const structure = readDocument(path.join(workspace, folder, 'mas', 'structure'));
    updateProjectsIndex(workspace, {
      folder, title: typeof structure?.title === 'string' ? structure.title : folder, step: structure?.locked ? 4 : 2,
      phase: structure?.locked ? 'locked' : 'design', agents: (Array.isArray(structure?.roles) ? structure.roles.length : 0) + 1,
    });
  }
  const mod = injected ?? await loadRuntime(out);
  if (!mod) return 1;
  let app;
  try {
    app = await mod.up({
      workspace, port: parsePort(options.port, 4747), host, maxParallel, startServer, out: say, printUrl: !json,
    });
  } catch (err) {
    if (err.code === 'EADDRINUSE') say(`✗ Port ${options.port ?? 4747} is already in use. Try --port ${Number(options.port ?? 4747) + 1}.`);
    else throw err;
    return 1;
  }
  if (json) out(JSON.stringify(handshake(app, maxParallel)));
  if (options.open) openBrowser(`${app.server.url}/office/?token=${app.server.token}`);

  let code = 0;
  if (options.task !== undefined) {
    try {
      const started = await app.runtime.run(project, { task: options.task });
      say(`  Run ${started.runId} started in ${project}.`);
      if (options.exit) {
        await started.finished;
        const phase = app.server.log(project).snapshot().state.phase;
        say(phase === 'done' ? `✓ Run finished. Answer: ${path.join(workspace, project, 'outputs', 'result.md')}` : `✗ Run ended as ${phase}.`);
        code = phase === 'done' ? 0 : 1;
      }
    } catch (err) {
      say(`✗ ${err.message}`);
      code = 1;
      if (!options.exit) say('  The panel is still up: fix the problem there or press Ctrl+C.');
    }
  }
  if (options.exit) {
    await app.close();
    return code;
  }
  say(json ? 'Close stdin (or send SIGTERM) to stop. Sessions are closed; they resume by id next time.'
    : 'Press Ctrl+C to stop. Sessions are closed; they resume by id next time.');
  let stopping = null;
  const stop = () => {
    stopping ??= app.close().catch((e) => say(`✗ ${e.message}`)).then(() => exit(0));
    return stopping;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  if (json) {
    // The parent holds our stdin. When it closes (on purpose, or because the parent died), shut down.
    // A dead parent also closed our stdout and stderr: a late write there must not crash the shutdown
    // before the sessions are closed.
    for (const stream of [process.stdout, process.stderr]) stream.on?.('error', () => {});
    stdin.once('end', stop);
    stdin.once('close', stop);
    stdin.once('error', stop);
    stdin.resume();
  }
  return new Promise(() => {}); // run until stopped
}
