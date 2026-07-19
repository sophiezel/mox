'use strict';

const fs = require('fs');
const path = require('path');
const { auditDir, ensureDataDirs } = require('./paths');

function changelogPath() {
  ensureDataDirs();
  return path.join(auditDir(), 'changelog.jsonl');
}

/**
 * Append an audit line. Compat: appendAudit(entry) or appendAudit(label, entry).
 */
function appendAudit(labelOrEntry, maybeEntry) {
  const entry =
    maybeEntry != null
      ? { label: labelOrEntry, ...maybeEntry }
      : labelOrEntry || {};
  const line = JSON.stringify({
    at: new Date().toISOString(),
    taskId: entry.taskId ?? null,
    ...entry,
  });
  fs.appendFileSync(changelogPath(), `${line}\n`, 'utf8');
}

/**
 * Read audit log. Compat: readAudit(slug, opts) or readAudit(opts).
 */
function readAudit(slugOrOpts, maybeOpts) {
  const opts =
    maybeOpts != null
      ? maybeOpts
      : slugOrOpts && typeof slugOrOpts === 'object' && !Array.isArray(slugOrOpts)
        ? slugOrOpts
        : {};
  const { taskId, api } = opts;
  const file = changelogPath();
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  let rows = lines
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (taskId) {
    rows = rows.filter((r) => r.taskId === taskId);
  }
  if (api) {
    rows = rows.filter(
      (r) =>
        r.apiKey === api ||
        (r.apiKey && r.apiKey.includes(api)) ||
        (r.path && r.path.includes(api)),
    );
  }
  return rows;
}

module.exports = { appendAudit, readAudit, changelogPath };
