// `mas-office verify <project-dir> [--no-network] [--json]`: parse the claim tags of the project's
// result, check the URL of every source card, append `claim.added` / `evidence.checked` events to the
// project's log and print a summary (counts, every link that is not live, untagged statements).
//
// Events are appended only when the project already has `mas/events.jsonl`: snapshots are rebuilt from
// the log after appending, and a kit project written by hand (no log) would lose its files otherwise.

import fs from 'node:fs';
import path from 'node:path';
import {
  ProjectLog, EventError, eventErrors, isValidFolder, parseLog, reduce, readDocument, writeSnapshots, SPEC_VERSION,
} from '../../sdk/index.js';
import {
  parseClaims, claimEvents, uncitedSentences, checkSources, evidenceEvents, summarize, shouldFlag,
  readSourceCards, gradeProblems,
} from '../../verify/index.js';
import { parseArgs, UsageError } from '../args.js';

const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHOW = 10;
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The result's markdown and its listed sources: `outputs/result.json` (or `.js`), else `outputs/result.md`. */
function readResult(dir) {
  const doc = readDocument(path.join(dir, 'outputs', 'result'));
  if (isObject(doc) && typeof doc.markdown === 'string') {
    return { markdown: doc.markdown, sources: Array.isArray(doc.sources) ? doc.sources.filter(isObject) : [] };
  }
  try {
    return { markdown: fs.readFileSync(path.join(dir, 'outputs', 'result.md'), 'utf8'), sources: [] };
  } catch {
    return null;
  }
}

/** Append to a log outside a workspace (no sibling `home/`): stamp, validate, append, rebuild snapshots. */
function appendStandalone(dir, file, events) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n').filter((l) => l.trim());
  let seq = parseLog(lines).reduce((max, e) => Math.max(max, e.seq), 0);
  const ts = new Date().toISOString();
  const stamped = events.map((e) => ({ v: SPEC_VERSION, seq: ++seq, ts, ...e }));
  const invalid = stamped.map((e, index) => ({ index, errors: eventErrors(e) })).filter((x) => x.errors.length);
  if (invalid.length) throw new EventError(invalid);
  const added = stamped.map((e) => JSON.stringify(e));
  fs.appendFileSync(file, (text && !text.endsWith('\n') ? '\n' : '') + added.join('\n') + '\n');
  writeSnapshots(dir, reduce([...lines, ...added]));
}

function appendEvents(dir, events) {
  const file = path.join(dir, 'mas', 'events.jsonl');
  if (!fs.existsSync(file)) return { appended: 0, file, reason: 'no event log' };
  if (!events.length) return { appended: 0, file };
  const folder = path.basename(dir);
  const workspace = path.dirname(dir);
  if (isValidFolder(folder) && fs.existsSync(path.join(workspace, 'home'))) {
    new ProjectLog(workspace, folder).append(events);
  } else {
    appendStandalone(dir, file, events);
  }
  return { appended: events.length, file };
}

