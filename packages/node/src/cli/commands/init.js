// `mas-office init [dir] [--kit] [--force]`: create a workspace with the panel in `office/`.

import fs from 'node:fs';
import path from 'node:path';
import { jsTwin, GLOBALS } from '../../sdk/index.js';
import { parseArgs } from '../args.js';
import { panelDir, kitDir, selfCommand } from '../paths.js';

const PANEL_SKIP = new Set(['tests']);

/** Every file under `dir` (relative paths), skipping symlinks and top-level names in `skip`. */
function filesUnder(dir, skip = new Set(), rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const childRel = rel ? path.join(rel, entry.name) : entry.name;
    if (!rel && skip.has(entry.name)) continue;
    if (entry.isDirectory()) out.push(...filesUnder(dir, skip, childRel));
    else if (entry.isFile() && entry.name !== '.DS_Store') out.push(childRel);
  }
  return out;
}

export function initWorkspace(target, { kit = false, force = false } = {}) {
  const created = [];
  const skipped = [];
  const put = (rel, write) => {
    const dest = path.join(target, rel);
    if (fs.existsSync(dest) && !force) {
      skipped.push(rel);
      return;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    write(dest);
    created.push(rel);
  };

  // In kit mode the assistant's own setup step writes home/ (as .js files only), so a .json
  // written here would go stale and fail `validate`'s twin check.
  if (!kit) {
    const home = { current: null, projects: [] };
    put(path.join('home', 'projects.json'), (dest) => fs.writeFileSync(dest, `${JSON.stringify(home, null, 2)}\n`));
    put(path.join('home', 'projects.js'), (dest) => fs.writeFileSync(dest, jsTwin(GLOBALS.projects, home)));
  }

  const panel = panelDir();
  if (!panel) throw new Error('Cannot find the panel files. Reinstall mas-office.');
  for (const rel of filesUnder(panel, PANEL_SKIP)) {
    put(path.join('office', rel), (dest) => fs.copyFileSync(path.join(panel, rel), dest));
  }
  if (kit) {
    const kitRoot = kitDir();
    if (!kitRoot) throw new Error('Cannot find the kit files. Reinstall mas-office.');
    for (const rel of filesUnder(kitRoot)) put(rel, (dest) => fs.copyFileSync(path.join(kitRoot, rel), dest));
  }
  return { created, skipped };
}

export function initCommand(argv, { out = console.log } = {}) {
  const { positionals, options } = parseArgs(argv, { kit: 'boolean', force: 'boolean' });
  const target = path.resolve(positionals[0] ?? '.');
  const { created, skipped } = initWorkspace(target, options);
  const shown = (list) => (list.length > 12 ? [...list.slice(0, 12), `… and ${list.length - 12} more`] : list);
  out(created.length ? `Created ${created.length} file(s) in ${target}:` : `Nothing to create in ${target}.`);
  for (const rel of shown(created)) out(`  + ${rel}`);
  if (skipped.length) {
    out(`Kept ${skipped.length} existing file(s) (use --force to overwrite):`);
    for (const rel of shown(skipped)) out(`  = ${rel}`);
  }
  const dir = positionals[0] ?? '.';
  out('\nNext:');
  if (options.kit) out(`  Open ${dir} in your AI assistant and say: "Read SETUP.md and set this folder up."`);
  out(`  Open ${path.join(dir, 'office', 'index.html')} in a browser, or run: ${selfCommand()} serve ${dir}`);
  return 0;
}
