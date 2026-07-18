'use strict';

/**
 * Materialize responseShape → sample object.
 * Hard rule: only fill VALUES for keys already in shape — never invent fields.
 * Primary: shape → JSON Schema → json-schema-faker; fallback: local heuristics.
 */

const { shapeToJsonSchema } = require('./infer/shape-json-schema');

const SEED = 'mox';

let _faker = null;
function getFaker() {
  if (_faker) return _faker;
  try {
    const { Faker, zh_CN, en } = require('@faker-js/faker');
    _faker = new Faker({ locale: [zh_CN, en] });
    _faker.seed(hashSeed(SEED));
  } catch {
    _faker = null;
  }
  return _faker;
}

function hashSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h) || 1;
}

/** Reset faker seed (tests). */
function resetFakerSeed() {
  const f = getFaker();
  if (f) f.seed(hashSeed(SEED));
}

/**
 * Sample value for an existing field name. Returns null if no rule matches.
 * Does not create fields — callers must already have the key.
 */
function sampleForName(name) {
  if (!name) return null;
  const n = String(name);

  // Structural (no faker needed)
  if (/List$/i.test(n) || /Items$/i.test(n) || n === 'items') return [];
  if (/^(is|has|can|enable)/i.test(n)) return false;
  if (/Count$/i.test(n) || /Total$/i.test(n) || /Num$/i.test(n)) return 0;

  const faker = getFaker();
  if (!faker) {
    if (/Id$/i.test(n) || /^id$/i.test(n) || /_id$/i.test(n)) return '1';
    if (/Name$/i.test(n) || /Title$/i.test(n)) return 'mock';
    if (/Date$/i.test(n) || /Time$/i.test(n)) return '2026-01-01';
    return null;
  }

  if (/^lng$|^lon$|longitude/i.test(n)) return Number(faker.location.longitude().toFixed(6));
  if (/^lat$|latitude/i.test(n)) return Number(faker.location.latitude().toFixed(6));
  if (/address/i.test(n)) return faker.location.streetAddress();
  if (/city.*name|city_name|cityName/i.test(n)) return faker.location.city();
  if (/phone|mobile|tel/i.test(n)) return faker.phone.number();
  if (/email/i.test(n)) return faker.internet.email();
  if (/Date$/i.test(n) || /Time$/i.test(n) || /_at$/i.test(n)) {
    return faker.date.recent().toISOString().slice(0, 10);
  }
  if (/Id$/i.test(n) || /^id$/i.test(n) || /_id$/i.test(n)) {
    return String(faker.number.int({ min: 1, max: 9999 }));
  }
  if (/Name$/i.test(n) || /Title$/i.test(n) || /_name$/i.test(n)) {
    return faker.person.fullName();
  }

  return null;
}

/**
 * Values that capture-merge may overwrite (init placeholders).
 */
function isPlaceholderValue(v) {
  if (v == null) return true;
  if (v === '') return true;
  if (v === 'mock') return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}

/**
 * Post-process jsf output: fill nulls via heuristics; never add keys.
 */
function enrichPlaceholders(sample, shape, fieldName = '') {
  if (!shape) return sample;
  if (shape.type === 'array') {
    if (!Array.isArray(sample) || !sample.length) {
      return materializeLegacy(shape, fieldName);
    }
    return sample.map((item) =>
      enrichPlaceholders(item, shape.item || {}, fieldName),
    );
  }
  if (shape.type === 'object' || shape.props) {
    const props = shape.props || {};
    const out =
      sample && typeof sample === 'object' && !Array.isArray(sample)
        ? { ...sample }
        : {};
    for (const [k, v] of Object.entries(props)) {
      if (v.type === 'object' || v.props || v.type === 'array') {
        out[k] = enrichPlaceholders(out[k], v, k);
        if (out[k] == null || out[k] === '') {
          out[k] = materializeLegacy(v, k);
        }
      } else {
        // leaf
        if (v.type === 'unknown') {
          const byName = sampleForName(k);
          out[k] = byName !== null ? byName : materializeLegacy(v, k);
        } else if (v.enums?.length) {
          out[k] = materializeLegacy(v, k);
        } else if (!(k in out) || out[k] == null || out[k] === '') {
          out[k] = materializeLegacy(v, k);
        } else if (v.type === 'number' && typeof out[k] !== 'number') {
          out[k] = materializeLegacy(v, k);
        } else if (v.type === 'string' && typeof out[k] !== 'string') {
          out[k] = materializeLegacy(v, k);
        } else if (v.type === 'boolean' && typeof out[k] !== 'boolean') {
          out[k] = materializeLegacy(v, k);
        }
      }
    }
    for (const k of Object.keys(out)) {
      if (!(k in props)) delete out[k];
    }
    return out;
  }
  if (sample == null || sample === '') {
    return materializeLegacy(shape, fieldName);
  }
  // Prefer name heuristics for unknown leaves (jsf may pick odd union members)
  if (shape.type === 'unknown' || (!shape.type && !shape.props)) {
    const byName = sampleForName(fieldName);
    if (byName !== null) return byName;
  }
  return sample;
}

/**
 * Materialize responseShape tree into a concrete sample object.
 * Keys ⊆ shape.props only.
 */
