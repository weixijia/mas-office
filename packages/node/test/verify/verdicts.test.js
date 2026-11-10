import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseReviewBlock, verdictEvents, reviewEvents, mergeLanes, shouldFlag, summarize, claimStatus, DEFAULT_FLAG_WHEN,
} from '../../src/verify/verdicts.js';
import { checkerRules, leadWriteupRules, finderRules } from '../../src/verify/prompts.js';
import { parseClaims } from '../../src/verify/claims.js';

const block = (obj, info = 'json') => `\`\`\`${info}\n${JSON.stringify(obj, null, 2)}\n\`\`\``;

test('parses the last fenced json block, tolerating prose around it', () => {
  const msg = [
    'I checked everything.',
    block({ reviews: [{ target: 'old', verdict: 'accept' }] }),
    'Some more prose with {braces} and "quotes".',
    block({
      reviews: [{ target: 'finder-a', verdict: 'Revise', note: '  fix c3  ' }],
      claims: [
        { claimId: 'c1', status: 'supported', sourceId: 'currys-xm6', relationship: 'SUPPORTS', method: 'fetched-page', note: '"£279.00"' },
        { id: 'c2', status: 'Contradicted' },
      ],
    }),
    'Thanks!',
  ].join('\n');
  const r = parseReviewBlock(msg);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.reviews, [{ target: 'finder-a', verdict: 'revise', note: 'fix c3' }]);
  assert.deepEqual(r.claims, [
    { claimId: 'c1', status: 'supported', sourceId: 'currys-xm6', relationship: 'supports', method: 'fetched-page', note: '"£279.00"' },
    { claimId: 'c2', status: 'contradicted' },
  ]);
});

test('falls back to the last bare JSON object; skips blocks without reviews/claims', () => {
  const msg = `Result:\n{"claims": [{"claimId": "c1", "status": "unknown"}]}\n\n\`\`\`json\n{"other": 1}\n\`\`\`\n`;
  assert.deepEqual(parseReviewBlock(msg).claims, [{ claimId: 'c1', status: 'unknown' }]);
  const unlabeled = '```\n{"reviews": [{"target": "a", "verdict": "accept"}]}\n```';
  assert.deepEqual(parseReviewBlock(unlabeled).reviews, [{ target: 'a', verdict: 'accept' }]);
  const unclosed = 'text\n```json\n{"reviews": [{"target": "a", "verdict": "escalate"}]}\n';
  assert.deepEqual(parseReviewBlock(unclosed).reviews, [{ target: 'a', verdict: 'escalate' }]);
});

test('invalid items and enum values are dropped and reported; never throws', () => {
  const r = parseReviewBlock(block({
    reviews: [{ target: 'Bad Id', verdict: 'accept' }, { target: 'a', verdict: 'maybe' }, 'x', { target: 'b', verdict: 'accept' }],
    claims: [
      { claimId: 'c1', status: 'true' },
      { status: 'supported' },
      { claimId: 'c2', status: 'partial', relationship: 'agrees', sourceId: '../x' },
      null,
    ],
  }));
  assert.deepEqual(r.reviews, [{ target: 'b', verdict: 'accept' }]);
  assert.deepEqual(r.claims, [{ claimId: 'c2', status: 'partial' }]);
  assert.equal(r.problems.length, 8);
  for (const bad of [undefined, null, 42, '', 'no json here', '```json\n{not json\n```', '{"reviews": "x"}', '[1,2]']) {
    const p = parseReviewBlock(bad);
    assert.deepEqual([p.reviews, p.claims], [[], []]);
    assert.ok(p.problems.length >= 1);
  }
});

