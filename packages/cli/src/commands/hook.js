// `mas-office hook claude-code [--workspace dir] [--project claude-code]`. Experimental.
// Reads one Claude Code hook input from stdin and appends the matching events.
// A hook must never break or slow the assistant: this always exits 0 and prints nothing;
// errors go to <workspace>/home/hook-errors.log.

import fs from 'node:fs';
import path from 'node:path';
import { ProjectLog, assertFolder } from '@mas-office/sdk';
import { parseArgs } from '../args.js';
import { mapHook } from '../claude-code.js';

const STDIN_TIMEOUT_MS = 2000;
const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10_000;

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let text = '';
    const timer = setTimeout(() => { process.stdin.pause(); resolve(text); }, STDIN_TIMEOUT_MS);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { text += chunk; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(text); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(text); });
  });
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Hooks can run in parallel (one per tool call): serialise writers with a lock file. */
function withLock(lockFile, fn) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd;
  while (fd === undefined) {
    try {
      fd = fs.openSync(lockFile, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > LOCK_STALE_MS) fs.rmSync(lockFile, { force: true });
      } catch { /* removed by its owner meanwhile */ }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${lockFile}`);
      pause(10);
    }
  }
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lockFile, { force: true });
  }
}

/** Handle one hook input. Exported for tests; throws on errors (the command catches them). */
export function handleHook(input, { workspace, project = 'claude-code' }) {
  assertFolder(project);
  const lock = path.join(workspace, project, 'mas', '.events.lock');
  withLock(lock, () => {
    const log = new ProjectLog(workspace, project, { title: 'Claude Code' });
    const events = mapHook(input, log.snapshot());
    if (events.length) log.append(events);
  });
}

export async function hookCommand(argv) {
  let workspace = path.resolve('.mas-office');
  try {
    const { positionals, options } = parseArgs(argv, { workspace: 'string', project: 'string' });
    if (options.workspace) workspace = path.resolve(options.workspace);
    const input = JSON.parse(await readStdin());
    if (!options.workspace && typeof input?.cwd === 'string') workspace = path.join(input.cwd, '.mas-office');
    if (positionals[0] !== 'claude-code') throw new Error(`unknown hook source "${positionals[0] ?? ''}" (expected claude-code)`);
    handleHook(input, { workspace, project: options.project ?? 'claude-code' });
  } catch (err) {
    try {
      const file = path.join(workspace, 'home', 'hook-errors.log');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${new Date().toISOString()} ${err?.stack ?? err}\n`);
    } catch { /* nowhere to report: stay silent */ }
  }
  return 0;
}
