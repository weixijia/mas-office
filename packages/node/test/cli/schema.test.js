import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../../src/cli/schema.js';

const paths = (errors) => errors.map((e) => `${e.path} ${e.message}`);

test('type, including arrays of types and integer vs number', () => {
  assert.deepEqual(validate({ type: 'string' }, 'x'), []);
  assert.deepEqual(paths(validate({ type: 'string' }, 1)), [' must be string']);
  assert.deepEqual(validate({ type: ['string', 'null'] }, null), []);
  assert.deepEqual(paths(validate({ type: ['string', 'null'] }, 3)), [' must be string or null']);
  assert.deepEqual(validate({ type: 'integer' }, 3), []);
  assert.equal(validate({ type: 'integer' }, 3.5).length, 1);
  assert.deepEqual(validate({ type: 'number' }, 3.5), []);
  assert.equal(validate({ type: 'object' }, []).length, 1);
  assert.equal(validate({ type: 'array' }, {}).length, 1);
  assert.equal(validate({ type: 'object' }, null).length, 1);
});

test('properties, required and items report JSON pointers', () => {
  const schema = {
    type: 'object',
    required: ['roles'],
    properties: { roles: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[a-z]+$' } } } } },
  };
  assert.deepEqual(paths(validate(schema, {})), ['/roles is required']);
  assert.deepEqual(paths(validate(schema, { roles: [{ id: 'ok' }, {}, { id: 'NO' }] })), ['/roles/1/id is required', '/roles/2/id must match ^[a-z]+$']);
  assert.deepEqual(paths(validate({ type: 'object', required: ['constructor'] }, {})), ['/constructor is required'], 'own properties only');
  assert.deepEqual(paths(validate({ properties: { 'a/b': { type: 'string' } } }, { 'a/b': 1 })), ['/a~1b must be string']);
});

test('enum (with null), const, bounds and lengths', () => {
  assert.deepEqual(validate({ enum: ['a', null] }, null), []);
  assert.deepEqual(paths(validate({ enum: ['a', 'b'] }, 'c')), [' must be one of "a", "b"']);
  assert.deepEqual(validate({ const: 'lead' }, 'lead'), []);
  assert.equal(validate({ const: 'lead' }, 'boss').length, 1);
  assert.equal(validate({ type: 'integer', minimum: 1 }, 0).length, 1);
  assert.equal(validate({ type: 'number', maximum: 100 }, 101).length, 1);
  assert.deepEqual(validate({ type: 'number', minimum: 0, maximum: 100 }, 100), []);
  assert.equal(validate({ type: 'string', minLength: 1 }, '').length, 1);
  assert.deepEqual(validate({ type: 'string', maxLength: 2 }, '🧭🧭'), [], 'lengths count code points');
  assert.equal(validate({ type: 'string', maxLength: 2 }, 'abc').length, 1);
});

test('additionalProperties (schema form) checks the values of keys not in properties', () => {
  const schema = { type: 'object', properties: { fixed: { type: 'string' } }, additionalProperties: { type: 'object', required: ['turns'] } };
  assert.deepEqual(validate(schema, { fixed: 'x', a: { turns: 1 } }), []);
  assert.deepEqual(paths(validate(schema, { fixed: 'x', a: {}, __proto__: [] })), ['/a/turns is required']);
  assert.deepEqual(paths(validate(schema, JSON.parse('{"__proto__": 1}'))), ['/__proto__ must be object'], 'own keys, even __proto__');
  assert.throws(() => validate({ additionalProperties: false }, {}), /only the schema form/);
});

test('annotations are ignored, unknown keywords throw', () => {
  assert.deepEqual(validate({ $schema: 'x', $id: 'y', title: 't', description: 'd', type: 'string' }, 's'), []);
  assert.throws(() => validate({ oneOf: [] }, 1), /Unsupported schema keyword "oneOf"/);
  assert.throws(() => validate({ type: 'date' }, 1), /Unsupported schema type/);
});

test('every keyword used in spec/schemas is supported', async () => {
  const fs = await import('node:fs');
  const dir = new URL('../../../../spec/schemas/', import.meta.url);
  for (const name of fs.readdirSync(dir)) {
    const schema = JSON.parse(fs.readFileSync(new URL(name, dir), 'utf8'));
    assert.doesNotThrow(() => validate(schema, {}), name);
  }
});
