import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaims, stripClaims, claimEvents, uncitedSentences } from '../../src/verify/claims.js';

const span = (r, c) => r.markdown.slice(c.start, c.end);

test('parses a claim with sources and strips the tags', () => {
  const md = 'Shortlist: <claim id="c1" src="currys-xm6,ebay-xm6">The XM6 is £279 at Currys.</claim> Done.';
  const r = parseClaims(md);
  assert.deepEqual(r.problems, []);
  assert.equal(r.markdown, 'Shortlist: The XM6 is £279 at Currys. Done.');
  assert.equal(r.claims.length, 1);
  const c = r.claims[0];
  assert.equal(c.claimId, 'c1');
  assert.deepEqual(c.sources, ['currys-xm6', 'ebay-xm6']);
  assert.equal(c.text, 'The XM6 is £279 at Currys.');
  assert.equal(span(r, c), 'The XM6 is £279 at Currys.');
});

test('attribute order, single quotes, unquoted values, case and missing src', () => {
  const r = parseClaims("<CLAIM src='a, b ,a' ID=c2>x one</Claim> <claim\n id=c3\n>two</claim >");
  assert.deepEqual(r.problems, []);
  assert.equal(r.markdown, 'x one two');
  assert.deepEqual(r.claims.map((c) => [c.claimId, c.sources]), [['c2', ['a', 'b']], ['c3', []]]);
});

test('offsets index the stripped markdown and skip surrounding whitespace', () => {
  const md = '# T\n\n<claim id="a">  first  </claim>\n| x | <claim id="b" src="s">£5</claim> |';
  const r = parseClaims(md);
  assert.equal(r.markdown, '# T\n\n  first  \n| x | £5 |');
  assert.deepEqual(r.claims.map((c) => span(r, c)), ['first', '£5']);
  assert.equal(r.claims[0].text, 'first');
});

test('a quoted attribute may contain ">"', () => {
  const r = parseClaims('<claim id="c1" note="a > b" src="s1">kept</claim>');
  assert.deepEqual(r.problems, []);
  assert.equal(r.markdown, 'kept');
  assert.deepEqual(r.claims[0].sources, ['s1']);
});

test('not a claim tag: <claims>, <claimant>', () => {
  const md = '<claims id="x">a</claims> <claimant>b';
  const r = parseClaims(md);
  assert.equal(r.markdown, md);
  assert.deepEqual(r.claims, []);
  assert.deepEqual(r.problems, []);
});

test('unclosed claim stays as text', () => {
  const md = 'a <claim id="c1">never closed';
  const r = parseClaims(md);
  assert.equal(r.markdown, md);
  assert.deepEqual(r.claims, []);
  assert.match(r.problems[0].message, /never closed/);
  assert.equal(r.problems[0].offset, 2);
});

test('nested claims: the whole group stays as text, later claims still parse', () => {
  const md = '<claim id="o">out <claim id="i">in</claim> more</claim> <claim id="c9">ok</claim>';
  const r = parseClaims(md);
  assert.equal(r.markdown, '<claim id="o">out <claim id="i">in</claim> more</claim> ok');
  assert.deepEqual(r.claims.map((c) => c.claimId), ['c9']);
  assert.match(r.problems[0].message, /nested/);
});

test('stray close, missing id, bad id, empty claim, self-closing, unclosed quote', () => {
  const cases = [
    ['x </claim> y', /without an opening/],
    ['<claim src="s">no id</claim>', /without an id/],
    ['<claim id="bad id!">t</claim>', /unexpected|not valid/],
    ['<claim id="has space">t</claim>', /not valid/],
    ['<claim id="c1">   </claim>', /empty/],
    ['<claim id="c1"/>', /self-closing/],
    ['<claim id="c1>text</claim>', /unclosed quote/],
    ['<claim id="c1" id="c2">t</claim>', /duplicate attribute/],
  ];
  for (const [md, re] of cases) {
    const r = parseClaims(md);
    assert.equal(r.claims.length, 0, md);
    assert.ok(r.problems.some((p) => re.test(p.message)), `${md}: ${JSON.stringify(r.problems)}`);
    // Malformed tags are never silently deleted: every character is kept except valid tag pairs.
    assert.ok(r.markdown.length >= md.length - 30, md);
  }
});

