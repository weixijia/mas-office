import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { signTeam, lockTeam, verifySignature, canonicalJson } from '../../src/team/sign.js';
import { normalizeTeam } from '../../src/team/normalize.js';
import { parseJsTwin } from '../../src/sdk/index.js';
import { v2Structure, ENV } from './fixtures.js';

const reorderKeys = (v) => {
  if (Array.isArray(v)) return v.map(reorderKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reorderKeys(v[k])]));
  return v;
};

test('canonical JSON sorts keys at every level and keeps array order', () => {
  assert.equal(canonicalJson({ b: [2, { d: 1, c: null }], a: 'x', u: undefined }), '{"a":"x","b":[2,{"c":null,"d":1}]}');
});

test('the signature is a sha256 and does not depend on key order or defaults written out', () => {
  const sig = signTeam(v2Structure());
  assert.match(sig, /^sha256:[0-9a-f]{64}$/);
  assert.equal(signTeam(reorderKeys(v2Structure())), sig);
  assert.equal(signTeam(normalizeTeam(v2Structure()).team), sig, 'raw structure and normalised team agree');
  const explicit = v2Structure();
  explicit.roles[0].tools[0] = { name: 'web search', effect: 'allow' };
  explicit.roles[2].review = { maxRounds: 2, onExceed: 'ask-human' };
  explicit.roles[0].backend = 'claude-code';
  explicit.verify = { claims: true };
  explicit.budget = { ...explicit.budget, stallMinutes: 5 };
  explicit.roles[2].tools = ['Web Search'];
  assert.equal(signTeam(explicit), sig);
});

test('cosmetic edits keep the signature', () => {
  const sig = signTeam(v2Structure());
  const s = v2Structure();
  s.title = 'Renamed';
  s.rationale = 'because';
  s.roles[0].name = 'Shop finder';
  s.roles[0].emoji = '🛒';
  s.roles[0].why = 'different';
  s.roles[0].serves = ['R1'];
  s.groups[0].label = 'Look around';
  s.gates[0].title = 'Show me first';
  s.lead.name = 'Boss';
  s.lead.emoji = '🧭';
  s.version = 7;
  s.locked = true;
  s.signature = 'sha256:old';
  assert.equal(signTeam(s), sig);
});

test('behaviour edits change the signature', () => {
  const sig = signTeam(v2Structure());
  const edits = [
    (s) => { s.roles[0].job = 'Find cheaper offers'; },
    (s) => { s.roles[0].tools[1] = { name: 'browse the web', effect: 'allow' }; },
    (s) => { s.roles[0].tools.push('run commands'); },
    (s) => { s.roles[2].backend = 'claude-code'; },
    (s) => { s.roles[2].model = 'gpt-6.1-sol'; },
    (s) => { s.roles[2].reviewerOf = ['finder-a']; },
    (s) => { s.roles[0].handsTo = 'lead'; },
    (s) => { s.roles[0].output = 'A list'; },
    (s) => { s.roles[0].group = 'B'; },
    (s) => { s.roles.reverse(); },
    (s) => { s.groups[1].after = null; },
    (s) => { s.gates[0].blocking = false; },
    (s) => { s.gates.pop(); },
    (s) => { s.lead.delegate[0].tools = ['web search']; },
    (s) => { s.lead.backend = 'codex'; },
    (s) => { s.budget.maxParallel = 2; },
    (s) => { s.verify = { urlHealth: false }; },
    (s) => { s.roles[2].review = { maxRounds: 3 }; },
    (s) => { s.roles[0].unknownTools = 'deny'; },
  ];
  const seen = new Set([sig]);
  for (const edit of edits) {
    const s = v2Structure();
    edit(s);
    const changed = signTeam(s);
    assert.ok(!seen.has(changed), `${edit} changed the signature`);
    seen.add(changed);
  }
});

test('lockTeam sets locked and signature only; verifySignature checks it', () => {
  const s = v2Structure();
  const locked = lockTeam(s, ENV);
  assert.deepEqual(Object.keys(locked).filter((k) => !(k in s)), ['locked', 'signature']);
  assert.equal(locked.locked, true);
  assert.equal(locked.version, s.version);
  assert.equal(locked.signature, signTeam(s));
  assert.ok(verifySignature(locked));
  assert.ok(verifySignature(reorderKeys(locked)));
  assert.ok(verifySignature({ ...locked, title: 'New title' }));
  assert.ok(!verifySignature({ ...locked, budget: { maxParallel: 1 } }));
  assert.ok(!verifySignature(s), 'no signature');
  assert.ok(!verifySignature(null));
  assert.ok(!verifySignature({ signature: 'sha256:x' }), 'a broken design never verifies');
});

test('lockTeam refuses a design with errors and says why', () => {
  const s = v2Structure();
  s.roles[0].tools.push('flight search');
  assert.throws(() => lockTeam(s, ENV), (err) => {
    assert.match(err.message, /\/roles\/0\/tools\/3: "flight search" is not a known tool/);
    assert.ok(err.problems.some((p) => p.level === 'error'));
    return true;
  });
  assert.throws(() => lockTeam(v2Structure(), { ...ENV, mcpServers: {} }), /mas-browser/);
});

test('the v2 example carries a valid signature', () => {
  const file = fileURLToPath(new URL('../../../../examples/price-compare/mas/structure.js', import.meta.url));
  const s = parseJsTwin(fs.readFileSync(file, 'utf8'));
  assert.equal(s.locked, true);
  assert.ok(verifySignature(s), `expected ${signTeam(s)}`);
});
