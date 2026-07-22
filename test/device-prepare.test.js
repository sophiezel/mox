'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('device prepare invokes adb settings put http_proxy when adb mock succeeds', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-dev-prep-'));
  const mitm = path.join(root, 'mitm');
  fs.mkdirSync(mitm, { recursive: true });
  const prevMitm = process.env.MOX_MITM_DIR;
  const prevData = process.env.MOX_DATA_ROOT;
  process.env.MOX_MITM_DIR = mitm;
  process.env.MOX_DATA_ROOT = root;

  const calls = [];
  const fakeAdb = (args) => {
    calls.push(args.slice());
    if (args[0] === 'devices') {
      return { status: 0, stdout: 'List of devices attached\nemulator-5554\tdevice\n', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  try {
    const { ensureCa } = require('../lib/mitm-ca');
    ensureCa({ forceRegen: true });
    const { devicePrepare } = require('../scripts/device-prepare');
    const out = devicePrepare({
      lanIp: '192.168.1.10',
      proxyPort: 18999,
      runAdb: fakeAdb,
    });
    assert.equal(out.ok, true);
    assert.ok(
      calls.some(
        (a) =>
          a.includes('settings') &&
          a.includes('put') &&
          a.includes('http_proxy') &&
          a.some((x) => String(x).includes('192.168.1.10:18999')),
      ),
      `expected settings put http_proxy, got ${JSON.stringify(calls)}`,
    );
    assert.ok(
      calls.some((a) => a.includes('push') && a.some((x) => /\.cer$|\.crt$/i.test(String(x)))),
      `expected adb push CA, got ${JSON.stringify(calls)}`,
    );
    assert.match(String(out.mitmCheckHint || ''), /__mox_mitm_check/);
  } finally {
    if (prevMitm === undefined) delete process.env.MOX_MITM_DIR;
    else process.env.MOX_MITM_DIR = prevMitm;
    if (prevData === undefined) delete process.env.MOX_DATA_ROOT;
    else process.env.MOX_DATA_ROOT = prevData;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('device prepare exits nonzero when no device', () => {
  const fakeAdb = (args) => {
    if (args[0] === 'devices') {
      return { status: 0, stdout: 'List of devices attached\n', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'fail' };
  };
  const { devicePrepare } = require('../scripts/device-prepare');
  assert.throws(
    () => devicePrepare({ lanIp: '10.0.0.1', proxyPort: 18999, runAdb: fakeAdb }),
    /no device/i,
  );
});