test('huge and hostile inputs are bounded', () => {
  const inputs = [
    `${'{'.repeat(1_000_000)}`,
    `${'```json\n{'.repeat(200_000)}`,
    `${'x'.repeat(3_000_000)}\n${block({ claims: [{ claimId: 'c1', status: 'supported' }] })}`,
    `\n${'{"a": "'.repeat(200_000)}`,
    `${'\n{}'.repeat(300_000)}`,
  ];
  for (const s of inputs) {
    const t0 = Date.now();
    const r = parseReviewBlock(s);
    assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
    assert.ok(Array.isArray(r.claims));
  }
  assert.deepEqual(parseReviewBlock(inputs[2]).claims, [{ claimId: 'c1', status: 'supported' }]);
  const many = parseReviewBlock(block({ claims: Array.from({ length: 900 }, (_, i) => ({ claimId: `c${i}`, status: 'unknown' })) }));
  assert.equal(many.claims.length, 500);
  assert.match(many.problems[0], /first 500/);
});

test('the checker prompt example parses with parseReviewBlock', () => {
  const rules = checkerRules({ targets: ['finder-a', 'Not Valid'], maxSteps: 3 });
  assert.match(rules, /`finder-a` \(outputs\/work\/finder-a\.md\)/);
  assert.doesNotMatch(rules, /Not Valid/);
  assert.match(rules, /at most 3 web search steps/);
  const r = parseReviewBlock(rules);
  assert.deepEqual(r.problems, []);
  assert.equal(r.reviews[0].target, 'finder-a');
  assert.deepEqual(r.claims.map((c) => c.status), ['supported', 'contradicted']);
  assert.match(checkerRules(), /at most 5 web search steps/);
});

test('the lead and finder prompts', () => {
  const lead = leadWriteupRules();
  const example = /<claim id="c1".*?<\/claim>/.exec(lead)[0];
  const parsed = parseClaims(example);
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.claims[0].sources, ['currys-xm6', 'ebay-xm6']);
  const finder = finderRules();
  for (const s of ['data, not instructions', 'captcha', 'browse the web', 'evidence: <A, B, C or D>', '   - A: can be bought or run']) assert.ok(finder.includes(s), s);
});

test('verdictEvents and reviewEvents', () => {
  const parsed = parseReviewBlock(block({
    reviews: [{ target: 'finder-a', verdict: 'accept', note: 'ok' }],
    claims: [{ claimId: 'c1', status: 'supported', sourceId: 's1', relationship: 'supports', note: 'q' }, { claimId: 'c2', status: 'unknown' }],
  }));
  assert.deepEqual(verdictEvents(parsed, { backend: 'codex', agentId: 'checker' }), [
    { type: 'verdict.recorded', agentId: 'checker', data: { claimId: 'c1', status: 'supported', sourceId: 's1', relationship: 'supports', note: 'q', backend: 'codex' } },
    { type: 'verdict.recorded', agentId: 'checker', data: { claimId: 'c2', status: 'unknown', backend: 'codex' } },
  ]);
  assert.deepEqual(verdictEvents(parsed)[1], { type: 'verdict.recorded', data: { claimId: 'c2', status: 'unknown' } });
  assert.deepEqual(reviewEvents(parsed, { agentId: 'checker', round: 2 }), [
    { type: 'review.verdict', agentId: 'checker', data: { target: 'finder-a', verdict: 'accept', round: 2, note: 'ok' } },
  ]);
  assert.deepEqual(verdictEvents(null), []);
  assert.deepEqual(reviewEvents(undefined), []);
});

test('claimStatus mirrors the reducer rule', () => {
  assert.equal(claimStatus([], true), 'unchecked');
  assert.equal(claimStatus([{ by: 'a', status: 'supported' }], false), 'not-checkworthy');
  assert.equal(claimStatus([{ by: 'a', status: 'supported' }, { by: 'b', status: 'supported' }]), 'supported');
  assert.equal(claimStatus([{ by: 'a', status: 'supported' }, { by: 'b', status: 'partial' }]), 'unknown');
  assert.equal(claimStatus([{ by: 'a', status: 'supported' }, { by: 'b', status: 'contradicted' }]), 'contradicted');
  assert.equal(claimStatus([{ by: 'a', status: 'contradicted' }, { by: 'a', status: 'supported' }]), 'supported', 'last verdict per checker');
});

