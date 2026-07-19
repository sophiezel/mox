'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { appendAudit, readAudit, changelogPath } = require('../lib/audit');
const { ensureDataDirs } = require('../lib/paths');

test('audit: append and filter by taskId/api', () => {
  ensureDataDirs();
  try {
    appendAudit({ command: 'init', taskId: 'T1', apiKey: 'GET h/p', summary: 'a' });
    appendAudit({ command: 'smoke', taskId: 'T2', apiKey: 'POST h/q', summary: 'b' });
    appendAudit({ command: 'bad', taskId: 'T1', summary: 'c' });

    // corrupt line tolerance
    const file = changelogPath();
    fs.appendFileSync(file, 'not-json\n');

    const all = readAudit();
    assert.ok(all.length >= 3);
    const t1 = readAudit({ taskId: 'T1' });
    assert.equal(t1.length, 2);
    const api = readAudit({ api: 'GET h/p' });
    assert.equal(api.length, 1);
    assert.equal(api[0].command, 'init');
  } finally {
    try {
      fs.unlinkSync(changelogPath());
    } catch {
      /* ignore */
    }
  }
});
