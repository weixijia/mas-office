// Reviewer verdicts (protocol 0.2 `review.verdict`, `verdict.recorded`), cross-checker merging,
// flag thresholds and the verification summary (RFC 0001 §2.4, §2.5, §4.3 claim status, §4.4 summary).
//
// The lane merge follows the dedupe-by-key idea of gastownhall/gascity internal/reviewquorum/finalize.go
// (MIT, idea only: findings keyed and merged across lanes, each keeping the list of lanes that reported
// it); no code was copied.

export const REVIEW_VERDICTS = ['accept', 'revise', 'escalate'];
export const CLAIM_STATUSES = ['supported', 'partial', 'contradicted', 'unknown', 'not-checkworthy'];
export const RELATIONSHIPS = ['supports', 'refutes', 'irrelevant'];
const URL_HEALTH = ['live', 'stale', 'hallucinated', 'blocked', 'unknown'];
export const DEFAULT_FLAG_WHEN = Object.freeze({ contradicted: 1, unknownShare: 0.34, hallucinated: 1 });

const MAX_INPUT = 2 * 1024 * 1024;
const MAX_ITEMS = 500;
const NOTE_MAX = 1000;
const MAX_PROBLEMS = 100;
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CLAIM_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, NOTE_MAX) : undefined);
const token = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/** Fenced code blocks (``` or ~~~), in order: {info, body}. Unclosed fences run to the end. */
function fencedBlocks(s) {
  const blocks = [];
  let open = null;
  let pos = 0;
  while (pos <= s.length) {
    let end = s.indexOf('\n', pos);
    if (end === -1) end = s.length;
    const line = s.slice(pos, end);
    const m = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/.exec(line);
    if (open) {
      if (m && m[1][0] === open.fence[0] && m[1].length >= open.fence.length && !m[2]) {
        blocks.push({ info: open.info, body: s.slice(open.start, pos) });
        open = null;
      }
    } else if (m) {
      open = { fence: m[1], info: m[2].toLowerCase(), start: end + 1 };
    }
    pos = end + 1;
  }
  if (open) blocks.push({ info: open.info, body: s.slice(Math.min(open.start, s.length)) });
  return blocks;
}

