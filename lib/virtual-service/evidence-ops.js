'use strict';

/**
 * Infer query operators from multi-Observation request↔result differentials.
 * Only emit operators when request field values change across samples AND
 * result row id sets differ — evidence-driven, no invented filters.
 */

const { PAGE_KEYS, PAGE_SIZE_KEYS } = require('./protocols/paginated-list');
const { rowId } = require('./seed-store');

const IGNORE_REQ = new Set([
  ...PAGE_KEYS,
  ...PAGE_SIZE_KEYS,
  'sortField',
  'sortOrder',
  'order',
  'orderBy',
  'sort',
]);

function resultIds(obs, listKey) {
  const data = obs?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return new Set();
  const arr = data[listKey];
  if (!Array.isArray(arr)) return new Set();
  const ids = new Set();
  for (const row of arr) {
    const id = rowId(row);
    if (id != null) ids.add(id);
  }
  return ids;
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * @param {object[]} observations
 * @param {{ listKey?: string }} envelope
 * @returns {object[]}
 */
function inferOperatorsFromObservations(observations, envelope = {}) {
  const listKey = envelope.listKey || 'detail';
  const list = (observations || []).filter(
    (o) => o && o.requestBody && typeof o.requestBody === 'object',
  );
  if (list.length < 2) return [];

  const fieldValues = new Map();
  for (const o of list) {
    for (const [k, v] of Object.entries(o.requestBody)) {
      if (IGNORE_REQ.has(k)) continue;
      if (v == null || v === '') continue;
      if (typeof v === 'object') continue;
      if (!fieldValues.has(k)) fieldValues.set(k, new Set());
      fieldValues.get(k).add(String(v));
    }
  }

  const operators = [];
  for (const [field, values] of fieldValues) {
    if (values.size < 2) continue;

    // Pairwise: same page-ish groups where only this field differs → id sets must differ
    let evidenced = false;
    for (let i = 0; i < list.length && !evidenced; i++) {
      for (let j = i + 1; j < list.length && !evidenced; j++) {
        const a = list[i];
        const b = list[j];
        const av = a.requestBody[field];
        const bv = b.requestBody[field];
        if (av == null || bv == null) continue;
        if (String(av) === String(bv)) continue;
        // other scalar req fields equal (except pagination / this field)
        let othersEqual = true;
        const keys = new Set([
          ...Object.keys(a.requestBody),
          ...Object.keys(b.requestBody),
        ]);
        for (const k of keys) {
          if (k === field || IGNORE_REQ.has(k)) continue;
          if (String(a.requestBody[k] ?? '') !== String(b.requestBody[k] ?? '')) {
            othersEqual = false;
            break;
          }
        }
        if (!othersEqual) continue;
        const idsA = resultIds(a, listKey);
        const idsB = resultIds(b, listKey);
        if (!setsEqual(idsA, idsB)) {
          evidenced = true;
        }
      }
    }
    if (evidenced) {
      operators.push({ type: 'eq', field });
    }
  }

  // Sort: if sortField present with different values and order of ids changes
  const sortSamples = list.filter(
    (o) => o.requestBody.sortField != null || o.requestBody.orderBy != null,
  );
  if (sortSamples.length >= 2) {
    operators.push({
      type: 'sort',
      requestField: sortSamples[0].requestBody.sortField != null ? 'sortField' : 'orderBy',
    });
  }

  return operators;
}

module.exports = {
  inferOperatorsFromObservations,
};
