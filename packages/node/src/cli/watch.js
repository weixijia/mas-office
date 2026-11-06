// Report changed files under a folder. Uses fs.watch({recursive: true}) where the platform
// supports it and falls back to polling once a second (e.g. Linux on Node 18).

import fs from 'node:fs';
import path from 'node:path';

const MAX_FILES = 5000;
const MAX_DEPTH = 6;

// Dot paths (temp files of atomic writes, .git, locks) and node_modules are never reported.
const ignored = (rel) => rel.split('/').some((s) => s.startsWith('.') || s === 'node_modules');

function scan(root) {
  const seen = new Map();
  const walk = (dir, rel, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (seen.size >= MAX_FILES) return;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (ignored(childRel)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) walk(full, childRel, depth + 1);
      } else if (entry.isFile()) {
        try {
          const st = fs.statSync(full);
          seen.set(childRel, `${st.mtimeMs}:${st.size}`);
        } catch { /* deleted while scanning */ }
      }
    }
  };
  walk(root, '', 0);
  return seen;
}

/**
 * @param {string} root
 * @param {(relPath: string) => void} onChange called with posix paths relative to root
 * @param {{poll?: boolean, interval?: number}} [options] `poll: true` forces polling
 * @returns {{mode: 'watch'|'poll', close(): void}}
 */
export function watchTree(root, onChange, { poll = false, interval = 1000 } = {}) {
  const pending = new Set();
  let timer = null;
  const flush = () => {
    timer = null;
    for (const rel of pending) onChange(rel);
    pending.clear();
  };
  const report = (rel) => {
    if (!rel || ignored(rel)) return;
    pending.add(rel);
    timer ??= setTimeout(flush, 50); // coalesce the bursts fs.watch produces
  };

  if (!poll) {
    try {
      const watcher = fs.watch(root, { recursive: true }, (_type, name) => {
        if (name) report(String(name).split(path.sep).join('/'));
      });
      watcher.on('error', () => {});
      return { mode: 'watch', close: () => { watcher.close(); clearTimeout(timer); } };
    } catch {
      // recursive watching is not available here: poll instead
    }
  }

  let last = scan(root);
  const tick = setInterval(() => {
    const now = scan(root);
    for (const [rel, sig] of now) if (last.get(rel) !== sig) report(rel);
    for (const rel of last.keys()) if (!now.has(rel)) report(rel);
    last = now;
  }, interval);
  tick.unref();
  return { mode: 'poll', close: () => { clearInterval(tick); clearTimeout(timer); } };
}
