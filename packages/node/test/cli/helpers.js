// Shared test helpers (not a test file).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const BIN = fileURLToPath(new URL('../../bin/mas-office.js', import.meta.url));
export const REPO = fileURLToPath(new URL('../../../../', import.meta.url));

export const tmpDir = (prefix = 'mas-office-cli-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
export const write = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
};

/** Run the CLI in a child process. */
export function runCli(args, { input, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

/** Collect printed lines instead of writing to the console. */
export function capture() {
  const lines = [];
  const out = (line) => lines.push(String(line));
  return { lines, out, text: () => lines.join('\n') };
}