function materializeLegacy(shape, fieldName = '') {
  if (!shape || typeof shape !== 'object') return {};
  if (shape.type === 'array') {
    const itemShape = shape.item || { type: 'object', props: {} };
    const itemProps = itemShape.props || {};
    if (
      itemShape.type !== 'array' &&
      Object.keys(itemProps).length === 0 &&
      !['string', 'number', 'boolean', 'unknown'].includes(itemShape.type)
    ) {
      return [];
    }
    return [materializeLegacy(itemShape, fieldName)];
  }
  if (shape.type === 'string') {
    if (shape.enums?.length) return shape.enums[0];
    const byName = sampleForName(fieldName);
    if (byName !== null && typeof byName !== 'object') return String(byName);
    return byName !== null ? byName : 'mock';
  }
  if (shape.type === 'number') {
    if (shape.enums?.length) return shape.enums[0];
    const byName = sampleForName(fieldName);
    if (typeof byName === 'number') return byName;
    if (
      typeof byName === 'string' &&
      byName !== '' &&
      !Number.isNaN(Number(byName))
    ) {
      return Number(byName);
    }
    return 0;
  }
  if (shape.type === 'boolean') {
    if (shape.enums?.length) return Boolean(shape.enums[0]);
    return false;
  }
  if (shape.type === 'unknown') {
    if (shape.enums?.length) return shape.enums[0];
    const byName = sampleForName(fieldName);
    if (byName !== null) return byName;
    return 'mock';
  }
  const out = {};
  const props = shape.props || {};
  for (const [k, v] of Object.entries(props)) {
    out[k] = materializeLegacy(v, k);
  }
  return out;
}

/**
 * Materialize via JSON Schema + json-schema-faker when possible.
 */
function materialize(shape, fieldName = '') {
  if (!shape || typeof shape !== 'object') return {};
  // Deterministic enums: always first value (jsf may pick randomly)
  if (shape.enums?.length && !shape.props) {
    const v = shape.enums[0];
    return v && typeof v === 'object' && 'value' in v ? v.value : v;
  }
  // Empty array payload (no item keys) → [] — do not invent [{}]
  if (shape.type === 'array') {
    const itemShape = shape.item || { type: 'object', props: {} };
    const itemProps = itemShape.props || {};
    if (
      itemShape.type !== 'array' &&
      Object.keys(itemProps).length === 0 &&
      !['string', 'number', 'boolean', 'unknown'].includes(itemShape.type)
    ) {
      return [];
    }
  }
  try {
    const jsf = require('json-schema-faker');
    jsf.option({
      alwaysFakeOptionals: true,
      useDefaultValue: true,
      fillProperties: false,
      minItems: 1,
      maxItems: 1,
      random: () => {
        const f = getFaker();
        return f
          ? f.number.float({ min: 0, max: 1, fractionDigits: 8 })
          : Math.random();
      },
    });
    const schema = shapeToJsonSchema(shape);
    const raw = jsf.generate(schema);
    return enrichPlaceholders(raw, shape, fieldName);
  } catch {
    return materializeLegacy(shape, fieldName);
  }
}

function shapeToDataFields(shape, prefix = '') {
  const fields = {};
  if (!shape) return fields;
  // Root (or nested) array payload: fold item props under `[]` / `prefix[]`
  if (shape.type === 'array' && shape.item) {
    const itemPrefix = prefix ? `${prefix}[]` : '[]';
    if (shape.item.type === 'object' || shape.item.props) {
      Object.assign(fields, shapeToDataFields(
        { type: 'object', props: shape.item.props || {} },
        itemPrefix,
      ));
    } else if (shape.item.type && shape.item.type !== 'object') {
      fields[itemPrefix] = {
        type: shape.item.type || 'unknown',
        enums: shape.item.enums || [],
        note: 'inferred from usage',
      };
    }
    return fields;
  }
  if (!shape?.props) return fields;
  for (const [k, v] of Object.entries(shape.props)) {
    const path = prefix ? `${prefix}.${k}` : k;
    fields[path] = {
      type: v.type || 'unknown',
      enums: v.enums || [],
      note: 'inferred from usage',
    };
    if (v.type === 'object' && v.props) {
      Object.assign(fields, shapeToDataFields(v, path));
    }
    if (v.type === 'array' && v.item?.props) {
      Object.assign(fields, shapeToDataFields(v.item, `${path}[]`));
    }
  }
  return fields;
}

function buildEnumCases(shape, baseData) {
  const cases = [];
  if (!shape?.props) return cases;
  function walk(node, pathParts) {
    if (!node) return;
    if (node.enums?.length && pathParts.length) {
      for (const val of node.enums) {
        const data = JSON.parse(JSON.stringify(baseData));
        let cur = data;
        for (let i = 0; i < pathParts.length - 1; i++) {
          if (cur[pathParts[i]] == null || typeof cur[pathParts[i]] !== 'object') {
            cur[pathParts[i]] = {};
          }
          cur = cur[pathParts[i]];
        }
        cur[pathParts[pathParts.length - 1]] = val;
        const id = `state_${pathParts.join('_')}_${String(val)}`.replace(
          /[^a-zA-Z0-9_]/g,
          '_',
        );
        cases.push({
          id,
          when: { header: { 'x-mock-case': id } },
          response: { code: 0, data, message: '' },
        });
      }
    }
    if (node.props) {
      for (const [k, v] of Object.entries(node.props)) {
        walk(v, [...pathParts, k]);
      }
    }
  }
  walk(shape, []);
  return cases.slice(0, 20); // cap
}

module.exports = {
  materialize,
  materializeLegacy,
  shapeToDataFields,
  buildEnumCases,
  sampleForName,
  isPlaceholderValue,
  resetFakerSeed,
  shapeToJsonSchema,
};