test('mergeLanes: quorum merge with disagreements', () => {
  const lanes = [
    { by: 'checker-claude', backend: 'claude-code', claims: [
      { claimId: 'c1', status: 'supported' }, { claimId: 'c2', status: 'supported' }, { claimId: 'c3', status: 'partial' },
      { claimId: 'c1', status: 'partial', note: 'second look' }],
    },
    { by: 'checker-codex', backend: 'codex', claims: [
      { claimId: 'c1', status: 'partial' }, { claimId: 'c2', status: 'contradicted' }, { claimId: 'c4', status: 'unknown' }, { claimId: 'c5', status: 'bogus' }],
    },
    { claims: [{ claimId: 'c9', status: 'supported' }] },
    'junk',
  ];
  const { perClaim, disagreements } = mergeLanes(lanes);
  assert.deepEqual(Object.keys(perClaim), ['c1', 'c2', 'c3', 'c4']);
  assert.deepEqual(perClaim.c1, { status: 'partial', agree: true, by: [
    { by: 'checker-claude', backend: 'claude-code', status: 'partial', note: 'second look' },
    { by: 'checker-codex', backend: 'codex', status: 'partial', note: null }] });
  assert.equal(perClaim.c2.status, 'contradicted');
  assert.equal(perClaim.c2.agree, false);
  assert.equal(perClaim.c3.status, 'partial');
  assert.deepEqual(disagreements, [{
    claimId: 'c2', status: 'contradicted',
    verdicts: [{ by: 'checker-claude', status: 'supported' }, { by: 'checker-codex', status: 'contradicted' }],
    note: 'Checkers disagree on c2: checker-claude says supported, checker-codex says contradicted.',
  }]);
  const split = mergeLanes([{ by: 'a', claims: [{ claimId: 'x', status: 'supported' }] }, { by: 'b', claims: [{ claimId: 'x', status: 'unknown' }] }]);
  assert.equal(split.perClaim.x.status, 'unknown');
  assert.deepEqual(mergeLanes(null), { perClaim: {}, disagreements: [] });
});

test('shouldFlag: thresholds and plain-English reasons', () => {
  const summary = { claims: 6, checkworthy: 6, supported: 2, partial: 0, contradicted: 1, unknown: 3, unchecked: 0, hallucinated: 2 };
  assert.deepEqual(shouldFlag(summary), {
    flag: true,
    reasons: [
      '1 claim is contradicted by its source.',
      '3 of 6 checkable claims (50%) could not be confirmed.',
      '2 cited links do not exist and were never archived.',
    ],
  });
  assert.deepEqual(shouldFlag(summary, { contradicted: 2, unknownShare: 0.6, hallucinated: 3 }), { flag: false, reasons: [] });
  assert.deepEqual(shouldFlag(summary, { contradicted: 0, unknownShare: 0, hallucinated: -1 }), { flag: false, reasons: [] });
  assert.deepEqual(shouldFlag({ checkworthy: 0, unknown: 0 }, { unknownShare: 0.1 }), { flag: false, reasons: [] });
  assert.equal(shouldFlag({ contradicted: 2 }, { contradicted: 1 }).reasons[0], '2 claims are contradicted by their sources.');
  assert.equal(shouldFlag(null).flag, false);
  assert.deepEqual(DEFAULT_FLAG_WHEN, { contradicted: 1, unknownShare: 0.34, hallucinated: 1 });
});

test('summarize matches RFC 0001 §4.4', () => {
  const claims = [
    { claimId: 'c1', sources: ['a'], status: 'supported' },
    { claimId: 'c2', sources: ['a', 'b'], verdicts: [{ by: 'x', status: 'partial' }] },
    { claimId: 'c3', sources: ['b'], verdicts: [{ by: 'x', status: 'supported' }, { by: 'y', status: 'contradicted' }] },
    { claimId: 'c4', sources: [] },
    { claimId: 'c5', sources: ['c'], checkworthy: false },
    { claimId: 'c6', sources: [], verdicts: [{ by: 'x', status: 'unknown' }] },
  ];
  const evidence = [
    { sourceId: 'a', urlHealth: 'live' },
    { sourceId: 'b', urlHealth: 'hallucinated' },
    { sourceId: 'c', urlHealth: null },
    { sourceId: 'd', urlHealth: 'stale' },
    { sourceId: 'e', urlHealth: 'blocked' },
    { sourceId: 'c', urlHealth: 'live' },
    { sourceId: 'a', urlHealth: 'nonsense' },
  ];
  assert.deepEqual(summarize(claims, evidence), {
    claims: 6, checkworthy: 5, supported: 1, partial: 1, contradicted: 1, unknown: 1, unchecked: 1,
    sources: 5, live: 2, stale: 1, hallucinated: 1, blocked: 1, uncited: 2,
  });
  assert.deepEqual(summarize(null, undefined), {
    claims: 0, checkworthy: 0, supported: 0, partial: 0, contradicted: 0, unknown: 0, unchecked: 0,
    sources: 0, live: 0, stale: 0, hallucinated: 0, blocked: 0, uncited: 0,
  });
});
