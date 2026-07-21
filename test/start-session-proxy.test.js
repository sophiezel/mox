'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  resolveClientProxyHost,
  buildChromiumLaunchArgs,
} = require('../scripts/start-session');
const { loadDefault, deepMerge, loadSession } = require('../lib/session-config');
const { setScenario } = require('../scripts/set-scenario');
const { copyBuiltinScenarios } = require('../lib/scenario');
const { ensureDataDirs } = require('../lib/paths');

test('resolveClientProxyHost: 0.0.0.0 bind → 127.0.0.1 for Chrome', () => {
  assert.equal(resolveClientProxyHost('0.0.0.0'), '127.0.0.1');
  assert.equal(resolveClientProxyHost('::'), '127.0.0.1');
  assert.equal(resolveClientProxyHost('127.0.0.1'), '127.0.0.1');
  assert.equal(resolveClientProxyHost('192.168.1.10'), '192.168.1.10');
});

test('buildChromiumLaunchArgs has bypass list and never ignore-certificate flags', () => {
  const args = buildChromiumLaunchArgs({
    userDataDir: '/tmp/mox-profile',
    proxyServerArg: '127.0.0.1:18999',
    clientProxyHost: '127.0.0.1',
    proxyPort: 18999,
    startUrl: 'http://127.0.0.1:8000/',
  });
  assert.ok(args.includes('--proxy-server=127.0.0.1:18999'));
  assert.ok(args.includes('--proxy-bypass-list=127.0.0.1;localhost;::1'));
  assert.ok(args.includes('http://127.0.0.1:8000/'));
  assert.ok(!args.some((a) => a.includes('ignore-certificate')));
});

test('defaults: mitm on, LAN bind, open proxy, startUrl localhost:8000', () => {
  const defaults = loadDefault();
  assert.equal(defaults.proxy.mitm?.enabled, true);
  assert.equal(defaults.proxy.host, '0.0.0.0');
  assert.equal(defaults.proxy.allowOpenProxy, true);
  assert.equal(defaults.browser.startUrl, 'http://127.0.0.1:8000');
});

test('session config: proxy.host=0.0.0.0 is parseable from defaults merge', () => {
  const defaults = loadDefault();
  const merged = deepMerge(defaults, { proxy: { host: '0.0.0.0', port: 18999 } });
  assert.equal(merged.proxy.host, '0.0.0.0');
  assert.equal(typeof merged.proxy.port, 'number');
  assert.equal(resolveClientProxyHost(merged.proxy.host), '127.0.0.1');
});

test('applySessionOpts --no-open-proxy locks allowOpenProxy', () => {
  const { applySessionOpts } = require('../scripts/start-session');
  const base = loadDefault();
  const next = applySessionOpts(base, { noOpenProxy: true });
  assert.equal(base.proxy.allowOpenProxy, true);
  assert.equal(next.proxy.allowOpenProxy, false);
});

test('setScenario persists scenario name for session Wi‑Fi block', () => {
  const slug = `proxy-host-test-${Date.now()}`;
  const sessionFile = path.join(os.tmpdir(), `${slug}-session.json`);
  const prev = process.env.MOX_SESSION_FILE;
  process.env.MOX_SESSION_FILE = sessionFile;
  try {
    ensureDataDirs();
    copyBuiltinScenarios();
    setScenario({ scenario: 'e2e-fault' });
    const cfg = loadSession();
    assert.equal(cfg.scenario, 'e2e-fault');
  } finally {
    process.env.MOX_SESSION_FILE = prev;
    try {
      fs.unlinkSync(sessionFile);
    } catch (_) {
      /* ignore */
    }
  }
});

test('applySessionOpts does not mutate base session config', () => {
  const { applySessionOpts } = require('../scripts/start-session');
  const base = {
    mock: { host: '127.0.0.1', port: 3900 },
    proxy: { enabled: true, host: '127.0.0.1', port: 18999, mitm: { enabled: true } },
    browser: { autoLaunch: true, startUrl: 'http://127.0.0.1:8000' },
    cors: {},
    cases: { default: 'success', active: {} },
  };
  const next = applySessionOpts(base, {
    mockPort: 4400,
    proxyHost: '0.0.0.0',
    proxyPort: 19000,
    autoLaunch: false,
    mitm: false,
  });
  assert.equal(base.mock.port, 3900);
  assert.equal(base.proxy.host, '127.0.0.1');
  assert.equal(base.proxy.mitm.enabled, true);
  assert.equal(base.browser.autoLaunch, true);
  assert.equal(next.mock.port, 4400);
  assert.equal(next.proxy.host, '0.0.0.0');
  assert.equal(next.proxy.port, 19000);
  assert.equal(next.browser.autoLaunch, false);
  assert.equal(next.proxy.mitm.enabled, false);
});
