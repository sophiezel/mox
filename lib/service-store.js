'use strict';

/**
 * Per-upstreamId in-memory store (Microcks-style scope).
 * Supports KV + named collections for CRUD-ish flows.
 * Journal is mirrored to disk so `stop` in another process can summarize hits.
 */

const fs = require('fs');
const path = require('path');
const { getServiceJournalPath } = require('./paths');

/** @type {Map<string, ServiceStore>} */
const stores = new Map();

/** @type {{ at: string, stubId?: string, method?: string, path?: string, upstreamId?: string }[]} */
const journal = [];
const JOURNAL_MAX = 200;

function clone(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

class ServiceStore {
  /**
   * @param {string} upstreamId
   */
  constructor(upstreamId) {
    this.upstreamId = upstreamId;
    /** @type {Map<string, { value: any, expiresAt: number|null }>} */
    this.kv = new Map();
    /** @type {Map<string, Map<string, any>>} */
    this.collections = new Map();
  }

  /**
   * @param {string} key
   * @param {any} value
   * @param {number} [ttlSec] TTL seconds; omit = no expiry
   */
  put(key, value, ttlSec) {
    const expiresAt =
      ttlSec != null && Number(ttlSec) > 0
        ? Date.now() + Number(ttlSec) * 1000
        : null;
    this.kv.set(String(key), { value: clone(value), expiresAt });
    return value;
  }

  /**
   * @param {string} key
   * @returns {any|null}
   */
  get(key) {
    const entry = this.kv.get(String(key));
    if (!entry) return null;
    if (entry.expiresAt != null && Date.now() > entry.expiresAt) {
      this.kv.delete(String(key));
      return null;
    }
    return clone(entry.value);
  }

  /**
   * @param {string} key
   */
  delete(key) {
    return this.kv.delete(String(key));
  }

  /**
   * @param {string} name
   * @returns {Map<string, any>}
   */
  collection(name) {
    const n = String(name || 'default');
    if (!this.collections.has(n)) this.collections.set(n, new Map());
    return this.collections.get(n);
  }

  /**
   * @param {string} name
   * @param {string} id
   * @param {any} record
   */
  collectionPut(name, id, record) {
    const col = this.collection(name);
    const row = { ...(clone(record) || {}), id: String(id) };
    col.set(String(id), row);
    return clone(row);
  }

  /**
   * @param {string} name
   * @param {string} id
   */
  collectionGet(name, id) {
    const col = this.collection(name);
    const row = col.get(String(id));
    return row == null ? null : clone(row);
  }

  /**
   * @param {string} name
   * @returns {any[]}
   */
  collectionList(name) {
    return [...this.collection(name).values()].map(clone);
  }

  /**
   * @param {string} name
   * @param {string} id
   */
  collectionDelete(name, id) {
    return this.collection(name).delete(String(id));
  }

  reset() {
    this.kv.clear();
    this.collections.clear();
  }

  snapshot() {
    return {
      upstreamId: this.upstreamId,
      kvKeys: [...this.kv.keys()],
      collections: Object.fromEntries(
        [...this.collections.entries()].map(([k, v]) => [k, v.size]),
      ),
    };
  }
}

/**
 * @param {string} upstreamId
 * @returns {ServiceStore}
 */
function getStore(upstreamId) {
  const id = String(upstreamId || '_default');
  if (!stores.has(id)) stores.set(id, new ServiceStore(id));
  return stores.get(id);
}

/**
 * @param {string} [upstreamId] omit = reset all
 */
function resetStore(upstreamId) {
  if (upstreamId == null || upstreamId === '' || upstreamId === '*') {
    for (const s of stores.values()) s.reset();
    stores.clear();
    clearJournal();
    return { reset: 'all' };
  }
  const s = getStore(upstreamId);
  s.reset();
  return { reset: upstreamId };
}

function persistJournal() {
  try {
    const file = getServiceJournalPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `${JSON.stringify({ version: 1, entries: journal }, null, 2)}\n`,
    );
  } catch {
    /* ignore disk errors — memory journal still works */
  }
}

function loadJournalFromDisk() {
  try {
    const file = getServiceJournalPath();
    if (!fs.existsSync(file)) return [];
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(raw?.entries) ? raw.entries : [];
  } catch {
    return [];
  }
}

/**
 * @param {{ stubId?: string, method?: string, path?: string, upstreamId?: string }} entry
 */
function appendJournal(entry) {
  journal.push({
    at: new Date().toISOString(),
    stubId: entry.stubId || null,
    method: entry.method || null,
    path: entry.path || null,
    upstreamId: entry.upstreamId || null,
  });
  while (journal.length > JOURNAL_MAX) journal.shift();
  persistJournal();
}

/**
 * Prefer in-memory when this process owns the session; else disk (e.g. stop CLI).
 * @param {number} [limit]
 */
function readJournal(limit = 50) {
  const n = Math.max(1, Math.min(JOURNAL_MAX, Number(limit) || 50));
  const source = journal.length ? journal : loadJournalFromDisk();
  return source.slice(-n);
}

function clearJournal() {
  journal.length = 0;
  try {
    const file = getServiceJournalPath();
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

/**
 * One-line summary for stop / Ctrl+C.
 * @returns {{ hits: number, line: string }}
 */
function journalSummary() {
  const entries = journal.length ? journal : loadJournalFromDisk();
  const hits = entries.length;
  if (!hits) {
    return { hits: 0, line: '[mox] journal: 0 hits' };
  }
  const byUp = new Map();
  for (const e of entries) {
    const id = e.upstreamId || '_default';
    byUp.set(id, (byUp.get(id) || 0) + 1);
  }
  const tops = [...byUp.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id, n]) => `${id}=${n}`)
    .join(', ');
  return {
    hits,
    line: `[mox] journal: ${hits} hit(s)${tops ? ` (${tops})` : ''}`,
  };
}

/** @internal — simulate another process with empty memory but disk intact */
function _emptyMemoryJournalForTests() {
  journal.length = 0;
}

/** @internal */
function _resetAllForTests() {
  resetStore('*');
}

module.exports = {
  ServiceStore,
  getStore,
  resetStore,
  appendJournal,
  readJournal,
  clearJournal,
  journalSummary,
  _resetAllForTests,
  _emptyMemoryJournalForTests,
};
