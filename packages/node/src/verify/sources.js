// Source cards: `<project>/sources/<slug>.md` in the kit format (`kit/harness/formats.md`):
//
//   ---
//   title: Sony WH-1000XM6 — Currys
//   url: https://www.currys.co.uk/...
//   accessed: 2026-11-05
//   evidence: A            # A can be bought/run · B study with data · C demo or marketing · D opinion
//   found by: new-price-finder
//   ---
//   > "£279.00 · Free delivery in 2–3 days"   (verbatim from the page)
//
//   Relevance: R1 — lowest new price found at a major retailer.
//
// Reading is tolerant: keys are case-insensitive (`found by`, `found_by`, `foundBy`), values may be
// quoted, ` # comments` are dropped. Without front matter the title is the first heading and the URL
// the first `url:` line or bare http(s) URL. Files larger than 256 KiB, symbolic links and files
// whose name is not a safe slug are skipped.

import fs from 'node:fs';
import path from 'node:path';
import { looksBlocked, looksLikeUnextractedPdf } from './url-health.js';

export const MAX_CARD_BYTES = 256 * 1024;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const GRADE = /^[A-D]$/;

const KEY_ALIASES = { 'found by': 'foundBy', found_by: 'foundBy', foundby: 'foundBy', grade: 'evidence' };

function unquote(v) {
  const s = v.trim();
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) return s.slice(1, -1).trim();
  return s;
}

/**
 * Parse one card's text.
 * @param {string} id the file name without `.md`
 * @param {string} text
 * @returns {{id: string, title: string|null, url: string|null, evidence: string|null, foundBy: string|null,
 *   accessed: string|null, quote: string|null, body: string, problems: string[]}}
 */
export function parseSourceCard(id, text) {
  const s = String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const card = { id, title: null, url: null, evidence: null, foundBy: null, accessed: null, quote: null, body: '', problems: [] };
  const fields = {};
  let body = s;
  const fm = /^---[ \t]*\n/.exec(s);
  const close = fm ? s.indexOf('\n---', fm[0].length - 1) : -1;
  if (fm && close !== -1) {
    for (const line of s.slice(fm[0].length, close).split('\n')) {
      const colon = line.indexOf(':');
      if (colon <= 0) continue;
      const rawKey = line.slice(0, colon).trim().toLowerCase();
      const key = KEY_ALIASES[rawKey] ?? rawKey;
      let raw = line.slice(colon + 1);
      const comment = raw.search(/\s#/);
      if (comment !== -1) raw = raw.slice(0, comment);
      const value = unquote(raw);
      if (value && !Object.hasOwn(fields, key)) fields[key] = value;
    }
    const after = s.indexOf('\n', close + 1);
    body = after === -1 ? '' : s.slice(after + 1);
  } else {
    card.problems.push('no front matter (--- … ---)');
    const heading = /^#{1,6}[ \t]+(.+)$/m.exec(s);
    if (heading) fields.title = heading[1].trim();
    const urlLine = /^url:[ \t]*(\S+)/im.exec(s) || /https?:\/\/[^\s)>\]"']+/.exec(s);
    if (urlLine) fields.url = urlLine[1] ?? urlLine[0];
  }
  card.title = fields.title ?? null;
  card.url = fields.url ?? null;
  card.foundBy = fields.foundBy ?? null;
  card.accessed = fields.accessed ?? null;
  if (fields.evidence !== undefined) {
    const grade = fields.evidence.trim();
    card.evidence = /^[A-Da-d]$/.test(grade) ? grade.toUpperCase() : grade;
  }
  card.body = body.trim();
  const quote = [];
  for (const line of card.body.split('\n')) {
    if (/^\s*>/.test(line)) quote.push(line.replace(/^\s*>\s?/, ''));
    else if (quote.length) break;
  }
  card.quote = quote.length ? quote.join('\n').trim() || null : null;
  return card;
}

/**
 * Read every source card of a project, sorted by id.
 * @param {string} projectDir
 * @returns {{id: string, title: string|null, url: string|null, evidence: string|null, foundBy: string|null,
 *   accessed: string|null, quote: string|null, body: string, problems: string[]}[]}
 *   `evidence` is the A–D grade, or the raw text when it is not one (see `gradeProblems`).
 */
export function readSourceCards(projectDir) {
  const dir = path.join(projectDir, 'sources');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const cards = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.md')) continue;
    const id = name.slice(0, -3);
    if (!SLUG.test(id)) continue;
    const file = path.join(dir, name);
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue; // symbolic links and folders are not cards
    if (stat.size > MAX_CARD_BYTES) {
      cards.push({ ...parseSourceCard(id, ''), problems: [`file is larger than ${MAX_CARD_BYTES / 1024} KiB; not read`] });
      continue;
    }
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    cards.push(parseSourceCard(id, text));
  }
  return cards;
}

/**
 * Deterministic sanity checks of a card's grade and evidence (plain English, empty when fine).
 * @param {{evidence?: string|null, url?: string|null, quote?: string|null}} card
 */
export function gradeProblems(card) {
  const problems = [];
  const c = card && typeof card === 'object' ? card : {};
  const grade = typeof c.evidence === 'string' ? c.evidence.trim() : '';
  if (!grade) problems.push('no evidence grade (A–D)');
  else if (!GRADE.test(grade)) problems.push(`evidence grade ${JSON.stringify(grade.slice(0, 40))} is not A, B, C or D`);
  const url = typeof c.url === 'string' ? c.url.trim() : '';
  if (!url && GRADE.test(grade) && grade !== 'D') problems.push(`grade ${grade} needs a URL`);
  if (url && !/^https?:\/\//i.test(url)) problems.push('the URL is not an http(s) link');
  const quote = typeof c.quote === 'string' ? c.quote.trim() : '';
  if (!quote) problems.push('no verbatim quote (a "> …" line)');
  else if (looksBlocked(quote)) problems.push('the quote looks like a block or captcha page, not the source');
  else if (looksLikeUnextractedPdf(quote)) problems.push('the quote looks like raw PDF bytes, not text from the document');
  return problems;
}
