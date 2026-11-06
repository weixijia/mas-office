// `mas-office export --ag-ui <project-dir>`: print the log as AG-UI events (NDJSON). Experimental.

import fs from 'node:fs';
import path from 'node:path';
import { parseLog } from '@mas-office/sdk';
import { parseArgs, UsageError } from '../args.js';
import { toAgUi } from '../agui.js';

export function exportCommand(argv, { out = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const { positionals, options } = parseArgs(argv, { 'ag-ui': 'boolean' });
  if (!options['ag-ui']) throw new UsageError('export needs a format; the only one is --ag-ui');
  if (!positionals[0]) throw new UsageError('export needs a project folder: mas-office export --ag-ui <project-dir>');
  const dir = path.resolve(positionals[0]);
  const file = path.join(dir, 'mas', 'events.jsonl');
  if (!fs.existsSync(file)) throw new Error(`No event log at ${file}`);
  const events = parseLog(fs.readFileSync(file, 'utf8').split('\n'));
  for (const e of toAgUi(events, { threadId: path.basename(dir) })) out(JSON.stringify(e));
  return 0;
}
