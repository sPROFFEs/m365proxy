// A deliberately bounded JSON Schema subset. Unknown assertion keywords fail
// closed at request time instead of being silently ignored. No remote $ref fetch.
import { invalid } from './errors.mjs';
import { plainObject, stable } from './util.mjs';
const annotations = new Set(['title', 'description', 'default', 'examples', '$comment', '$schema', 'deprecated', 'readOnly', 'writeOnly']);
const assertions = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'prefixItems', 'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minProperties', 'maxProperties', 'enum', 'const', 'anyOf', 'oneOf', 'allOf', 'not', '$ref', '$defs', 'definitions', 'nullable']);
const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
function deref(ref, root) {
  if (ref === '#') return root;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) throw invalid('Only local JSON Pointer $ref values are supported.', 'tools');
  let current = root;
  for (const p of ref.slice(2).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (!plainObject(current) || !Object.hasOwn(current, p)) throw invalid('Unresolved local schema reference.', 'tools');
    current = current[p];
  }
  return current;
}
export function compileSchema(root) {
  const seen = new Set();
  let nodes = 0;
  function check(s, depth = 0) {
    if (typeof s === 'boolean') return;
    if (!plainObject(s) || depth > 64 || ++nodes > 2000) throw invalid('Invalid or excessively complex tool schema.', 'tools');
    if (seen.has(s)) return;
    seen.add(s);
    for (const k of Object.keys(s)) if (!annotations.has(k) && !assertions.has(k)) throw invalid(`Unsupported JSON Schema keyword: ${k}. This proxy does not pretend to validate it.`, 'tools');
    if (s.$ref !== undefined) check(deref(s.$ref, root), depth + 1);
    if (s.type !== undefined) {
      const t = Array.isArray(s.type) ? s.type : [s.type];
      if (!t.length || t.some((x) => !types.has(x))) throw invalid('Invalid schema type.', 'tools');
    }
    for (const field of ['properties', '$defs', 'definitions']) if (s[field] !== undefined) {
      if (!plainObject(s[field])) throw invalid(`${field} must be an object.`, 'tools');
      for (const child of Object.values(s[field])) check(child, depth + 1);
    }
    for (const field of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) if (s[field] !== undefined) {
      if (!Array.isArray(s[field]) || !s[field].length) throw invalid(`${field} must be a nonempty array.`, 'tools');
      s[field].forEach((child) => check(child, depth + 1));
    }
    for (const field of ['items', 'additionalProperties', 'not']) if (s[field] !== undefined) check(s[field], depth + 1);
    if (s.required !== undefined && (!Array.isArray(s.required) || s.required.some((k) => typeof k !== 'string'))) throw invalid('required must contain property names.', 'tools');
    if (s.enum !== undefined && (!Array.isArray(s.enum) || !s.enum.length)) throw invalid('enum must be a nonempty array.', 'tools');
    for (const field of ['minItems', 'maxItems', 'minLength', 'maxLength', 'minProperties', 'maxProperties']) if (s[field] !== undefined && (!Number.isInteger(s[field]) || s[field] < 0)) throw invalid(`${field} must be a nonnegative integer.`, 'tools');
    for (const field of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']) if (s[field] !== undefined && (typeof s[field] !== 'number' || !Number.isFinite(s[field]) || (field === 'multipleOf' && s[field] <= 0))) throw invalid(`${field} must be a valid number.`, 'tools');
    for (const field of ['uniqueItems', 'nullable']) if (s[field] !== undefined && typeof s[field] !== 'boolean') throw invalid(`${field} must be boolean.`, 'tools');

  }
  check(root);
  const matches = (v, t) => t === 'null' ? v === null : t === 'object' ? plainObject(v) : t === 'array' ? Array.isArray(v) : t === 'integer' ? Number.isInteger(v) : t === 'number' ? typeof v === 'number' && Number.isFinite(v) : typeof v === t;
  let evaluations = 0;
  function validate(s, v, depth = 0) {
    if (++evaluations > 10000) return 'Schema evaluation budget exceeded.';
    if (depth > 64) return 'Schema recursion limit exceeded.';
    if (s === true) return null;
    if (s === false) return 'Value is prohibited by schema.';
    const run = (child, value = v) => validate(child, value, depth + 1);
    if (s.$ref !== undefined) { const err = run(deref(s.$ref, root)); if (err) return err; }
    if (s.type !== undefined && !(s.nullable === true && v === null) && !(Array.isArray(s.type) ? s.type : [s.type]).some((t) => matches(v, t))) return 'Wrong argument type.';
    if (s.enum !== undefined && !s.enum.some((x) => stable(x) === stable(v))) return 'Value is outside enum.';
    if (Object.hasOwn(s, 'const') && stable(s.const) !== stable(v)) return 'Value differs from const.';
    if (s.anyOf && !s.anyOf.some((child) => !run(child))) return 'No anyOf branch matched.';
    if (s.oneOf && s.oneOf.filter((child) => !run(child)).length !== 1) return 'Exactly one oneOf branch must match.';
    if (s.allOf) for (const child of s.allOf) { const err = run(child); if (err) return err; }
    if (s.not !== undefined && !run(s.not)) return 'Value matched a prohibited schema.';
    if (plainObject(v)) {
      const keys = Object.keys(v);
      if (s.minProperties !== undefined && keys.length < s.minProperties) return 'Too few properties.';
      if (s.maxProperties !== undefined && keys.length > s.maxProperties) return 'Too many properties.';
      for (const k of s.required ?? []) if (!Object.hasOwn(v, k)) return `Missing required argument: ${k}.`;
      for (const k of keys) {
        const child = Object.hasOwn(s.properties ?? {}, k) ? s.properties[k] : s.additionalProperties;
        if (child !== undefined) { const err = run(child, v[k]); if (err) return `${k}: ${err}`; }
      }
    }
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) return 'Array is too short.';
      if (s.maxItems !== undefined && v.length > s.maxItems) return 'Array is too long.';
      if (s.uniqueItems && new Set(v.map(stable)).size !== v.length) return 'Array contains duplicate items.';
      for (let i = 0; i < v.length; i++) {
        const child = s.prefixItems?.[i] ?? s.items;
        if (child !== undefined) { const err = run(child, v[i]); if (err) return `[${i}]: ${err}`; }
      }
    }
    if (typeof v === 'string') {
      const n = Array.from(v).length;
      if (s.minLength !== undefined && n < s.minLength) return 'String is too short.';
      if (s.maxLength !== undefined && n > s.maxLength) return 'String is too long.';
    }
    if (typeof v === 'number') {
      if (s.minimum !== undefined && v < s.minimum) return 'Below minimum.';
      if (s.maximum !== undefined && v > s.maximum) return 'Above maximum.';
      if (s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum) return 'Below exclusive minimum.';
      if (s.exclusiveMaximum !== undefined && v >= s.exclusiveMaximum) return 'Above exclusive maximum.';
      if (s.multipleOf !== undefined && Math.abs(v / s.multipleOf - Math.round(v / s.multipleOf)) > 1e-9) return 'Not a multipleOf.';
    }
    return null;
  }
  return (value) => { evaluations = 0; return validate(root, value); };
}
