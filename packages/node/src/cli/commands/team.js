// `mas-office team check|lock|show <project-dir>`: check a team design against the v2 rules,
// lock it (sets `locked` and `signature`), or print its Markdown view.

import fs from 'node:fs';
import path from 'node:path';
import { readDocument, jsTwin, writeFileAtomic, GLOBALS } from '../../sdk/index.js';
import { normalizeTeam, lockTeam, teamToMarkdown, verifySignature } from '../../team/index.js';
import { parseArgs, UsageError } from '../args.js';

const USAGE = 'mas-office team check|lock|show <project-dir> [--workspace <dir>]';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

/**
 * The workspace a team runs in: MCP servers from `<workspace>/.mcp.json` and the command
 * allow-list `<workspace>/home/commands.json` (a list of command prefixes, or `{"commands": [...]}`).
 */
export function loadTeamEnv(project, workspace = path.dirname(project)) {
  const mcp = readJson(path.join(workspace, '.mcp.json'));
  const commands = readJson(path.join(workspace, 'home', 'commands.json'));
  const list = Array.isArray(commands) ? commands : Array.isArray(commands?.commands) ? commands.commands : [];
  return {
    workspace,
    project,
    mcpServers: mcp && typeof mcp.mcpServers === 'object' && mcp.mcpServers !== null ? mcp.mcpServers : {},
    commands: list.filter((c) => typeof c === 'string'),
  };
}

const printProblems = (problems, out) => {
  for (const p of problems) out(`${p.level === 'error' ? '✗' : '!'} ${p.path || '(root)'}: ${p.message}`);
};

export function teamCommand(argv, { out = console.log } = {}) {
  const { positionals, options } = parseArgs(argv, { workspace: 'string' });
  const [action, dir] = positionals;
  if (!['check', 'lock', 'show'].includes(action)) throw new UsageError(`team needs an action: ${USAGE}`);
  if (!dir) throw new UsageError(`team ${action} needs a project folder: ${USAGE}`);
  const project = path.resolve(dir);
  const base = path.join(project, 'mas', 'structure');
  const structure = readDocument(base);
  if (structure === undefined) throw new Error(`No team design at ${base}.json or ${base}.js`);
  const env = loadTeamEnv(project, options.workspace ? path.resolve(options.workspace) : undefined);
  const { team, problems } = normalizeTeam(structure, env);
  const errors = problems.filter((p) => p.level === 'error');

  if (action === 'show') {
    if (team) out(teamToMarkdown(team).trimEnd());
    if (problems.length) out('');
    printProblems(problems, out);
    return errors.length ? 1 : 0;
  }
  if (action === 'check') {
    printProblems(problems, out);
    if (structure.locked === true && structure.signature !== undefined && !verifySignature(structure)) {
      out('✗ /signature: the design changed after it was locked; unlock and lock it again');
      return 1;
    }
    out(errors.length
      ? `\n${errors.length} error${errors.length === 1 ? '' : 's'}: the team cannot be locked yet.`
      : `✓ The team design is valid${problems.length ? ` (${problems.length} warning${problems.length === 1 ? '' : 's'})` : ''}.`);
    return errors.length ? 1 : 0;
  }
  // lock
  if (errors.length) {
    printProblems(problems, out);
    out(`\n${errors.length} error${errors.length === 1 ? '' : 's'}: the team was not locked.`);
    return 1;
  }
  const locked = lockTeam(structure, env);
  const json = `${base}.json`;
  const js = `${base}.js`;
  if (fs.existsSync(json)) writeFileAtomic(json, `${JSON.stringify(locked, null, 2)}\n`);
  if (fs.existsSync(js) || !fs.existsSync(json)) writeFileAtomic(js, jsTwin(GLOBALS.structure, locked));
  printProblems(problems, out);
  out(`✓ Locked ${path.relative(process.cwd(), project) || '.'}: ${locked.signature}`);
  return 0;
}
