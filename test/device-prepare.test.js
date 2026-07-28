'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('device prepare does NOT put http_proxy; pushes CA and prints banner', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-dev-prep-'));
  const mitm = path.join(root, 'mitm');
  fs.mkdirSync(mitm, { recursive: true });
  const prevMitm = process.env.MOX_MITM_DIR;
  const prevData = process.env.MOX_DATA_ROOT;
  process.env.MOX_MITM_DIR = mitm;
  process.env.MOX_DATA_ROOT = root;

  const calls = [];
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(' '));

  const fakeAdb = (args) => {
    calls.push(args.slice());
    if (args[0] === 'devices') {
      return {
        status: 0,
        stdout: 'List of devices attached\nemulator-5554\tdevice\n',
        stderr: '',
      };
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
    assert.equal(out.httpProxySet, false);
    assert.ok(
      !calls.some(
        (a) =>
          a.includes('settings') &&
          a.includes('put') &&
          a.includes('http_proxy'),
      ),
      `prepare must not put http_proxy, got ${JSON.stringify(calls)}`,
    );
    assert.ok(
      calls.some((a) => a.includes('push') && a.some((x) => /\.cer$|\.crt$/i.test(String(x)))),
      `expected adb push CA, got ${JSON.stringify(calls)}`,
    );
    assert.ok(logs.some((l) => /does NOT set http_proxy/i.test(l)));
    assert.match(String(out.mitmCheckHint || ''), /__mox_mitm_check/);
  } finally {
    console.log = origLog;
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

test('device clear force-clears global proxy', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-dev-clear-'));
  const prevHome = process.env.MOX_HOME;
  process.env.MOX_HOME = root;
  const store = { proxy: '10.1.2.3:8899' };
  const fakeAdb = (args) => {
    if (args[0] === 'devices') {
      return {
        status: 0,
        stdout: 'List of devices attached\nemulator-5554\tdevice\n',
        stderr: '',
      };
    }
    if (args[0] === '-s' && args[2] === 'shell' && args[3] === 'settings') {
      const op = args[4];
      if (op === 'get') return { status: 0, stdout: `${store.proxy}\n`, stderr: '' };
      if (op === 'put') {
        store.proxy = args[7];
        return { status: 0, stdout: '', stderr: '' };
      }
      if (op === 'delete') {
        store.proxy = '';
        return { status: 0, stdout: '', stderr: '' };
      }
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const { deviceClear } = require('../scripts/device-clear');
    deviceClear({ runAdb: fakeAdb });
    const { isProxyActive, normalizeProxyValue } = require('../lib/device-proxy');
    assert.ok(!isProxyActive(normalizeProxyValue(store.proxy)));
    assert.ok(logs.some((l) => /WARN|empties global http_proxy/i.test(l)));
  } finally {
    console.log = origLog;
    if (prevHome === undefined) delete process.env.MOX_HOME;
    else process.env.MOX_HOME = prevHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
