// `mas-office up [workspace] [--project name] [--task "..."] [--port 4747] [--max-parallel 3] [--open]`
//
// Runs the team: the same server as `serve`, with the runtime attached. The runtime is a separate
// package (it depends on the Claude Agent SDK), so this package stays dependency-free.

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

export async function upCommand(argv, { out = console.log, runtime: injected } = {}) {
  const { positionals, options } = parseArgs(argv, {
    port: 'string', host: 'string', open: 'boolean', project: 'string', task: 'string', 'max-parallel': 'string', exit: 'boolean',
  });
  const workspace = path.resolve(positionals[0] ?? '.');
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    out(`✗ Workspace folder not found: ${workspace}\n  Create one with: ${selfCommand()} init ${positionals[0] ?? '.'}`);
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
  // A fresh workspace has no home/projects yet: without it the panel has nothing to show.
  if (isValidFolder(project) && fs.existsSync(path.join(workspace, project))
      && !readDocument(path.join(workspace, 'home', 'projects'))?.projects?.some((p) => p?.folder === project)) {
    const title = readDocument(path.join(workspace, project, 'mas', 'structure'))?.title ?? project;
    updateProjectsIndex(workspace, { folder: project, title, step: 4, phase: 'locked' });
  }
  const mod = injected ?? await loadRuntime(out);
  if (!mod) return 1;
  let app;
  try {
    app = await mod.up({
      workspace, port: parsePort(options.port, 4747), host, maxParallel, startServer, out,
    });
  } catch (err) {
    if (err.code === 'EADDRINUSE') out(`✗ Port ${options.port ?? 4747} is already in use. Try --port ${Number(options.port ?? 4747) + 1}.`);
    else throw err;
    return 1;
  }
  if (options.open) openBrowser(`${app.server.url}/office/?token=${app.server.token}`);

  let code = 0;
  if (options.task !== undefined) {
    try {
      const started = await app.runtime.run(project, { task: options.task });
      out(`  Run ${started.runId} started in ${project}.`);
      if (options.exit) {
        await started.finished;
        const phase = app.server.log(project).snapshot().state.phase;
        out(phase === 'done' ? `✓ Run finished. Answer: ${path.join(workspace, project, 'outputs', 'result.md')}` : `✗ Run ended as ${phase}.`);
        code = phase === 'done' ? 0 : 1;
      }
    } catch (err) {
      out(`✗ ${err.message}`);
      code = 1;
      if (!options.exit) out('  The panel is still up: fix the problem there or press Ctrl+C.');
    }
  }
  if (options.exit) {
    await app.close();
    return code;
  }
  out('Press Ctrl+C to stop. Sessions are closed; they resume by id next time.');
  const stop = async () => {
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return new Promise(() => {}); // run until stopped
}
