// `mas-office validate [path]`: check snapshots and event logs against spec/schemas.

import fs from 'node:fs';
import path from 'node:path';
import { describeDocument, splitJsTwin, validateEvent } from '../../sdk/index.js';
import { validate } from '../schema.js';
import { schemasDir } from '../paths.js';
import { parseArgs } from '../args.js';

const PROJECT_DOCS = ['me/task', 'mas/structure', 'mas/state', 'mas/env', 'outputs/result'];
const SKIP_DIRS = new Set(['home', 'office', 'harness', 'node_modules']);

function loadSchemas() {
  const dir = schemasDir();
  if (!dir) throw new Error('Cannot find the JSON Schemas (spec/schemas). Reinstall mas-office.');
  const schemas = {};
  for (const name of ['projects', 'env', 'task', 'structure', 'state', 'status', 'result', 'event']) {
    schemas[name] = JSON.parse(fs.readFileSync(path.join(dir, `${name}.schema.json`), 'utf8'));
  }
  return schemas;
}

const formatErrors = (errors, prefix = '') => errors.map((e) => `${prefix}${e.path || '(root)'}: ${e.message}`);

/**
 * Read a `.js` twin without running it: it must have one of the two shapes of spec §1.1
 * and assign valid JSON. Twins are agent-written, so nothing in them is ever executed.
 */
function readTwin(file, doc) {
  const parts = splitJsTwin(fs.readFileSync(file, 'utf8'));
  const name = doc.statusId === undefined ? doc.global : `${doc.global}[${JSON.stringify(doc.statusId)}]`;
  if (!parts || (parts.statusId === undefined) !== (doc.statusId === undefined)) {
    throw new Error(`not a recognised data file: expected ${twinShape(doc)}`);
  }
  if (parts.global !== doc.global || parts.statusId !== doc.statusId) throw new Error(`does not set window.${name}`);
  try {
    return JSON.parse(parts.json);
  } catch (err) {
    throw new Error(`the value assigned to window.${name} is not valid JSON: ${err.message}`);
  }
}

const twinShape = (doc) => (doc.statusId === undefined
  ? `window.${doc.global} = {...};`
  : `window.${doc.global} = window.${doc.global} || {}; window.${doc.global}[${JSON.stringify(doc.statusId)}] = {...};`);

function readValue(file, doc) {
  return file.endsWith('.js') ? readTwin(file, doc) : JSON.parse(fs.readFileSync(file, 'utf8'));
}

function structureErrors(structure) {
  const roles = Array.isArray(structure?.roles) ? structure.roles : [];
  const ids = new Set(['lead', ...roles.map((r) => r?.id)]);
  const errors = [];
  roles.forEach((role, i) => {
    if (role && role.handsTo !== undefined && !ids.has(role.handsTo)) {
      errors.push(`/roles/${i}/handsTo: "${role.handsTo}" is not a role id or "lead"`);
    }
  });
  return errors;
}

/** Check one document given by its base path (no extension): `.json`, `.js` twin, and that they agree. */
function checkDocument(base, schemas) {
  const doc = describeDocument(base);
  const results = [];
  const values = {};
  for (const ext of ['.json', '.js']) {
    const file = base + ext;
    if (!fs.existsSync(file)) continue;
    const errors = [];
    try {
      const value = readValue(file, doc);
      values[ext] = value;
      errors.push(...formatErrors(validate(schemas[doc.kind], value)));
      if (doc.kind === 'structure') errors.push(...structureErrors(value));
    } catch (err) {
      errors.push(err?.name === 'SyntaxError' ? `not valid JSON: ${err.message}` : err.message);
    }
    results.push({ file, errors });
  }
  if (values['.json'] !== undefined && values['.js'] !== undefined
      && JSON.stringify(values['.json']) !== JSON.stringify(values['.js'])) {
    results[results.length - 1].errors.push(`differs from ${path.basename(base)}.json`);
  }
  return results;
}

function checkEvents(file, schema) {
  const errors = [];
  let previous = 0;
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    const at = `line ${i + 1}`;
    let event;
    try { event = JSON.parse(line); } catch { errors.push(`${at}: not valid JSON`); return; }
    const schemaErrors = validate(schema, event);
    if (schemaErrors.length) errors.push(...formatErrors(schemaErrors, `${at} `));
    else errors.push(...validateEvent(event).errors.map((m) => `${at}: ${m}`));
    if (Number.isSafeInteger(event?.seq)) {
      if (event.seq <= previous) errors.push(`${at}: seq ${event.seq} is not greater than the previous seq ${previous}`);
      previous = Math.max(previous, event.seq);
    }
  });
  return [{ file, errors }];
}

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isProject = (dir) => ['mas', 'me', 'outputs'].some((d) => isDir(path.join(dir, d)));
const bases = (dir) => (isDir(dir) ? fs.readdirSync(dir) : [])
  .filter((f) => /\.(json|js)$/.test(f) && !f.startsWith('.'))
  .map((f) => path.join(dir, f.replace(/\.(json|js)$/, '')));

function checkProject(dir, schemas) {
  const results = [];
  const docs = [...PROJECT_DOCS.map((d) => path.join(dir, d)), ...new Set(bases(path.join(dir, 'mas', 'status')))];
  for (const base of docs) results.push(...checkDocument(base, schemas));
  const log = path.join(dir, 'mas', 'events.jsonl');
  if (fs.existsSync(log)) results.push(...checkEvents(log, schemas.event));
  return results;
}

function checkWorkspace(dir, schemas) {
  const results = [
    ...checkDocument(path.join(dir, 'home', 'projects'), schemas),
    ...checkDocument(path.join(dir, 'home', 'env'), schemas),
  ];
  const projects = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
    .map((e) => path.join(dir, e.name))
    .filter(isProject)
    .sort();
  for (const project of projects) results.push(...checkProject(project, schemas));
  return results;
}

function checkFile(file, schemas) {
  if (path.basename(file) === 'events.jsonl') return checkEvents(file, schemas.event);
  const doc = describeDocument(file);
  if (!doc || !/\.(json|js)$/.test(file)) throw new Error(`Not a MAS Office document: ${file}`);
  const errors = [];
  try {
    errors.push(...formatErrors(validate(schemas[doc.kind], readValue(file, doc))));
  } catch (err) {
    errors.push(err.message);
  }
  return [{ file, errors }];
}

/** Validate a workspace, a project folder or one file. Returns the per-file results. */
export function validatePath(target, schemas = loadSchemas()) {
  if (!isDir(target)) return checkFile(target, schemas);
  return isProject(target) ? checkProject(target, schemas) : checkWorkspace(target, schemas);
}

export function validateCommand(argv, { out = console.log } = {}) {
  const { positionals } = parseArgs(argv, {});
  const target = path.resolve(positionals[0] ?? '.');
  if (!fs.existsSync(target)) {
    out(`✗ Not found: ${target}`);
    return 1;
  }
  const results = validatePath(target);
  if (!results.length) {
    out(`✗ No MAS Office files found in ${target}`);
    return 1;
  }
  for (const { file, errors } of results) {
    out(`${errors.length ? '✗' : '✓'} ${path.relative(process.cwd(), file) || file}`);
    for (const e of errors) out(`    ${e}`);
  }
  const bad = results.filter((r) => r.errors.length);
  const count = bad.reduce((n, r) => n + r.errors.length, 0);
  out(bad.length
    ? `\n${results.length} files checked: ${bad.length} with problems (${count} error${count === 1 ? '' : 's'}).`
    : `\n${results.length} files checked: all valid.`);
  return bad.length ? 1 : 0;
}
