// Where the CLI finds the panel, the JSON Schemas and the kit.
// In a published package they are bundled next to `src/` by `scripts/bundle.js` (prepack);
// in a clone of the repo they are read from the repo itself.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bundled = (name) => fileURLToPath(new URL(`../../${name}/`, import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const inRepo = fs.existsSync(`${repoRoot}spec/README.md`) && fs.existsSync(`${repoRoot}packages/node/package.json`);

function locate(name, repoPath) {
  if (fs.existsSync(bundled(name))) return bundled(name);
  if (inRepo && fs.existsSync(repoRoot + repoPath)) return repoRoot + repoPath;
  return null;
}

/** The panel folder (`index.html`, `app.js`, …), or null. */
export const panelDir = () => locate('panel', 'panel/');
/** The folder with `*.schema.json`, or null. */
export const schemasDir = () => locate('schemas', 'spec/schemas/');
/** The AGENTS.md kit folder, or null. */
export const kitDir = () => locate('kit', 'kit/');

export const packageJson = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

/**
 * The command that runs this CLI again, for hints we print: `mas-office` when it was run through
 * an npm bin link, otherwise `node <path to bin/mas-office.js>` (e.g. from a clone of the repo).
 */
export function selfCommand(script = process.argv[1], cwd = process.cwd()) {
  if (!script || /^mas-office(\.cmd|\.ps1)?$/i.test(script.split(/[\\/]/).pop())) return 'mas-office';
  const rel = path.relative(cwd, script);
  const shown = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : script;
  return `node ${/^[\w./\\:-]+$/.test(shown) ? shown : `"${shown}"`}`;
}
