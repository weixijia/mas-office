import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSourceCards, parseSourceCard, gradeProblems, MAX_CARD_BYTES } from '../../src/verify/sources.js';

const EXAMPLES = fileURLToPath(new URL('../../../../examples/', import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mas-office-verify-'));

test('reads the example source cards', () => {
  const cards = readSourceCards(path.join(EXAMPLES, 'thesis-feasibility'));
  assert.deepEqual(cards.map((c) => c.id), ['airbnb-indoor-camera-policy', 'gdpr-article-9-biometrics', 'mmgait-open-set', 'ti-iwr6843-gait']);
  const gdpr = cards[1];
  assert.equal(gdpr.title, 'GDPR Article 9 - Processing of Special Categories of Personal Data');
  assert.equal(gdpr.url, 'https://gdpr-info.eu/art-9-gdpr/');
  assert.equal(gdpr.evidence, 'A');
  assert.equal(gdpr.foundBy, 'privacy-scout');
  assert.equal(gdpr.accessed, '2026-11-05');
  assert.match(gdpr.quote, /^"Processing of biometric data/);
  assert.match(gdpr.body, /Relevance: R3/);
  assert.deepEqual(gdpr.problems, []);
  for (const example of ['price-compare', 'trip-planning', 'thesis-feasibility']) {
    const all = readSourceCards(path.join(EXAMPLES, example));
    assert.ok(all.length >= 4, example);
    for (const c of all) {
      assert.ok(/^[A-D]$/.test(c.evidence), `${example}/${c.id}: ${c.evidence}`);
      assert.ok(/^https?:\/\//.test(c.url), `${example}/${c.id}`);
    }
  }
});

test('the grade comment in the kit format is dropped, URL fragments are kept', () => {
  const card = parseSourceCard('x', '---\ntitle: "Quoted: title"\nurl: https://a.example/p#frag\nevidence: b            # A can be bought/run · B study\nFound_By: finder\n---\n> "one"\n> "two"\n\nRelevance: R1\n> later quote\n');
  assert.equal(card.title, 'Quoted: title');
  assert.equal(card.url, 'https://a.example/p#frag');
  assert.equal(card.evidence, 'B');
  assert.equal(card.foundBy, 'finder');
  assert.equal(card.quote, '"one"\n"two"');
});

test('tolerant without front matter; CRLF and BOM', () => {
  const card = parseSourceCard('y', '﻿# A page title\r\n\r\nSee https://b.example/x for details.\r\n> "quote"\r\n');
  assert.equal(card.title, 'A page title');
  assert.equal(card.url, 'https://b.example/x');
  assert.equal(card.quote, '"quote"');
  assert.deepEqual(card.problems, ['no front matter (--- … ---)']);
  assert.equal(parseSourceCard('z', '').quote, null);
});

test('skips unsafe names, symlinks and folders; marks oversize files', () => {
  const dir = tmp();
  const src = path.join(dir, 'sources');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'good-card.md'), '---\nurl: https://a.example/\nevidence: A\n---\n> "x"\n');
  fs.writeFileSync(path.join(src, '.hidden.md'), 'x');
  fs.writeFileSync(path.join(src, 'has space.md'), 'x');
  fs.writeFileSync(path.join(src, 'notes.txt'), 'x');
  fs.mkdirSync(path.join(src, 'folder.md'));
  fs.writeFileSync(path.join(dir, 'outside.md'), '---\nurl: https://secret/\n---\n');
  fs.symlinkSync(path.join(dir, 'outside.md'), path.join(src, 'link.md'));
  fs.writeFileSync(path.join(src, 'huge.md'), 'x'.repeat(MAX_CARD_BYTES + 1));
  const cards = readSourceCards(dir);
  assert.deepEqual(cards.map((c) => c.id), ['good-card', 'huge']);
  assert.deepEqual(cards[1].problems, ['file is larger than 256 KiB; not read']);
  assert.deepEqual(readSourceCards(path.join(dir, 'missing')), []);
});

test('gradeProblems', () => {
  assert.deepEqual(gradeProblems({ evidence: 'A', url: 'https://a/', quote: '"x"' }), []);
  assert.deepEqual(gradeProblems({ evidence: 'D', url: null, quote: '"x"' }), []);
  assert.deepEqual(gradeProblems({}), ['no evidence grade (A–D)', 'no verbatim quote (a "> …" line)']);
  assert.deepEqual(gradeProblems({ evidence: 'E', url: 'ftp://x', quote: 'q' }), ['evidence grade "E" is not A, B, C or D', 'the URL is not an http(s) link']);
  assert.deepEqual(gradeProblems({ evidence: 'B', quote: 'q' }), ['grade B needs a URL']);
  assert.deepEqual(gradeProblems({ evidence: 'A', url: 'https://a/', quote: 'Attention Required! | Cloudflare' }), ['the quote looks like a block or captcha page, not the source']);
  assert.deepEqual(gradeProblems({ evidence: 'A', url: 'https://a/', quote: '%PDF-1.4 obj' }), ['the quote looks like raw PDF bytes, not text from the document']);
  assert.deepEqual(gradeProblems(null).length, 2);
});
