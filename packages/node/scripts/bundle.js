// prepack: copy the panel, the JSON Schemas and the kit into this package so that
// `npm pack` / `npm publish` ship them. postpack (`--clean`) removes the copies again.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = fileURLToPath(new URL('../', import.meta.url));
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const COPIES = [
  ['panel', 'panel'],
  ['spec/schemas', 'schemas'],
  ['kit', 'kit'],
];

for (const [from, to] of COPIES) {
  fs.rmSync(pkg + to, { recursive: true, force: true });
  if (process.argv.includes('--clean')) continue;
  fs.cpSync(repo + from, pkg + to, {
    recursive: true,
    // Skip the panel's own tests and macOS clutter.
    filter: (src) => path.relative(repo + from, src).split(path.sep)[0] !== 'tests' && !src.endsWith('.DS_Store'),
  });
  console.log(`bundled ${from} → packages/node/${to}`);
}
