// Inline claim tags in a result's markdown (protocol 0.2, RFC 0001 §2.5):
//
//   <claim id="c3" src="currys-xm6,ebay-xm6">The XM6 costs £279 at Currys.</claim>
//
// Grammar, as accepted here:
// - The open tag is `<claim` (any ASCII case) followed by whitespace or `>`. Attributes are
//   `name="value"`, `name='value'`, `name=value` or a bare `name`, in any order. `id` is required
//   (letters, digits, `_ . : -`, max 64 chars); `src` is optional, a comma-separated list of source
//   ids. Unknown attributes are ignored. A quoted value may contain `>` but not `<`; an open tag
//   longer than 4096 characters is malformed. The close tag is `</claim>` (whitespace allowed before `>`).
// - Claims do not nest. A nested group, an unclosed claim, an empty claim, a claim without a valid
//   id and a stray `</claim>` are reported in `problems` and left in the markdown as plain text.
//   A malformed open tag (no closing `>`, bad attribute syntax) is plain text too.
// - A second claim with an id already used is stripped but not returned again (reported).
//
// The parser is a single forward scan. Every failed tag scan stops at the next `<`, so the work is
// linear in the input size whatever the input (unclosed quotes, megabytes of `<claim `, deep nesting).
// Tags inside markdown code spans or fences are not special: they are parsed like any other text.

const TAG_MAX = 4096;
const MAX_PROBLEMS = 100;
const CLAIM_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

const isWs = (c) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
const isNameStart = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isNameChar = (c) => isNameStart(c) || (c >= 48 && c <= 57) || c === 45 || c === 46 || c === 58;

/** Does `s` contain `word` (lower-case ASCII) at `i`, ignoring ASCII case? */
function matchesAt(s, i, word) {
  if (i + word.length > s.length) return false;
  for (let k = 0; k < word.length; k += 1) {
    let c = s.charCodeAt(i + k);
    if (c >= 65 && c <= 90) c += 32;
    if (c !== word.charCodeAt(k)) return false;
  }
  return true;
}

/**
 * Scan an open tag whose `<claim` starts at `i`.
 * @returns {{end: number, attrs: Record<string, string>} | {error: string} | null} null when it is
 *   not a claim tag at all (e.g. `<claims>`); `end` is the index just after `>`.
 */
function scanOpenTag(s, i) {
  let j = i + 6;
  if (j >= s.length) return { error: 'unfinished claim tag' };
  const first = s.charCodeAt(j);
  if (!isWs(first) && first !== 62) return null;
  const attrs = {};
  const limit = Math.min(s.length, i + TAG_MAX);
  for (;;) {
    while (j < limit && isWs(s.charCodeAt(j))) j += 1;
    if (j >= limit) return { error: 'claim tag is not closed with ">"' };
    const c = s.charCodeAt(j);
    if (c === 62) return { end: j + 1, attrs };
    if (c === 47) return { error: 'self-closing claim tag' };
    if (!isNameStart(c)) return { error: `unexpected ${JSON.stringify(s[j])} in claim tag` };
    const nameStart = j;
    while (j < limit && isNameChar(s.charCodeAt(j))) j += 1;
    const name = s.slice(nameStart, j).toLowerCase();
    while (j < limit && isWs(s.charCodeAt(j))) j += 1;
    let value = '';
    if (j < limit && s.charCodeAt(j) === 61) {
      j += 1;
      while (j < limit && isWs(s.charCodeAt(j))) j += 1;
      if (j >= limit) return { error: 'claim tag is not closed with ">"' };
      const q = s.charCodeAt(j);
      if (q === 34 || q === 39) {
        const valueStart = j + 1;
        j = valueStart;
        while (j < limit && s.charCodeAt(j) !== q && s.charCodeAt(j) !== 60) j += 1;
        if (j >= limit || s.charCodeAt(j) !== q) return { error: `unclosed quote in claim attribute "${name}"` };
        value = s.slice(valueStart, j);
        j += 1;
      } else {
        const valueStart = j;
        while (j < limit) {
          const v = s.charCodeAt(j);
          if (isWs(v) || v === 62) break;
          if (v === 60 || v === 34 || v === 39 || v === 61 || v === 96) return { error: `bad unquoted value for claim attribute "${name}"` };
          j += 1;
        }
        value = s.slice(valueStart, j);
      }
    }
    if (Object.hasOwn(attrs, name)) return { error: `duplicate attribute "${name}" in claim tag` };
    attrs[name] = value;
  }
}

/** Length of a close tag `</claim\s*>` at `i`, or 0. */
function closeTagLength(s, i) {
  if (!matchesAt(s, i, '</claim')) return 0;
  let j = i + 7;
  const limit = Math.min(s.length, i + 64);
  while (j < limit && isWs(s.charCodeAt(j))) j += 1;
  return j < s.length && s.charCodeAt(j) === 62 ? j + 1 - i : 0;
}

