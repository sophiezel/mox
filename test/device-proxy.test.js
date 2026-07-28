'use strict';

const test = require('node:test');
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function withTempHome(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-dev-proxy-'));
  const prevHome = process.env.MOX_HOME;
  const prevSerial = process.env.ANDROID_SERIAL;
  process.env.MOX_HOME = root;
  delete process.env.ANDROID_SERIAL;
  try {
    return fn(root);
  } finally {
    if (prevHome === undefined) delete process.env.MOX_HOME;
    else process.env.MOX_HOME = prevHome;
    if (prevSerial === undefined) delete process.env.ANDROID_SERIAL;
    else process.env.ANDROID_SERIAL = prevSerial;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function makeFakeAdb(store) {
  const calls = [];
  const fakeAdb = (args) => {
    calls.push(args.slice());
    if (args[0] === 'devices') {
      return {
        status: 0,
        stdout: 'List of devices attached\nemulator-5554\tdevice\n',
        stderr: '',
      };
    }
    // adb -s SERIAL shell settings get/put/delete ...
    if (args[0] === '-s' && args[2] === 'shell' && args[3] === 'settings') {
      const op = args[4];
      const key = args[6];
      if (key === 'http_proxy') {
        if (op === 'get') {
          return { status: 0, stdout: `${store.proxy || 'null'}\n`, stderr: '' };
        }
        if (op === 'put') {
          store.proxy = args[7];
          return { status: 0, stdout: '', stderr: '' };
        }
        if (op === 'delete') {
          store.proxy = '';
          return { status: 0, stdout: '', stderr: '' };
        }
      }
    }
    if (args[0] === '-s' && args[2] === 'push') {
      store.pushed = args[3];
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { fakeAdb, calls, store };
}

test('normalizeProxyValue treats :0 and null as cleared', () => {
  const { normalizeProxyValue, isProxyActive } = require('../lib/device-proxy');
  assert.equal(normalizeProxyValue(':0'), '');
  assert.equal(normalizeProxyValue('null'), '');
  assert.equal(normalizeProxyValue(' 10.0.0.1:18999 '), '10.0.0.1:18999');
  assert.equal(isProxyActive(normalizeProxyValue('10.0.0.1:18999')), true);
  assert.equal(isProxyActive(normalizeProxyValue(':0')), false);
});

test('attachDeviceForSession sets http_proxy and writes ~/.mox lease', async () => {
  await withTempHome(async (home) => {
    const mitm = path.join(home, 'mitm');
    fs.mkdirSync(mitm, { recursive: true });
    const prevMitm = process.env.MOX_MITM_DIR;
    process.env.MOX_MITM_DIR = mitm;
    try {
      const { ensureCa } = require('../lib/mitm-ca');
      ensureCa({ forceRegen: true });
      const { fakeAdb, store } = makeFakeAdb({ proxy: '' });
      const {
        attachDeviceForSession,
        readLease,
        leasePath,
      } = require('../lib/device-proxy');
      const out = attachDeviceForSession({
        lanIp: '192.168.1.10',
        proxyPort: 18999,
        runAdb: fakeAdb,
        catalogHost: 'api.example.com',
      });
      assert.equal(out.ok, true);
      assert.equal(store.proxy, '192.168.1.10:18999');
      const lease = readLease();
      assert.equal(lease.value, '192.168.1.10:18999');
      assert.ok(fs.existsSync(leasePath()));
      assert.match(leasePath(), new RegExp(home.replace(/\\/g, '\\\\')));
    } finally {
      if (prevMitm === undefined) delete process.env.MOX_MITM_DIR;
      else process.env.MOX_MITM_DIR = prevMitm;
    }
  });
});

test('attachDeviceForSession fails without LAN IP', () => {
  withTempHome(() => {
    const { attachDeviceForSession } = require('../lib/device-proxy');
    const { fakeAdb } = makeFakeAdb({ proxy: '' });
    assert.throws(
      () => attachDeviceForSession({ lanIp: '', proxyPort: 18999, runAdb: fakeAdb }),
      /no LAN IP/i,
    );
  });
});

test('attachDeviceForSession fails with no adb device', () => {
  withTempHome(() => {
    const { attachDeviceForSession } = require('../lib/device-proxy');
    const fakeAdb = (args) => {
      if (args[0] === 'devices') {
        return { status: 0, stdout: 'List of devices attached\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    assert.throws(
      () =>
        attachDeviceForSession({
          lanIp: '10.0.0.1',
          proxyPort: 18999,
          runAdb: fakeAdb,
        }),
      /no device/i,
    );
  });
});

test('attach warns when dirty global proxy without lease', async () => {
  await withTempHome(async (home) => {
    const mitm = path.join(home, 'mitm');
    fs.mkdirSync(mitm, { recursive: true });
    const prevMitm = process.env.MOX_MITM_DIR;
    process.env.MOX_MITM_DIR = mitm;
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => warns.push(a.join(' '));
    try {
      const { ensureCa } = require('../lib/mitm-ca');
      ensureCa({ forceRegen: true });
      const { fakeAdb } = makeFakeAdb({ proxy: '10.1.1.1:8899' });
      const { attachDeviceForSession } = require('../lib/device-proxy');
      const out = attachDeviceForSession({
        lanIp: '192.168.1.10',
        proxyPort: 18999,
        runAdb: fakeAdb,
      });
      assert.equal(out.dirtyWarns.length, 1);
      assert.ok(warns.some((w) => /device clear/i.test(w)));
    } finally {
      console.warn = origWarn;
      if (prevMitm === undefined) delete process.env.MOX_MITM_DIR;
      else process.env.MOX_MITM_DIR = prevMitm;
    }
  });
});

test('clearDeviceHttpProxyIfLease clears only when matches lease', async () => {
  await withTempHome(async (home) => {
    const mitm = path.join(home, 'mitm');
    fs.mkdirSync(mitm, { recursive: true });
    const prevMitm = process.env.MOX_MITM_DIR;
    process.env.MOX_MITM_DIR = mitm;
    try {
      const { ensureCa } = require('../lib/mitm-ca');
      ensureCa({ forceRegen: true });
      const store = { proxy: '' };
      const { fakeAdb } = makeFakeAdb(store);
      const {
        attachDeviceForSession,
        clearDeviceHttpProxyIfLease,
        readLease,
      } = require('../lib/device-proxy');
      attachDeviceForSession({
        lanIp: '10.0.0.2',
        proxyPort: 18999,
        runAdb: fakeAdb,
      });
      assert.equal(store.proxy, '10.0.0.2:18999');
      const cleared = clearDeviceHttpProxyIfLease({ runAdb: fakeAdb });
      assert.equal(cleared.ok, true);
      assert.equal(cleared.cleared, true);
      assert.ok(!isActive(store.proxy));
      assert.equal(readLease(), null);
    } finally {
      if (prevMitm === undefined) delete process.env.MOX_MITM_DIR;
      else process.env.MOX_MITM_DIR = prevMitm;
    }
  });
});

function isActive(v) {
  const { isProxyActive, normalizeProxyValue } = require('../lib/device-proxy');
  return isProxyActive(normalizeProxyValue(v));
}

test('clear skips when user changed proxy away from lease', async () => {
  await withTempHome(async (home) => {
    const mitm = path.join(home, 'mitm');
    fs.mkdirSync(mitm, { recursive: true });
    const prevMitm = process.env.MOX_MITM_DIR;
    process.env.MOX_MITM_DIR = mitm;
    try {
      const { ensureCa } = require('../lib/mitm-ca');
      ensureCa({ forceRegen: true });
      const store = { proxy: '' };
      const { fakeAdb } = makeFakeAdb(store);
      const {
        attachDeviceForSession,
        clearDeviceHttpProxyIfLease,
      } = require('../lib/device-proxy');
      attachDeviceForSession({
        lanIp: '10.0.0.2',
        proxyPort: 18999,
        runAdb: fakeAdb,
      });
      store.proxy = '10.112.114.173:8899';
      const out = clearDeviceHttpProxyIfLease({ runAdb: fakeAdb });
      assert.equal(out.ok, true);
      assert.equal(out.cleared, false);
      assert.equal(store.proxy, '10.112.114.173:8899');
    } finally {
      if (prevMitm === undefined) delete process.env.MOX_MITM_DIR;
      else process.env.MOX_MITM_DIR = prevMitm;
    }
  });
});

test('forceClearDeviceHttpProxy clears regardless of lease match', async () => {
  await withTempHome(async () => {
    const store = { proxy: '10.112.114.173:8899' };
    const { fakeAdb } = makeFakeAdb(store);
    const { forceClearDeviceHttpProxy, writeLease } = require('../lib/device-proxy');
    writeLease({ value: '1.2.3.4:18999', setAt: new Date().toISOString() });
    const out = forceClearDeviceHttpProxy({ runAdb: fakeAdb });
    assert.equal(out.ok, true);
    assert.ok(!isActive(store.proxy));
  });
});

test('stopSession clears matching lease via injected runAdb', async () => {
  await withTempHome(async (home) => {
    const mitm = path.join(home, 'mitm');
    fs.mkdirSync(mitm, { recursive: true });
    const prevMitm = process.env.MOX_MITM_DIR;
    const prevData = process.env.MOX_DATA_ROOT;
    process.env.MOX_MITM_DIR = mitm;
    process.env.MOX_DATA_ROOT = path.join(home, 'data');
    fs.mkdirSync(process.env.MOX_DATA_ROOT, { recursive: true });
    try {
      const { ensureCa } = require('../lib/mitm-ca');
      ensureCa({ forceRegen: true });
      const store = { proxy: '' };
      const { fakeAdb } = makeFakeAdb(store);
      const { attachDeviceForSession } = require('../lib/device-proxy');
      attachDeviceForSession({
        lanIp: '10.0.0.9',
        proxyPort: 18999,
        runAdb: fakeAdb,
      });
      const { stopSession } = require('../scripts/stop-session');
      const out = stopSession({ runAdb: fakeAdb });
      assert.equal(out.deviceProxyClear.ok, true);
      assert.ok(!isActive(store.proxy));
    } finally {
      if (prevMitm === undefined) delete process.env.MOX_MITM_DIR;
      else process.env.MOX_MITM_DIR = prevMitm;
      if (prevData === undefined) delete process.env.MOX_DATA_ROOT;
      else process.env.MOX_DATA_ROOT = prevData;
    }
  });
});