const more = (list) => (list.length > SHOW ? [`    … and ${list.length - SHOW} more`] : []);
const short = (s, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * @param {string[]} argv
 * @param {{out?: (line: string) => void, fetch?: Function, lookup?: Function}} [io] `fetch`/`lookup` for tests
 * @returns {Promise<number>} exit code
 */
export async function verifyCommand(argv, { out = console.log, fetch, lookup } = {}) {
  const { positionals, options } = parseArgs(argv, { network: 'boolean', json: 'boolean' });
  if (!positionals[0]) throw new UsageError('verify needs a project folder: mas-office verify <project-dir> [--no-network] [--json]');
  const dir = path.resolve(positionals[0]);
  const network = options.network !== false;
  const result = readResult(dir);
  if (!result) {
    out(`✗ No result at ${path.join(dir, 'outputs', 'result.json')} (or result.js / result.md)`);
    return 1;
  }

  const parsed = parseClaims(result.markdown);
  const cards = readSourceCards(dir);
  const sources = cards.map((c) => ({ id: c.id, url: c.url, evidence: c.evidence, quote: c.quote }));
  const known = new Set(sources.map((s) => s.id));
  for (const s of result.sources) {
    if (typeof s.id === 'string' && SLUG.test(s.id) && !known.has(s.id)) {
      sources.push({ id: s.id, url: typeof s.url === 'string' ? s.url : null, evidence: s.evidence ?? null, quote: null });
      known.add(s.id);
    }
  }
  const missing = [];
  for (const c of parsed.claims) for (const id of c.sources) if (!known.has(id)) missing.push({ claimId: c.claimId, sourceId: id });

  const evidence = await checkSources(sources, { network, fetch, lookup });
  const events = [...claimEvents(parsed.claims, { agentId: 'lead' }), ...evidenceEvents(evidence)];
  const log = appendEvents(dir, events);

  const summary = summarize(parsed.claims, evidence);
  const structure = readDocument(path.join(dir, 'mas', 'structure'));
  const flagWhen = isObject(structure) && isObject(structure.verify) && isObject(structure.verify.flagWhen) ? structure.verify.flagWhen : undefined;
  const flag = shouldFlag(summary, flagWhen);
  const untagged = uncitedSentences(result.markdown);
  const cardProblems = cards.map((c) => ({ sourceId: c.id, problems: [...c.problems, ...gradeProblems(c)] })).filter((x) => x.problems.length);

  if (options.json) {
    out(JSON.stringify({
      project: dir, network, claims: parsed.claims, claimProblems: parsed.problems, missingSources: missing, evidence,
      summary, flag, untagged, cardProblems, appended: log.appended,
    }, null, 2));
    return 0;
  }

  out(`Verified ${dir}`);
  out(`  Claims: ${summary.claims} tagged${parsed.claims.length ? `, citing ${new Set(parsed.claims.flatMap((c) => c.sources)).size} source(s)` : ''}`);
  if (network) {
    const unknown = evidence.filter((e) => e.urlHealth === 'unknown').length;
    out(`  Sources: ${summary.sources} (live ${summary.live}, stale ${summary.stale}, hallucinated ${summary.hallucinated}, blocked ${summary.blocked}, unknown ${unknown})`);
  } else {
    out(`  Sources: ${summary.sources} (links not checked: --no-network)`);
  }
  const bad = evidence.filter((e) => e.url && e.urlHealth && e.urlHealth !== 'live');
  for (const e of bad.slice(0, SHOW)) {
    const extra = [e.httpStatus ? `HTTP ${e.httpStatus}` : null, e.note, e.archivedUrl ? `archived: ${e.archivedUrl}` : null].filter(Boolean).join('; ');
    out(`  ✗ ${e.urlHealth.padEnd(12)} ${e.sourceId}  ${short(e.url, 100)}${extra ? `  (${extra})` : ''}`);
  }
  more(bad).forEach((l) => out(l));
  if (missing.length) {
    out(`  Claims citing a source that has no card (${missing.length}):`);
    for (const m of missing.slice(0, SHOW)) out(`    ${m.claimId} → ${m.sourceId}`);
    more(missing).forEach((l) => out(l));
  }
  if (parsed.problems.length) {
    out(`  Claim tag problems (${parsed.problems.length}):`);
    for (const p of parsed.problems.slice(0, SHOW)) out(`    at ${p.offset}: ${p.message}`);
    more(parsed.problems).forEach((l) => out(l));
  }
  if (untagged.length) {
    out(`  Statements with numbers, dates or superlatives that are not tagged as claims (${untagged.length}):`);
    for (const u of untagged.slice(0, SHOW)) out(`    - ${short(u.text.replace(/\s+/g, ' '))}  [${u.reason}]`);
    more(untagged).forEach((l) => out(l));
  }
  if (cardProblems.length) {
    out(`  Source cards with problems (${cardProblems.length}):`);
    for (const c of cardProblems.slice(0, SHOW)) out(`    ${c.sourceId}: ${c.problems.join('; ')}`);
    more(cardProblems).forEach((l) => out(l));
  }
  if (flag.flag) {
    out('  Needs a person:');
    for (const r of flag.reasons) out(`    - ${r}`);
  }
  if (log.reason) out(`  No event log at ${log.file}; nothing appended.`);
  else out(`  Appended ${log.appended} event(s) to ${log.file}.`);
  return 0;
}
