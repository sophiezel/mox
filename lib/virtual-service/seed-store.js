'use strict';

/**
 * Persist Virtual Service collection rows under services/<id>/seeds/<resource>.json
 * and hydrate them into the in-memory service-store on start.
 */

const fs = require('fs');
const path = require('path');
const {
  serviceDataDir,
  sanitizeUpstreamId,
  listServiceIds,
} = require('../paths');
const { getStore } = require('../service-store');

function seedsDir(upstreamId) {
  return path.join(serviceDataDir(upstreamId), 'seeds');
}

function sanitizeResource(raw) {
  const s = String(raw || 'items')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/_+/g, '_');
  return s || 'items';
}

/**
 * @param {string} upstreamId
 * @param {string} resource
 * @returns {string}
 */
function seedPath(upstreamId, resource) {
  return path.join(seedsDir(upstreamId), `${sanitizeResource(resource)}.json`);
}

/**
 * Stable row id: prefer record.id, else first non-empty of common keys.
 * @param {object} row
 * @returns {string|null}
 */
function rowId(row) {
  if (row == null || typeof row !== 'object' || Array.isArray(row)) return null;
  if (row.id != null && row.id !== '') return String(row.id);
  for (const k of ['appointId', 'clueId', 'sourceId', 'key', 'uuid']) {
    if (row[k] != null && row[k] !== '') return String(row[k]);
  }
  return null;
}

/**
 * @param {string} upstreamId
 * @param {string} resource
 * @returns {{ version: number, resource: string, rows: object[] }}
 */
function readSeed(upstreamId, resource) {
  const file = seedPath(upstreamId, resource);
  if (!fs.existsSync(file)) {
    return {
      version: 1,
      resource: sanitizeResource(resource),
      rows: [],
    };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rows = Array.isArray(raw?.rows) ? raw.rows : [];
    return {
      version: 1,
      resource: sanitizeResource(resource),
      rows,
    };
  } catch {
    return {
      version: 1,
      resource: sanitizeResource(resource),
      rows: [],
    };
  }
}

/**
 * @param {string} upstreamId
 * @param {string} resource
 * @param {object[]} rows
 */
function writeSeed(upstreamId, resource, rows) {
  const res = sanitizeResource(resource);
  const dir = seedsDir(upstreamId);
  fs.mkdirSync(dir, { recursive: true });
  const payload = {
    version: 1,
    resource: res,
    upstreamId: sanitizeUpstreamId(upstreamId),
    rows: Array.isArray(rows) ? rows : [],
  };
  fs.writeFileSync(seedPath(upstreamId, res), `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

/**
 * Upsert rows by id into an existing seed file.
 * @param {string} upstreamId
 * @param {string} resource
 * @param {object[]} incoming
 * @returns {{ version: number, resource: string, rows: object[] }}
 */
function upsertSeedRows(upstreamId, resource, incoming) {
  const current = readSeed(upstreamId, resource);
  const byId = new Map();
  for (const row of current.rows) {
    const id = rowId(row);
    if (id == null) continue;
    byId.set(id, { ...row, id });
  }
  for (const row of incoming || []) {
    if (row == null || typeof row !== 'object' || Array.isArray(row)) continue;
    const id = rowId(row);
    if (id == null) continue;
    const prev = byId.get(id) || {};
    byId.set(id, { ...prev, ...row, id });
  }
  return writeSeed(upstreamId, resource, [...byId.values()]);
}

/**
 * @param {string} upstreamId
 * @returns {string[]}
 */
function listSeedResources(upstreamId) {
  const dir = seedsDir(upstreamId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.replace(/\.json$/, ''))
    .sort();
}

/**
 * Load seeds for catalogs into memory stores.
 * @param {string[]} [serviceIds] default listServiceIds()
 * @returns {number} number of seed files hydrated
 */
function hydrateSeedsIntoStores(serviceIds) {
  const ids =
    Array.isArray(serviceIds) && serviceIds.length
      ? serviceIds
      : listServiceIds();
  let count = 0;
  for (const up of ids) {
    const store = getStore(up);
    for (const resource of listSeedResources(up)) {
      const seed = readSeed(up, resource);
      for (const row of seed.rows) {
        const id = rowId(row);
        if (id == null) continue;
        store.collectionPut(resource, id, row);
      }
      count += 1;
    }
  }
  return count;
}

module.exports = {
  seedPath,
  seedsDir,
  sanitizeResource,
  rowId,
  readSeed,
  writeSeed,
  upsertSeedRows,
  listSeedResources,
  hydrateSeedsIntoStores,
};
