// Shared test helpers (not a test file).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const tmpDir = (prefix = 'mas-office-test-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** Evaluate a `.js` twin the way a browser would, with a fresh (or given) `window`. */
export function evalTwin(code, window = {}) {
  new Function('window', code)(window);
  return window;
}

/** Every file and folder under `dir`, as sorted posix paths (Node 18 has no recursive readdir). */
export function listTree(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    out.push(rel);
    if (entry.isDirectory()) out.push(...listTree(path.join(dir, entry.name), rel));
  }
  return out.sort();
}

export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** Record console.warn calls while `fn` runs (works on every Node 18 release, unlike t.mock). */
export async function captureWarnings(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    await fn(warnings);
  } finally {
    console.warn = original;
  }
  return warnings;
}