/** Split a `src` attribute into source ids. */
function splitSources(src, problems, offset) {
  const out = [];
  for (const part of src.split(',')) {
    const id = part.trim();
    if (!id) continue;
    if (!SOURCE_ID.test(id)) {
      problems(offset, `source id ${JSON.stringify(id.slice(0, 80))} is not a valid source id; ignored`);
      continue;
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Parse the claim tags of a result's markdown.
 * @param {string} markdown
 * @returns {{claims: {claimId: string, text: string, sources: string[], start: number, end: number}[],
 *   markdown: string, problems: {offset: number, message: string}[]}}
 *   `start`/`end` index the returned (stripped) markdown; `offset` indexes the input.
 */
export function parseClaims(markdown) {
  const s = typeof markdown === 'string' ? markdown : '';
  const claims = [];
  const problems = [];
  const seen = new Set();
  const report = (offset, message) => {
    if (problems.length < MAX_PROBLEMS) problems.push({ offset, message });
    else if (problems.length === MAX_PROBLEMS) problems.push({ offset, message: 'too many problems; stopped reporting' });
  };
  const out = [];
  let outLen = 0;
  const emit = (text) => {
    if (text) {
      out.push(text);
      outLen += text.length;
    }
  };

  let flushed = 0; // input before this index has been emitted
  let depth = 0; // open claim tags in the current group
  let group = null; // {start, innerStart, attrs, poisoned, reason}
  let i = 0;
  for (;;) {
    const lt = s.indexOf('<', i);
    if (lt === -1) break;
    i = lt + 1;
    if (matchesAt(s, lt, '<claim')) {
      const tag = scanOpenTag(s, lt);
      if (tag === null) continue;
      if (tag.error) {
        report(lt, `${tag.error}; left as text`);
        continue;
      }
      i = tag.end;
      depth += 1;
      if (depth === 1) {
        const id = tag.attrs.id;
        let reason = null;
        if (id === undefined || id === '') reason = 'claim tag without an id';
        else if (!CLAIM_ID.test(id)) reason = `claim id ${JSON.stringify(id.slice(0, 80))} is not valid (letters, digits, _ . : -, max 64)`;
        group = { start: lt, innerStart: tag.end, attrs: tag.attrs, poisoned: reason !== null, reason };
        if (reason) report(lt, `${reason}; left as text`);
      } else if (!group.poisoned) {
        group.poisoned = true;
        report(lt, 'nested claim tag; the enclosing claim is left as text');
      }
      continue;
    }
    const closeLen = closeTagLength(s, lt);
    if (!closeLen) continue;
    i = lt + closeLen;
    if (depth === 0) {
      report(lt, 'closing </claim> without an opening tag; left as text');
      continue;
    }
    depth -= 1;
    if (depth > 0) continue;
    const g = group;
    group = null;
    if (g.poisoned) continue; // the whole group stays as text: nothing flushed
    const inner = s.slice(g.innerStart, lt);
    const text = inner.replace(/\s+/g, ' ').trim();
    const id = g.attrs.id;
    if (!text) {
      report(g.start, `claim "${id}" is empty; left as text`);
      continue;
    }
    emit(s.slice(flushed, g.start));
    const lead = inner.length - inner.trimStart().length;
    const start = outLen + lead;
    const end = outLen + inner.trimEnd().length;
    emit(inner);
    flushed = i;
    if (seen.has(id)) {
      report(g.start, `duplicate claim id "${id}"; only the first is kept`);
      continue;
    }
    seen.add(id);
    const sources = g.attrs.src === undefined ? [] : splitSources(g.attrs.src, report, g.start);
    claims.push({ claimId: id, text, sources, start, end });
  }
  if (depth > 0) report(group.start, 'claim tag is never closed; left as text');
  emit(s.slice(flushed));
  return { claims, markdown: out.join(''), problems };
}

/** The markdown with every well-formed claim tag removed (malformed ones stay as text). */
export function stripClaims(markdown) {
  return parseClaims(markdown).markdown;
}

/**
 * `claim.added` events for parsed claims.
 * @param {{claimId: string, text: string, sources?: string[]}[]} claims
 * @param {{serves?: string | Record<string, string>, agentId?: string}} [options]
 *   `serves`: one requirement id for every claim, or a map claimId → requirement id.
 *   `agentId`: the author (usually `lead`); omitted when not given.
 */
export function claimEvents(claims, { serves, agentId } = {}) {
  return (Array.isArray(claims) ? claims : []).map((c) => {
    const data = { claimId: c.claimId, text: c.text, sources: Array.isArray(c.sources) ? [...c.sources] : [] };
    const s = typeof serves === 'string' ? serves : serves && typeof serves[c.claimId] === 'string' ? serves[c.claimId] : null;
    if (s) data.serves = s;
    return agentId ? { type: 'claim.added', agentId, data } : { type: 'claim.added', data };
  });
}

// ---------- untagged statements ----------

const MONTHS = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/i;
const SUPERLATIVE = /\b(cheapest|lowest|highest|fastest|largest|smallest|best|worst|only|first|most|least|always|never)\b/i;
const MAX_UNTAGGED = 50;
const UNIT_MAX = 2000; // longer units are judged (and returned) on their first 2000 characters

/** Why a piece of prose looks like a checkable statement, or null. */
function checkworthyReason(text) {
  if (/[£$€¥₹]\s?\d|\d\s?(€|eur|usd|gbp|p\b)/i.test(text)) return 'price';
  if (/\d\s?%|\bper ?cent\b/i.test(text)) return 'percentage';
  if (/\b(1[89]|20)\d\d\b/.test(text) || (MONTHS.test(text) && /\d/.test(text))) return 'date';
  if (/\d/.test(text)) return 'number';
  if (SUPERLATIVE.test(text)) return 'superlative';
  return null;
}

/** Prose of a line with markdown noise removed: links keep their text, URLs and list markers go. */
function proseOf(text) {
  return text
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/<?https?:\/\/[^\s)>]+>?/g, ' ')
    .replace(/^\s*(#{1,6}|[-*+]|\d+[.)]|>)\s+/, '')
    .replace(/\bR\d+\b/g, ' ') // requirement ids (R1, R2 …) are labels, not numbers
    .trim();
}

/**
 * A cheap heuristic list of statements outside any claim tag that look checkable: they hold a
 * number, price, percentage, date or superlative. The engine shows them to the Lead as "these
 * statements are not tagged".
 *
 * Limits: units are lines, split further at `.`, `!`, `?` followed by a space, so abbreviations
 * ("e.g. ") split sentences and a sentence wrapped over two lines counts as two. A table row is one
 * unit. Only the parts of a unit outside claim spans are tested, so a sentence half inside a claim
 * is judged on its other half. Headings, code fences, table separators and lines that are only a
 * link are skipped. Proper nouns without numbers are not detected; opinions that contain numbers
 * are reported. It is a nudge for the writer, not a verdict.
 * @param {string} markdown result markdown, with or without claim tags
 * @returns {{text: string, start: number, end: number, reason: string}[]} offsets into the stripped markdown
 */
export function uncitedSentences(markdown) {
  const { claims, markdown: md } = parseClaims(markdown);
  const spans = claims.map((c) => [c.start, c.end]).sort((a, b) => a[0] - b[0]);
  const found = [];
  let span = 0;
  let inFence = false;
  const consider = (start, end) => {
    if (found.length >= MAX_UNTAGGED) return;
    while (span < spans.length && spans[span][1] <= start) span += 1;
    let outside = '';
    let pos = start;
    for (let k = span; k < spans.length && spans[k][0] < end; k += 1) {
      if (spans[k][0] > pos) outside += md.slice(pos, spans[k][0]) + ' ';
      pos = Math.max(pos, spans[k][1]);
    }
    if (pos < end) outside += md.slice(pos, end);
    const prose = proseOf(outside.slice(0, UNIT_MAX));
    if (prose.length < 3) return;
    const reason = checkworthyReason(prose);
    if (reason) found.push({ text: md.slice(start, Math.min(end, start + UNIT_MAX)).trim(), start, end, reason });
  };
  let lineStart = 0;
  while (lineStart <= md.length && found.length < MAX_UNTAGGED) {
    let lineEnd = md.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = md.length;
    const line = md.slice(lineStart, lineEnd);
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) inFence = !inFence;
    else if (!inFence && trimmed && !/^#{1,6}\s/.test(trimmed) && !/^\|?[\s:|-]+\|?$/.test(trimmed)) {
      if (trimmed.startsWith('|')) {
        const next = md.indexOf('\n', lineEnd + 1);
        const nextLine = lineEnd < md.length ? md.slice(lineEnd + 1, next === -1 ? md.length : next).trim() : '';
        if (!/^\|?[\s:|-]+\|?$/.test(nextLine) || !nextLine.includes('-')) consider(lineStart, lineEnd); // skip header rows
      }
      else {
        let unitStart = lineStart;
        for (let k = lineStart; k < lineEnd; k += 1) {
          const c = md[k];
          if ((c === '.' || c === '!' || c === '?' || c === '。' || c === '！' || c === '？') && (k + 1 === lineEnd || md[k + 1] === ' ')) {
            consider(unitStart, k + 1);
            unitStart = k + 1;
          }
        }
        if (unitStart < lineEnd) consider(unitStart, lineEnd);
      }
    }
    lineStart = lineEnd + 1;
  }
  return found;
}
