'use strict';

/**
 * Content fingerprint for capture dedupe: same method+host+path+status+body → skip rewrite.
 */

const crypto = require('crypto');

function canonicalJson(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/**
 * @param {object} rec capture record
 * @returns {string|null} null when body not usable for fingerprinting
 */
function captureContentKey(rec = {}) {
  if (rec.bodyMeta && rec.bodyMeta.parseOk === false) return null;
  if (rec.responseBody == null || rec.responseBody === '') return null;
  const method = String(rec.method || 'GET').toUpperCase();
  const host = String(rec.host || '').toLowerCase();
  const pathPart = String(rec.path || '');
  const status = rec.status != null ? String(rec.status) : '';
  let body = rec.responseBody;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = rec.responseBody;
    }
  }
  const payload = `${method}|${host}|${pathPart}|${status}|${canonicalJson(body)}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Per-directory seen set (process lifetime + optional warm from existing files).
 */
class CaptureSeenIndex {
  constructor() {
    /** @type {Map<string, Set<string>>} */
    this.byDir = new Map();
  }

  /**
   * @param {string} dir
   * @param {string} key
   */
  has(dir, key) {
    if (!dir || !key) return false;
    const set = this.byDir.get(dir);
    return Boolean(set && set.has(key));
  }

  /**
   * @param {string} dir
   * @param {string} key
   */
  add(dir, key) {
    if (!dir || !key) return;
    if (!this.byDir.has(dir)) this.byDir.set(dir, new Set());
    this.byDir.get(dir).add(key);
  }
}

const globalSeen = new CaptureSeenIndex();

module.exports = {
  canonicalJson,
  captureContentKey,
  CaptureSeenIndex,
  globalSeen,
};