test('duplicate ids: tags stripped, only the first claim kept', () => {
  const r = parseClaims('<claim id="c1">one</claim> <claim id="c1">two</claim>');
  assert.equal(r.markdown, 'one two');
  assert.deepEqual(r.claims.map((c) => c.text), ['one']);
  assert.match(r.problems[0].message, /duplicate claim id/);
});

test('invalid source ids are dropped and reported', () => {
  const r = parseClaims('<claim id="c1" src="ok-1,../etc/passwd,,also_ok">t</claim>');
  assert.deepEqual(r.claims[0].sources, ['ok-1', 'also_ok']);
  assert.match(r.problems[0].message, /not a valid source id/);
});

test('non-string input is treated as empty', () => {
  assert.deepEqual(parseClaims(null), { claims: [], markdown: '', problems: [] });
  assert.equal(stripClaims(undefined), '');
});

test('stripClaims keeps malformed tags', () => {
  assert.equal(stripClaims('<claim id="a">x</claim> <claim>y'), 'x <claim>y');
});

test('hostile inputs stay linear: 1 MB of open tags, unclosed quotes, opens without closes', () => {
  const inputs = [
    '<claim '.repeat(150_000),
    '<claim id="'.repeat(100_000),
    '<claim id="a">'.repeat(80_000),
    '</claim>'.repeat(130_000),
    `<claim id="${'a'.repeat(1_000_000)}`,
    `<claim id="c1">${'x'.repeat(1_000_000)}`,
    '<claim id="c1">x</claim>'.repeat(45_000),
  ];
  for (const md of inputs) {
    const t0 = process.hrtime.bigint();
    const r = parseClaims(md);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 1500, `took ${ms.toFixed(0)} ms for ${md.slice(0, 20)}…`);
    assert.ok(r.problems.length <= 101);
    assert.ok(typeof r.markdown === 'string');
  }
});

test('claimEvents builds claim.added events', () => {
  const { claims } = parseClaims('<claim id="c1" src="s1">a</claim><claim id="c2">b</claim>');
  assert.deepEqual(claimEvents(claims, { agentId: 'lead', serves: { c1: 'R1' } }), [
    { type: 'claim.added', agentId: 'lead', data: { claimId: 'c1', text: 'a', sources: ['s1'], serves: 'R1' } },
    { type: 'claim.added', agentId: 'lead', data: { claimId: 'c2', text: 'b', sources: [] } },
  ]);
  assert.deepEqual(claimEvents(claims, { serves: 'R2' })[1], { type: 'claim.added', data: { claimId: 'c2', text: 'b', sources: [], serves: 'R2' } });
  assert.deepEqual(claimEvents(null), []);
});

test('uncitedSentences finds numbers, prices and dates outside claim tags', () => {
  const md = [
    '## Prices in 2026',
    '<claim id="c1" src="s">The XM6 is £279 at Currys.</claim> The XM5 is £229 at John Lewis.',
    'We recommend buying soon. It opened on 5 May.',
    '| Shop | Price |',
    '|---|---|',
    '| Argos | £319 |',
    '| Currys | <claim id="c2" src="s">£279</claim> |',
    'See [the 2025 review](https://example.com/2025/review) for more.',
    '```',
    'code 123',
    '```',
  ].join('\n');
  const found = uncitedSentences(md);
  assert.deepEqual(found.map((f) => [f.text, f.reason]), [
    ['The XM5 is £229 at John Lewis.', 'price'],
    ['It opened on 5 May.', 'date'],
    ['| Argos | £319 |', 'price'],
    ['See [the 2025 review](https://example.com/2025/review) for more.', 'date'],
  ]);
  const stripped = parseClaims(md).markdown;
  for (const f of found) assert.equal(stripped.slice(f.start, f.end).trim(), f.text);
});

test('uncitedSentences on hostile input is fast and bounded', () => {
  const t0 = Date.now();
  const found = uncitedSentences('['.repeat(500_000) + '1. '.repeat(100_000));
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(found.length <= 50);
});
