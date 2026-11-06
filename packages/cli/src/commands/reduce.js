// `mas-office reduce <project-dir>`: rebuild every snapshot from mas/events.jsonl.

import fs from 'node:fs';
import path from 'node:path';
import { ProjectLog, isValidFolder, parseLog, writeSnapshots, reduce } from '@mas-office/sdk';
import { parseArgs, UsageError } from '../args.js';

export function reduceCommand(argv, { out = console.log } = {}) {
  const { positionals } = parseArgs(argv, {});
  if (!positionals[0]) throw new UsageError('reduce needs a project folder: mas-office reduce <project-dir>');
  const dir = path.resolve(positionals[0]);
  const file = path.join(dir, 'mas', 'events.jsonl');
  if (!fs.existsSync(file)) {
    out(`✗ No event log at ${file}`);
    return 1;
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  const folder = path.basename(dir);
  const workspace = path.dirname(dir);
  let snapshot;
  // Inside a workspace (a sibling home/ folder) also refresh home/projects.
  if (isValidFolder(folder) && fs.existsSync(path.join(workspace, 'home'))) {
    const log = new ProjectLog(workspace, folder);
    log.write();
    snapshot = log.snapshot();
  } else {
    snapshot = reduce(lines);
    writeSnapshots(dir, snapshot);
  }
  const applied = parseLog(lines).length;
  out(`Rebuilt snapshots in ${dir} from ${applied} event(s)${applied < lines.length ? ` (${lines.length - applied} line(s) skipped)` : ''}.`);
  out(`  run ${snapshot.state.run}, phase ${snapshot.state.phase}, ${Object.keys(snapshot.statuses).length} agent(s)`);
  return 0;
}
