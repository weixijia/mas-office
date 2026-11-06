// `mas-office demo [--port 4747] [--no-open] [--exit] [--speed 1]`:
// serve a temporary workspace and play a simulated team in it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Office } from '../../sdk/index.js';
import { parseArgs, parsePort, UsageError } from '../args.js';
import { openBrowser } from '../server.js';
import { runDemo, DEMO_PROJECT } from '../demo-script.js';
import { listen } from './serve.js';

export async function demoCommand(argv, { out = console.log } = {}) {
  const { options } = parseArgs(argv, { port: 'string', open: 'boolean', exit: 'boolean', speed: 'string' });
  const speed = options.speed === undefined ? 1 : Number(options.speed);
  if (!(speed > 0)) throw new UsageError(`--speed must be a positive number, got "${options.speed}"`);
  const port = parsePort(options.port, 4747);

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-office-demo-'));
  // Without an explicit --port, fall back to any free port when 4747 is taken.
  let srv = await listen({ workspace, port }, options.port === undefined ? () => {} : out);
  if (!srv && options.port === undefined) srv = await listen({ workspace, port: 0 }, out);
  if (!srv) return 1;

  const panelUrl = `${srv.url}/office/`;
  out('MAS Office demo — a simulated team plans a weekend in Lisbon (about 40 seconds).');
  out(`  Panel:     ${panelUrl}`);
  out(`  Workspace: ${workspace}`);
  if (options.open !== false) openBrowser(panelUrl);

  const office = new Office({ workspace });
  await runDemo(office, { speed });
  await office.close();
  out(`Run finished. Result: ${path.join(workspace, DEMO_PROJECT, 'outputs', 'result.json')}`);

  if (options.exit) {
    await srv.close();
    return 0;
  }
  out('Still serving the panel — press Ctrl+C to stop.');
  process.once('SIGINT', async () => {
    await srv.close();
    process.exit(0);
  });
  return new Promise(() => {});
}
