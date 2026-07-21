'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { explainPortBusy } = require('../lib/start-preflight');

test('explainPortBusy detects live mox runtime pid', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-rt-'));
  const runtimePath = path.join(dir, 'runtime.json');
  fs.writeFileSync(
    runtimePath,
    JSON.stringify({ mock: { pid: process.pid, port: 3900 }, proxy: { port: 18999 } }),
  );
  const r = explainPortBusy({ runtimePath, port: 3900, kind: 'mock' });
  assert.equal(r.ours, true);
  assert.match(r.hint, /mox stop/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('explainPortBusy generic hint when no runtime', () => {
  const r = explainPortBusy({
    runtimePath: path.join(os.tmpdir(), 'mox-no-rt.json'),
    port: 3900,
    kind: 'mock',
  });
  assert.equal(r.ours, false);
  assert.match(r.hint, /mox stop/);
});
