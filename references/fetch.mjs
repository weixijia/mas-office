#!/usr/bin/env node
// Fetch the third-party reference repositories listed in references/manifest.json
// into references/repos/<owner>__<repo>, pinned to the recorded commit.
//
// Usage:
//   node references/fetch.mjs              fetch missing repos
//   node references/fetch.mjs --tier core  only repos of one tier (core | secondary | background)
//   node references/fetch.mjs --update     re-pin to the latest default-branch commit and rewrite the manifest
//
// The fetched code is reference material: it is never built, installed or executed.
// No dependencies; needs git on PATH.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(here, 'manifest.json');
const reposDir = join(here, 'repos');

const args = process.argv.slice(2);
const update = args.includes('--update');
const tierIndex = args.indexOf('--tier');
const tier = tierIndex >= 0 ? args[tierIndex + 1] : null;

const git = (cwd, ...gitArgs) =>
  execFileSync('git', gitArgs, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
mkdirSync(reposDir, { recursive: true });

let failures = 0;
for (const entry of manifest.repos) {
  if (tier && entry.tier !== tier) continue;
  const dir = join(reposDir, entry.repo.replace('/', '__'));
  const url = `https://github.com/${entry.repo}.git`;
  try {
    if (update) {
      if (!existsSync(dir)) git(reposDir, 'clone', '--quiet', '--depth', '1', '--single-branch', url, dir);
      else git(dir, 'pull', '--quiet', '--depth', '1', '--rebase=false');
      entry.sha = git(dir, 'rev-parse', 'HEAD');
      console.log(`updated ${entry.repo} @ ${entry.sha.slice(0, 7)}`);
      continue;
    }
    if (existsSync(dir)) {
      console.log(`present ${entry.repo}`);
      continue;
    }
    mkdirSync(dir);
    git(dir, 'init', '--quiet');
    git(dir, 'remote', 'add', 'origin', url);
    git(dir, 'fetch', '--quiet', '--depth', '1', 'origin', entry.sha);
    git(dir, 'checkout', '--quiet', 'FETCH_HEAD');
    console.log(`fetched ${entry.repo} @ ${entry.sha.slice(0, 7)}`);
  } catch (err) {
    failures += 1;
    console.error(`failed  ${entry.repo}: ${err.stderr?.toString().trim() || err.message}`);
  }
}

if (update) {
  manifest.updated = new Date().toISOString().slice(0, 10);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
process.exitCode = failures ? 1 : 0;
