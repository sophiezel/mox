'use strict';

const fs = require('fs');
const path = require('path');
const { reportsDir, ensureDataDirs } = require('./paths');

function upstreamFailuresPath() {
  ensureDataDirs();
  return path.join(reportsDir(), 'upstream-failures.jsonl');
}

/**
 * Append one upstream failure line (connect error or HTTP >= 400).
 * Never merges into contracts — journal only.
 *
 * @param {object} entry
 * @param {string} entry.host
 * @param {string} [entry.path]
 * @param {string} [entry.method]
 * @param {'connect-error'|'http-error'} entry.kind
 * @param {string} [entry.error]
 * @param {string} [entry.message]
 * @param {number} [entry.status]
 * @param {string|null} [entry.taskId]
 */
function appendUpstreamFailure(entry = {}) {
  const row = {
    at: new Date().toISOString(),
    kind: entry.kind || 'connect-error',
    host: entry.host || '',
    path: entry.path || '',
    method: entry.method || '',
    status: entry.status != null ? Number(entry.status) : null,
    error: entry.error || entry.message || null,
    message: entry.message || entry.error || null,
    taskId: entry.taskId ?? null,
  };
  fs.appendFileSync(upstreamFailuresPath(), `${JSON.stringify(row)}\n`, 'utf8');
  return row;
}

module.exports = {
  appendUpstreamFailure,
  upstreamFailuresPath,
};
