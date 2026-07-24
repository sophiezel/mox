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
  captureHasUsableBody,
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
    'capture',
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

test('summary prints mock, fail, and capture', () => {
  assert.equal(
    shouldPrintConsole({ action: 'mitm-mock' }, 'summary'),
    true,
  );
  assert.equal(
    shouldPrintConsole({ action: 'reject' }, 'summary'),
    true,
  );
  assert.equal(
    shouldPrintConsole({ action: 'capture' }, 'summary'),
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

test('noise-host block-write is quiet in summary; business stays fail', () => {
  const quiet = enrichAccessEntry({
    action: 'block-write',
    host: 'c-hzgt2.getui.com',
    method: 'POST',
    url: 'http://c-hzgt2.getui.com/api.php',
  });
  assert.equal(quiet.label, 'fail');
  assert.equal(quiet.bucket, 'noise');
  assert.equal(shouldPrintConsole(quiet, 'summary'), false);
  assert.equal(shouldPrintConsole(quiet, 'verbose'), true);

  const business = enrichAccessEntry({
    action: 'block-write',
    host: 'jian-j.guazi.com',
    method: 'POST',
    url: 'https://jian-j.guazi.com/x',
  });
  assert.equal(business.bucket, 'signal');
  assert.equal(shouldPrintConsole(business, 'summary'), true);
});

test('block-write under capture-open is noise even for business host', () => {
  const e = enrichAccessEntry({
    action: 'block-write',
    host: 'jian-j.guazi.com',
    mode: 'capture-open',
    method: 'POST',
    url: 'https://jian-j.guazi.com/x',
  });
  assert.equal(e.bucket, 'noise');
  assert.equal(shouldPrintConsole(e, 'summary'), false);
});

test('formatConsoleLine: capture label', () => {
  assert.equal(
    formatConsoleLine({
      action: 'capture',
      method: 'POST',
      url: 'https://a/b',
    }),
    '[proxy] capture  POST https://a/b',
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

test('captureHasUsableBody: block-write / empty / parse fail are not capture signals', () => {
  assert.equal(
    captureHasUsableBody({ reason: 'block-write', responseBody: '{}' }),
    false,
  );
  assert.equal(captureHasUsableBody({ reason: 'miss', responseBody: '' }), false);
  assert.equal(captureHasUsableBody({ reason: 'miss' }), false);
  assert.equal(
    captureHasUsableBody({
      reason: 'miss',
      responseBody: 'not-json',
      bodyMeta: { parseOk: false },
    }),
    false,
  );
  assert.equal(
    captureHasUsableBody({
      reason: 'miss',
      responseBody: '{"ok":true}',
      bodyMeta: { parseOk: true },
    }),
    true,
  );
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
