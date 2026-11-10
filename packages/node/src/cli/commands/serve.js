// `mas-office serve [workspace] [--port 4747] [--host 127.0.0.1] [--open]`

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, parsePort } from '../args.js';
import { startServer, openBrowser } from '../server.js';
import { selfCommand } from '../paths.js';

/** Start the server, with a readable message when the port is taken. */
export async function listen(options, out) {
  try {
    return await startServer(options);
  } catch (err) {
    if (err.code === 'EADDRINUSE') out(`✗ Port ${options.port} is already in use. Try --port ${options.port + 1}.`);
    else if (err.code === 'EACCES') out(`✗ Not allowed to listen on port ${options.port}. Try a port above 1024.`);
    else throw err;
    return null;
  }
}

export async function serveCommand(argv, { out = console.log } = {}) {
  const { positionals, options } = parseArgs(argv, { port: 'string', host: 'string', open: 'boolean' });
  const workspace = path.resolve(positionals[0] ?? '.');
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    out(`✗ Workspace folder not found: ${workspace}\n  Create one with: ${selfCommand()} init ${positionals[0] ?? '.'}`);
    return 1;
  }
  const host = options.host ?? '127.0.0.1';
  const srv = await listen({ workspace, port: parsePort(options.port, 4747), host }, out);
  if (!srv) return 1;
  out(`MAS Office is serving ${workspace}`);
  out(`  Panel:   ${srv.url}/office/?token=${srv.token}`);
  out('           (the token lets this browser answer requests and message agents; keep the link to yourself)');
  out(`  Events:  POST ${srv.url}/v0/events?project=<folder>`);
  out(`  Commands: POST ${srv.url}/v0/commands?project=<folder>   (needs the token)`);
  out(`  Stream:  ${srv.url}/v0/stream`);
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    out(`  Warning: listening on ${host} — anyone who can reach this machine can read the workspace and post events.`);
  }
  out('Press Ctrl+C to stop.');
  if (options.open) openBrowser(`${srv.url}/office/?token=${srv.token}`);
  const stop = async () => {
    await srv.close();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return new Promise(() => {}); // run until stopped
}
