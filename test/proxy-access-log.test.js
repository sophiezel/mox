'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ACTION_CLASS,
  classifyAccess,
  resolveProxyLogLevel,
  shouldPrintConsole,
  formatConsoleLine,
  enrichAccessEntry,
} = require('../lib/proxy-access-log');

test('ACTION_CLASS covers known proxy actions without dropping detail names', () => {
  const required = [
    'mock',
    'mitm-mock',
    'on-demand-mock',
    'passthrough',
    'mitm-passthrough',
    'traffic-passthrough',
    'mitm-traffic-passthrough',
    'passthrough-host',
    'reject',
    'block-write',
    'connect-mitm',
    'connect-tunnel',
    'connect-tunnel-cronet',
    'connect-mitm-fail',
    'mitm-passthrough-error',
    'mox-hub',
    'options',
    'mitm-options',
    'mitm-check',
  ];
  for (const a of required) {
    assert.ok(ACTION_CLASS[a], `missing ACTION_CLASS for ${a}`);
  }
});

test('classifyAccess: mock and fail are signal; upstream/connect/tool are noise', () => {
  assert.deepEqual(classifyAccess('mitm-mock'), {
    label: 'mock',
    bucket: 'signal',
  });
  assert.deepEqual(classifyAccess('mitm-traffic-passthrough'), {
    label: 'upstream',
    bucket: 'noise',
  });
  assert.deepEqual(classifyAccess('connect-mitm'), {
    label: 'connect',
    bucket: 'noise',
  });
  assert.deepEqual(classifyAccess('connect-tunnel-fail'), {
    label: 'fail',
    bucket: 'signal',
  });
  assert.deepEqual(classifyAccess('mox-pac'), {
    label: 'tool',
    bucket: 'noise',
  });
});

test('summary prints only mock and fail', () => {
  assert.equal(
    shouldPrintConsole({ action: 'mitm-mock' }, 'summary'),
    true,
  );
  assert.equal(
    shouldPrintConsole({ action: 'reject' }, 'summary'),
    true,
  );
  assert.equal(
    shouldPrintConsole({ action: 'mitm-passthrough' }, 'summary'),
    false,
  );
  assert.equal(
    shouldPrintConsole({ action: 'connect-mitm' }, 'summary'),
    false,
  );
  assert.equal(
    shouldPrintConsole({ action: 'mitm-options' }, 'summary'),
    false,
  );
});

test('verbose prints all; silent prints none', () => {
  assert.equal(
    shouldPrintConsole({ action: 'connect-mitm' }, 'verbose'),
    true,
  );
  assert.equal(
    shouldPrintConsole({ action: 'mitm-mock' }, 'silent'),
    false,
  );
});

test('formatConsoleLine uses short label; fail keeps action', () => {
  assert.equal(
    formatConsoleLine({
      action: 'mitm-mock',
      method: 'POST',
      url: 'https://a/b',
    }),
    '[proxy] mock  POST https://a/b',
  );
  assert.equal(
    formatConsoleLine({
      action: 'mitm-passthrough-error',
      method: 'GET',
      url: 'https://a/b',
    }),
    '[proxy] fail  GET https://a/b  (mitm-passthrough-error)',
  );
});

test('enrichAccessEntry keeps original action', () => {
  const out = enrichAccessEntry({
    action: 'mitm-traffic-passthrough',
    method: 'GET',
    url: 'https://x',
  });
  assert.equal(out.action, 'mitm-traffic-passthrough');
  assert.equal(out.label, 'upstream');
  assert.equal(out.bucket, 'noise');
});

test('resolveProxyLogLevel: CLI > env > summary; invalid throws', () => {
  const prev = process.env.MOX_PROXY_LOG;
  try {
    delete process.env.MOX_PROXY_LOG;
    assert.equal(resolveProxyLogLevel(), 'summary');
    assert.equal(resolveProxyLogLevel('verbose'), 'verbose');
    assert.equal(resolveProxyLogLevel('silent'), 'silent');

    process.env.MOX_PROXY_LOG = 'silent';
    assert.equal(resolveProxyLogLevel(), 'silent');
    assert.equal(resolveProxyLogLevel('verbose'), 'verbose'); // CLI wins

    assert.throws(
      () => resolveProxyLogLevel('nope'),
      /invalid proxy-log/,
    );
    process.env.MOX_PROXY_LOG = 'nope';
    assert.throws(() => resolveProxyLogLevel(), /invalid proxy-log/);
  } finally {
    if (prev === undefined) delete process.env.MOX_PROXY_LOG;
    else process.env.MOX_PROXY_LOG = prev;
  }
});
