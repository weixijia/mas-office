#!/usr/bin/env node
// MAS Office kit — PreToolUse guard for the role browser (mas-browser).
// The browser server writes snapshot and screenshot files itself, outside Claude Code's file permissions,
// so a `filePath` could overwrite files anywhere in this folder. Snapshots and screenshots must come back
// to the agent instead. Exit code 2 blocks the call and tells the agent why. Any other input passes.
import fs from 'node:fs';

let input = {};
try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
const name = String(input.tool_name || '');
const args = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
if (/^mcp__mas-browser__/.test(name) && args.filePath != null && args.filePath !== '') {
  process.stderr.write('mas-browser: saving to a file is not allowed in this kit. Call the tool again without filePath; save what you need with your file tools inside your MAS folder.\n');
  process.exit(2);
}
process.exit(0);
