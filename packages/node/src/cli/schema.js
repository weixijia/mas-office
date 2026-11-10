// A small JSON Schema validator for exactly the keywords used in spec/schemas/:
// type (string or array), properties, additionalProperties (a schema), required, items,
// enum, const, pattern, minimum, maximum, minLength, maxLength. Anything else is an error, so a schema
// change that needs a new keyword fails loudly instead of being ignored.

const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description', '$comment']);
const KEYWORDS = new Set([
  'type', 'properties', 'additionalProperties', 'required', 'items', 'enum', 'const', 'pattern',
  'minimum', 'maximum', 'minLength', 'maxLength',
]);

const pointer = (base, key) => `${base}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (v) => JSON.stringify(v);

function hasType(type, v) {
  switch (type) {
    case 'null': return v === null;
    case 'boolean': return typeof v === 'boolean';
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return Number.isInteger(v);
    case 'array': return Array.isArray(v);
    case 'object': return typeof v === 'object' && v !== null && !Array.isArray(v);
    default: throw new Error(`Unsupported schema type "${type}"`);
  }
}

/**
 * Validate `value` against `schema`.
 * @returns {{path: string, message: string}[]} empty when valid; `path` is a JSON pointer ('' = root)
 */
export function validate(schema, value, path = '') {
  const errors = [];
  const fail = (message, at = path) => errors.push({ path: at, message });
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key)) throw new Error(`Unsupported schema keyword "${key}"`);
  }
  const extra = schema.additionalProperties;
  if (extra !== undefined && (typeof extra !== 'object' || extra === null || Array.isArray(extra))) {
    throw new Error('Unsupported schema keyword "additionalProperties" (only the schema form is supported)');
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => hasType(t, value))) {
      fail(`must be ${types.join(' or ')}`);
      return errors; // the other keywords would only repeat the problem
    }
  }
  if (schema.const !== undefined && !same(schema.const, value)) fail(`must be ${show(schema.const)}`);
  if (schema.enum && !schema.enum.some((option) => same(option, value))) fail(`must be one of ${schema.enum.map(show).join(', ')}`);

  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) fail(`must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && length > schema.maxLength) fail(`must be at most ${schema.maxLength} characters`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) fail(`must match ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail(`must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(`must be <= ${schema.maximum}`);
  }
  if (hasType('object', value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail('is required', pointer(path, key));
    const properties = schema.properties ?? {};
    for (const [key, sub] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) errors.push(...validate(sub, value[key], pointer(path, key)));
    }
    if (extra) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) errors.push(...validate(extra, value[key], pointer(path, key)));
      }
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errors.push(...validate(schema.items, item, pointer(path, i))));
  }
  return errors;
}