/** End index (exclusive) of the balanced JSON object starting at `start`, or -1. String-aware, linear. */
function objectEnd(s, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (inString) {
      if (c === 92) i += 1;
      else if (c === 34) inString = false;
    } else if (c === 34) inString = true;
    else if (c === 123 || c === 91) depth += 1;
    else if (c === 125 || c === 93) {
      depth -= 1;
      if (depth === 0) return i + 1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/** Candidate JSON texts, most preferred first: last fenced json block first, then bare objects from the end. */
function* candidates(s) {
  const blocks = fencedBlocks(s).filter((b) => b.info === 'json' || b.info === 'jsonc' || b.info === '');
  for (let k = blocks.length - 1; k >= 0; k -= 1) {
    const body = blocks[k].body.trim();
    if (body.startsWith('{')) yield body;
  }
  // Bare objects: try the last few `{` that start a line, scanning forward from each (linear per try).
  let tries = 0;
  let from = s.length;
  while (tries < 5 && from > 0) {
    const brace = s.lastIndexOf('{', from - 1);
    if (brace === -1) break;
    from = brace;
    let k = brace - 1;
    while (k >= 0 && (s[k] === ' ' || s[k] === '\t' || s[k] === '\r')) k -= 1;
    if (k >= 0 && s[k] !== '\n') continue; // only objects that start a line
    tries += 1;
    const end = objectEnd(s, brace);
    if (end !== -1) yield s.slice(brace, end);
  }
}

/**
 * Parse the final JSON block of a reviewer's message:
 * `{"reviews": [{target, verdict, note?}], "claims": [{claimId, status, sourceId?, relationship?, note?, method?}]}`.
 * Takes the last fenced ```json block (or the last bare JSON object) that parses to an object with
 * `reviews` or `claims`. Invalid items are dropped and reported. Never throws.
 * @param {string} message
 * @returns {{reviews: {target: string, verdict: string, note?: string}[],
 *   claims: {claimId: string, status: string, sourceId?: string, relationship?: string, note?: string, method?: string}[],
 *   problems: string[]}}
 */
export function parseReviewBlock(message) {
  const result = { reviews: [], claims: [], problems: [] };
  const problem = (msg) => {
    if (result.problems.length < MAX_PROBLEMS) result.problems.push(msg);
  };
  try {
    let s = typeof message === 'string' ? message : '';
    if (s.length > MAX_INPUT) {
      s = s.slice(-MAX_INPUT);
      problem(`message longer than ${MAX_INPUT} characters; only its end was read`);
    }
    let block = null;
    for (const candidate of candidates(s)) {
      let value;
      try { value = JSON.parse(candidate); } catch { continue; }
      if (isObject(value) && (Array.isArray(value.reviews) || Array.isArray(value.claims))) {
        block = value;
        break;
      }
    }
    if (!block) {
      problem('no JSON block with "reviews" or "claims" found');
      return result;
    }
    const reviews = Array.isArray(block.reviews) ? block.reviews : [];
    const claims = Array.isArray(block.claims) ? block.claims : [];
    if (reviews.length > MAX_ITEMS) problem(`only the first ${MAX_ITEMS} reviews were read`);
    if (claims.length > MAX_ITEMS) problem(`only the first ${MAX_ITEMS} claims were read`);
    reviews.slice(0, MAX_ITEMS).forEach((r, i) => {
      if (!isObject(r)) return problem(`reviews[${i}] is not an object`);
      const target = typeof r.target === 'string' ? r.target.trim() : '';
      if (!AGENT_ID.test(target)) return problem(`reviews[${i}]: "target" must be a role id`);
      const verdict = token(r.verdict);
      if (!REVIEW_VERDICTS.includes(verdict)) return problem(`reviews[${i}]: "verdict" must be one of ${REVIEW_VERDICTS.join(', ')}`);
      const item = { target, verdict };
      const note = text(r.note);
      if (note) item.note = note;
      result.reviews.push(item);
      return undefined;
    });
    claims.slice(0, MAX_ITEMS).forEach((c, i) => {
      if (!isObject(c)) return problem(`claims[${i}] is not an object`);
      const rawId = c.claimId ?? c.id;
      const claimId = typeof rawId === 'string' ? rawId.trim() : '';
      if (!CLAIM_ID.test(claimId)) return problem(`claims[${i}]: "claimId" is missing or not valid`);
      const status = token(c.status);
      if (!CLAIM_STATUSES.includes(status)) return problem(`claims[${i}] (${claimId}): "status" must be one of ${CLAIM_STATUSES.join(', ')}`);
      const item = { claimId, status };
      if (c.sourceId !== undefined && c.sourceId !== null) {
        const sourceId = typeof c.sourceId === 'string' ? c.sourceId.trim() : '';
        if (SOURCE_ID.test(sourceId)) item.sourceId = sourceId;
        else problem(`claims[${i}] (${claimId}): "sourceId" is not a valid source id; ignored`);
      }
      if (c.relationship !== undefined && c.relationship !== null) {
        const rel = token(c.relationship);
        if (RELATIONSHIPS.includes(rel)) item.relationship = rel;
        else problem(`claims[${i}] (${claimId}): "relationship" must be one of ${RELATIONSHIPS.join(', ')}; ignored`);
      }
      const note = text(c.note);
      if (note) item.note = note;
      const method = text(c.method);
      if (method) item.method = method.slice(0, 64);
      result.claims.push(item);
      return undefined;
    });
  } catch (err) {
    problem(`could not read the review block: ${err?.message || err}`);
  }
  return result;
}

/**
 * `verdict.recorded` events for the claims of a parsed review block.
 * @param {{claims?: object[]}} parsed
 * @param {{backend?: string, agentId?: string}} [options] `agentId` is the checker (omitted when not given)
 */
export function verdictEvents(parsed, { backend, agentId } = {}) {
  const claims = parsed && Array.isArray(parsed.claims) ? parsed.claims : [];
  return claims.map((c) => {
    const data = { claimId: c.claimId, status: c.status };
    for (const key of ['sourceId', 'relationship', 'method', 'note']) if (typeof c[key] === 'string') data[key] = c[key];
    if (typeof backend === 'string' && backend) data.backend = backend;
    return agentId ? { type: 'verdict.recorded', agentId, data } : { type: 'verdict.recorded', data };
  });
}

/**
 * `review.verdict` events for the reviews of a parsed review block.
 * @param {{reviews?: object[]}} parsed
 * @param {{agentId?: string, round?: number}} [options] `agentId` is the reviewer
 */
export function reviewEvents(parsed, { agentId, round } = {}) {
  const reviews = parsed && Array.isArray(parsed.reviews) ? parsed.reviews : [];
  return reviews.map((r) => {
    const data = { target: r.target, verdict: r.verdict };
    if (Number.isInteger(round) && round >= 1) data.round = round;
    if (typeof r.note === 'string') data.note = r.note;
    return agentId ? { type: 'review.verdict', agentId, data } : { type: 'review.verdict', data };
  });
}

/**
 * The claim-status rule of RFC 0001 §4.3: not checkworthy → `not-checkworthy`; no verdicts →
 * `unchecked`; otherwise, over the last verdict of each distinct `by`: any `contradicted` →
 * `contradicted`; disagreement → `unknown`; else the shared status.
 * @param {{by?: string, status: string}[]} verdicts in order
 */
export function claimStatus(verdicts, checkworthy = true) {
  if (checkworthy === false) return 'not-checkworthy';
  const last = new Map();
  for (const v of Array.isArray(verdicts) ? verdicts : []) {
    if (v && CLAIM_STATUSES.includes(v.status)) last.set(v.by ?? null, v.status);
  }
  if (!last.size) return 'unchecked';
  const statuses = [...last.values()];
  if (statuses.includes('contradicted')) return 'contradicted';
  return statuses.every((x) => x === statuses[0]) ? statuses[0] : 'unknown';
}

/**
 * Merge the claim verdicts of several independent checker lanes (e.g. one Claude Code and one Codex
 * checker). Within a lane the last verdict per claim counts. Lanes without a usable `by` are skipped.
 * @param {{by: string, backend?: string, claims: {claimId: string, status: string, note?: string}[]}[]} lanes
 * @returns {{perClaim: Record<string, {status: string, agree: boolean, by: {by: string, backend: string|null, status: string, note: string|null}[]}>,
 *   disagreements: {claimId: string, status: string, verdicts: {by: string, status: string}[], note: string}[]}}
 */
export function mergeLanes(lanes) {
  const perClaim = {};
  const order = [];
  for (const lane of Array.isArray(lanes) ? lanes : []) {
    if (!isObject(lane) || typeof lane.by !== 'string' || !lane.by) continue;
    const backend = typeof lane.backend === 'string' ? lane.backend : null;
    for (const c of Array.isArray(lane.claims) ? lane.claims : []) {
      if (!isObject(c) || typeof c.claimId !== 'string' || !CLAIM_STATUSES.includes(c.status)) continue;
      if (!Object.hasOwn(perClaim, c.claimId)) {
        perClaim[c.claimId] = { status: 'unchecked', agree: true, by: [] };
        order.push(c.claimId);
      }
      const entry = { by: lane.by, backend, status: c.status, note: typeof c.note === 'string' ? c.note : null };
      const list = perClaim[c.claimId].by;
      const at = list.findIndex((x) => x.by === lane.by);
      if (at === -1) list.push(entry);
      else list[at] = entry;
    }
  }
  const disagreements = [];
  for (const claimId of order) {
    const item = perClaim[claimId];
    item.status = claimStatus(item.by);
    item.agree = item.by.every((x) => x.status === item.by[0].status);
    if (!item.agree) {
      disagreements.push({
        claimId,
        status: item.status,
        verdicts: item.by.map((x) => ({ by: x.by, status: x.status })),
        note: `Checkers disagree on ${claimId}: ${item.by.map((x) => `${x.by} says ${x.status}`).join(', ')}.`,
      });
    }
  }
  return { perClaim, disagreements };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * Decide whether the verification summary needs a human (`verify.flagWhen`).
 * Count thresholds flag at `>=` and are off when missing or not positive; `unknownShare` (0–1]
 * compares `unknown / checkworthy`. Without thresholds, `DEFAULT_FLAG_WHEN` applies.
 * @param {object} summary RFC §4.4 summary
 * @param {{contradicted?: number, unknownShare?: number, hallucinated?: number}} [thresholds]
 * @returns {{flag: boolean, reasons: string[]}} reasons are plain English for the inbox card
 */
export function shouldFlag(summary, thresholds) {
  const t = isObject(thresholds) ? thresholds : DEFAULT_FLAG_WHEN;
  const s = isObject(summary) ? summary : {};
  const num = (v) => (Number.isFinite(v) ? v : 0);
  const reasons = [];
  const contradicted = num(s.contradicted);
  if (Number.isFinite(t.contradicted) && t.contradicted > 0 && contradicted >= t.contradicted) {
    reasons.push(`${plural(contradicted, 'claim is', 'claims are')} contradicted by ${contradicted === 1 ? 'its source' : 'their sources'}.`);
  }
  const checkworthy = num(s.checkworthy);
  const unknown = num(s.unknown);
  if (Number.isFinite(t.unknownShare) && t.unknownShare > 0 && t.unknownShare <= 1 && checkworthy > 0 && unknown / checkworthy >= t.unknownShare) {
    reasons.push(`${unknown} of ${plural(checkworthy, 'checkable claim', 'checkable claims')} (${Math.round((unknown / checkworthy) * 100)}%) could not be confirmed.`);
  }
  const hallucinated = num(s.hallucinated);
  if (Number.isFinite(t.hallucinated) && t.hallucinated > 0 && hallucinated >= t.hallucinated) {
    reasons.push(`${plural(hallucinated, 'cited link does', 'cited links do')} not exist and ${hallucinated === 1 ? 'was' : 'were'} never archived.`);
  }
  return { flag: reasons.length > 0, reasons };
}

/**
 * The verification summary exactly as RFC 0001 §4.4, computed without the reducer.
 * A claim's status is its `status` when given, else derived from its `verdicts` (§4.3), else
 * `unchecked`. Evidence entries with the same `sourceId` are merged (later given fields win).
 * @param {{claimId: string, sources?: string[], checkworthy?: boolean, status?: string, verdicts?: object[]}[]} claims
 * @param {{sourceId: string, urlHealth?: string|null}[]} evidence
 */
export function summarize(claims, evidence) {
  const summary = {
    claims: 0, checkworthy: 0, supported: 0, partial: 0, contradicted: 0, unknown: 0, unchecked: 0,
    sources: 0, live: 0, stale: 0, hallucinated: 0, blocked: 0, uncited: 0,
  };
  const cited = new Set();
  for (const c of Array.isArray(claims) ? claims : []) {
    if (!isObject(c)) continue;
    summary.claims += 1;
    for (const id of Array.isArray(c.sources) ? c.sources : []) if (typeof id === 'string') cited.add(id);
    const checkworthy = c.checkworthy !== false;
    if (!checkworthy) continue;
    summary.checkworthy += 1;
    const status = typeof c.status === 'string' ? c.status : claimStatus(c.verdicts, true);
    if (['supported', 'partial', 'contradicted', 'unknown', 'unchecked'].includes(status)) summary[status] += 1;
  }
  const health = new Map();
  for (const e of Array.isArray(evidence) ? evidence : []) {
    if (!isObject(e) || typeof e.sourceId !== 'string') continue;
    const h = URL_HEALTH.includes(e.urlHealth) ? e.urlHealth : null;
    if (!health.has(e.sourceId) || h) health.set(e.sourceId, h);
  }
  summary.sources = health.size;
  for (const [sourceId, h] of health) {
    if (h === 'live' || h === 'stale' || h === 'hallucinated' || h === 'blocked') summary[h] += 1;
    if (!cited.has(sourceId)) summary.uncited += 1;
  }
  return summary;
}
