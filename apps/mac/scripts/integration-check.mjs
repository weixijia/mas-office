#!/usr/bin/env node
// Runs the scripted daemon (scripted-daemon.mjs: real server and runtime, fake backends) with its stdin on a
// pipe, reads its handshake, runs something against it, then closes the pipe (the daemon stops) and exits
// with that thing's status. The token travels only through environment variables.
//
//   node integration-check.mjs                         swift run MASOfficeChecks --integration
//   node integration-check.mjs --app <MAS Office.app> --self-check <report.json>
//   node integration-check.mjs --app <MAS Office.app> --render <dir> [--fixture <workspace>]
//   node integration-check.mjs --render <dir> [--fixture <workspace>]   renders with the debug build (swift run MASOffice);
//                                                                        no integration steps
//   node integration-check.mjs --supervision [--fixture <workspace>]     MASOfficeChecks --supervision: the inbox and agent
//                                                                        page intents (scripted run, or the fixture)
//   node integration-check.mjs [--fixture <workspace>] -- <command …>   run any command with the attach variables
//                                                                        (e.g. the app binary, to see its logs)
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mac = path.resolve(here, '..');
const all = process.argv.slice(2);
const dashes = all.indexOf('--');
const args = dashes >= 0 ? all.slice(0, dashes) : all;
const command = dashes >= 0 ? all.slice(dashes + 1) : null;
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const daemonArgs = [path.join(here, 'scripted-daemon.mjs')];
if (opt('--fixture')) daemonArgs.push('--fixture', path.resolve(opt('--fixture')));
const daemon = spawn(process.execPath, daemonArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
let log = '';
daemon.stderr.on('data', (c) => { log += c; });

const handshake = await new Promise((resolve, reject) => {
  let buf = '';
  const timer = setTimeout(() => reject(new Error(`no handshake within 20 s\n${log}`)), 20_000);
  daemon.stdout.on('data', (c) => {
    buf += c;
    const nl = buf.indexOf('\n');
    if (nl >= 0) { clearTimeout(timer); resolve(JSON.parse(buf.slice(0, nl))); }
  });
  daemon.on('exit', (code) => reject(new Error(`daemon exited (${code})\n${log}`)));
});
console.log(`Scripted daemon at ${handshake.url} (pid ${daemon.pid})${opt('--fixture') ? ' serving a fixture copy' : ''}`);

const env = { ...process.env, MAS_OFFICE_ATTACH_URL: handshake.url, MAS_OFFICE_ATTACH_TOKEN: handshake.token };
const run = (cmd, argv, options = {}) => new Promise((resolve) => {
  const child = spawn(cmd, argv, { stdio: 'inherit', env, ...options });
  child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
});

let status;
const app = opt('--app');
if (command?.length) {
  status = await run(command[0], command.slice(1));
} else if (app) {
  const appArgs = [];
  if (opt('--self-check')) appArgs.push('--self-check', path.resolve(opt('--self-check')));
  if (opt('--self-check-seconds')) appArgs.push('--self-check-seconds', opt('--self-check-seconds'));
  if (opt('--render')) appArgs.push('--render', path.resolve(opt('--render')));
  // LaunchServices does not pass our environment on: hand the attach variables over with --env.
  status = await run('open', ['-n', '-W', '--env', `MAS_OFFICE_ATTACH_URL=${handshake.url}`, '--env', `MAS_OFFICE_ATTACH_TOKEN=${handshake.token}`,
    path.resolve(app), '--args', ...appArgs]);
} else if (opt('--render')) {
  status = await run('swift', ['run', '--package-path', mac, 'MASOffice', '--render', path.resolve(opt('--render'))]);
} else if (args.includes('--supervision')) {
  status = await run('swift', ['run', '--package-path', mac, 'MASOfficeChecks', '--supervision', ...(opt('--fixture') ? ['--fixture'] : [])]);
} else {
  status = await run('swift', ['run', '--package-path', mac, 'MASOfficeChecks', '--integration']);
}

daemon.stdin.end(); // the daemon shuts down when its stdin closes
const stopped = await Promise.race([
  new Promise((resolve) => daemon.on('exit', () => resolve(true))),
  new Promise((resolve) => setTimeout(() => resolve(false), 10_000)),
]);
if (!stopped) {
  console.error('✗ the daemon did not stop after its stdin closed');
  daemon.kill('SIGKILL');
  status ||= 1;
} else {
  console.log('Daemon stopped after its stdin closed.');
}
process.exit(status);
