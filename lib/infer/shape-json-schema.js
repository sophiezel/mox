'use strict';

/**
 * Shared IR: internal responseShape ↔ JSON Schema.
 * Used by materialize (jsf) and OpenAPI import — one type system.
 */

/**
 * @param {object} shape - mox responseShape
 * @returns {object} JSON Schema draft-07-ish object
 */
function shapeToJsonSchema(shape) {
  if (!shape || typeof shape !== 'object') {
    return { type: 'object', properties: {}, additionalProperties: false };
  }

  if (shape.type === 'array') {
    return {
      type: 'array',
      minItems: 1,
      maxItems: 1,
      items: shapeToJsonSchema(shape.item || { type: 'object', props: {} }),
    };
  }

  if (shape.type === 'object' || shape.props) {
    const properties = {};
    const props = shape.props || {};
    for (const [k, v] of Object.entries(props)) {
      properties[k] = shapeToJsonSchema(v);
    }
    return {
      type: 'object',
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    };
  }

  if (shape.enums?.length) {
    const vals = shape.enums.map((e) =>
      e && typeof e === 'object' && 'value' in e ? e.value : e,
    );
    const t = typeof vals[0];
    const out = { enum: vals, default: vals[0] };
    if (t === 'string' || t === 'number' || t === 'boolean') out.type = t;
    return out;
  }

  if (shape.type === 'string') return { type: 'string', minLength: 1 };
  if (shape.type === 'number') return { type: 'number' };
  if (shape.type === 'boolean') return { type: 'boolean' };
  if (shape.type === 'unknown') {
    return { type: ['string', 'number', 'boolean'] };
  }

  return { type: 'string' };
}

/**
 * @param {object} schema - JSON Schema
 * @param {object} [components]
 * @returns {object} responseShape
 */
function jsonSchemaToShape(schema, components = {}) {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', props: {} };
  }
  if (schema.$ref) {
    const name = String(schema.$ref).split('/').pop();
    const resolved = components.schemas?.[name] || components[name];
    return jsonSchemaToShape(resolved || {}, components);
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    const merged = { type: 'object', props: {} };
    for (const part of schema.allOf) {
      const s = jsonSchemaToShape(part, components);
      if (s.props) Object.assign(merged.props, s.props);
      if (s.type === 'array') return s;
    }
    return merged;
  }
  if (schema.type === 'array' || schema.items) {
    return {
      type: 'array',
      item: jsonSchemaToShape(schema.items || {}, components),
    };
  }
  if (schema.type === 'object' || schema.properties) {
    const props = {};
    for (const [k, v] of Object.entries(schema.properties || {})) {
      props[k] = jsonSchemaToShape(v, components);
    }
    return { type: 'object', props };
  }
  if (schema.enum?.length) {
    const t = typeof schema.enum[0];
    return {
      type: t === 'number' ? 'number' : t === 'boolean' ? 'boolean' : 'string',
      enums: [...schema.enum],
    };
  }
  const t = schema.type;
  if (Array.isArray(t)) {
    if (t.includes('string')) return { type: 'string' };
    if (t.includes('number') || t.includes('integer')) return { type: 'number' };
    if (t.includes('boolean')) return { type: 'boolean' };
    return { type: 'unknown' };
  }
  if (t === 'integer') return { type: 'number' };
  if (t === 'string' || t === 'number' || t === 'boolean') return { type: t };
  return { type: 'unknown' };
}

/**
 * Stable export identity: definingFile#exportName
 * @param {string} definingFile - project-relative posix path
 * @param {string} exportName
 */
function makeExportKey(definingFile, exportName) {
  if (!exportName) return null;
  const file = String(definingFile || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
  return file ? `${file}#${exportName}` : exportName;
}

module.exports = {
  shapeToJsonSchema,
  jsonSchemaToShape,
  makeExportKey,
};
